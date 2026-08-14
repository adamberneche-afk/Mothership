// Apps Script port of api/recursive_learning.js. Same platform differences
// as gas/autonomous_agent.js apply here - see that file's header comment
// for the full rationale, including the multi-tenancy data model (this
// file already fetched its own global-context files, and now spokes.json/
// tenants.json too, via `hubGithub` instead of local disk - the per-spoke
// context always was fetched this way).

const RECENT_DECISIONS_PER_SPOKE = 10;

// DEFAULT_HUB_OWNER/DEFAULT_HUB_REPO/SPOKES_REGISTRY_PATH/
// TENANTS_REGISTRY_PATH/DEFAULT_TENANT_ID all live in constants.js, shared
// with autonomous_agent.js - see that file's comment for why.

function safeGetTextContent(github, base64Decode, owner, repo, path) {
  try {
    const { data } = github.repos.getContent({ owner, repo, path });
    return base64Decode(data.content);
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

function getDefaultBranch(github, owner, repo) {
  try {
    const { data } = github.repos.get({ owner, repo });
    return data.default_branch || 'main';
  } catch (e) {
    return 'main';
  }
}

// --- Multi-tenancy: same data model/resolution as gas/autonomous_agent.js
// (see that file's header comment) - ported here so the Recursive Learning
// Loop never pools two tenants' spoke data into one cross-spoke prompt.

function groupSpokesByTenantRL(spokes) {
  const byTenant = {};
  for (const spoke of spokes) {
    if (!spoke || !spoke.owner || !spoke.repo) continue;
    const tenantId = spoke.tenantId || DEFAULT_TENANT_ID;
    (byTenant[tenantId] = byTenant[tenantId] || []).push(spoke);
  }
  return byTenant;
}

function findTenantRL(tenantId, tenants) {
  return tenants.find(t => t && t.tenantId === tenantId) || null;
}

// Same env:/kv: scheme as gas/autonomous_agent.js's resolveSecretRef.
// TODO: wire the kv: branch to a real secrets store - see that file's
// identical TODO.
function resolveSecretRefRL(ref, scriptProperties) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('env:')) return scriptProperties.getProperty(ref.slice(4)) || null;
  if (ref.startsWith('kv:')) return null;
  return null;
}

// Builds and runs one tenant's independent cross-spoke proposal - see
// api/recursive_learning.js's runForTenant for the full rationale; this is
// a direct, synchronous port (no Promises, matching UrlFetchApp).
function runForTenantRL({ tenantId, tenantSpokes, tenant, githubFactory, hubGithub, aiFetch, base64Encode, base64Decode, config, dryRun, universalLessons, globalNorthStar, HUB_OWNER, HUB_REPO }) {
  const spokeToken = (tenant && resolveSecretRefRL(tenant.githubCredentialRef, config.scriptProperties)) || config.globalGithubToken;
  const github = githubFactory(spokeToken);

  const perSpokeContext = [];
  for (const spoke of tenantSpokes) {
    const lessons = safeGetTextContent(github, base64Decode, spoke.owner, spoke.repo, 'lessons.md');
    const decisionLogText = safeGetTextContent(github, base64Decode, spoke.owner, spoke.repo, 'ai_decision_log.json');
    const recentDecisions = safeParseJsonArray(decisionLogText).slice(-RECENT_DECISIONS_PER_SPOKE);
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

  const aiResponse = aiFetch(`${config.aiBaseUrl}/chat/completions`, {
    method: 'post',
    headers: { Authorization: `Bearer ${config.aiApiKey}`, 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      model: config.aiModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    })
  });

  let aiData;
  try {
    aiData = JSON.parse(aiResponse.getContentText());
  } catch (e) {
    aiData = null;
  }
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

  // Live: propose via a PR against the hub itself, using hubGithub (the
  // hub's own credential) - never push directly to the default branch. The
  // PR body names which tenant's data prompted it - see
  // api/recursive_learning.js's identical comment for why that disclosure
  // matters.
  const defaultBranch = getDefaultBranch(hubGithub, HUB_OWNER, HUB_REPO);
  const { data: baseRef } = hubGithub.git.getRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `heads/${defaultBranch}` });
  const branchName = `recursive-learning-${tenantId}-${Date.now()}`;
  hubGithub.git.createRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `refs/heads/${branchName}`, sha: baseRef.object.sha });

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
      const { data } = hubGithub.repos.getContent({ owner: HUB_OWNER, repo: HUB_REPO, path: file.path, ref: branchName });
      existingSha = data.sha;
    } catch (e) {
      existingSha = undefined;
    }
    const params = {
      owner: HUB_OWNER, repo: HUB_REPO, path: file.path, branch: branchName,
      message: `docs: recursive-learning proposal for ${file.path} (tenant ${tenantId})`,
      content: base64Encode(file.content)
    };
    if (existingSha) params.sha = existingSha;
    hubGithub.repos.createOrUpdateFileContents(params);
  }

  const pr = hubGithub.pulls.create({
    owner: HUB_OWNER, repo: HUB_REPO,
    title: `Recursive Learning: proposed cross-spoke updates (tenant ${tenantId})`,
    head: branchName,
    base: defaultBranch,
    body: `### Reasoning\n${result.reasoning}\n\n---\nGenerated automatically by \`gas/recursive_learning.js\` from patterns observed across ${tenantSpokes.length} spoke(s) belonging to **tenant \`${tenantId}\`** (\`${(tenant && tenant.name) || tenantId}\`). This is a proposal, not a decision - review before merging, and consider whether generalizing a pattern from one customer's projects into the shared global standard is appropriate before doing so.`
  });

  return { tenantId, status: 'Success', dryRun: false, pullRequestUrl: pr.data.html_url };
}

