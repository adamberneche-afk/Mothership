// Apps Script port of api/autonomous_agent.js. Same decision logic, ported
// to run on a platform with no npm, no Node `fetch`, no filesystem, and no
// async I/O for UrlFetchApp (it blocks synchronously) - see the three
// platform differences called out inline below. Everything else is
// unchanged: same validation discipline, same dry-run/rate-cap rails, same
// decision-log dedup and memory.
//
// Platform differences from api/autonomous_agent.js:
//   1. No @octokit/rest - `github` (see github.js) replaces `octokit` with
//      the same method shapes, built on a raw REST client instead of a
//      library.
//   2. No Node `fetch`/Promises - everything here is a plain synchronous
//      function, matching UrlFetchApp.fetch's real (blocking) execution
//      model. `aiFetch(url, options)` returns the same
//      { getResponseCode(), getContentText() } shape `github`'s calls do,
//      rather than a Fetch Response with an async `.json()`.
//   3. No local filesystem - a Vercel deployment bundles this repo's own
//      universal_lessons.md/north_star_framework.md/hub_lessons.md
//      alongside the function; an Apps Script project only contains script
//      files. Those three files are fetched from the hub repo itself via
//      `github.repos.getContent`, the same way this file already fetched a
//      spoke's lessons.md/NORTH_STAR.md - always the current committed
//      content, no redeploy needed to pick up an edit (an improvement, not
//      just a workaround).

const MAX_DIFF_CHARS = 12000;
const HUB_ISSUE_LABEL = 'cto-hub-auto';
const DECISION_LOG_PATH = 'ai_decision_log.json';
const DECISION_LOG_MAX_ENTRIES = 500;
const PRIOR_DECISIONS_CONTEXT_COUNT = 5;

// DEFAULT_HUB_OWNER/DEFAULT_HUB_REPO live in constants.js, shared with
// recursive_learning.js - Apps Script has one global scope per project, so
// declaring the same const in two files here would be a real SyntaxError,
// not just an unused duplicate.

const MODE_INSTRUCTIONS = {
  debug: 'Review the RECENT CODE CHANGES below for bugs, unsafe patterns, and code quality issues actually present in this diff. Only report something you can point to directly in the diff text.',
  hunt: "Review the RECENT CODE CHANGES below for silent logic errors - places where the code runs without crashing but produces a wrong result. You cannot execute code or run tests; base findings only on what's visible in the diff text.",
  refactor: 'Review the RECENT CODE CHANGES below for opportunities to simplify complex logic, remove redundancy, or improve maintainability. Only report something you can point to directly in the diff text.'
};

function countHubIssuesCreatedTodayUTC(github, owner, repo) {
  const { data } = github.issues.listForRepo({
    owner, repo, state: 'all', labels: HUB_ISSUE_LABEL,
    sort: 'created', direction: 'desc', per_page: 100
  });
  const startOfDayUTC = new Date();
  startOfDayUTC.setUTCHours(0, 0, 0, 0);
  let count = 0;
  for (const issue of data) {
    if (new Date(issue.created_at) < startOfDayUTC) break;
    count++;
  }
  return count;
}

function readDecisionLog(github, base64Decode, owner, repo) {
  try {
    const { data } = github.repos.getContent({ owner, repo, path: DECISION_LOG_PATH });
    let entries = [];
    try {
      const parsed = JSON.parse(base64Decode(data.content));
      if (Array.isArray(parsed)) entries = parsed;
    } catch (e) {
      entries = [];
    }
    return { entries, sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

function appendDecisionLogEntry(github, base64Encode, base64Decode, owner, repo, entry) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { entries, sha } = readDecisionLog(github, base64Decode, owner, repo);
      const updated = [...entries, entry].slice(-DECISION_LOG_MAX_ENTRIES);
      const content = base64Encode(JSON.stringify(updated, null, 2));
      const params = {
        owner, repo, path: DECISION_LOG_PATH,
        message: `chore: log ${entry.mode} decision (${entry.outcome})`,
        content
      };
      if (sha) params.sha = sha;
      github.repos.createOrUpdateFileContents(params);
      return;
    } catch (e) {
      // Retry with a fresh sha on the next attempt; swallow on the last one.
    }
  }
}

