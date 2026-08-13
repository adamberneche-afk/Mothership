import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = 'spokes.json';
const TENANTS_REGISTRY_PATH = 'tenants.json';
const DEFAULT_TENANT_ID = 'default';
// How many of a spoke's most recent decision-log entries get included in
// the cross-spoke summary prompt - enough to see a pattern, not so much
// that one busy spoke drowns out the others.
const RECENT_DECISIONS_PER_SPOKE = 10;

// The hub's own identity - needed because this endpoint opens a PR against
// itself, unlike autonomous_agent.js, which always operates on a spoke
// passed in the request body. Overridable via env var (and via the
// `hubOwner`/`hubRepo` options below, for tests) in case this code is ever
// deployed under a different repo.
const DEFAULT_HUB_OWNER = 'adamberneche-afk';
const DEFAULT_HUB_REPO = 'Mothership';

async function safeGetTextContent(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
}

function safeParseJsonArray(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Looks up the hub repo's actual default branch instead of assuming 'main' -
// correct today, but a hardcoded assumption is exactly the kind of thing
// that silently breaks later if the default branch is ever renamed.
async function getDefaultBranch(octokit, owner, repo) {
  try {
    const { data } = await octokit.repos.get({ owner, repo });
    return data.default_branch || 'main';
  } catch (e) {
    return 'main';
  }
}

// --- Multi-tenancy: same data model/resolution as api/autonomous_agent.js
// (see that file's header comment for the full rationale) - ported here so
// the Recursive Learning Loop never pools two tenants' spoke data into one
// cross-spoke prompt, which would otherwise be a real, silent isolation
// leak specific to this endpoint's whole purpose (finding patterns ACROSS
// spokes).

function groupSpokesByTenant(spokes) {
  const byTenant = {};
  for (const spoke of spokes) {
    if (!spoke || !spoke.owner || !spoke.repo) continue;
    const tenantId = spoke.tenantId || DEFAULT_TENANT_ID;
    (byTenant[tenantId] = byTenant[tenantId] || []).push(spoke);
  }
  return byTenant;
}

function findTenant(tenantId, tenants) {
  return tenants.find(t => t && t.tenantId === tenantId) || null;
}

// Same env:/kv: scheme as api/autonomous_agent.js's resolveSecretRef.
// TODO: wire the kv: branch to a real secrets store before onboarding a
// second tenant for real - see that file's identical TODO.
function resolveSecretRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] || null;
  if (ref.startsWith('kv:')) return null;
  return null;
}

