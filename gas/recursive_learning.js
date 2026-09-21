// Apps Script port of api/recursive_learning.js. Same platform differences
// as gas/autonomous_agent.js apply here - see that file's header comment
// for the full rationale, including the multi-tenancy data model (this
// file already fetched its own global-context files, and now spokes.json/
// tenants.json too, via `hubGithub` instead of local disk - the per-spoke
// context always was fetched this way).
//
// Same async split as gas/autonomous_agent.js, and for the identical
// reason - see review_queue.js's header comment for the full mechanics.
// runRecursiveLearning() below gathers context and enqueues one
// LearningQueue row per tenant (plus one for the shared pool, when it has
// enough opted-in spokes to clear its own evidence bar) instead of calling
// an AI endpoint inline; finalizeLearningResult_() is the rest of the
// original logic (validation, dry-run, PR opening), run by
// harvestLearningResults() once a human-built Workspace Flow has answered.

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

// --- Shared, opt-in, cross-organization learning pool -----------------------
// Direct port of api/recursive_learning.js's identical section - see that
// file's header comment for the full rationale (repo-scoped opt-in,
// anonymized "Contributor N" labels, and the anti-hallucination gate that
// verifies the model's cited evidence in code rather than trusting
// "has_proposal: true" on its own).
const MIN_DISTINCT_TENANTS_CROSS_ORG_RL = 2;
const MIN_DISTINCT_REPOS_SAME_TENANT_RL = 3;

function selectSharedPoolSpokesRL(spokes) {
  return spokes.filter(s => s && s.owner && s.repo && s.shareLearnings === true);
}

function poolCouldSatisfyEvidenceBarRL(sharedPoolSpokes) {
  const distinctTenants = new Set(sharedPoolSpokes.map(s => s.tenantId || DEFAULT_TENANT_ID));
  if (distinctTenants.size >= MIN_DISTINCT_TENANTS_CROSS_ORG_RL) return true;
  return sharedPoolSpokes.length >= MIN_DISTINCT_REPOS_SAME_TENANT_RL;
}

function citedEvidenceMeetsBarRL(citedLabels, labelToSpoke) {
  const citedSpokes = citedLabels.map(label => labelToSpoke[label]).filter(Boolean);
  const distinctRepoKeys = new Set(citedSpokes.map(s => `${s.owner}/${s.repo}`));
  const distinctTenantIds = new Set(citedSpokes.map(s => s.tenantId));
  if (distinctTenantIds.size >= MIN_DISTINCT_TENANTS_CROSS_ORG_RL) return true;
  if (distinctRepoKeys.size >= MIN_DISTINCT_REPOS_SAME_TENANT_RL) return true;
  return false;
}

// --- Prompt building (enqueue-time context gathering) -----------------------
// Both builders below do exactly the per-spoke lessons/decision-log/
// feedback gathering the original inline runForTenantRL/runForSharedPoolRL
// did before their own aiFetch call - unchanged. What's new is that they
// return the prompt (and, for the shared pool, the label mapping) instead
// of calling an AI endpoint with it.

