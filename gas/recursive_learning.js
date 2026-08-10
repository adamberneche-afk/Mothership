// Apps Script port of api/recursive_learning.js. Same platform differences
// as gas/autonomous_agent.js apply here - see that file's header comment
// for the full rationale. This file already fetched its own global-context
// files (universal_lessons.md/north_star_framework.md) from local disk in
// the Vercel version; here they're fetched via `github` instead, the same
// way the per-spoke context always was.

const SPOKES_REGISTRY_PATH = 'spokes.json';
const RECENT_DECISIONS_PER_SPOKE = 10;

// DEFAULT_HUB_OWNER/DEFAULT_HUB_REPO live in constants.js, shared with
// autonomous_agent.js - see that file's comment for why.

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

// The actual logic, factored out of the Apps Script entry point (Code.js)
// so it can be driven by a local mock harness instead of hitting GitHub/the
// AI API for real.
//
// Plain global function, not an ES module export - see gas/github.js's
// header comment for why.
function runRecursiveLearning(reqBody, {
  github,
  aiFetch,
  base64Encode,
  base64Decode,
  config = {},
  dryRunOverride,
  hubOwner,
  hubRepo
} = {}) {
  const HUB_OWNER = hubOwner || config.hubOwner || DEFAULT_HUB_OWNER;
  const HUB_REPO = hubRepo || config.hubRepo || DEFAULT_HUB_REPO;

  const dryRun = dryRunOverride !== undefined
    ? dryRunOverride
    : config.dryRunMode !== 'false';

  let spokes = safeParseJsonArray(safeGetTextContent(github, base64Decode, HUB_OWNER, HUB_REPO, SPOKES_REGISTRY_PATH));

  if (spokes.length === 0) {
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No spokes registered in spokes.json', dryRun } };
  }

  const universalLessons = safeGetTextContent(github, base64Decode, HUB_OWNER, HUB_REPO, 'universal_lessons.md') || '';
  const globalNorthStar = safeGetTextContent(github, base64Decode, HUB_OWNER, HUB_REPO, 'north_star_framework.md') || '';

  const perSpokeContext = [];
  for (const spoke of spokes) {
    const lessons = safeGetTextContent(github, base64Decode, spoke.owner, spoke.repo, 'lessons.md');
    const decisionLogText = safeGetTextContent(github, base64Decode, spoke.owner, spoke.repo, 'ai_decision_log.json');
    const recentDecisions = safeParseJsonArray(decisionLogText).slice(-RECENT_DECISIONS_PER_SPOKE);
    perSpokeContext.push({
      owner: spoke.owner,
      repo: spoke.repo,
      lessons: lessons || 'No lessons.md found.',
      recentDecisions
    });
  }

  const perSpokeSection = perSpokeContext.map(s => `
    --- ${s.owner}/${s.repo} ---
    LESSONS: ${s.lessons}
    RECENT HUB DECISIONS: ${JSON.stringify(s.recentDecisions)}
  `).join('\n');

  const prompt = `
    ROLE: Senior AI CTO performing a cross-project retrospective across every
    connected spoke.
    CURRENT GLOBAL STANDARDS (universal_lessons.md): ${universalLessons}
    CURRENT GLOBAL NORTH STAR (north_star_framework.md): ${globalNorthStar}

    PER-SPOKE CONTEXT:
    ${perSpokeSection}

    TASK: Look for a genuine pattern that recurs across TWO OR MORE spokes
    above - not something specific to only one project - that the CURRENT
    GLOBAL STANDARDS or GLOBAL NORTH STAR don't already cover. If you find
    one, propose it as the FULL, updated text of universal_lessons.md and/or
    north_star_framework.md (not a diff - the complete file content with
    your addition folded in). If nothing genuinely cross-cutting stands out,
    set "has_proposal" to false and leave both patch fields as empty strings -
    do not invent a pattern just to have something to propose.
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
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'AI returned no content', dryRun } };
  }

  let result;
  try {
    result = JSON.parse(rawContent);
  } catch (parseError) {
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: 'AI did not return valid JSON', raw: rawContent.slice(0, 500), dryRun }
    };
  }

  if (result.has_proposal !== true) {
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'AI found no cross-spoke pattern worth proposing', dryRun } };
  }

  const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
  const hasAnyPatch = isNonEmptyString(result.universal_lessons_patch) || isNonEmptyString(result.north_star_patch);
  const isValidShape = isNonEmptyString(result.reasoning) && hasAnyPatch;

  if (!isValidShape) {
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: 'AI response did not match the required shape', raw: rawContent.slice(0, 500), dryRun }
    };
  }

  if (dryRun) {
    return { httpStatus: 200, body: { status: 'DryRunProposal', dryRun: true, proposal: result } };
  }

  // Live: propose via a PR against the hub itself - never push directly to
  // the default branch.
  const defaultBranch = getDefaultBranch(github, HUB_OWNER, HUB_REPO);
  const { data: baseRef } = github.git.getRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `heads/${defaultBranch}` });
  const branchName = `recursive-learning-${Date.now()}`;
  github.git.createRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `refs/heads/${branchName}`, sha: baseRef.object.sha });

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
      const { data } = github.repos.getContent({ owner: HUB_OWNER, repo: HUB_REPO, path: file.path, ref: branchName });
      existingSha = data.sha;
    } catch (e) {
      existingSha = undefined;
    }
    const params = {
      owner: HUB_OWNER, repo: HUB_REPO, path: file.path, branch: branchName,
      message: `docs: recursive-learning proposal for ${file.path}`,
      content: base64Encode(file.content)
    };
    if (existingSha) params.sha = existingSha;
    github.repos.createOrUpdateFileContents(params);
  }

  const pr = github.pulls.create({
    owner: HUB_OWNER, repo: HUB_REPO,
    title: 'Recursive Learning: proposed cross-spoke updates',
    head: branchName,
    base: defaultBranch,
    body: `### Reasoning\n${result.reasoning}\n\n---\nGenerated automatically by \`gas/recursive_learning.js\` from patterns observed across ${spokes.length} spoke(s). This is a proposal, not a decision - review before merging.`
  });

  return { httpStatus: 200, body: { status: 'Success', dryRun: false, pullRequestUrl: pr.data.html_url } };
}