// Builds and runs one tenant's independent cross-spoke proposal - the unit
// of work this whole redesign scopes tenant-isolation around. Only ever
// sees this tenant's own spokes' lessons.md/ai_decision_log.json; never
// pools another tenant's data into the same prompt.
async function runForTenant({ tenantId, tenantSpokes, tenant, octokitFactory, hubOctokit, fetchImpl, dryRun, universalLessons, globalNorthStar, HUB_OWNER, HUB_REPO }) {
  const spokeToken = (tenant && resolveSecretRef(tenant.githubCredentialRef)) || process.env.GLOBAL_GITHUB_TOKEN;
  const octokit = octokitFactory(spokeToken);

  const perSpokeContext = [];
  for (const spoke of tenantSpokes) {
    const lessons = await safeGetTextContent(octokit, spoke.owner, spoke.repo, 'lessons.md');
    const decisionLogText = await safeGetTextContent(octokit, spoke.owner, spoke.repo, 'ai_decision_log.json');
    const recentDecisions = safeParseJsonArray(decisionLogText).slice(-RECENT_DECISIONS_PER_SPOKE);
    // scripts/collect-issue-feedback.js attaches a `feedback` field (from
    // issue reactions - a real "this was wrong" signal from the spoke's own
    // maintainer) to matching entries. Summarized here rather than dumped
    // raw, same reasoning as RECENT_DECISIONS_PER_SPOKE's own cap - enough
    // signal to see a pattern, not so much detail it drowns out everything
    // else in the prompt.
    const negativeFeedbackCount = recentDecisions.filter((d) => d && d.feedback && d.feedback.thumbsDown > 0).length;
    const feedbackSummary = negativeFeedbackCount > 0
      ? `${negativeFeedbackCount} of the last ${recentDecisions.length} decisions received negative maintainer feedback (a real thumbs-down reaction on the filed issue).`
      : 'none of the last decisions received negative maintainer feedback.';
    perSpokeContext.push({
      owner: spoke.owner,
      repo: spoke.repo,
      lessons: lessons || 'No lessons.md found.',
      recentDecisions,
      feedbackSummary
    });
  }

  const perSpokeSection = perSpokeContext.map(s => `
    --- ${s.owner}/${s.repo} ---
    LESSONS: ${s.lessons}
    RECENT HUB DECISIONS: ${JSON.stringify(s.recentDecisions)}
    MAINTAINER FEEDBACK: ${s.feedbackSummary}
  `).join('\n');

  const prompt = `
    ROLE: Senior AI CTO performing a cross-project retrospective across every
    connected spoke belonging to ONE customer (tenant "${tenantId}") - never
    mix in patterns from any other tenant's projects, even if you happen to
    know about them; a proposal here must be justifiable from this tenant's
    own spokes alone.
    CURRENT GLOBAL STANDARDS (universal_lessons.md): ${universalLessons}
    CURRENT GLOBAL NORTH STAR (north_star_framework.md): ${globalNorthStar}

    PER-SPOKE CONTEXT:
    ${perSpokeSection}

    TASK: Look for a genuine pattern that recurs across TWO OR MORE spokes
    above - not something specific to only one project - that the CURRENT
    GLOBAL STANDARDS or GLOBAL NORTH STAR don't already cover. Weigh a
    MAINTAINER FEEDBACK signal that recurs across multiple spokes as real
    evidence too - if several spokes show negative feedback on a similar
    kind of finding, that's a sign a check should be adjusted or suppressed,
    not just repeated. If you find one, propose it as the FULL, updated text
    of universal_lessons.md and/or north_star_framework.md (not a diff - the
    complete file content with your addition folded in). If nothing
    genuinely cross-cutting stands out, set "has_proposal" to false and
    leave both patch fields as empty strings - do not invent a pattern just
    to have something to propose.
    Respond with ONLY valid JSON, exactly this shape:
    {
      "has_proposal": boolean,
      "reasoning": string,
      "universal_lessons_patch": string,
      "north_star_patch": string
    }
  `;

  const aiResponse = await fetchImpl(`${process.env.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    })
  });

  const aiData = await aiResponse.json();
  const rawContent = aiData?.choices?.[0]?.message?.content;

  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return { tenantId, status: 'Skipped', reason: 'AI returned no content', dryRun };
  }

  let result;
  try {
    result = JSON.parse(rawContent);
  } catch (parseError) {
    return { tenantId, status: 'Skipped', reason: 'AI did not return valid JSON', raw: rawContent.slice(0, 500), dryRun };
  }

  if (result.has_proposal !== true) {
    return { tenantId, status: 'Skipped', reason: 'AI found no cross-spoke pattern worth proposing', dryRun };
  }

  const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
  const hasAnyPatch = isNonEmptyString(result.universal_lessons_patch) || isNonEmptyString(result.north_star_patch);
  const isValidShape = isNonEmptyString(result.reasoning) && hasAnyPatch;

  if (!isValidShape) {
    return { tenantId, status: 'Skipped', reason: 'AI response did not match the required shape', raw: rawContent.slice(0, 500), dryRun };
  }

  if (dryRun) {
    return { tenantId, status: 'DryRunProposal', dryRun: true, proposal: result };
  }

  // Live: propose via a PR against the hub itself, using hubOctokit (the
  // hub's own credential - a tenant's own token has no access to the hub
  // repo at all, by design) - never push directly to the default branch.
  // The PR body names which tenant's data prompted it, so the human
  // reviewing/merging can judge whether generalizing a customer-specific
  // pattern into the shared global standard is appropriate - this
  // disclosure is what keeps "propose via PR, human merges" an adequate
  // isolation safeguard instead of a silent cross-tenant leak.
  const defaultBranch = await getDefaultBranch(hubOctokit, HUB_OWNER, HUB_REPO);
  const { data: baseRef } = await hubOctokit.git.getRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `heads/${defaultBranch}` });
  const branchName = `recursive-learning-${tenantId}-${Date.now()}`;
  await hubOctokit.git.createRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `refs/heads/${branchName}`, sha: baseRef.object.sha });

  const filesToUpdate = [];
  if (isNonEmptyString(result.universal_lessons_patch)) {
    filesToUpdate.push({ path: 'universal_lessons.md', content: result.universal_lessons_patch });
  }
  if (isNonEmptyString(result.north_star_patch)) {
    filesToUpdate.push({ path: 'north_star_framework.md', content: result.north_star_patch });
  }

  for (const file of filesToUpdate) {
    let existingSha;
    try {
      const { data } = await hubOctokit.repos.getContent({ owner: HUB_OWNER, repo: HUB_REPO, path: file.path, ref: branchName });
      existingSha = data.sha;
    } catch (e) {
      existingSha = undefined;
    }
    const params = {
      owner: HUB_OWNER, repo: HUB_REPO, path: file.path, branch: branchName,
      message: `docs: recursive-learning proposal for ${file.path} (tenant ${tenantId})`,
      content: Buffer.from(file.content).toString('base64')
    };
    if (existingSha) params.sha = existingSha;
    await hubOctokit.repos.createOrUpdateFileContents(params);
  }

  const pr = await hubOctokit.pulls.create({
    owner: HUB_OWNER, repo: HUB_REPO,
    title: `Recursive Learning: proposed cross-spoke updates (tenant ${tenantId})`,
    head: branchName,
    base: defaultBranch,
    body: `### Reasoning\n${result.reasoning}\n\n---\nGenerated automatically by \`api/recursive_learning.js\` from patterns observed across ${tenantSpokes.length} spoke(s) belonging to **tenant \`${tenantId}\`** (\`${tenant?.name || tenantId}\`). This is a proposal, not a decision - review before merging, and consider whether generalizing a pattern from one customer's projects into the shared global standard is appropriate before doing so.`
  });

  return { tenantId, status: 'Success', dryRun: false, pullRequestUrl: pr.data.html_url };
}