function buildTenantLearningPrompt_({ tenantId, tenantSpokes, github, base64Decode, universalLessons, globalNorthStar }) {
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
      owner: spoke.owner, repo: spoke.repo,
      lessons: lessons || 'No lessons.md found.', recentDecisions, feedbackSummary
    });
  }

  const perSpokeSection = perSpokeContext.map(s => `
    --- ${s.owner}/${s.repo} ---
    LESSONS: ${s.lessons}
    RECENT HUB DECISIONS: ${JSON.stringify(s.recentDecisions)}
    MAINTAINER FEEDBACK: ${s.feedbackSummary}
  `).join('\n');

  return `
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
}

function buildSharedPoolLearningPrompt_({ sharedPoolSpokes, tenants, githubFactory, base64Decode, config, universalLessons, globalNorthStar }) {
  const labelToSpoke = {};
  const perSpokeContext = [];
  for (let i = 0; i < sharedPoolSpokes.length; i++) {
    const spoke = sharedPoolSpokes[i];
    const label = `Contributor ${i + 1}`;
    const tenantId = spoke.tenantId || DEFAULT_TENANT_ID;
    const tenant = findTenantRL(tenantId, tenants);
    // Same rules/rationale as api/recursive_learning.js's identical fix: a
    // matched tenant whose credential ref fails to resolve is excluded
    // from this round of the shared pool (never a silent fallback to a
    // broader credential) - `continue`, not a hard return, so one
    // misconfigured contributor doesn't abort the whole cross-org pass.
    let spokeToken;
    if (tenant) {
      spokeToken = resolveSecretRefRL(tenant.githubCredentialRef, config.scriptProperties);
      if (!spokeToken) continue;
    } else {
      spokeToken = config.globalGithubToken;
    }
    const github = githubFactory(spokeToken);

    labelToSpoke[label] = { owner: spoke.owner, repo: spoke.repo, tenantId };

    const lessons = safeGetTextContent(github, base64Decode, spoke.owner, spoke.repo, 'lessons.md');
    const decisionLogText = safeGetTextContent(github, base64Decode, spoke.owner, spoke.repo, 'ai_decision_log.json');
    const recentDecisions = safeParseJsonArray(decisionLogText).slice(-RECENT_DECISIONS_PER_SPOKE);
    const negativeFeedbackCount = recentDecisions.filter((d) => d && d.feedback && d.feedback.thumbsDown > 0).length;
    const feedbackSummary = negativeFeedbackCount > 0
      ? `${negativeFeedbackCount} of the last ${recentDecisions.length} decisions received negative maintainer feedback (a real thumbs-down reaction on the filed issue).`
      : 'none of the last decisions received negative maintainer feedback.';

    perSpokeContext.push({ label, lessons: lessons || 'No lessons.md found.', recentDecisions, feedbackSummary });
  }

  const perSpokeSection = perSpokeContext.map(s => `
    --- ${s.label} ---
    LESSONS: ${s.lessons}
    RECENT HUB DECISIONS: ${JSON.stringify(s.recentDecisions)}
    MAINTAINER FEEDBACK: ${s.feedbackSummary}
  `).join('\n');

  const prompt = `
    ROLE: Senior AI CTO performing a cross-ORGANIZATION retrospective across
    every repo that has opted into a shared learning pool. These
    contributors belong to DIFFERENT organizations/customers - you are only
    given anonymized labels ("Contributor N"), never real names, precisely
    so nothing organization-identifying ends up in a shared standard.
    CURRENT GLOBAL STANDARDS (universal_lessons.md): ${universalLessons}
    CURRENT GLOBAL NORTH STAR (north_star_framework.md): ${globalNorthStar}

    PER-CONTRIBUTOR CONTEXT:
    ${perSpokeSection}

    TASK: Look for a genuine pattern that recurs across MULTIPLE DISTINCT
    contributors above - not something specific to only one - that the
    CURRENT GLOBAL STANDARDS or GLOBAL NORTH STAR don't already cover. You
    MUST list every contributor label your proposal is actually evidenced
    by in "supporting_contributors" - a proposal with no real, cited
    supporting evidence will be rejected regardless of what you say in
    "has_proposal". Never phrase the proposed lesson text in terms of a
    specific contributor or organization - describe only the underlying,
    general engineering principle. If you find one, propose it as the
    FULL, updated text of universal_lessons.md and/or north_star_framework.md
    (not a diff - the complete file content with your addition folded in).
    If nothing genuinely cross-cutting stands out, set "has_proposal" to
    false, leave both patch fields as empty strings, and leave
    "supporting_contributors" as an empty array - do not invent a pattern
    just to have something to propose.
    Respond with ONLY valid JSON, exactly this shape:
    {
      "has_proposal": boolean,
      "reasoning": string,
      "supporting_contributors": string[],
      "universal_lessons_patch": string,
      "north_star_patch": string
    }
  `;

  return { prompt, labelToSpoke };
}

// --- Finalization (harvest-time validation + PR opening) --------------------
// Both functions below do exactly the validation/dry-run/PR-opening logic
// the original inline runForTenantRL/runForSharedPoolRL did after their own
// aiFetch call - unchanged. What's new is that they take the harvested
// GeminiFullOutput text as input instead of calling an AI endpoint for it,
// and (for the tenant case) re-derive tenant/tenantSpokes fresh from
// spokes.json/tenants.json rather than trusting anything persisted at
// enqueue time - same "current config wins" reasoning as
// autonomous_agent.js's resolveTenantAndGithub_. The shared-pool case is
// the one exception: its Contributor-N-to-real-spoke label mapping is
// load-bearing for both the evidence-bar check and the PR body, and would
// silently mean something different if re-derived after spokes.json's
// opt-in list changed - so that mapping is passed in from the queue row's
// own persisted ContextJson instead (see review_queue.js's LQ schema).

function finalizeTenantLearning_({ tenantId, rawContent }, { githubFactory, hubGithub, base64Encode, base64Decode, config, dryRunOverride, spokesOverride, tenantsOverride, hubOwner, hubRepo }) {
  const HUB_OWNER = hubOwner || config.hubOwner || DEFAULT_HUB_OWNER;
  const HUB_REPO = hubRepo || config.hubRepo || DEFAULT_HUB_REPO;
  const dryRun = dryRunOverride !== undefined ? dryRunOverride : config.dryRunMode !== 'false';

  const spokes = spokesOverride || safeParseJsonArray(safeGetTextContent(hubGithub, base64Decode, HUB_OWNER, HUB_REPO, SPOKES_REGISTRY_PATH));
  const tenants = tenantsOverride || safeParseJsonArray(safeGetTextContent(hubGithub, base64Decode, HUB_OWNER, HUB_REPO, TENANTS_REGISTRY_PATH));
  const tenantSpokes = groupSpokesByTenantRL(spokes)[tenantId] || [];
  const tenant = findTenantRL(tenantId, tenants);

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

function finalizeSharedPoolLearning_({ rawContent, labelToSpoke }, { hubGithub, base64Encode, config, dryRunOverride, hubOwner, hubRepo }) {
  const HUB_OWNER = hubOwner || config.hubOwner || DEFAULT_HUB_OWNER;
  const HUB_REPO = hubRepo || config.hubRepo || DEFAULT_HUB_REPO;
  const dryRun = dryRunOverride !== undefined ? dryRunOverride : config.dryRunMode !== 'false';

  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return { pool: 'shared', status: 'Skipped', reason: 'AI returned no content', dryRun };
  }

  let result;
  try {
    result = JSON.parse(rawContent);
  } catch (parseError) {
    return { pool: 'shared', status: 'Skipped', reason: 'AI did not return valid JSON', raw: rawContent.slice(0, 500), dryRun };
  }

  if (result.has_proposal !== true) {
    return { pool: 'shared', status: 'Skipped', reason: 'AI found no cross-organization pattern worth proposing', dryRun };
  }

  const isNonEmptyStringSP = (v) => typeof v === 'string' && v.trim().length > 0;
  const hasAnyPatch = isNonEmptyStringSP(result.universal_lessons_patch) || isNonEmptyStringSP(result.north_star_patch);
  const citedLabels = Array.isArray(result.supporting_contributors) ? result.supporting_contributors : [];
  const isValidShape = isNonEmptyStringSP(result.reasoning) && hasAnyPatch && citedLabels.length > 0;

  if (!isValidShape) {
    return { pool: 'shared', status: 'Skipped', reason: 'AI response did not match the required shape', raw: rawContent.slice(0, 500), dryRun };
  }

  if (!citedEvidenceMeetsBarRL(citedLabels, labelToSpoke)) {
    return { pool: 'shared', status: 'Skipped', reason: 'Cited evidence does not meet the cross-organization bar (needs 2+ distinct tenants, or 3+ distinct repos within one tenant)', dryRun };
  }

  const supportingSpokes = citedLabels.map(label => labelToSpoke[label]).filter(Boolean);

  if (dryRun) {
    return { pool: 'shared', status: 'DryRunProposal', dryRun: true, proposal: result, supportingSpokes };
  }

  const defaultBranch = getDefaultBranch(hubGithub, HUB_OWNER, HUB_REPO);
  const { data: baseRef } = hubGithub.git.getRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `heads/${defaultBranch}` });
  const branchName = `recursive-learning-shared-pool-${Date.now()}`;
  hubGithub.git.createRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `refs/heads/${branchName}`, sha: baseRef.object.sha });

  const filesToUpdate = [];
  if (isNonEmptyStringSP(result.universal_lessons_patch)) {
    filesToUpdate.push({ path: 'universal_lessons.md', content: result.universal_lessons_patch });
  }
  if (isNonEmptyStringSP(result.north_star_patch)) {
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
      message: `docs: recursive-learning proposal for ${file.path} (shared cross-organization pool)`,
      content: base64Encode(file.content)
    };
    if (existingSha) params.sha = existingSha;
    hubGithub.repos.createOrUpdateFileContents(params);
  }

  const supportingList = supportingSpokes.map(s => `\`${s.owner}/${s.repo}\` (tenant \`${s.tenantId}\`)`).join(', ');
  const pr = hubGithub.pulls.create({
    owner: HUB_OWNER, repo: HUB_REPO,
    title: `Recursive Learning: proposed cross-organization pattern (shared pool)`,
    head: branchName,
    base: defaultBranch,
    body: `### Reasoning\n${result.reasoning}\n\n### Supporting repos\n${supportingList}\n\n---\nGenerated automatically by \`gas/recursive_learning.js\` from a pattern the model reported recurring across the repos above - all opted into the shared learning pool (\`shareLearnings: true\`) and spanning ${new Set(supportingSpokes.map(s => s.tenantId)).size} distinct tenant(s). This is a proposal, not a decision - review before merging, and consider whether this generalization is fair to every contributing organization.`
  });

  return { pool: 'shared', status: 'Success', dryRun: false, pullRequestUrl: pr.data.html_url, supportingSpokes };
}

