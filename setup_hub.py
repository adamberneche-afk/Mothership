import os
import subprocess

def setup_hub():
    print("Initializing the AI Mothership (Hub)...")

    # Define the core files for the Hub
    hub_files = [
        # 1. THE UNIVERSAL CONTEXT
        {
            "path": "universal_lessons.md",
            "content": "# Universal Engineering Standards\n\n- **Security**: Never commit API keys; use environment variables.\n- **Quality**: All code must be typed (TypeScript) or linted.\n- **Architecture**: Prefer flat logic over deep nesting.\n- **Documentation**: Every Spoke must maintain a NORTH_STAR.md."
        },
        {
            "path": "north_star_framework.md",
            "content": "# Global North Star Framework\n\n## Core Values\n- **Efficiency without Anxiety**: UX should feel fast and calm.\n- **Invisible Complexity**: The AI handles the mess; the user sees the magic.\n- **Forgiving Design**: Always provide a path to undo or go back."
        },
        {
            "path": "spokes.json",
            "content": "[]"
        },

        # 2. THE CENTRAL INTELLIGENCE (Vercel Worker)
        {
            "path": "api/autonomous_agent.js",
            "content": """import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Caps how much diff text gets forwarded to the LLM per run - keeps prompt
// size and API cost bounded.
const MAX_DIFF_CHARS = 12000;

// Every issue this handler files is tagged with this label. GitHub creates
// the label automatically on first use. It's how the rate cap below counts
// "issues the hub created" without confusing them with anything a human
// filed manually, and it's what the health-report/decision-log tooling
// filters on too.
const HUB_ISSUE_LABEL = 'cto-hub-auto';

const DECISION_LOG_PATH = 'ai_decision_log.json';
// Overflow guard so the log can't grow unbounded before a real retention
// policy exists (that's scripts/prune-logs.js's job, not this handler's).
const DECISION_LOG_MAX_ENTRIES = 500;
// How many of the most recent decisions get fed back into the prompt as
// context, so the model doesn't re-report something already logged.
const PRIOR_DECISIONS_CONTEXT_COUNT = 5;

const MODE_INSTRUCTIONS = {
  debug: 'Review the RECENT CODE CHANGES below for bugs, unsafe patterns, and code quality issues actually present in this diff. Only report something you can point to directly in the diff text.',
  hunt: "Review the RECENT CODE CHANGES below for silent logic errors - places where the code runs without crashing but produces a wrong result. You cannot execute code or run tests; base findings only on what's visible in the diff text.",
  refactor: 'Review the RECENT CODE CHANGES below for opportunities to simplify complex logic, remove redundancy, or improve maintainability. Only report something you can point to directly in the diff text.'
};

// Counts issues carrying HUB_ISSUE_LABEL that were created since UTC
// midnight today, for the rate cap below. Derived on-demand from GitHub's
// primary issue list (not the Search API, which lags real-time) - there is
// no database in this stack, so "how many have we filed today" has to be
// computed from GitHub itself every time, not tracked in memory (a Vercel
// function's memory doesn't survive between invocations anyway).
async function countHubIssuesCreatedTodayUTC(octokit, owner, repo) {
  const { data } = await octokit.issues.listForRepo({
    owner, repo, state: 'all', labels: HUB_ISSUE_LABEL,
    sort: 'created', direction: 'desc', per_page: 100
  });
  const startOfDayUTC = new Date();
  startOfDayUTC.setUTCHours(0, 0, 0, 0);
  let count = 0;
  for (const issue of data) {
    // Sorted newest-first, so the moment we hit one from before today we
    // can stop - everything after it is even older.
    if (new Date(issue.created_at) < startOfDayUTC) break;
    count++;
  }
  return count;
}

// Reads the spoke's decision log. Missing file (404), an unreachable repo,
// or corrupted JSON all come back as an empty log rather than throwing -
// the log is a memory aid, not a source of truth the rest of the handler
// depends on to function.
async function readDecisionLog(octokit, owner, repo) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: DECISION_LOG_PATH });
    let entries = [];
    try {
      const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      if (Array.isArray(parsed)) entries = parsed;
    } catch (e) {
      entries = []; // corrupted log - treat as empty rather than fail the request
    }
    return { entries, sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

// Appends one entry to the spoke's decision log via read-modify-write.
// Best-effort: a logging failure must never fail the request - the actual
// decision (skip/create/etc.) has already been made and returned by the
// time this runs. Retries a few times on a stale sha (another invocation
// wrote in between) by re-reading and reapplying the write.
async function appendDecisionLogEntry(octokit, owner, repo, entry) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { entries, sha } = await readDecisionLog(octokit, owner, repo);
      const updated = [...entries, entry].slice(-DECISION_LOG_MAX_ENTRIES);
      const content = Buffer.from(JSON.stringify(updated, null, 2)).toString('base64');
      const params = {
        owner, repo, path: DECISION_LOG_PATH,
        message: `chore: log ${entry.mode} decision (${entry.outcome})`,
        content
      };
      if (sha) params.sha = sha;
      await octokit.repos.createOrUpdateFileContents(params);
      return;
    } catch (e) {
      // Most likely a 409 from another invocation writing between our read
      // and write - loop and retry with a fresh sha. On the last attempt,
      // swallow it: telemetry loss, not a request failure.
    }
  }
}

function makeLogEntry({ mode, commitSha, outcome, issueUrl = null, summary = null }) {
  return { timestamp: new Date().toISOString(), mode, commitSha, outcome, issueUrl, summary };
}

// The actual decision logic, factored out of the Vercel handler so it can
// be driven by a local test harness (scripts/dev-test-handler.mjs) with a
// fake octokit/fetch instead of hitting GitHub and the AI API for real.
// `dryRunOverride` lets tests force a specific dry-run state instead of
// reading the DRY_RUN_MODE env var.
export async function processRequest(reqBody, { octokit, fetchImpl = fetch, dryRunOverride } = {}) {
  const { owner, repo, mode } = reqBody || {};

  if (!owner || !repo || !mode) {
    return { httpStatus: 400, body: { error: 'owner, repo, and mode are required' } };
  }

  const taskInstruction = MODE_INSTRUCTIONS[mode];
  if (!taskInstruction) {
    return { httpStatus: 400, body: { error: `Unknown mode: ${mode}` } };
  }

  // SAFETY RAIL 1: dry-run mode. Defaults to true so a missing/misconfigured
  // env var never files a real issue by accident - DRY_RUN_MODE has to be
  // explicitly set to the string "false" in Vercel to go live. Every
  // response from this point on carries `dryRun` so callers (and the
  // decision log / health report built on top of this) can always tell
  // which mode produced it.
  const dryRun = dryRunOverride !== undefined
    ? dryRunOverride
    : process.env.DRY_RUN_MODE !== 'false';

  // Fetch Global Context from Hub
  const universalLessonsPath = join(process.cwd(), 'universal_lessons.md');
  const globalNorthStarPath = join(process.cwd(), 'north_star_framework.md');
  const hubLessonsPath = join(process.cwd(), 'hub_lessons.md');

  const universalLessons = existsSync(universalLessonsPath)
    ? readFileSync(universalLessonsPath, 'utf8')
    : "";
  const globalNorthStar = existsSync(globalNorthStarPath)
    ? readFileSync(globalNorthStarPath, 'utf8')
    : "";
  const hubLessons = existsSync(hubLessonsPath)
    ? readFileSync(hubLessonsPath, 'utf8')
    : "";

  // Fetch Local Context from the Spoke repo
  let localContext = "No local context found.";
  try {
    const { data: lsData } = await octokit.repos.getContent({ owner, repo, path: 'lessons.md' });
    const { data: nsData } = await octokit.repos.getContent({ owner, repo, path: 'NORTH_STAR.md' });
    localContext = `
      LOCAL LESSONS: ${Buffer.from(lsData.content, 'base64').toString()}
      LOCAL NORTH STAR: ${Buffer.from(nsData.content, 'base64').toString()}
    `;
  } catch (e) {
    localContext = "No local context found.";
  }

  // Find the spoke's latest commit sha up front - both the decision-log
  // dedup check below and the diff fetch further down need it, so fetch it
  // once and reuse it instead of calling listCommits twice.
  let latestCommitSha = null;
  try {
    const { data: commits } = await octokit.repos.listCommits({ owner, repo, per_page: 1 });
    if (commits.length > 0) latestCommitSha = commits[0].sha;
  } catch (e) {
    latestCommitSha = null;
  }

  // DECISION LOGGING: don't re-run the AI (or spend the diff-fetch call) on
  // a commit+mode combination already decided. An 'ai_error' outcome means
  // the AI call itself failed last time (not that a real decision was
  // made), so those don't block a retry - everything else does.
  const { entries: decisionLog } = await readDecisionLog(octokit, owner, repo);
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
      // A caller checking body.issueUrl (the shape a live 'created' response
      // uses) would otherwise only find it nested under priorDecision on a
      // replay - surface it at the top level too when the prior decision
      // actually filed one.
      if (priorEntry.issueUrl) body.issueUrl = priorEntry.issueUrl;
      return { httpStatus: 200, body };
    }
  }

  const logOutcome = (outcome, extra = {}) => {
    if (!latestCommitSha) return; // nothing meaningful to key the entry on
    return appendDecisionLogEntry(octokit, owner, repo, makeLogEntry({ mode, commitSha: latestCommitSha, outcome, ...extra }));
  };

  // Fetch REAL CODE context: the diff of the spoke's latest commit.
  //
  // Every "audit" used to run with zero actual code in the prompt - only
  // lessons.md/NORTH_STAR.md, which are notes files, not source. That
  // guaranteed the LLM would hallucinate a plausible-looking bug + patch
  // every single run, since it had nothing real to look at. If there's no
  // usable diff (empty commit, binary-only changes, repo unreachable, huge
  // commit GitHub won't return patches for), we skip the AI call and the
  // issue entirely instead of asking it to invent something out of nothing.
  let codeDiff = null;
  if (latestCommitSha) {
    try {
      const { data: commitDetail } = await octokit.repos.getCommit({ owner, repo, ref: latestCommitSha });
      const patches = (commitDetail.files || [])
        .filter(f => typeof f.patch === 'string' && f.patch.length > 0)
        .map(f => `--- ${f.filename} (${f.status}) ---\\n${f.patch}`)
        .join('\\n\\n');
      if (patches.length > 0) {
        codeDiff = patches.length > MAX_DIFF_CHARS
          ? patches.slice(0, MAX_DIFF_CHARS) + `\\n\\n[... diff truncated at ${MAX_DIFF_CHARS} chars ...]`
          : patches;
      }
    } catch (e) {
      codeDiff = null;
    }
  }

  if (!codeDiff) {
    await logOutcome('no_diff_skip');
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No usable code diff found for the latest commit', dryRun } };
  }

  const priorDecisionsContext = decisionLog.length > 0
    ? decisionLog
        .slice(-PRIOR_DECISIONS_CONTEXT_COUNT)
        .map(e => `- [${e.timestamp}] mode=${e.mode} outcome=${e.outcome}${e.summary ? `: ${e.summary}` : ''}`)
        .join('\\n')
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
    // Treated as an infra/API failure, not a real decision - doesn't block
    // a retry of this same commit+mode on the next run.
    await logOutcome('ai_error', { summary: 'AI returned no content' });
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'AI returned no content', dryRun } };
  }

  // Parse and STRICTLY VALIDATE the AI's response before acting on it.
  //
  // A JSON.parse failure does not fabricate a synthetic result and file an
  // issue anyway, and a successful parse is checked field-by-field (non-empty
  // strings for action_summary/code_patch/value_impact.reasoning) before use.
  // Unmet validation returns a 200 "Skipped" response instead of posting.
  let result;
  try {
    result = JSON.parse(rawContent);
  } catch (parseError) {
    await logOutcome('invalid_ai_response', { summary: 'AI did not return valid JSON' });
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: 'AI did not return valid JSON', raw: rawContent.slice(0, 500), dryRun }
    };
  }

  if (result.has_findings !== true) {
    await logOutcome('no_findings');
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
    await logOutcome('invalid_ai_response', { summary: 'AI response did not match the required shape' });
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: 'AI response did not match the required shape', raw: rawContent.slice(0, 500), dryRun }
    };
  }

  const issueTitle = `CTO HUB: ${mode.toUpperCase()} Action`;
  const issueBody = `### Value Impact\\n${result.value_impact.reasoning}\\n\\n### Patch\\n\\`\\`\\`\\n${result.code_patch}\\n\\`\\`\\``;
  const summary = result.action_summary.slice(0, 200);

  // SAFETY RAIL 1 (continued): a real, validated finding - but dry-run mode
  // means we report what we *would* have filed instead of actually filing it.
  if (dryRun) {
    await logOutcome('dry_run_would_create', { summary });
    return {
      httpStatus: 200,
      body: { status: 'DryRunFinding', dryRun: true, wouldCreate: { title: issueTitle, body: issueBody } }
    };
  }

  // SAFETY RAIL 2: a hard cap on how many issues this handler will file
  // against one repo per day, live mode only. This is what stands between
  // a misbehaving prompt/model and a repeat of the ~1,974-issue incident -
  // even if validation above somehow passes bad data every run, this bounds
  // the damage to a handful of issues instead of one every 30 minutes for
  // months.
  const cap = Number(process.env.RATE_CAP_PER_REPO_PER_DAY || 3);
  const countToday = await countHubIssuesCreatedTodayUTC(octokit, owner, repo);
  if (countToday >= cap) {
    await logOutcome('rate_capped', { summary });
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: `Rate cap reached (${countToday}/${cap} issues filed today)`, dryRun }
    };
  }

  const created = await octokit.issues.create({
    owner, repo,
    title: issueTitle,
    body: issueBody,
    labels: [HUB_ISSUE_LABEL]
  });

  await logOutcome('created', { issueUrl: created.data.html_url, summary });

  return { httpStatus: 200, body: { status: "Success", dryRun, issueUrl: created.data.html_url } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  try {
    const { httpStatus, body } = await processRequest(req.body, { octokit, fetchImpl: fetch });
    return res.status(httpStatus).json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}"""
        },
        {
            "path": "api/recursive_learning.js",
            "content": """import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = 'spokes.json';
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

// The actual logic, factored out of the Vercel handler the same way
// autonomous_agent.js's processRequest is, so it can be driven by a local
// mock harness instead of hitting GitHub/the AI API for real.
export async function runRecursiveLearning(reqBody, { octokit, fetchImpl = fetch, dryRunOverride, hubOwner, hubRepo } = {}) {
  const HUB_OWNER = hubOwner || process.env.HUB_GITHUB_OWNER || DEFAULT_HUB_OWNER;
  const HUB_REPO = hubRepo || process.env.HUB_GITHUB_REPO || DEFAULT_HUB_REPO;

  // Same safety rail as autonomous_agent.js, and the same env var - a
  // proposal is a lower-stakes action than filing an issue (it's a PR
  // someone has to review and merge, not something posted unattended), but
  // this still shouldn't go live before Sprint 0's rail has been verified.
  const dryRun = dryRunOverride !== undefined
    ? dryRunOverride
    : process.env.DRY_RUN_MODE !== 'false';

  let spokes = safeParseJsonArray(await safeGetTextContent(octokit, HUB_OWNER, HUB_REPO, SPOKES_REGISTRY_PATH));

  if (spokes.length === 0) {
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No spokes registered in spokes.json', dryRun } };
  }

  const universalLessonsPath = join(process.cwd(), 'universal_lessons.md');
  const globalNorthStarPath = join(process.cwd(), 'north_star_framework.md');
  const universalLessons = existsSync(universalLessonsPath) ? readFileSync(universalLessonsPath, 'utf8') : "";
  const globalNorthStar = existsSync(globalNorthStarPath) ? readFileSync(globalNorthStarPath, 'utf8') : "";

  const perSpokeContext = [];
  for (const spoke of spokes) {
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
  `).join('\\n');

  const prompt = `
    ROLE: Senior AI CTO performing a cross-project retrospective across every
    connected spoke.
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
  // the default branch. Whatever comes out of this is a suggestion a human
  // reviews and merges (or doesn't), same as any other PR.
  const defaultBranch = await getDefaultBranch(octokit, HUB_OWNER, HUB_REPO);
  const { data: baseRef } = await octokit.git.getRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `heads/${defaultBranch}` });
  const branchName = `recursive-learning-${Date.now()}`;
  await octokit.git.createRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `refs/heads/${branchName}`, sha: baseRef.object.sha });

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
      const { data } = await octokit.repos.getContent({ owner: HUB_OWNER, repo: HUB_REPO, path: file.path, ref: branchName });
      existingSha = data.sha;
    } catch (e) {
      existingSha = undefined;
    }
    const params = {
      owner: HUB_OWNER, repo: HUB_REPO, path: file.path, branch: branchName,
      message: `docs: recursive-learning proposal for ${file.path}`,
      content: Buffer.from(file.content).toString('base64')
    };
    if (existingSha) params.sha = existingSha;
    await octokit.repos.createOrUpdateFileContents(params);
  }

  const pr = await octokit.pulls.create({
    owner: HUB_OWNER, repo: HUB_REPO,
    title: 'Recursive Learning: proposed cross-spoke updates',
    head: branchName,
    base: defaultBranch,
    body: `### Reasoning\\n${result.reasoning}\\n\\n---\\nGenerated automatically by \\`api/recursive_learning.js\\` from patterns observed across ${spokes.length} spoke(s). This is a proposal, not a decision - review before merging.`
  });

  return { httpStatus: 200, body: { status: 'Success', dryRun: false, pullRequestUrl: pr.data.html_url } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  try {
    const { httpStatus, body } = await runRecursiveLearning(req.body, { octokit, fetchImpl: fetch });
    return res.status(httpStatus).json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}"""
        },

        # 3. MEMORY MANAGEMENT
        {
            "path": "scripts/prune-logs.js",
            "content": """// Real implementation of the "Maintenance Scripts" capability README always
// claimed. The previous version of this file was a no-op stub
// ("Pruner initialized. Ready for Sunday maintenance.") that nothing ever
// invoked and that didn't touch a single decision log.
//
// Runs as a plain GitHub Actions script (no AI, no Vercel call) - it only
// needs a GitHub token with cross-repo write access, mirrored here as the
// GLOBAL_GITHUB_TOKEN Actions secret on this repo (the Vercel env var of
// the same name doesn't reach an Actions runner).
//
// Usage: node scripts/prune-logs.js
//   Env: RETENTION_DAYS (default 90), DRY_RUN=true to report without writing

import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = join(process.cwd(), 'spokes.json');
const DECISION_LOG_PATH = 'ai_decision_log.json';
const ARCHIVE_LOG_PATH = 'ai_decision_log_archive.json';
const DEFAULT_RETENTION_DAYS = 90;

function loadSpokesRegistry() {
  if (!existsSync(SPOKES_REGISTRY_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SPOKES_REGISTRY_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function readJsonArrayFile(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { entries: Array.isArray(parsed) ? parsed : [], sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

async function writeJsonArrayFile(octokit, owner, repo, path, entries, sha, message) {
  const content = Buffer.from(JSON.stringify(entries, null, 2)).toString('base64');
  const params = { owner, repo, path, message, content };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

// Entries without a parseable timestamp are treated as "recent" (kept) -
// safer to keep something we can't date than to silently archive it.
function partitionByAge(entries, retentionDays, now) {
  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const recent = [];
  const old = [];
  for (const entry of entries) {
    const t = entry && entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
    if (!Number.isNaN(t) && t < cutoffMs) old.push(entry);
    else recent.push(entry);
  }
  return { recent, old };
}

// A stable identity for a decision-log entry, used to dedupe against what's
// already archived. timestamp+commitSha+mode is unique per real decision;
// this is not a general-purpose object hash, just enough to recognize "this
// exact entry already made it into the archive."
function archiveKeyFor(entry) {
  return `${entry && entry.timestamp}|${entry && entry.commitSha}|${entry && entry.mode}`;
}

// Prunes one spoke's decision log. Archive-then-truncate: the archive write
// happens first, so a failure between the two writes leaves an entry
// duplicated in both files (safe, idempotent on the next run) rather than
// lost.
//
// Retries the whole read-partition-write cycle a few times on failure - most
// likely a stale-sha conflict from a heartbeat run (autonomous_agent.js)
// appending a new decision entry in the same window this pruner is reading
// and writing. Re-reading from scratch each attempt picks up that new entry
// instead of clobbering it.
//
// The archive write itself is deduped against what's already there before
// writing (and skipped entirely if there's nothing new). Without this, a
// retry triggered by the *live-log* write failing - after the *archive*
// write on that same attempt already succeeded - would re-append the same
// "old" entries to the archive a second time on the next attempt, since
// re-reading from scratch recomputes the same `old` set from an
// as-yet-untruncated live log. That's a real duplicate within one
// invocation's retry loop, not just the safe, eventually-consistent
// duplication the archive-then-truncate ordering is meant to allow for
// across separate runs.
export async function pruneSpoke(octokit, spoke, { retentionDays = DEFAULT_RETENTION_DAYS, dryRun = false, now = Date.now(), maxAttempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { entries: liveEntries, sha: liveSha } = await readJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH);
    const { recent, old } = partitionByAge(liveEntries, retentionDays, now);

    if (old.length === 0) {
      return { owner: spoke.owner, repo: spoke.repo, moved: 0, skipped: true };
    }

    if (dryRun) {
      return { owner: spoke.owner, repo: spoke.repo, moved: old.length, dryRun: true };
    }

    try {
      const { entries: archiveEntries, sha: archiveSha } = await readJsonArrayFile(octokit, spoke.owner, spoke.repo, ARCHIVE_LOG_PATH);
      const archivedKeys = new Set(archiveEntries.map(archiveKeyFor));
      const newToArchive = old.filter((entry) => !archivedKeys.has(archiveKeyFor(entry)));
      if (newToArchive.length > 0) {
        const updatedArchive = [...archiveEntries, ...newToArchive];
        await writeJsonArrayFile(octokit, spoke.owner, spoke.repo, ARCHIVE_LOG_PATH, updatedArchive, archiveSha, 'chore: archive old decision-log entries');
      }
      await writeJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH, recent, liveSha, 'chore: prune archived entries from decision log');
      return { owner: spoke.owner, repo: spoke.repo, moved: old.length, dryRun: false };
    } catch (e) {
      lastError = e;
      // Loop and retry with a fresh read on the next iteration.
    }
  }
  throw lastError;
}

export async function pruneAllSpokes(octokit, options = {}) {
  const spokes = loadSpokesRegistry();
  const results = [];
  for (const spoke of spokes) {
    try {
      results.push(await pruneSpoke(octokit, spoke, options));
    } catch (e) {
      results.push({ owner: spoke.owner, repo: spoke.repo, error: e.message });
    }
  }
  return results;
}

// CLI entry point - only runs when this file is executed directly, not
// when the test harness imports pruneSpoke/pruneAllSpokes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const retentionDays = Number(process.env.RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  const dryRun = process.env.DRY_RUN === 'true';
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  pruneAllSpokes(octokit, { retentionDays, dryRun })
    .then((results) => {
      console.log(JSON.stringify(results, null, 2));
      if (results.some((r) => r.error)) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}"""
        },
        {
            "path": "scripts/health-report.js",
            "content": """// Real, Mothership-native health reporting - replaces the health-report.yml
// PR #1 deleted, which was a non-functional copy-paste from tso (referenced
// scripts/health-analyzer.js and Prisma, neither of which exist in this
// repo, and posted comments literally saying "Auto-generated by TSO Health
// System"). This one reports on the hub/swarm's own health, not a spoke's.
//
// Runs as a plain GitHub Actions script (no AI, no Vercel call) - like
// prune-logs.js, it only needs a GitHub token, mirrored as the
// GLOBAL_GITHUB_TOKEN Actions secret on this repo.
//
// Usage: node scripts/health-report.js

import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = join(process.cwd(), 'spokes.json');
const DECISION_LOG_PATH = 'ai_decision_log.json';
const HUB_ISSUE_LABEL = 'cto-hub-auto';
const REPORT_ISSUE_LABEL = 'mothership-health-report';
const REPORT_ISSUE_TITLE = 'Mothership Health Report';
const REPORT_WINDOW_DAYS = 7;

const HUB_OWNER = process.env.HUB_GITHUB_OWNER || 'adamberneche-afk';
const HUB_REPO = process.env.HUB_GITHUB_REPO || 'Mothership';

function loadSpokesRegistry() {
  if (!existsSync(SPOKES_REGISTRY_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SPOKES_REGISTRY_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

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

function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item);
    (out[k] = out[k] || []).push(item);
  }
  return out;
}

async function countIssuesCreatedSince(octokit, owner, repo, windowStart) {
  const { data } = await octokit.issues.listForRepo({
    owner, repo, state: 'all', labels: HUB_ISSUE_LABEL, sort: 'created', direction: 'desc', per_page: 100
  });
  let count = 0;
  for (const issue of data) {
    if (new Date(issue.created_at) < windowStart) break;
    count++;
  }
  return count;
}

// Builds the report for a single spoke. Exported separately from
// buildFullReport so tests can drive it directly without needing a real
// spokes.json on disk.
export async function buildReportForSpoke(octokit, spoke, { windowStart }) {
  const issuesFiled = await countIssuesCreatedSince(octokit, spoke.owner, spoke.repo, windowStart);
  const logText = await safeGetTextContent(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH);
  const allEntries = safeParseJsonArray(logText);
  const recentEntries = allEntries.filter((e) => e && e.timestamp && new Date(e.timestamp) >= windowStart);

  const byOutcomeGroups = groupBy(recentEntries, (e) => e.outcome || 'unknown');
  const byOutcome = Object.fromEntries(Object.entries(byOutcomeGroups).map(([k, v]) => [k, v.length]));
  const total = recentEntries.length;
  const createdCount = byOutcome.created || 0;
  const dryRunFindingCount = byOutcome.dry_run_would_create || 0;
  const skipRate = total > 0 ? 1 - createdCount / total : null;

  // Live/dry-run status is INFERRED from observed decision-log outcomes,
  // not read from Vercel config - a GitHub Actions runner has no way to
  // read the hub's Vercel env vars directly.
  let capabilityStatus;
  if (total === 0) {
    capabilityStatus = 'no decisions logged this window (heartbeat may not have run, or spoke was recently added)';
  } else if (createdCount > 0) {
    capabilityStatus = 'live (created at least one issue this window)';
  } else if (dryRunFindingCount > 0) {
    capabilityStatus = 'dry-run (reported findings, filed nothing)';
  } else {
    capabilityStatus = 'active, no real findings this window';
  }

  return { owner: spoke.owner, repo: spoke.repo, issuesFiled, entriesInWindow: total, byOutcome, skipRate, capabilityStatus };
}

export async function buildFullReport(octokit, { now = Date.now(), windowDays = REPORT_WINDOW_DAYS } = {}) {
  const spokes = loadSpokesRegistry();
  const windowStart = new Date(now - windowDays * 24 * 60 * 60 * 1000);
  const generatedAt = new Date(now).toISOString();

  const spokeReports = [];
  for (const spoke of spokes) {
    try {
      spokeReports.push(await buildReportForSpoke(octokit, spoke, { windowStart }));
    } catch (e) {
      spokeReports.push({ owner: spoke.owner, repo: spoke.repo, error: e.message });
    }
  }

  return { generatedAt, windowDays, spokes: spokeReports };
}

export function renderReportMarkdown(report) {
  const lines = [];
  lines.push('# Mothership Health Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt} · Window: last ${report.windowDays} days`);
  lines.push('');

  if (report.spokes.length === 0) {
    lines.push('_No spokes registered in `spokes.json` yet - nothing to report on._');
    return lines.join('\\n');
  }

  lines.push('| Spoke | Issues Filed | Decisions Logged | Skip Rate | Status |');
  lines.push('|---|---|---|---|---|');
  for (const s of report.spokes) {
    if (s.error) {
      lines.push(`| ${s.owner}/${s.repo} | - | - | - | error: ${s.error} |`);
      continue;
    }
    const skipRatePct = s.skipRate === null ? 'n/a' : `${Math.round(s.skipRate * 100)}%`;
    lines.push(`| ${s.owner}/${s.repo} | ${s.issuesFiled} | ${s.entriesInWindow} | ${skipRatePct} | ${s.capabilityStatus} |`);
  }

  lines.push('');
  lines.push('<details><summary>Outcome breakdown per spoke</summary>');
  lines.push('');
  for (const s of report.spokes) {
    if (s.error) continue;
    lines.push(`- **${s.owner}/${s.repo}**: ${JSON.stringify(s.byOutcome)}`);
  }
  lines.push('');
  lines.push('</details>');

  return lines.join('\\n');
}

async function findExistingReportIssue(octokit) {
  const { data } = await octokit.issues.listForRepo({
    owner: HUB_OWNER, repo: HUB_REPO, state: 'all', labels: REPORT_ISSUE_LABEL, per_page: 10
  });
  return data.find((issue) => issue.title === REPORT_ISSUE_TITLE) || null;
}

// Updates the same pinned issue in place on every run instead of creating a
// new one each time - a deliberate callback to the original issue-spam
// disaster this whole system exists to avoid repeating.
export async function publishReport(octokit, body) {
  const existing = await findExistingReportIssue(octokit);
  if (existing) {
    const updateParams = { owner: HUB_OWNER, repo: HUB_REPO, issue_number: existing.number, body };
    // If a human closed the report issue (e.g. tidying notifications), the
    // update itself doesn't reopen it by default - reopen explicitly, or
    // every future run would keep silently rewriting a closed issue's body
    // instead of surfacing anywhere a maintainer would actually look.
    const wasClosed = existing.state === 'closed';
    if (wasClosed) updateParams.state = 'open';
    await octokit.issues.update(updateParams);
    return { action: wasClosed ? 'reopened' : 'updated', issueUrl: existing.html_url };
  }
  const created = await octokit.issues.create({
    owner: HUB_OWNER, repo: HUB_REPO, title: REPORT_ISSUE_TITLE, body, labels: [REPORT_ISSUE_LABEL]
  });
  return { action: 'created', issueUrl: created.data.html_url };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  buildFullReport(octokit)
    .then(async (report) => {
      const body = renderReportMarkdown(report);
      console.log(body);
      const result = await publishReport(octokit, body);
      console.log(JSON.stringify(result));
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}"""
        },

        {
            "path": "scripts/collect-issue-feedback.js",
            "content": """// Closes a real gap: today the only way a spoke maintainer can tell the
// system "this finding was wrong" is closing the issue - nothing reads
// that. GitHub's issue objects already carry a `reactions` summary
// (`{"+1", "-1", laugh, ...}`) on every issue `issues.listForRepo` returns -
// no extra API call needed - so a thumbs-down on a hub-filed issue is a
// free, already-available signal that's simply never been read. This
// script reads it and attaches it to the matching `ai_decision_log.json`
// entry, so `api/recursive_learning.js`/`gas/recursive_learning.js` can
// factor a spoke's negative feedback into what they propose.
//
// Runs as a plain GitHub Actions script (no AI, no Vercel call) - like
// prune-logs.js/health-report.js, it only needs a GitHub token, mirrored as
// the GLOBAL_GITHUB_TOKEN Actions secret on this repo.
//
// Usage: node scripts/collect-issue-feedback.js

import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = join(process.cwd(), 'spokes.json');
const DECISION_LOG_PATH = 'ai_decision_log.json';
const HUB_ISSUE_LABEL = 'cto-hub-auto';

function loadSpokesRegistry() {
  if (!existsSync(SPOKES_REGISTRY_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SPOKES_REGISTRY_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function readJsonArrayFile(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { entries: Array.isArray(parsed) ? parsed : [], sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

async function writeJsonArrayFile(octokit, owner, repo, path, entries, sha, message) {
  const content = Buffer.from(JSON.stringify(entries, null, 2)).toString('base64');
  const params = { owner, repo, path, message, content };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

async function fetchLabeledIssues(octokit, owner, repo) {
  const { data } = await octokit.issues.listForRepo({
    owner, repo, state: 'all', labels: HUB_ISSUE_LABEL, per_page: 100
  });
  return data;
}

function reactionCounts(issue) {
  const r = issue && issue.reactions;
  return { thumbsUp: (r && r['+1']) || 0, thumbsDown: (r && r['-1']) || 0 };
}

function feedbackChanged(existing, counts) {
  if (!existing) return true;
  return existing.thumbsDown !== counts.thumbsDown || existing.thumbsUp !== counts.thumbsUp;
}

// Collects feedback for one spoke. Only decisions with outcome 'created'
// ever have a non-null issueUrl (confirmed against makeLogEntry in both
// autonomous_agent.js files) - anything else is skipped, there's nothing to
// match a reaction to. Matches by exact issueUrl === issue.html_url string
// equality; both come from the same GitHub field, so this is reliable
// without needing to parse an issue number out of the URL.
//
// Same retry-on-conflict shape as prune-logs.js's pruneSpoke: re-read the
// live log fresh on every attempt, in case a concurrent heartbeat run
// appended a new decision in the same window. Only writes if something
// actually changed - a run with no new reactions writes nothing.
export async function collectFeedbackForSpoke(octokit, spoke, { now = Date.now(), maxAttempts = 3 } = {}) {
  const issues = await fetchLabeledIssues(octokit, spoke.owner, spoke.repo);
  const issuesByUrl = new Map(issues.map((issue) => [issue.html_url, issue]));

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { entries, sha } = await readJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH);

    const updated = entries.map((entry) => {
      if (!entry || !entry.issueUrl) return entry;
      const issue = issuesByUrl.get(entry.issueUrl);
      if (!issue) return entry;
      const counts = reactionCounts(issue);
      // Only a real negative signal is worth recording - a plain thumbs-up
      // with no thumbs-down isn't feedback the system needs to act on.
      if (counts.thumbsDown === 0) return entry;
      if (!feedbackChanged(entry.feedback, counts)) return entry;
      return { ...entry, feedback: { thumbsUp: counts.thumbsUp, thumbsDown: counts.thumbsDown, checkedAt: new Date(now).toISOString() } };
    });

    const changedCount = updated.filter((entry, i) => entry !== entries[i]).length;
    if (changedCount === 0) {
      return { owner: spoke.owner, repo: spoke.repo, updated: 0 };
    }

    try {
      await writeJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH, updated, sha, 'chore: record maintainer feedback on filed issues');
      return { owner: spoke.owner, repo: spoke.repo, updated: changedCount };
    } catch (e) {
      lastError = e;
      // Loop and retry with a fresh read on the next iteration.
    }
  }
  throw lastError;
}

export async function collectFeedbackForAllSpokes(octokit, options = {}) {
  const spokes = loadSpokesRegistry();
  const results = [];
  for (const spoke of spokes) {
    try {
      results.push(await collectFeedbackForSpoke(octokit, spoke, options));
    } catch (e) {
      results.push({ owner: spoke.owner, repo: spoke.repo, error: e.message });
    }
  }
  return results;
}

// CLI entry point - only runs when this file is executed directly, not
// when the test harness imports collectFeedbackForSpoke/collectFeedbackForAllSpokes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  collectFeedbackForAllSpokes(octokit)
    .then((results) => {
      console.log(JSON.stringify(results, null, 2));
      if (results.some((r) => r.error)) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}"""
        },

        {
            "path": "scripts/doctor.js",
            "content": """// Pre-flight health check for the hub + every registered spoke - checks
// exactly the class of bug found live this session: GLOBAL_GITHUB_TOKEN
// invalid (health-report.yml's 401, undetected through 5 straight runs)
// and a spoke's call-hub.yml missing its hub-URL secret entirely
// (thinkos-server/tais failing 100+ scheduled runs on an unset VERCEL_URL).
// Both were checkable in under a second per repo - nothing before this ran
// that check before something broke in production.
//
// Deliberately workflow_dispatch-only, no schedule (see doctor.yml) - this
// session's whole investigation was triggered by workflows failing
// silently on a schedule nobody was watching; adding another scheduled job
// here risks the identical failure mode this tool exists to catch.
//
// A real, disclosed limitation, not overclaimed: GitHub never exposes a
// repo secret's VALUE via any API, only its name and timestamps. The
// per-spoke secret check below can only confirm something with the right
// NAME exists - it would have caught a fully-unset VERCEL_URL, but not one
// set to an empty string or a wrong value. That's a narrower net than "the
// exact incident," and it's stated as such rather than papered over.
//
// Usage: node scripts/doctor.js

import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = join(process.cwd(), 'spokes.json');
const CALL_HUB_WORKFLOW_PATH = '.github/workflows/call-hub.yml';
const HUB_URL_SECRET_NAMES = ['VERCEL_URL', 'APPS_SCRIPT_URL'];

function loadSpokesRegistry() {
  if (!existsSync(SPOKES_REGISTRY_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SPOKES_REGISTRY_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// This exact repo's own GLOBAL_GITHUB_TOKEN, readable at Actions runtime -
// a 401 here is precisely this session's own confirmed incident.
//
// `GET /rate_limit` itself doesn't require authentication at all - it
// happily returns 200 for a fully unauthenticated request too. Found this
// the hard way running the real CLI locally: an empty token still reported
// "valid" here, since the endpoint's own 200 doesn't distinguish "no token"
// from "a real, working one." `token` is checked directly, before ever
// calling the API, for exactly the same reason the AI key check below
// short-circuits on empty rather than trusting a response code that can't
// tell the two states apart.
async function checkGlobalGithubToken(octokit, token) {
  if (!token) return { label: 'GLOBAL_GITHUB_TOKEN', ok: false, detail: 'not configured' };
  try {
    await octokit.request('GET /rate_limit');
    return { label: 'GLOBAL_GITHUB_TOKEN', ok: true, detail: 'valid' };
  } catch (e) {
    const status = e && e.status;
    return {
      label: 'GLOBAL_GITHUB_TOKEN',
      ok: false,
      detail: status === 401 ? 'invalid or expired (401)' : `unexpected error (${e.message})`
    };
  }
}

// Same URL-join convention as the real AI call in autonomous_agent.js
// (`${aiBaseUrl}/chat/completions`) - listing models is the standard,
// low-cost way to validate an OpenAI-compatible key without spending
// completion tokens.
async function checkAiKey(fetchImpl, aiBaseUrl, aiApiKey) {
  if (!aiApiKey) return { label: 'AI_API_KEY', ok: false, detail: 'not configured' };
  if (!aiBaseUrl) return { label: 'AI_API_KEY', ok: false, detail: 'AI_BASE_URL not configured' };
  try {
    const res = await fetchImpl(`${aiBaseUrl}/models`, { headers: { Authorization: `Bearer ${aiApiKey}` } });
    if (res.ok) return { label: 'AI_API_KEY', ok: true, detail: 'valid' };
    return { label: 'AI_API_KEY', ok: false, detail: `invalid or unauthorized (${res.status})` };
  } catch (e) {
    return { label: 'AI_API_KEY', ok: false, detail: `unexpected error (${e.message})` };
  }
}

async function checkSpokeRepoReachable(octokit, spoke) {
  const label = `${spoke.owner}/${spoke.repo}: repo reachable`;
  try {
    await octokit.repos.get({ owner: spoke.owner, repo: spoke.repo });
    return { label, ok: true, detail: 'reachable' };
  } catch (e) {
    return { label, ok: false, detail: `not reachable (${e.message})` };
  }
}

async function checkSpokeHasCallHubWorkflow(octokit, spoke) {
  const label = `${spoke.owner}/${spoke.repo}: call-hub.yml exists`;
  try {
    await octokit.repos.getContent({ owner: spoke.owner, repo: spoke.repo, path: CALL_HUB_WORKFLOW_PATH });
    return { label, ok: true, detail: 'found' };
  } catch (e) {
    // A real 404 means the file genuinely doesn't exist - "not wired up" is
    // the accurate, actionable message. Anything else (rate-limited,
    // network error, auth problem) is a different failure entirely and
    // shouldn't be reported as if the spoke were missing its workflow -
    // caught this exact conflation running the real CLI against the
    // unauthenticated API, where a rate-limit on this call looked
    // identical to a missing file until the real status was checked.
    if (e && e.status === 404) return { label, ok: false, detail: 'not found - spoke not wired up' };
    return { label, ok: false, detail: `couldn't check (${e.message})` };
  }
}

// Can only confirm a secret with the right NAME exists - see the file
// header comment. Still catches the "totally forgot to set it" class of
// mistake, which is a real, common failure mode on its own.
async function checkSpokeHasHubUrlSecret(octokit, spoke) {
  const label = `${spoke.owner}/${spoke.repo}: VERCEL_URL or APPS_SCRIPT_URL secret present`;
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/secrets', { owner: spoke.owner, repo: spoke.repo });
    const names = (data.secrets || []).map((s) => s.name);
    const hasOne = HUB_URL_SECRET_NAMES.some((n) => names.includes(n));
    if (hasOne) return { label, ok: true, detail: 'present (name only - value can\\'t be verified)' };
    return { label, ok: false, detail: 'neither VERCEL_URL nor APPS_SCRIPT_URL is set - call-hub.yml will fail' };
  } catch (e) {
    return { label, ok: false, detail: `couldn't list secrets (${e.message})` };
  }
}

// Core check, testable without any real network access. Returns a plain
// result object rather than exiting - only the CLI wrapper below does
// that, matching processRequest/buildFullReport/pruneAllSpokes's existing
// testable-core/thin-CLI-shell split.
export async function runDoctor(octokit, { fetchImpl = fetch, env = process.env } = {}) {
  const checks = [];
  checks.push(await checkGlobalGithubToken(octokit, env.GLOBAL_GITHUB_TOKEN));
  checks.push(await checkAiKey(fetchImpl, env.AI_BASE_URL, env.AI_API_KEY));

  const spokes = loadSpokesRegistry();
  for (const spoke of spokes) {
    checks.push(await checkSpokeRepoReachable(octokit, spoke));
    checks.push(await checkSpokeHasCallHubWorkflow(octokit, spoke));
    checks.push(await checkSpokeHasHubUrlSecret(octokit, spoke));
  }

  return { checks, allOk: checks.every((c) => c.ok) };
}

export function renderReport(result) {
  const lines = ['Mothership pre-flight doctor check', ''];
  for (const c of result.checks) {
    lines.push(`${c.ok ? '✓' : '✗'} ${c.label}: ${c.detail}`);
  }
  lines.push('');
  lines.push(result.allOk ? 'All checks passed.' : 'One or more checks failed - see above.');
  return lines.join('\\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  runDoctor(octokit, { fetchImpl: fetch })
    .then((result) => {
      console.log(renderReport(result));
      if (!result.allOk) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}"""
        },

        # 4. AUTOMATION (GitHub Actions workflows - self-reflect, maintenance,
        # health reporting, recursive learning). Without these, api/*.js and
        # scripts/*.js above are never actually invoked on any schedule - a
        # freshly-scaffolded hub would otherwise deploy successfully to Vercel
        # and sit there completely inert.
        {
            "path": ".github/workflows/self-reflect.yml",
            "content": """name: Hub Self-Reflection
on:
  schedule:
    - cron: '0 0 * * 0'  # Weekly at midnight UTC
  workflow_dispatch:

jobs:
  self-check:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Hub for self-analysis
        env:
          # Note: GLOBAL_GITHUB_TOKEN is not needed here - the hub authenticates
          # to GitHub server-side using its own Vercel env var, not anything
          # the caller sends. Only HUB_VERCEL_URL is actually required.
          HUB_VERCEL_URL: ${{ secrets.HUB_VERCEL_URL }}
          # The hub's deployment currently sits behind Vercel Deployment
          # Protection - without this header every call gets a 403 before it
          # ever reaches the handler. Get a "Protection Bypass for
          # Automation" secret from the Vercel dashboard (Settings ->
          # Deployment Protection) and store it as VERCEL_BYPASS_TOKEN.
          VERCEL_BYPASS_TOKEN: ${{ secrets.VERCEL_BYPASS_TOKEN }}
        run: |
          curl -X POST "${HUB_VERCEL_URL}/api/autonomous_agent" \\
            -H "Content-Type: application/json" \\
            -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_TOKEN}" \\
            -d '{
              "owner": "${{ github.repository_owner }}",
              "repo": "${{ github.event.repository.name }}",
              "mode": "refactor"
            }'"""
        },
        {
            "path": ".github/workflows/prune-logs.yml",
            "content": """name: Prune Decision Logs

on:
  schedule:
    - cron: '0 0 * * 0'  # Weekly, Sunday at midnight UTC
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Report what would move without writing anything'
        type: boolean
        default: false

jobs:
  prune:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Prune old decision-log entries across all registered spokes
        env:
          # Mirrors the Vercel env var of the same name - an Actions runner
          # can't read Vercel's env, so this needs its own copy of the token
          # as a repo secret, with cross-repo write access to every spoke.
          GLOBAL_GITHUB_TOKEN: ${{ secrets.GLOBAL_GITHUB_TOKEN }}
          DRY_RUN: ${{ inputs.dry_run }}
        run: node scripts/prune-logs.js"""
        },
        {
            "path": ".github/workflows/health-report.yml",
            "content": """name: Health Report

on:
  schedule:
    - cron: '0 6 * * 1'  # Weekly, Monday at 6 AM UTC
  workflow_dispatch:

jobs:
  report:
    runs-on: ubuntu-latest
    # Only governs the auto-generated GITHUB_TOKEN (used below by checkout) -
    # the script's actual GitHub calls authenticate with the GLOBAL_GITHUB_TOKEN
    # secret instead, so this block doesn't grant those anything. Listed
    # explicitly (rather than left off) so a future repo-visibility change
    # doesn't silently drop checkout's read access - declaring any permissions
    # here sets every unlisted scope to 'none'.
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4

      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Build and publish the Mothership health report
        env:
          # Mirrors the Vercel env var of the same name - an Actions runner
          # can't read Vercel's env, so this needs its own copy as a repo
          # secret, with read access to every registered spoke plus write
          # access to this repo (to update the pinned report issue).
          GLOBAL_GITHUB_TOKEN: ${{ secrets.GLOBAL_GITHUB_TOKEN }}
        run: node scripts/health-report.js"""
        },
        {
            "path": ".github/workflows/collect-issue-feedback.yml",
            "content": """name: Collect Issue Feedback

on:
  schedule:
    - cron: '0 6 * * 6'  # Weekly, Saturday at 06:00 UTC - offset from prune-logs.yml/health-report.yml's Sunday/Monday cadence
  workflow_dispatch:

jobs:
  collect-feedback:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Record maintainer feedback (issue reactions) across all registered spokes
        env:
          # Mirrors the Vercel env var of the same name - an Actions runner
          # can't read Vercel's env, so this needs its own copy of the token
          # as a repo secret, with cross-repo write access to every spoke.
          GLOBAL_GITHUB_TOKEN: ${{ secrets.GLOBAL_GITHUB_TOKEN }}
        run: node scripts/collect-issue-feedback.js"""
        },

        {
            "path": ".github/workflows/doctor.yml",
            "content": """name: Doctor

# Deliberately workflow_dispatch-only, no schedule. This session's whole
# investigation into the hub's health started because scheduled workflows
# were failing silently with nobody watching - adding another scheduled job
# here would risk the exact same failure mode this tool exists to catch.
# Run this manually when setting up a new spoke, rotating a credential, or
# troubleshooting - not on a clock.
on:
  workflow_dispatch:

jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run pre-flight checks against the hub and every registered spoke
        env:
          # GLOBAL_GITHUB_TOKEN also needs read access to each spoke's
          # Actions secrets metadata (names only, never values) to check
          # VERCEL_URL/APPS_SCRIPT_URL is set - the same classic PAT with
          # full repo scope already documented in README already covers this.
          GLOBAL_GITHUB_TOKEN: ${{ secrets.GLOBAL_GITHUB_TOKEN }}
          # AI_API_KEY/AI_BASE_URL normally live only as Vercel env vars, not
          # Actions secrets (an Actions runner can't read Vercel's env either
          # way) - the AI_API_KEY check below reports "not configured" and
          # is skipped gracefully unless you also mirror these two as Actions
          # secrets on this repo, the same way GLOBAL_GITHUB_TOKEN already
          # has to be mirrored to reach an Actions runner at all.
          AI_API_KEY: ${{ secrets.AI_API_KEY }}
          AI_BASE_URL: ${{ secrets.AI_BASE_URL }}
        run: node scripts/doctor.js"""
        },

        {
            "path": ".github/workflows/recursive-learning.yml",
            "content": """name: Recursive Learning

on:
  schedule:
    - cron: '0 0 1 * *'  # Monthly, 1st of the month at midnight UTC
  workflow_dispatch:

jobs:
  aggregate:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Hub for cross-spoke aggregation
        env:
          HUB_VERCEL_URL: ${{ secrets.HUB_VERCEL_URL }}
          # See self-reflect.yml - required while the deployment has Vercel
          # Deployment Protection enabled.
          VERCEL_BYPASS_TOKEN: ${{ secrets.VERCEL_BYPASS_TOKEN }}
        run: |
          curl -X POST "${HUB_VERCEL_URL}/api/recursive_learning" \\
            -H "Content-Type: application/json" \\
            -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_TOKEN}" \\
            -d '{}'"""
        },

        # 5. INFRASTRUCTURE
        {
            "path": "package.json",
            "content": "{\n  \"name\": \"ai-cto-hub\",\n  \"version\": \"1.0.0\",\n  \"type\": \"module\",\n  \"scripts\": {\n    \"test\": \"for f in scripts/dev-test-*.mjs; do node \\\"$f\\\" || exit 1; done\"\n  },\n  \"dependencies\": {\n    \"@octokit/rest\": \"^19.0.0\"\n  }\n}"
        },
        {
            "path": ".gitignore",
            "content": "node_modules/\n.env\n.vercel\n__pycache__/\n*.pyc\n# clasp's own config - contains a scriptId tied to one person's Google\n# account, generated by `clasp create`/`clasp clone`. gas/.clasp.json.example\n# is the checked-in template; the real file is per-deployment, not shared code.\n.clasp.json\n.clasprc.json"
        }
    ]

    for f in hub_files:
        os.makedirs(os.path.dirname(f["path"]), exist_ok=True) if os.path.dirname(f["path"]) else None
        with open(f["path"], "w") as file:
            file.write(f["content"])
        print(f"Created: {f['path']}")

    print("\nInstalling Hub dependencies...")
    # No shell=True here: combined with a list, it runs the list's first
    # item as the shell command and every item after it as arguments to the
    # *shell* invocation itself, not to that command - so ["npm", "install"]
    # silently ran bare `npm` (no subcommand) and never installed anything.
    # A plain list without shell=True execs npm directly with both args.
    install = subprocess.run(["npm", "install"])
    if install.returncode != 0:
        print("Warning: 'npm install' failed - install dependencies manually before deploying.")

    print("\n" + "="*50)
    print("MOTHERSHIP INITIALIZED")
    print("="*50)
    print("1. Deploy this folder to Vercel.")
    print("2. Set your Environment Variables in Vercel:")
    print("   - AI_API_KEY, AI_MODEL, AI_BASE_URL")
    print("   - GLOBAL_GITHUB_TOKEN (Personal Access Token with Repo access)")
    print("   - DRY_RUN_MODE (optional, defaults to true - set to \"false\" only")
    print("     after watching dry-run output for a while; see README)")
    print("   - RATE_CAP_PER_REPO_PER_DAY (optional, defaults to 3)")
    print("3. You are now ready to onboard 'Spoke' projects.")
    print("="*50)

if __name__ == "__main__":
    setup_hub()