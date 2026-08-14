import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadSpokesRegistry, loadTenantsRegistry, resolveTenantIdForSpoke, findTenant, resolveSecretRef } from '../lib/secrets.js';

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

const USAGE_LOG_MAX_ENTRIES = 5000;

// This hub's own identity, for writing its own usage/{tenantId}.json logs -
// same env vars api/recursive_learning.js already uses for the same reason
// (it also writes to this repo, proposing PRs against itself).
const DEFAULT_HUB_OWNER = 'adamberneche-afk';
const DEFAULT_HUB_REPO = 'Mothership';

const MODE_INSTRUCTIONS = {
  debug: 'Review the RECENT CODE CHANGES below for bugs, unsafe patterns, and code quality issues actually present in this diff. Only report something you can point to directly in the diff text.',
  hunt: "Review the RECENT CODE CHANGES below for silent logic errors - places where the code runs without crashing but produces a wrong result. You cannot execute code or run tests; base findings only on what's visible in the diff text.",
  refactor: 'Review the RECENT CODE CHANGES below for opportunities to simplify complex logic, remove redundancy, or improve maintainability. Only report something you can point to directly in the diff text.'
};

// --- Multi-tenancy: data model + credential resolution -----------------
//
// spokes.json/tenants.json are both hub-root files, read from local disk the
// same way universal_lessons.md/north_star_framework.md already are - no
// octokit call needed, since this Vercel function's own checkout already
// has them. loadSpokesRegistry/loadTenantsRegistry/resolveTenantIdForSpoke/
// findTenant/resolveSecretRef now live in ../lib/secrets.js (imported
// above) - deduped out of what used to be 6 byte-identical Node-side
// copies of the same functions, see that file's header comment.

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

// --- Usage metering (hooks only - see lessons.md's dated entry) --------
//
// Lives in the HUB repo (usage/{tenantId}.json), not the spoke - the whole
// point is the operator/billing system can read every tenant's usage
// without needing per-spoke access, matching how a tenant's OWN credential
// (decision #1) is scoped only to their own repos and couldn't write here
// anyway. Written via hubOctokit, a SEPARATE credential from the
// tenant-scoped one used for spoke operations - see processRequest's
// factory-vs-hubOctokit split below.
//
// Same read-modify-write-with-retry shape as appendDecisionLogEntry/
// scripts/prune-logs.js - reused, not reinvented.
function usageLogPath(tenantId) {
  return `usage/${tenantId}.json`;
}