// finalizeLearningResult_ - dispatches a harvested LearningQueue row to the
// right finalizer by Kind. Called by harvestLearningResults() (review_queue.js).
function finalizeLearningResult_({ kind, tenantId, rawContent, contextJson }, deps) {
  if (kind === 'shared_pool') {
    const labelToSpoke = contextJson ? JSON.parse(contextJson) : {};
    return finalizeSharedPoolLearning_({ rawContent, labelToSpoke }, deps);
  }
  return finalizeTenantLearning_({ tenantId, rawContent }, deps);
}

// The actual logic, factored out of the Apps Script entry point (Code.js)
// so it can be driven by a local mock harness instead of hitting GitHub for
// real.
//
// Plain global function, not an ES module export - see gas/github.js's
// header comment for why. `githubFactory(token)` replaces a single
// injected `github` client - see gas/autonomous_agent.js's identical
// header comment for the full rationale.
function runRecursiveLearning(reqBody, {
  githubFactory,
  hubGithub,
  base64Encode,
  base64Decode,
  config = {},
  dryRunOverride,
  hubOwner,
  hubRepo,
  spokesOverride,
  tenantsOverride,
  learningQueueSheet
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

  // No direct AI call here (see review_queue.js's header comment for why).
  // Build each prompt exactly as before, then queue it for a human-built
  // Workspace Studio Flow's own native inference step to answer -
  // finalizeLearningResult_() (called by harvestLearningResults()) does the
  // rest once a real answer exists.
  const sheet = learningQueueSheet || (() => {
    const ss = openQueueSpreadsheet_(config);
    return ss ? ensureQueueTab_(ss, QUEUE_TAB_LEARNING, LQ_HEADERS) : null;
  })();

  if (!sheet) {
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No queue spreadsheet available (QUEUE_SHEET_ID unset and no scriptProperties to auto-create/persist one into, or the create-lock was briefly contended) - nothing to queue this run into', dryRun } };
  }

  // One independent run per tenant - never pooled. See
  // buildTenantLearningPrompt_'s own prompt text on why the prompt itself
  // also says this explicitly.
  const results = [];
  for (const tenantId in byTenant) {
    if (!Object.prototype.hasOwnProperty.call(byTenant, tenantId)) continue;
    const tenantSpokes = byTenant[tenantId];
    const tenant = findTenantRL(tenantId, tenants);

    // Same rules/rationale as gas/autonomous_agent.js's identical fix: a
    // tenant with no githubCredentialRef configured at all falls back to
    // config.globalGithubToken; a tenant that DID configure one but whose
    // ref fails to resolve is a hard skip instead, never a silent fallback
    // to that broader token for reading this tenant's own repos.
    let spokeToken;
    if (tenant && tenant.githubCredentialRef) {
      spokeToken = resolveSecretRefRL(tenant.githubCredentialRef, config.scriptProperties);
      if (!spokeToken) {
        results.push({ tenantId, status: 'Skipped', reason: `Could not resolve GitHub credential for tenant '${tenantId}'`, dryRun });
        continue;
      }
    } else {
      spokeToken = config.globalGithubToken;
    }
    const github = githubFactory(spokeToken);

    const promptText = buildTenantLearningPrompt_({ tenantId, tenantSpokes, github, base64Decode, universalLessons, globalNorthStar });
    enqueueLearningRow_(sheet, { kind: 'tenant', tenantId, promptText });
    results.push({ tenantId, status: 'Queued', reason: 'Queued for native Workspace inference; harvestLearningResults() opens the proposal PR once a Flow has answered', dryRun });
  }

  // Additional, separate pass: repos that opted in (spoke.shareLearnings)
  // get pooled together regardless of which tenant owns them - see
  // buildSharedPoolLearningPrompt_'s header comment for the anonymization/
  // anti-hallucination safeguards. Not a tenant, so it isn't forced into
  // the `results` array shape above. These two skip conditions stay
  // synchronous, exactly like autonomous_agent.js's no_diff_skip - no
  // reason to queue a row that would be skipped before ever reaching a
  // Flow anyway.
  const sharedPoolSpokes = selectSharedPoolSpokesRL(spokes);
  let sharedPoolResult;
  if (sharedPoolSpokes.length === 0) {
    sharedPoolResult = { pool: 'shared', status: 'Skipped', reason: 'No spokes opted into the shared learning pool', dryRun };
  } else if (!poolCouldSatisfyEvidenceBarRL(sharedPoolSpokes)) {
    sharedPoolResult = { pool: 'shared', status: 'Skipped', reason: 'Not enough opted-in spokes yet to meet the cross-organization evidence bar', dryRun };
  } else {
    const { prompt: sharedPromptText, labelToSpoke } = buildSharedPoolLearningPrompt_({
      sharedPoolSpokes, tenants, githubFactory, base64Decode, config, universalLessons, globalNorthStar
    });
    enqueueLearningRow_(sheet, { kind: 'shared_pool', tenantId: 'shared_pool', promptText: sharedPromptText, contextJson: JSON.stringify(labelToSpoke) });
    sharedPoolResult = { pool: 'shared', status: 'Queued', reason: 'Queued for native Workspace inference; harvestLearningResults() opens the proposal PR once a Flow has answered', dryRun };
  }

  return { httpStatus: 200, body: { status: 'Completed', dryRun, tenantCount: results.length, results, sharedPoolResult } };
}