// The actual logic, factored out of the Apps Script entry point (Code.js)
// so it can be driven by a local mock harness instead of hitting GitHub/the
// AI API for real.
//
// Plain global function, not an ES module export - see gas/github.js's
// header comment for why. `githubFactory(token)` replaces a single
// injected `github` client - see gas/autonomous_agent.js's identical
// header comment for the full rationale.
function runRecursiveLearning(reqBody, {
  githubFactory,
  hubGithub,
  aiFetch,
  base64Encode,
  base64Decode,
  config = {},
  dryRunOverride,
  hubOwner,
  hubRepo,
  spokesOverride,
  tenantsOverride
} = {}) {
  const HUB_OWNER = hubOwner || config.hubOwner || DEFAULT_HUB_OWNER;
  const HUB_REPO = hubRepo || config.hubRepo || DEFAULT_HUB_REPO;

  const dryRun = dryRunOverride !== undefined
    ? dryRunOverride
    : config.dryRunMode !== 'false';

  const spokes = spokesOverride || safeParseJsonArray(safeGetTextContent(hubGithub, base64Decode, HUB_OWNER, HUB_REPO, SPOKES_REGISTRY_PATH));

  if (spokes.length === 0) {
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No spokes registered in spokes.json', dryRun } };
  }

  const tenants = tenantsOverride || safeParseJsonArray(safeGetTextContent(hubGithub, base64Decode, HUB_OWNER, HUB_REPO, TENANTS_REGISTRY_PATH));
  const byTenant = groupSpokesByTenantRL(spokes);

  const universalLessons = safeGetTextContent(hubGithub, base64Decode, HUB_OWNER, HUB_REPO, 'universal_lessons.md') || '';
  const globalNorthStar = safeGetTextContent(hubGithub, base64Decode, HUB_OWNER, HUB_REPO, 'north_star_framework.md') || '';

  // One independent run per tenant - never pooled. See runForTenantRL's
  // own comment on why the prompt itself also says this explicitly.
  const results = [];
  for (const tenantId in byTenant) {
    if (!Object.prototype.hasOwnProperty.call(byTenant, tenantId)) continue;
    const tenant = findTenantRL(tenantId, tenants);
    results.push(runForTenantRL({
      tenantId, tenantSpokes: byTenant[tenantId], tenant, githubFactory, hubGithub, aiFetch, base64Encode, base64Decode, config, dryRun,
      universalLessons, globalNorthStar, HUB_OWNER, HUB_REPO
    }));
  }

  return { httpStatus: 200, body: { status: 'Completed', dryRun, tenantCount: results.length, results } };
}