// The actual logic, factored out of the Vercel handler the same way
// autonomous_agent.js's processRequest is, so it can be driven by a local
// mock harness instead of hitting GitHub/the AI API for real.
//
// `octokitFactory(token)` replaces a single injected `octokit` instance,
// mirroring api/autonomous_agent.js's own multi-tenancy redesign - each
// tenant's spokes get read with THEIR OWN credential (decision #1), not one
// shared token. `hubOctokit` is a separate, already-constructed client
// scoped to the hub's own repo/token, used for reading spokes.json/
// tenants.json and for the PR/branch operations against the hub itself.
export async function runRecursiveLearning(reqBody, { octokitFactory, hubOctokit, fetchImpl = fetch, dryRunOverride, hubOwner, hubRepo, spokesOverride, tenantsOverride } = {}) {
  const HUB_OWNER = hubOwner || process.env.HUB_GITHUB_OWNER || DEFAULT_HUB_OWNER;
  const HUB_REPO = hubRepo || process.env.HUB_GITHUB_REPO || DEFAULT_HUB_REPO;

  // Same safety rail as autonomous_agent.js, and the same env var - a
  // proposal is a lower-stakes action than filing an issue (it's a PR
  // someone has to review and merge, not something posted unattended), but
  // this still shouldn't go live before Sprint 0's rail has been verified.
  const dryRun = dryRunOverride !== undefined
    ? dryRunOverride
    : process.env.DRY_RUN_MODE !== 'false';

  const spokes = spokesOverride || safeParseJsonArray(await safeGetTextContent(hubOctokit, HUB_OWNER, HUB_REPO, SPOKES_REGISTRY_PATH));

  if (spokes.length === 0) {
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No spokes registered in spokes.json', dryRun } };
  }

  const tenants = tenantsOverride || safeParseJsonArray(await safeGetTextContent(hubOctokit, HUB_OWNER, HUB_REPO, TENANTS_REGISTRY_PATH));
  const byTenant = groupSpokesByTenant(spokes);

  const universalLessonsPath = join(process.cwd(), 'universal_lessons.md');
  const globalNorthStarPath = join(process.cwd(), 'north_star_framework.md');
  const universalLessons = existsSync(universalLessonsPath) ? readFileSync(universalLessonsPath, 'utf8') : "";
  const globalNorthStar = existsSync(globalNorthStarPath) ? readFileSync(globalNorthStarPath, 'utf8') : "";

  // One independent run per tenant - never pooled. See runForTenant's own
  // comment on why the prompt itself also says this explicitly.
  const results = [];
  for (const [tenantId, tenantSpokes] of Object.entries(byTenant)) {
    const tenant = findTenant(tenantId, tenants);
    results.push(await runForTenant({
      tenantId, tenantSpokes, tenant, octokitFactory, hubOctokit, fetchImpl, dryRun,
      universalLessons, globalNorthStar, HUB_OWNER, HUB_REPO
    }));
  }

  return { httpStatus: 200, body: { status: 'Completed', dryRun, tenantCount: results.length, results } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const octokitFactory = (token) => new Octokit({ auth: token });
  const hubOctokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  try {
    const { httpStatus, body } = await runRecursiveLearning(req.body, { octokitFactory, hubOctokit, fetchImpl: fetch });
    return res.status(httpStatus).json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