function makeLogEntry({ mode, commitSha, outcome, issueUrl = null, summary = null }) {
  return { timestamp: new Date().toISOString(), mode, commitSha, outcome, issueUrl, summary };
}

function safeGetHubFile(github, base64Decode, hubOwner, hubRepo, path) {
  try {
    const { data } = github.repos.getContent({ owner: hubOwner, repo: hubRepo, path });
    return base64Decode(data.content);
  } catch (e) {
    return '';
  }
}

// The actual decision logic, factored out of the Apps Script entry point
// (Code.js) so it can be driven by a local test harness with fakes instead
// of hitting GitHub and the AI API for real - same testability the Vercel
// version had via { octokit, fetchImpl }.
//
// Plain global function, not an ES module export - see github.js's header
// comment for why. Depends on makeGithubClient existing in the same global
// scope (real Apps Script: another file in the same project; tests: loaded
// into the same vm context - see scripts/gas-test-harness.mjs).
function processRequest(reqBody, {
  github,
  aiFetch,
  base64Encode,
  base64Decode,
  config = {},
  dryRunOverride
} = {}) {
  const { owner, repo, mode } = reqBody || {};

  if (!owner || !repo || !mode) {
    return { httpStatus: 400, body: { error: 'owner, repo, and mode are required' } };
  }

  const taskInstruction = MODE_INSTRUCTIONS[mode];
  if (!taskInstruction) {
    return { httpStatus: 400, body: { error: `Unknown mode: ${mode}` } };
  }

  const hubOwner = config.hubOwner || DEFAULT_HUB_OWNER;
  const hubRepo = config.hubRepo || DEFAULT_HUB_REPO;

  // SAFETY RAIL 1: dry-run mode. Defaults to true so a missing/misconfigured
  // config value never files a real issue by accident - DRY_RUN_MODE has to
  // be explicitly set to the string "false" to go live.
  const dryRun = dryRunOverride !== undefined
    ? dryRunOverride
    : config.dryRunMode !== 'false';

  const universalLessons = safeGetHubFile(github, base64Decode, hubOwner, hubRepo, 'universal_lessons.md');
  const globalNorthStar = safeGetHubFile(github, base64Decode, hubOwner, hubRepo, 'north_star_framework.md');
  const hubLessons = safeGetHubFile(github, base64Decode, hubOwner, hubRepo, 'hub_lessons.md');

  let localContext = 'No local context found.';
  try {
    const { data: lsData } = github.repos.getContent({ owner, repo, path: 'lessons.md' });
    const { data: nsData } = github.repos.getContent({ owner, repo, path: 'NORTH_STAR.md' });
    localContext = `
      LOCAL LESSONS: ${base64Decode(lsData.content)}
      LOCAL NORTH STAR: ${base64Decode(nsData.content)}
    `;
  } catch (e) {
    localContext = 'No local context found.';
  }

  let latestCommitSha = null;
  try {
    const { data: commits } = github.repos.listCommits({ owner, repo, per_page: 1 });
    if (commits.length > 0) latestCommitSha = commits[0].sha;
  } catch (e) {
    latestCommitSha = null;
  }

  const { entries: decisionLog } = readDecisionLog(github, base64Decode, owner, repo);
  if (latestCommitSha) {
    const priorEntry = decisionLog.find(
      e => e.commitSha === latestCommitSha && e.mode === mode && e.outcome !== 'ai_error'
    );
    if (priorEntry) {
      const body = {
        status: 'Skipped',
        reason: `Already decided for this commit in ${mode} mode (${priorEntry.outcome})`,
        dryRun,
        priorDecision: priorEntry
      };
      if (priorEntry.issueUrl) body.issueUrl = priorEntry.issueUrl;
      return { httpStatus: 200, body };
    }
  }

  const logOutcome = (outcome, extra = {}) => {
    if (!latestCommitSha) return;
    appendDecisionLogEntry(github, base64Encode, base64Decode, owner, repo, makeLogEntry({ mode, commitSha: latestCommitSha, outcome, ...extra }));
  };

  let codeDiff = null;
  if (latestCommitSha) {
    try {
      const { data: commitDetail } = github.repos.getCommit({ owner, repo, ref: latestCommitSha });
      const patches = (commitDetail.files || [])
        .filter(f => typeof f.patch === 'string' && f.patch.length > 0)
        .map(f => `--- ${f.filename} (${f.status}) ---\n${f.patch}`)
        .join('\n\n');
      if (patches.length > 0) {
        codeDiff = patches.length > MAX_DIFF_CHARS
          ? patches.slice(0, MAX_DIFF_CHARS) + `\n\n[... diff truncated at ${MAX_DIFF_CHARS} chars ...]`
          : patches;
      }
    } catch (e) {
      codeDiff = null;
    }
  }

  if (!codeDiff) {
    logOutcome('no_diff_skip');
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No usable code diff found for the latest commit', dryRun } };
  }

  const priorDecisionsContext = decisionLog.length > 0
    ? decisionLog
        .slice(-PRIOR_DECISIONS_CONTEXT_COUNT)
        .map(e => `- [${e.timestamp}] mode=${e.mode} outcome=${e.outcome}${e.summary ? `: ${e.summary}` : ''}`)
        .join('\n')
    : 'None yet.';

  const prompt = `
    ROLE: Senior AI CTO. MODE: ${mode.toUpperCase()}.
    GLOBAL STANDARDS: ${universalLessons}
    GLOBAL NORTH STAR: ${globalNorthStar}
    HUB LESSONS: ${hubLessons}
    LOCAL CONTEXT: ${localContext}

    PRIOR DECISIONS (most recent ${PRIOR_DECISIONS_CONTEXT_COUNT} for this repo - do not re-report
    something already logged here as decided unless the diff below clearly
    shows something new):
    ${priorDecisionsContext}

    RECENT CODE CHANGES (diff of the latest commit):
    ${codeDiff}

    TASK: ${taskInstruction}
    If you find nothing worth reporting, set "has_findings" to false and
    leave "code_patch" and "value_impact.reasoning" as empty strings - do
    not invent an issue just to have something to say.
    Respond with ONLY valid JSON, exactly this shape:
    {
      "has_findings": boolean,
      "action_summary": string,
      "code_patch": string,
      "value_impact": { "reasoning": string }
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
    logOutcome('ai_error', { summary: 'AI returned no content' });
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'AI returned no content', dryRun } };
  }

  let result;
  try {
    result = JSON.parse(rawContent);
  } catch (parseError) {
    logOutcome('invalid_ai_response', { summary: 'AI did not return valid JSON' });
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: 'AI did not return valid JSON', raw: rawContent.slice(0, 500), dryRun }
    };
  }

  if (result.has_findings !== true) {
    logOutcome('no_findings');
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'AI reported no findings', dryRun } };
  }

  const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
  const isValidShape =
    isNonEmptyString(result.action_summary) &&
    isNonEmptyString(result.code_patch) &&
    result.value_impact &&
    typeof result.value_impact === 'object' &&
    isNonEmptyString(result.value_impact.reasoning);

  if (!isValidShape) {
    logOutcome('invalid_ai_response', { summary: 'AI response did not match the required shape' });
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: 'AI response did not match the required shape', raw: rawContent.slice(0, 500), dryRun }
    };
  }

  const issueTitle = `CTO HUB: ${mode.toUpperCase()} Action`;
  const issueBody = `### Value Impact\n${result.value_impact.reasoning}\n\n### Patch\n\`\`\`\n${result.code_patch}\n\`\`\``;
  const summary = result.action_summary.slice(0, 200);

  if (dryRun) {
    logOutcome('dry_run_would_create', { summary });
    return {
      httpStatus: 200,
      body: { status: 'DryRunFinding', dryRun: true, wouldCreate: { title: issueTitle, body: issueBody } }
    };
  }

  const cap = Number(config.rateCapPerRepoPerDay || 3);
  const countToday = countHubIssuesCreatedTodayUTC(github, owner, repo);
  if (countToday >= cap) {
    logOutcome('rate_capped', { summary });
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: `Rate cap reached (${countToday}/${cap} issues filed today)`, dryRun }
    };
  }

  const created = github.issues.create({
    owner, repo,
    title: issueTitle,
    body: issueBody,
    labels: [HUB_ISSUE_LABEL]
  });

  logOutcome('created', { issueUrl: created.data.html_url, summary });

  return { httpStatus: 200, body: { status: 'Success', dryRun, issueUrl: created.data.html_url } };
}