async function readUsageLog(hubOctokit, hubOwner, hubRepo, tenantId) {
  try {
    const { data } = await hubOctokit.repos.getContent({ owner: hubOwner, repo: hubRepo, path: usageLogPath(tenantId) });
    let entries = [];
    try {
      const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      if (Array.isArray(parsed)) entries = parsed;
    } catch (e) {
      entries = [];
    }
    return { entries, sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

async function recordUsageEvent(hubOctokit, hubOwner, hubRepo, event) {
  if (!hubOctokit) return; // no hub-write credential configured - see handler()
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { entries, sha } = await readUsageLog(hubOctokit, hubOwner, hubRepo, event.tenantId);
      const updated = [...entries, event].slice(-USAGE_LOG_MAX_ENTRIES);
      const content = Buffer.from(JSON.stringify(updated, null, 2)).toString('base64');
      const params = {
        owner: hubOwner, repo: hubRepo, path: usageLogPath(event.tenantId),
        message: `chore: record ${event.eventType} usage for tenant ${event.tenantId}`,
        content
      };
      if (sha) params.sha = sha;
      await hubOctokit.repos.createOrUpdateFileContents(params);
      return;
    } catch (e) {
      // Same reasoning as appendDecisionLogEntry: best-effort, retry on a
      // likely stale-sha conflict, swallow on the last attempt - a metering
      // gap is a billing-accuracy problem to notice later, not a reason to
      // fail the actual review request.
    }
  }
}

// Sums this calendar month's 'review_run' events for a tenant, for the
// quota check below. `reviewsPerMonth: null` (the "default" tenant's value)
// means unlimited - never even reads the usage log in that case.
async function countReviewsThisMonth(hubOctokit, hubOwner, hubRepo, tenantId, now) {
  const { entries } = await readUsageLog(hubOctokit, hubOwner, hubRepo, tenantId);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return entries.filter(e => e && e.eventType === 'review_run' && new Date(e.timestamp) >= monthStart).length;
}

// The actual decision logic, factored out of the Vercel handler so it can
// be driven by a local test harness (scripts/dev-test-handler.mjs) with a
// fake octokit/fetch instead of hitting GitHub and the AI API for real.
// `dryRunOverride` lets tests force a specific dry-run state instead of
// reading the DRY_RUN_MODE env var.
//
// `octokitFactory(token)` replaces a single injected `octokit` instance -
// multi-tenancy means the credential used for a spoke's own repo operations
// now depends on which tenant that spoke belongs to (decision #1: each
// tenant supplies their own, not one shared master token), so it can't be
// constructed once outside this function anymore. `hubOctokit` is a
// SEPARATE, already-constructed client scoped to the hub's own repo (still
// GLOBAL_GITHUB_TOKEN under the hood - see handler() below) - it's what
// usage-log writes and quota reads use, since a tenant's own credential has
// no access to the hub repo at all.
export async function processRequest(reqBody, { octokitFactory, hubOctokit, fetchImpl = fetch, dryRunOverride, now = new Date(), spokesOverride, tenantsOverride } = {}) {
  const { owner, repo, mode, callerKey } = reqBody || {};

  if (!owner || !repo || !mode) {
    return { httpStatus: 400, body: { error: 'owner, repo, and mode are required' } };
  }

  const taskInstruction = MODE_INSTRUCTIONS[mode];
  if (!taskInstruction) {
    return { httpStatus: 400, body: { error: `Unknown mode: ${mode}` } };
  }

  // TENANT RESOLUTION + CALLER AUTHENTICATION.
  //
  // Real, disclosed gap this closes a first step toward: spoke-to-hub POSTs
  // carried ZERO credential before this - any caller who knew the hub URL
  // could trigger a review for any registered owner/repo. The check below
  // is deliberately opt-in per tenant: a tenant with no `callerKeyRef` set
  // (true for "default" today) skips verification entirely, preserving
  // today's exact zero-auth behavior for anything not yet migrated. A
  // tenant that HAS set one gets it strictly enforced. Migrating a tenant
  // to enforced caller-auth is then just a config change, not a breaking
  // flag day for spokes that were already working.
  //
  // spokesOverride/tenantsOverride let tests inject a registry instead of
  // reading this checkout's real spokes.json/tenants.json - same
  // dependency-injection convention as dryRunOverride/octokitFactory.
  const spokes = spokesOverride || loadSpokesRegistry();
  const tenants = tenantsOverride || loadTenantsRegistry();
  const tenantId = resolveTenantIdForSpoke(owner, repo, spokes);
  const tenant = findTenant(tenantId, tenants);

  // SAFETY RAIL 1: dry-run mode. Defaults to true so a missing/misconfigured
  // env var never files a real issue by accident - DRY_RUN_MODE has to be
  // explicitly set to the string "false" in Vercel to go live. Every
  // response from this point on carries `dryRun` so callers (and the
  // decision log / health report built on top of this) can always tell
  // which mode produced it. Computed up front (moved ahead of tenant/
  // credential handling below) so the tenant-status gate can use it too.
  const dryRun = dryRunOverride !== undefined
    ? dryRunOverride
    : process.env.DRY_RUN_MODE !== 'false';

  // TENANT STATUS GATE: an explicitly non-'active' tenant (suspended, e.g.
  // for a failed payment) must never be served, checked before any
  // GitHub call - including the credential resolution below - so a
  // suspended tenant costs nothing, not even a failed auth attempt.
  // `status` is optional for backward compat: a record with no `status`
  // field, or the "default" tenant's seeded "active", is always served -
  // only an EXPLICIT non-'active' value skips. (Found while building the
  // GitHub App credential path: `status` was defined in tenants.json's own
  // schema but never actually read anywhere in this handler until now.)
  if (tenant && tenant.status && tenant.status !== 'active') {
    return { httpStatus: 200, body: { status: 'Skipped', reason: `Tenant status is '${tenant.status}', not 'active'`, dryRun } };
  }

  const requiredCallerKey = tenant ? await resolveSecretRef(tenant.callerKeyRef) : null;
  if (requiredCallerKey && callerKey !== requiredCallerKey) {
    return { httpStatus: 401, body: { error: 'invalid or missing caller key for this tenant' } };
  }

  // Credential for this request's SPOKE operations - the tenant's own
  // token (decision #1), resolved via the same env:/kv: scheme as the
  // caller key above. GLOBAL_GITHUB_TOKEN is used ONLY for the true
  // legacy/pre-migration case: no tenant record matched this spoke at all
  // (mirrors resolveTenantIdForSpoke's own backward-compatibility
  // fallback). A tenant that DID match but whose credential ref fails to
  // resolve (unset env var, revoked/misconfigured ref) is a hard skip, not
  // a fallback - silently widening to the hub's own broad
  // GLOBAL_GITHUB_TOKEN here would be exactly backwards: a tenant whose
  // credential is broken or was just revoked should lose access, not gain
  // the operator's own token against their repo. (Inert while only one
  // tenant with one credential path existed; a real, live bug the moment a
  // second, revocable per-tenant credential does - fixed here before that
  // becomes true.)
  let spokeToken;
  if (tenant) {
    spokeToken = await resolveSecretRef(tenant.githubCredentialRef);
    if (!spokeToken) {
      return { httpStatus: 200, body: { status: 'Skipped', reason: `Could not resolve GitHub credential for tenant '${tenantId}'`, dryRun } };
    }
  } else {
    spokeToken = process.env.GLOBAL_GITHUB_TOKEN;
  }
  const octokit = octokitFactory(spokeToken);

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

  const hubOwner = process.env.HUB_GITHUB_OWNER || DEFAULT_HUB_OWNER;
  const hubRepo = process.env.HUB_GITHUB_REPO || DEFAULT_HUB_REPO;
  const recordUsage = (eventType, extra = {}) =>
    recordUsageEvent(hubOctokit, hubOwner, hubRepo, { tenantId, timestamp: new Date().toISOString(), eventType, mode, owner, repo, ...extra });

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
    await logOutcome('no_diff_skip');
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No usable code diff found for the latest commit', dryRun } };
  }

  // BILLING/QUOTA GATE, tenant-scoped - placed before the AI call
  // deliberately (not just before filing, like the rate cap below), since
  // the AI call is the actual cost-incurring event the hub is metering
  // (decision #2: one shared AI_API_KEY, usage attributed per tenant). A
  // tenant with `quota.reviewsPerMonth: null` (the "default" tenant's
  // value, and the only one seeded today) is never checked - unlimited.
  // This is a hooks-only, no-payment-processor gate: it enforces a number
  // already in tenants.json, it doesn't invoice anyone.
  const monthlyQuota = tenant && tenant.quota && tenant.quota.reviewsPerMonth;
  if (typeof monthlyQuota === 'number') {
    const usedThisMonth = await countReviewsThisMonth(hubOctokit, hubOwner, hubRepo, tenantId, now);
    if (usedThisMonth >= monthlyQuota) {
      await logOutcome('quota_exceeded');
      return {
        httpStatus: 200,
        body: { status: 'Skipped', reason: `Monthly review quota reached (${usedThisMonth}/${monthlyQuota} reviews this month)`, dryRun }
      };
    }
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

  // This is the actual cost-incurring event the quota gate above protects
  // against overrunning - record it now that the AI call genuinely
  // happened, regardless of what it decided. `aiData.usage` is an OpenAI-
  // compatible response field some providers populate and some don't -
  // captured when present, never fabricated when it's not.
  await recordUsage('review_run', aiData && aiData.usage ? { usage: aiData.usage } : {});

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
  const issueBody = `### Value Impact\n${result.value_impact.reasoning}\n\n### Patch\n\`\`\`\n${result.code_patch}\n\`\`\``;
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
  await recordUsage('issue_created', { issueUrl: created.data.html_url });

  return { httpStatus: 200, body: { status: "Success", dryRun, issueUrl: created.data.html_url } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // octokitFactory defers Octokit construction until processRequest knows
  // which tenant's credential to use (decision #1) - hubOctokit stays the
  // one, hub-repo-scoped credential (still GLOBAL_GITHUB_TOKEN) used only
  // for this hub's own usage-log writes/quota reads, never for a tenant's
  // spoke operations.
  const octokitFactory = (token) => new Octokit({ auth: token });
  const hubOctokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  try {
    const { httpStatus, body } = await processRequest(req.body, { octokitFactory, hubOctokit, fetchImpl: fetch });
    return res.status(httpStatus).json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
