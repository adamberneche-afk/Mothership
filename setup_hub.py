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
        {
            # Multi-tenancy registry (see lessons.md's multi-tenancy entry).
            # Starts empty - a fresh hub has zero spokes and needs no tenant
            # entries yet. Every script that resolves a tenant's credential
            # falls back to GLOBAL_GITHUB_TOKEN when no tenant is found, so
            # an empty registry here is fully backward-compatible with the
            # single-tenant, zero-config setup this installer has always
            # produced.
            "path": "tenants.json",
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

const SPOKES_REGISTRY_PATH = 'spokes.json';
const TENANTS_REGISTRY_PATH = 'tenants.json';
const DEFAULT_TENANT_ID = 'default';
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
// has them. Both are architecture/data-model additions only this pass (see
// lessons.md's dated entry) - no real tenant self-service onboarding UI, no
// real secrets store, no payment processor. What's real: every spoke is now
// unambiguously scoped to one tenant, credential resolution has a real seam
// instead of one shared global token, and usage gets attributed per tenant.

function loadJsonArrayFromDisk(path) {
  const fullPath = join(process.cwd(), path);
  if (!existsSync(fullPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Finds which tenant a given owner/repo belongs to. Falls back to
// DEFAULT_TENANT_ID for anything not found in spokes.json - a deliberate
// backward-compatibility choice, not a security feature: it preserves
// today's exact behavior (no registration required to get a response) for
// spokes nobody has migrated into the tenant model yet. Once real
// multi-tenant onboarding exists, an unmatched spoke should probably reject
// instead of silently defaulting - flagged here, not fixed here.
function resolveTenantIdForSpoke(owner, repo, spokes) {
  const match = spokes.find(s => s && s.owner === owner && s.repo === repo);
  return (match && match.tenantId) || DEFAULT_TENANT_ID;
}

function findTenant(tenantId, tenants) {
  return tenants.find(t => t && t.tenantId === tenantId) || null;
}

// githubCredentialRef/callerKeyRef use a `scheme:value` format:
//   env:VAR_NAME - reads an env var directly. This is what keeps the
//     "default" tenant working exactly as before with zero migration -
//     tenants.json seeds it with "env:GLOBAL_GITHUB_TOKEN".
//   kv:some/path - a pointer into a real dynamic secrets store (Vercel KV,
//     a database, a secrets manager) that DOES NOT EXIST YET. Provisioning
//     one is required, separate infrastructure work before any tenant
//     beyond "default" can actually go live - a git-committed JSON file
//     can't hold a raw secret without permanently leaking it into git
//     history, so there is deliberately no local fallback for this scheme.
// TODO: wire the kv: branch to a real secrets store before onboarding a
// second tenant for real.
function resolveSecretRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] || null;
  if (ref.startsWith('kv:')) return null; // see TODO above
  return null;
}

function loadSpokesRegistry() {
  return loadJsonArrayFromDisk(SPOKES_REGISTRY_PATH);
}

function loadTenantsRegistry() {
  return loadJsonArrayFromDisk(TENANTS_REGISTRY_PATH);
}

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

  const requiredCallerKey = tenant ? resolveSecretRef(tenant.callerKeyRef) : null;
  if (requiredCallerKey && callerKey !== requiredCallerKey) {
    return { httpStatus: 401, body: { error: 'invalid or missing caller key for this tenant' } };
  }

  // Credential for this request's SPOKE operations - the tenant's own
  // token (decision #1), resolved via the same env:/kv: scheme as the
  // caller key above. Falls back to GLOBAL_GITHUB_TOKEN only when no
  // tenant match exists at all (mirrors resolveTenantIdForSpoke's own
  // backward-compatibility fallback) or the ref can't be resolved yet
  // (e.g. a kv: ref with no secrets store behind it) - fails toward "use
  // the one credential that's always been used" rather than toward a
  // silent, harder-to-diagnose 401 from GitHub itself.
  const spokeToken = (tenant && resolveSecretRef(tenant.githubCredentialRef)) || process.env.GLOBAL_GITHUB_TOKEN;
  const octokit = octokitFactory(spokeToken);

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
}"""
        },
        {
            "path": "api/recursive_learning.js",
            "content": """import { Octokit } from '@octokit/rest';
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

// --- Shared, opt-in, cross-organization learning pool -----------------------
//
// Repo-scoped opt-in (spoke.shareLearnings === true), NOT tenant-scoped -
// deliberately: whether a codebase's patterns are safe to pool into a wider
// corpus is a property of that codebase, not of who's paying for it. A repo
// that opts in still ALSO runs in its own tenant's private runForTenant pass
// above - this is purely additive, nothing existing changes.
//
// Two structural safeguards against exactly the failure mode this feature
// exists to avoid ("co-mingle/hallucinate codebase"):
//   1. The per-spoke context sent to the AI is labeled with an anonymized
//      "Contributor N" tag instead of the real owner/repo. There's no
//      actual source code to redact here in the first place (this loop
//      never fetches diffs, only lessons.md/decision-log text - same as
//      runForTenant's per-spoke fetch above), but a real org/repo name
//      could still get echoed back into the merged, hub-global lessons
//      text, so it's kept out of the model's view entirely.
//   2. The model must CITE which anonymized contributors back its proposal
//      (`supporting_contributors`) - and that citation is verified in CODE
//      against the real spokes those labels map to (distinct tenants /
//      distinct repos), never just trusted because the model said
//      "has_proposal: true". Same "validate the claim, don't trust the
//      free-text self-report" discipline already applied to
//      has_findings/has_proposal everywhere else in this project.
const MIN_DISTINCT_TENANTS_CROSS_ORG = 2;
const MIN_DISTINCT_REPOS_SAME_TENANT = 3;

function selectSharedPoolSpokes(spokes) {
  return spokes.filter(s => s && s.owner && s.repo && s.shareLearnings === true);
}

// Cheap precondition, checked before spending an AI call: can this set of
// opted-in spokes even theoretically satisfy the evidence bar yet?
function poolCouldSatisfyEvidenceBar(sharedPoolSpokes) {
  const distinctTenants = new Set(sharedPoolSpokes.map(s => s.tenantId || DEFAULT_TENANT_ID));
  if (distinctTenants.size >= MIN_DISTINCT_TENANTS_CROSS_ORG) return true;
  return sharedPoolSpokes.length >= MIN_DISTINCT_REPOS_SAME_TENANT;
}

// The anti-hallucination gate: given the labels the model actually cited,
// counts DISTINCT real tenants and DISTINCT real repos behind them and
// checks that against the locked bar - never trusts "has_proposal: true"
// on its own.
function citedEvidenceMeetsBar(citedLabels, labelToSpoke) {
  const citedSpokes = citedLabels.map(label => labelToSpoke[label]).filter(Boolean);
  const distinctRepoKeys = new Set(citedSpokes.map(s => `${s.owner}/${s.repo}`));
  const distinctTenantIds = new Set(citedSpokes.map(s => s.tenantId));
  if (distinctTenantIds.size >= MIN_DISTINCT_TENANTS_CROSS_ORG) return true;
  if (distinctRepoKeys.size >= MIN_DISTINCT_REPOS_SAME_TENANT) return true;
  return false;
}

// Builds and runs the shared cross-organization pass - parallel in shape to
// runForTenant, but spans every tenant's opted-in spokes in one pool
// instead of being confined to one tenant.
async function runForSharedPool({ sharedPoolSpokes, tenants, octokitFactory, hubOctokit, fetchImpl, dryRun, universalLessons, globalNorthStar, HUB_OWNER, HUB_REPO }) {
  if (sharedPoolSpokes.length === 0) {
    return { pool: 'shared', status: 'Skipped', reason: 'No spokes opted into the shared learning pool', dryRun };
  }
  if (!poolCouldSatisfyEvidenceBar(sharedPoolSpokes)) {
    return { pool: 'shared', status: 'Skipped', reason: 'Not enough opted-in spokes yet to meet the cross-organization evidence bar', dryRun };
  }

  // Per-spoke credential resolution still happens per-spoke, not once - the
  // pool spans multiple tenants' repos, so each one is still fetched using
  // ITS OWN resolved tenant credential, exactly like runForTenant, just
  // inside one aggregating loop instead of one tenant-scoped loop.
  const labelToSpoke = {};
  const perSpokeContext = [];
  for (let i = 0; i < sharedPoolSpokes.length; i++) {
    const spoke = sharedPoolSpokes[i];
    const label = `Contributor ${i + 1}`;
    const tenantId = spoke.tenantId || DEFAULT_TENANT_ID;
    const tenant = findTenant(tenantId, tenants);
    const spokeToken = (tenant && resolveSecretRef(tenant.githubCredentialRef)) || process.env.GLOBAL_GITHUB_TOKEN;
    const octokit = octokitFactory(spokeToken);

    labelToSpoke[label] = { owner: spoke.owner, repo: spoke.repo, tenantId };

    const lessons = await safeGetTextContent(octokit, spoke.owner, spoke.repo, 'lessons.md');
    const decisionLogText = await safeGetTextContent(octokit, spoke.owner, spoke.repo, 'ai_decision_log.json');
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
  `).join('\\n');

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

  // The critical anti-hallucination gate - see this function's header
  // comment. Rejects the proposal outright if the model's own cited
  // evidence doesn't actually clear the bar, regardless of has_proposal.
  if (!citedEvidenceMeetsBar(citedLabels, labelToSpoke)) {
    return { pool: 'shared', status: 'Skipped', reason: 'Cited evidence does not meet the cross-organization bar (needs 2+ distinct tenants, or 3+ distinct repos within one tenant)', dryRun };
  }

  const supportingSpokes = citedLabels.map(label => labelToSpoke[label]).filter(Boolean);

  if (dryRun) {
    return { pool: 'shared', status: 'DryRunProposal', dryRun: true, proposal: result, supportingSpokes };
  }

  // Live: same "propose via PR against the hub, never push directly"
  // mechanism as runForTenant - real names are used here in the PR body
  // (built from the code-side labelToSpoke map, never from model output),
  // since the human reviewing/merging already has full visibility into
  // spokes.json/tenants.json. The anonymization boundary is the model's
  // own reasoning, not the operator reading the PR.
  const defaultBranch = await getDefaultBranch(hubOctokit, HUB_OWNER, HUB_REPO);
  const { data: baseRef } = await hubOctokit.git.getRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `heads/${defaultBranch}` });
  const branchName = `recursive-learning-shared-pool-${Date.now()}`;
  await hubOctokit.git.createRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `refs/heads/${branchName}`, sha: baseRef.object.sha });

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
      const { data } = await hubOctokit.repos.getContent({ owner: HUB_OWNER, repo: HUB_REPO, path: file.path, ref: branchName });
      existingSha = data.sha;
    } catch (e) {
      existingSha = undefined;
    }
    const params = {
      owner: HUB_OWNER, repo: HUB_REPO, path: file.path, branch: branchName,
      message: `docs: recursive-learning proposal for ${file.path} (shared cross-organization pool)`,
      content: Buffer.from(file.content).toString('base64')
    };
    if (existingSha) params.sha = existingSha;
    await hubOctokit.repos.createOrUpdateFileContents(params);
  }

  const supportingList = supportingSpokes.map(s => `\\`${s.owner}/${s.repo}\\` (tenant \\`${s.tenantId}\\`)`).join(', ');
  const pr = await hubOctokit.pulls.create({
    owner: HUB_OWNER, repo: HUB_REPO,
    title: `Recursive Learning: proposed cross-organization pattern (shared pool)`,
    head: branchName,
    base: defaultBranch,
    body: `### Reasoning\\n${result.reasoning}\\n\\n### Supporting repos\\n${supportingList}\\n\\n---\\nGenerated automatically by \\`api/recursive_learning.js\\` from a pattern the model reported recurring across the repos above - all opted into the shared learning pool (\\`shareLearnings: true\\`) and spanning ${new Set(supportingSpokes.map(s => s.tenantId)).size} distinct tenant(s). This is a proposal, not a decision - review before merging, and consider whether this generalization is fair to every contributing organization.`
  });

  return { pool: 'shared', status: 'Success', dryRun: false, pullRequestUrl: pr.data.html_url, supportingSpokes };
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
  `).join('\\n');

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
    body: `### Reasoning\\n${result.reasoning}\\n\\n---\\nGenerated automatically by \\`api/recursive_learning.js\\` from patterns observed across ${tenantSpokes.length} spoke(s) belonging to **tenant \\`${tenantId}\\`** (\\`${tenant?.name || tenantId}\\`). This is a proposal, not a decision - review before merging, and consider whether generalizing a pattern from one customer's projects into the shared global standard is appropriate before doing so.`
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

  // Additional, separate pass: repos that opted in (spoke.shareLearnings)
  // get pooled together regardless of which tenant owns them, looking for
  // patterns that recur ACROSS organizations - see runForSharedPool's own
  // header comment for the anonymization/anti-hallucination safeguards.
  // Not a tenant, so it isn't forced into the `results` array shape above.
  const sharedPoolSpokes = selectSharedPoolSpokes(spokes);
  const sharedPoolResult = await runForSharedPool({
    sharedPoolSpokes, tenants, octokitFactory, hubOctokit, fetchImpl, dryRun,
    universalLessons, globalNorthStar, HUB_OWNER, HUB_REPO
  });

  return { httpStatus: 200, body: { status: 'Completed', dryRun, tenantCount: results.length, results, sharedPoolResult } };
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
}"""
        },
        {
            # Dedicated, credential-free liveness route for the CD pipelines'
            # post-deploy smoke test (scripts/smoke-test.js) - deliberately
            # never one of the AI-calling endpoints above, which need real
            # credentials and could have side effects.
            "path": "api/health.js",
            "content": """// Minimal liveness endpoint - confirms the deployment is up and responding
// to real HTTP requests, with zero external dependencies (no GitHub call,
// no AI call, no credentials needed at all, no side effects). This is
// what .github/workflows/deploy-vercel.yml's post-deploy smoke test
// (scripts/smoke-test.js) hits before considering a deploy successful -
// deliberately NOT smoke-testing api/autonomous_agent.js/
// api/recursive_learning.js directly, since those need real GitHub/AI
// credentials to do anything meaningful and could have side effects; a
// dedicated liveness endpoint is the standard, safe pattern instead.
//
// Includes the deployed commit SHA - Vercel sets VERCEL_GIT_COMMIT_SHA
// automatically on every deployment - so a smoke test (or a human) can
// confirm a deploy actually shipped the EXPECTED commit, not just that
// something is listening on the URL.

export function buildHealthResponse({ now = Date.now(), env = process.env } = {}) {
  return {
    status: 'ok',
    timestamp: new Date(now).toISOString(),
    commit: env.VERCEL_GIT_COMMIT_SHA || null
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  res.status(200).json(buildHealthResponse({}));
}
"""
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
const TENANTS_REGISTRY_PATH = join(process.cwd(), 'tenants.json');
const DEFAULT_TENANT_ID = 'default';
const DECISION_LOG_PATH = 'ai_decision_log.json';
const ARCHIVE_LOG_PATH = 'ai_decision_log_archive.json';
const DEFAULT_RETENTION_DAYS = 90;

function loadJsonArrayFromDisk(path) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function loadSpokesRegistry() {
  return loadJsonArrayFromDisk(SPOKES_REGISTRY_PATH);
}

function loadTenantsRegistry() {
  return loadJsonArrayFromDisk(TENANTS_REGISTRY_PATH);
}

// Same env:/kv: scheme and TODO as api/autonomous_agent.js's resolveSecretRef.
function resolveSecretRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] || null;
  if (ref.startsWith('kv:')) return null;
  return null;
}

function resolveTenantIdForSpoke(owner, repo, spokes) {
  const match = spokes.find(s => s && s.owner === owner && s.repo === repo);
  return (match && match.tenantId) || DEFAULT_TENANT_ID;
}

function findTenant(tenantId, tenants) {
  return tenants.find(t => t && t.tenantId === tenantId) || null;
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

// Multi-tenancy: each spoke's decision log is pruned using ITS tenant's own
// resolved credential when `octokitFactory` is supplied in `options`
// (decision #1 in lessons.md's multi-tenancy entry) - falls back to the
// single `octokit` passed in when octokitFactory isn't given, so existing
// single-tenant callers/tests keep working unchanged.
export async function pruneAllSpokes(octokit, options = {}) {
  const { octokitFactory, spokesOverride, tenantsOverride, ...pruneOptions } = options;
  const spokes = spokesOverride || loadSpokesRegistry();
  const tenants = tenantsOverride || loadTenantsRegistry();
  const results = [];
  for (const spoke of spokes) {
    try {
      let spokeOctokit = octokit;
      if (octokitFactory) {
        const tenantId = resolveTenantIdForSpoke(spoke.owner, spoke.repo, spokes);
        const tenant = findTenant(tenantId, tenants);
        const token = (tenant && resolveSecretRef(tenant.githubCredentialRef)) || process.env.GLOBAL_GITHUB_TOKEN;
        spokeOctokit = octokitFactory(token);
      }
      results.push(await pruneSpoke(spokeOctokit, spoke, pruneOptions));
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
  const octokitFactory = (token) => new Octokit({ auth: token });

  pruneAllSpokes(octokit, { retentionDays, dryRun, octokitFactory })
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
// Multi-tenancy: each spoke's own data (issues filed, decision log) is read
// using ITS tenant's own resolved credential when octokitFactory is
// supplied (decision #1 in lessons.md's multi-tenancy entry) - falls back
// to the single `octokit` passed to buildFullReport when octokitFactory
// isn't given, so existing single-tenant callers/tests keep working
// unchanged. The report itself (and the pinned issue it publishes to) stay
// hub-wide/operator-facing - this is about using the right credential to
// read each spoke, not about splitting the report per tenant.
//
// Usage: node scripts/health-report.js

import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = join(process.cwd(), 'spokes.json');
const TENANTS_REGISTRY_PATH = join(process.cwd(), 'tenants.json');
const DEFAULT_TENANT_ID = 'default';
const DECISION_LOG_PATH = 'ai_decision_log.json';
const HUB_ISSUE_LABEL = 'cto-hub-auto';
const REPORT_ISSUE_LABEL = 'mothership-health-report';
const REPORT_ISSUE_TITLE = 'Mothership Health Report';
const REPORT_WINDOW_DAYS = 7;

const HUB_OWNER = process.env.HUB_GITHUB_OWNER || 'adamberneche-afk';
const HUB_REPO = process.env.HUB_GITHUB_REPO || 'Mothership';

function loadJsonArrayFromDisk(path) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function loadSpokesRegistry() {
  return loadJsonArrayFromDisk(SPOKES_REGISTRY_PATH);
}

function loadTenantsRegistry() {
  return loadJsonArrayFromDisk(TENANTS_REGISTRY_PATH);
}

// Same env:/kv: scheme and TODO as api/autonomous_agent.js's resolveSecretRef.
function resolveSecretRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] || null;
  if (ref.startsWith('kv:')) return null;
  return null;
}

function resolveTenantIdForSpoke(owner, repo, spokes) {
  const match = spokes.find(s => s && s.owner === owner && s.repo === repo);
  return (match && match.tenantId) || DEFAULT_TENANT_ID;
}

function findTenant(tenantId, tenants) {
  return tenants.find(t => t && t.tenantId === tenantId) || null;
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

export async function buildFullReport(octokit, { now = Date.now(), windowDays = REPORT_WINDOW_DAYS, octokitFactory, spokesOverride, tenantsOverride } = {}) {
  const spokes = spokesOverride || loadSpokesRegistry();
  const tenants = tenantsOverride || loadTenantsRegistry();
  const windowStart = new Date(now - windowDays * 24 * 60 * 60 * 1000);
  const generatedAt = new Date(now).toISOString();

  const resolveOctokitForSpoke = (spoke) => {
    if (!octokitFactory) return octokit;
    const tenantId = resolveTenantIdForSpoke(spoke.owner, spoke.repo, spokes);
    const tenant = findTenant(tenantId, tenants);
    const token = (tenant && resolveSecretRef(tenant.githubCredentialRef)) || process.env.GLOBAL_GITHUB_TOKEN;
    return octokitFactory(token);
  };

  const spokeReports = [];
  for (const spoke of spokes) {
    try {
      spokeReports.push(await buildReportForSpoke(resolveOctokitForSpoke(spoke), spoke, { windowStart }));
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
// disaster this whole system exists to avoid repeating. Always uses the
// hub's own credential (never a tenant-scoped one) - this issue lives on
// the hub repo itself.
// A per-spoke `.error` (set in buildFullReport's catch block) means a real
// fetch/API failure happened for that spoke - distinct from a spoke that's
// just quiet (0 issues, 0 decisions, both legitimate report values, not
// errors). Exported and tested directly, per this project's
// testable-core/thin-CLI-shell convention, rather than inlined only in the
// CLI guard block below.
export function hasSpokeErrors(report) {
  return report.spokes.some((s) => s && s.error);
}

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
  const octokitFactory = (token) => new Octokit({ auth: token });

  buildFullReport(octokit, { octokitFactory })
    .then(async (report) => {
      const body = renderReportMarkdown(report);
      console.log(body);
      const result = await publishReport(octokit, body);
      console.log(JSON.stringify(result));

      // The report itself still gets published either way (best-effort,
      // matching this project's "a failing spoke's read shouldn't block
      // reporting on the rest" design) - but the job must exit non-zero when
      // hasSpokeErrors is true, so the notify-on-failure step in
      // health-report.yml actually fires for this class of problem, instead
      // of a genuine per-spoke failure silently reading as a successful run.
      if (hasSpokeErrors(report)) {
        const erroredSpokes = report.spokes.filter((s) => s && s.error);
        console.error(`${erroredSpokes.length} spoke(s) failed to report: ${erroredSpokes.map((s) => `${s.owner}/${s.repo}`).join(', ')}`);
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
"""
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
// Multi-tenancy: each spoke's issues/decision log are read using ITS
// tenant's own resolved credential when octokitFactory is supplied
// (decision #1 in lessons.md's multi-tenancy entry) - falls back to the
// single `octokit` passed to collectFeedbackForAllSpokes when
// octokitFactory isn't given, so existing single-tenant callers/tests keep
// working unchanged.
//
// Usage: node scripts/collect-issue-feedback.js

import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = join(process.cwd(), 'spokes.json');
const TENANTS_REGISTRY_PATH = join(process.cwd(), 'tenants.json');
const DEFAULT_TENANT_ID = 'default';
const DECISION_LOG_PATH = 'ai_decision_log.json';
const HUB_ISSUE_LABEL = 'cto-hub-auto';

function loadJsonArrayFromDisk(path) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function loadSpokesRegistry() {
  return loadJsonArrayFromDisk(SPOKES_REGISTRY_PATH);
}

function loadTenantsRegistry() {
  return loadJsonArrayFromDisk(TENANTS_REGISTRY_PATH);
}

// Same env:/kv: scheme and TODO as api/autonomous_agent.js's resolveSecretRef.
function resolveSecretRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] || null;
  if (ref.startsWith('kv:')) return null;
  return null;
}

function resolveTenantIdForSpoke(owner, repo, spokes) {
  const match = spokes.find(s => s && s.owner === owner && s.repo === repo);
  return (match && match.tenantId) || DEFAULT_TENANT_ID;
}

function findTenant(tenantId, tenants) {
  return tenants.find(t => t && t.tenantId === tenantId) || null;
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
  const { octokitFactory, spokesOverride, tenantsOverride, ...collectOptions } = options;
  const spokes = spokesOverride || loadSpokesRegistry();
  const tenants = tenantsOverride || loadTenantsRegistry();
  const results = [];
  for (const spoke of spokes) {
    try {
      let spokeOctokit = octokit;
      if (octokitFactory) {
        const tenantId = resolveTenantIdForSpoke(spoke.owner, spoke.repo, spokes);
        const tenant = findTenant(tenantId, tenants);
        const token = (tenant && resolveSecretRef(tenant.githubCredentialRef)) || process.env.GLOBAL_GITHUB_TOKEN;
        spokeOctokit = octokitFactory(token);
      }
      results.push(await collectFeedbackForSpoke(spokeOctokit, spoke, collectOptions));
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
  const octokitFactory = (token) => new Octokit({ auth: token });

  collectFeedbackForAllSpokes(octokit, { octokitFactory })
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
// Multi-tenancy: each spoke is checked using ITS OWN tenant's resolved
// GitHub credential (decision #1 in lessons.md's multi-tenancy entry), not
// one shared token - see checkSpokeRepoReachable/checkSpokeHasCallHubWorkflow/
// checkSpokeHasHubUrlSecret's octokitFactory parameter. checkGlobalGithubToken
// still checks the HUB's own token specifically (that's what it's for), via
// the octokit instance the CLI wrapper passes in directly.
//
// Usage: node scripts/doctor.js

import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = join(process.cwd(), 'spokes.json');
const TENANTS_REGISTRY_PATH = join(process.cwd(), 'tenants.json');
const DEFAULT_TENANT_ID = 'default';
const CALL_HUB_WORKFLOW_PATH = '.github/workflows/call-hub.yml';
const HUB_URL_SECRET_NAMES = ['VERCEL_URL', 'APPS_SCRIPT_URL'];

function loadJsonArrayFromDisk(path) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function loadSpokesRegistry() {
  return loadJsonArrayFromDisk(SPOKES_REGISTRY_PATH);
}

function loadTenantsRegistry() {
  return loadJsonArrayFromDisk(TENANTS_REGISTRY_PATH);
}

// Same env:/kv: scheme and TODO as api/autonomous_agent.js's resolveSecretRef.
function resolveSecretRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] || null;
  if (ref.startsWith('kv:')) return null;
  return null;
}

function resolveTenantIdForSpoke(owner, repo, spokes) {
  const match = spokes.find(s => s && s.owner === owner && s.repo === repo);
  return (match && match.tenantId) || DEFAULT_TENANT_ID;
}

function findTenant(tenantId, tenants) {
  return tenants.find(t => t && t.tenantId === tenantId) || null;
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
//
// `octokit` here checks the HUB's own token (GLOBAL_GITHUB_TOKEN) directly -
// that's the whole point of checkGlobalGithubToken. `octokitFactory(token)`
// is used per-spoke instead, resolving each spoke's OWN tenant credential
// (decision #1) rather than reusing the hub's token for every spoke's
// checks - falls back to `octokit` itself when octokitFactory isn't
// supplied, so existing single-tenant callers/tests keep working unchanged.
export async function runDoctor(octokit, { fetchImpl = fetch, env = process.env, octokitFactory, spokesOverride, tenantsOverride } = {}) {
  const checks = [];
  checks.push(await checkGlobalGithubToken(octokit, env.GLOBAL_GITHUB_TOKEN));
  checks.push(await checkAiKey(fetchImpl, env.AI_BASE_URL, env.AI_API_KEY));

  const spokes = spokesOverride || loadSpokesRegistry();
  const tenants = tenantsOverride || loadTenantsRegistry();
  const resolveOctokitForSpoke = (spoke) => {
    if (!octokitFactory) return octokit;
    const tenantId = resolveTenantIdForSpoke(spoke.owner, spoke.repo, spokes);
    const tenant = findTenant(tenantId, tenants);
    const token = (tenant && resolveSecretRef(tenant.githubCredentialRef)) || env.GLOBAL_GITHUB_TOKEN;
    return octokitFactory(token);
  };

  for (const spoke of spokes) {
    const spokeOctokit = resolveOctokitForSpoke(spoke);
    checks.push(await checkSpokeRepoReachable(spokeOctokit, spoke));
    checks.push(await checkSpokeHasCallHubWorkflow(spokeOctokit, spoke));
    checks.push(await checkSpokeHasHubUrlSecret(spokeOctokit, spoke));
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
  const octokitFactory = (token) => new Octokit({ auth: token });

  runDoctor(octokit, { fetchImpl: fetch, octokitFactory })
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

        {
            "path": "scripts/smoke-test.js",
            "content": """// Post-deploy smoke test - confirms a freshly-deployed hub endpoint is
// actually alive and responding before a CD pipeline (deploy-vercel.yml/
// deploy-apps-script.yml) considers the deploy successful. Hits the
// dedicated /health (Vercel) or ?endpoint=health (Apps Script) liveness
// route - see api/health.js/gas/Code.js's renderHealthResponse for what
// it's checking - never the AI-calling endpoints, which need real
// credentials to do anything meaningful and could have side effects.
//
// Retries a few times with a short delay before giving up, rather than
// failing on the first non-2xx/mismatch: a brief propagation lag right
// after a deploy completes (edge-cache warmup, DNS, an Apps Script
// deployment version taking a moment to become the active one) is normal,
// expected behavior, not a real problem - treating a single transient
// blip as a hard CI failure would create exactly the kind of noisy
// false-failure this project has been careful to avoid elsewhere (see
// doctor.js's deliberately narrow, honestly-scoped checks).
//
// Usage: node scripts/smoke-test.js <url> [expectedCommit]
//   node scripts/smoke-test.js https://mothership.example.com/api/health abc1234
//   node scripts/smoke-test.js "https://script.google.com/macros/s/.../exec?endpoint=health"

const TIMEOUT_MS = 15000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 3000;

// Single attempt - no retry logic here, so tests can assert exact
// pass/fail behavior for one call without needing to reason about timing.
export async function checkHealth(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, expectedCommit, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal, headers });
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, reason: 'response was not valid JSON' };
  }

  if (body.status !== 'ok') {
    return { ok: false, reason: `unexpected response body: ${JSON.stringify(body)}` };
  }

  // Apps Script's health response has no `commit` field at all (a real,
  // disclosed platform difference - see gas/Code.js's renderHealthResponse
  // comment) - only compared when both an expectation and a real value
  // exist to compare against.
  if (expectedCommit && body.commit && body.commit !== expectedCommit) {
    return { ok: false, reason: `deployed commit ${body.commit} does not match expected ${expectedCommit}` };
  }

  return { ok: true, body };
}

// Retries checkHealth up to maxAttempts times, returning as soon as one
// attempt succeeds - the actual entry point the CLI/CD pipeline uses.
export async function checkHealthWithRetry(url, {
  fetchImpl = fetch,
  timeoutMs = TIMEOUT_MS,
  expectedCommit,
  headers,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  delayMs = DEFAULT_RETRY_DELAY_MS,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  let lastResult;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await checkHealth(url, { fetchImpl, timeoutMs, expectedCommit, headers });
    if (lastResult.ok) return lastResult;
    if (attempt < maxAttempts - 1) await sleepImpl(delayMs);
  }
  return lastResult;
}

// --- CLI-only from here down ------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, expectedCommit] = process.argv.slice(2);
  if (!url) {
    console.error('Usage: node scripts/smoke-test.js <url> [expectedCommit]');
    process.exitCode = 1;
  } else {
    // Generic (not Vercel-specific) escape hatch for a platform that needs
    // one extra header to reach its own health route - e.g. Vercel
    // Deployment Protection's bypass header, set by deploy-vercel.yml via
    // SMOKE_TEST_HEADER_NAME/VALUE. Both must be non-empty, or no header is
    // sent at all - matches every other caller of VERCEL_BYPASS_TOKEN in
    // this repo, where an unset value means "no protection, nothing to add."
    const headers = (process.env.SMOKE_TEST_HEADER_NAME && process.env.SMOKE_TEST_HEADER_VALUE)
      ? { [process.env.SMOKE_TEST_HEADER_NAME]: process.env.SMOKE_TEST_HEADER_VALUE }
      : undefined;
    checkHealthWithRetry(url, { expectedCommit, headers })
      .then((result) => {
        if (result.ok) {
          console.log(`OK - ${url} is healthy: ${JSON.stringify(result.body)}`);
        } else {
          console.error(`FAIL - ${url} did not become healthy: ${result.reason}`);
          process.exitCode = 1;
        }
      })
      .catch((err) => {
        console.error(err);
        process.exitCode = 1;
      });
  }
}
"""
        },

        # 4. AUTOMATION (GitHub Actions workflows - self-reflect, maintenance,
        # health reporting, recursive learning). Without these, api/*.js and
        # scripts/*.js above are never actually invoked on any schedule - a
        # freshly-scaffolded hub would otherwise deploy successfully to Vercel
        # and sit there completely inert.
        {
            # Composite action referenced by path (uses: ./.github/actions/...)
            # from every scheduled workflow below that opts into failure
            # alerting - avoids duplicating the same alert-webhook logic six
            # times over.
            "path": ".github/actions/notify-on-failure/action.yml",
            "content": """name: 'Notify on Failure'
description: >-
  Posts a Slack-compatible webhook message when the calling job has
  failed. Opt-in and silent by design: a missing/empty webhook-url is a
  no-op, never a job failure of its own - alerting is a real, disclosed
  gap when unconfigured, not a hard requirement. Add as the LAST step in
  a job, with `if: failure()`, so it only ever fires once something has
  already actually gone wrong.
inputs:
  webhook-url:
    description: >-
      Slack-compatible incoming webhook URL (the ALERT_WEBHOOK_URL
      secret). A Discord webhook also works if you append /slack to its
      URL - Discord's own compatibility mode for this exact payload
      shape. Empty/unset = no-op.
    required: false
    default: ''
  workflow-name:
    description: 'Human-readable label for which workflow/job failed, shown in the alert.'
    required: true
runs:
  using: 'composite'
  steps:
    - shell: bash
      run: |
        if [ -z "${{ inputs.webhook-url }}" ]; then
          echo "ALERT_WEBHOOK_URL not configured - skipping failure notification (see README's Deployment & Maintenance section)."
          exit 0
        fi
        RUN_URL="${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
        PAYLOAD=$(printf '{"text":":rotating_light: Mothership workflow *%s* failed - %s"}' "${{ inputs.workflow-name }}" "$RUN_URL")
        # Never fails this step (and so never adds a second, confusing
        # failure on top of the real one that triggered it) if the
        # notification itself can't be delivered - the underlying
        # workflow failure is still the real signal either way; check the
        # Actions tab directly if this warning appears.
        curl -sf -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "${{ inputs.webhook-url }}" \\
          || echo "::warning::Failed to deliver the failure notification itself - the workflow failure that triggered it is still real, see the Actions tab."
"""
        },

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
      # Only needed so the notify-on-failure composite action below (a
      # local action, referenced by path) is present on the runner - this
      # job itself reads no repo files.
      - uses: actions/checkout@v4

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
          curl -sf -X POST "${HUB_VERCEL_URL}/api/autonomous_agent" \\
            -H "Content-Type: application/json" \\
            -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_TOKEN}" \\
            -d '{
              "owner": "${{ github.repository_owner }}",
              "repo": "${{ github.event.repository.name }}",
              "mode": "refactor"
            }'

      - name: Notify on failure
        if: failure()
        uses: ./.github/actions/notify-on-failure
        with:
          webhook-url: ${{ secrets.ALERT_WEBHOOK_URL }}
          workflow-name: 'Hub Self-Reflection'
"""
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
        run: node scripts/prune-logs.js

      - name: Notify on failure
        if: failure()
        uses: ./.github/actions/notify-on-failure
        with:
          webhook-url: ${{ secrets.ALERT_WEBHOOK_URL }}
          workflow-name: 'Prune Decision Logs'
"""
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
        run: node scripts/health-report.js

      - name: Notify on failure
        if: failure()
        uses: ./.github/actions/notify-on-failure
        with:
          webhook-url: ${{ secrets.ALERT_WEBHOOK_URL }}
          workflow-name: 'Health Report'
"""
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
        run: node scripts/collect-issue-feedback.js

      - name: Notify on failure
        if: failure()
        uses: ./.github/actions/notify-on-failure
        with:
          webhook-url: ${{ secrets.ALERT_WEBHOOK_URL }}
          workflow-name: 'Collect Issue Feedback'
"""
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
      # Only needed so the notify-on-failure composite action below (a
      # local action, referenced by path) is present on the runner - this
      # job itself reads no repo files.
      - uses: actions/checkout@v4

      - name: Ping Hub for cross-spoke aggregation
        env:
          HUB_VERCEL_URL: ${{ secrets.HUB_VERCEL_URL }}
          # See self-reflect.yml - required while the deployment has Vercel
          # Deployment Protection enabled.
          VERCEL_BYPASS_TOKEN: ${{ secrets.VERCEL_BYPASS_TOKEN }}
        run: |
          curl -sf -X POST "${HUB_VERCEL_URL}/api/recursive_learning" \\
            -H "Content-Type: application/json" \\
            -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_TOKEN}" \\
            -d '{}'

      - name: Notify on failure
        if: failure()
        uses: ./.github/actions/notify-on-failure
        with:
          webhook-url: ${{ secrets.ALERT_WEBHOOK_URL }}
          workflow-name: 'Recursive Learning'
"""
        },
        {
            "path": ".github/workflows/deploy-vercel.yml",
            "content": """name: Deploy to Vercel

# Real CD for the Vercel backend, closing the gap this whole
# deployment-pipeline sprint exists to close: nothing in this repo has ever
# auto-deployed anywhere before this workflow. A push to main deploys to
# production; a pull request targeting main deploys a preview - which IS
# this project's staging environment for the Vercel backend (a real,
# isolated deployment per PR, not a separate long-lived environment to
# maintain). Both paths are smoke-tested against Phase 1's /api/health
# route before being considered successful.
#
# NOT live-verified end-to-end: no Vercel account/token is reachable from
# this environment, so this workflow's actual `vercel` CLI behavior has
# never been run for real. The `pull`/`build`/`deploy --prebuilt` sequence
# below is Vercel's own documented CI recipe - flagged here, honestly, as
# "should work per the documented interface," not "confirmed working,"
# the same disclosure discipline this project applies to every other
# untestable-from-here integration (see README's Stripe webhook note).
#
# Known, disclosed limitation: a pull_request from a fork does not receive
# repository secrets (a GitHub Actions security restriction, not a bug
# here) - so a preview deploy only works for PRs from branches within this
# same repository. Fine for this project's current single-operator model;
# would need re-architecting (e.g. a separate workflow_run-triggered job)
# if external contributions are ever accepted.

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-vercel-${{ github.ref }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # only used to comment the preview URL back onto the PR
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Install Vercel CLI
        run: npm install --global vercel@latest

      # Step output, not an inline ternary expression repeated in every
      # later step - this project's own established preference (see
      # lessons.md's Sprint 4 entry on `setup_spoke.py`'s cron/mode wiring).
      - name: Determine deploy target
        id: target
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            echo "environment=preview" >> "$GITHUB_OUTPUT"
            echo "prod_flag=" >> "$GITHUB_OUTPUT"
          else
            echo "environment=production" >> "$GITHUB_OUTPUT"
            echo "prod_flag=--prod" >> "$GITHUB_OUTPUT"
          fi

      - name: Pull Vercel project configuration
        run: vercel pull --yes --environment=${{ steps.target.outputs.environment }} --token="$VERCEL_TOKEN"

      - name: Build project artifacts
        run: vercel build ${{ steps.target.outputs.prod_flag }} --token="$VERCEL_TOKEN"

      - name: Deploy the prebuilt output
        id: deploy
        run: |
          url=$(vercel deploy --prebuilt ${{ steps.target.outputs.prod_flag }} --token="$VERCEL_TOKEN")
          echo "url=$url" >> "$GITHUB_OUTPUT"

      - name: Smoke test the deployment
        env:
          # Only needed if the deployment has Vercel Deployment Protection
          # enabled (see README's "Enable Hub Self-Analysis" section for
          # where this token comes from) - empty/unset means no header is
          # sent at all, matching every other caller of this same secret.
          SMOKE_TEST_HEADER_NAME: x-vercel-protection-bypass
          SMOKE_TEST_HEADER_VALUE: ${{ secrets.VERCEL_BYPASS_TOKEN }}
        run: node scripts/smoke-test.js "${{ steps.deploy.outputs.url }}/api/health" "${{ github.sha }}"

      - name: Comment the preview URL on the PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const url = `${{ steps.deploy.outputs.url }}`;
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `**Vercel preview deployed and smoke-tested:** ${url}\\n\\nThis is the staging deployment for this PR - it's automatically replaced on every new push.`
            });

      # Only wired for the production path. A preview-deploy failure is
      # already visible to whoever opened the PR, directly as a failing
      # check - the silent-failure risk this whole sprint exists to close
      # is specifically the unattended, post-merge production path.
      - name: Notify on failure
        if: failure() && github.event_name != 'pull_request'
        uses: ./.github/actions/notify-on-failure
        with:
          webhook-url: ${{ secrets.ALERT_WEBHOOK_URL }}
          workflow-name: 'Deploy to Vercel (production)'
"""
        },
        {
            "path": ".github/workflows/deploy-apps-script.yml",
            "content": """name: Deploy to Google Apps Script

# Real CD for the Apps Script backend, matching deploy-vercel.yml's shape:
# push to main -> production (GAS_PROD_DEPLOYMENT_ID); a pull request
# targeting main -> a separate, persistent staging deployment
# (GAS_STAGING_DEPLOYMENT_ID) - Apps Script's equivalent of a PR preview.
# Both are existing Apps Script deployments, created once by hand via the
# IDE (see README's "Alternative: Deploy Without Vercel" section) -
# `clasp deploy -i <id>` updates a specific deployment's code in place
# rather than minting a new one, which is what keeps each deployment's Web
# App URL stable across every CD run instead of changing on every deploy
# the way a plain `clasp deploy` (no `-i`) would.
#
# NOT live-verified end-to-end: no Google account/clasp credential is
# reachable from this environment. clasp's own OAuth credential file has
# moved location across versions (~/.clasprc.json in older releases,
# ~/.config/clasp/.clasprc.json from clasp 2.4+) - this workflow writes the
# decoded CLASPRC_JSON secret to both paths to hedge against that, but
# which one a real `clasp push`/`clasp deploy` actually reads has never
# been confirmed from this session. Flagged honestly, same disclosure
# standard as deploy-vercel.yml.
#
# Known, disclosed limitation: same as deploy-vercel.yml - a pull_request
# from a fork doesn't receive repository secrets, so a staging deploy only
# works for PRs from branches within this same repository.

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-apps-script-${{ github.ref }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # only used to comment the staging URL back onto the PR
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install clasp
        run: npm install --global @google/clasp@latest

      - name: Restore clasp credentials
        env:
          CLASPRC_JSON: ${{ secrets.CLASPRC_JSON }}
        run: |
          mkdir -p "$HOME/.config/clasp"
          echo "$CLASPRC_JSON" | base64 -d > "$HOME/.clasprc.json"
          echo "$CLASPRC_JSON" | base64 -d > "$HOME/.config/clasp/.clasprc.json"

      - name: Write .clasp.json for this run
        env:
          GAS_SCRIPT_ID: ${{ secrets.GAS_SCRIPT_ID }}
        run: |
          cat > gas/.clasp.json <<CLASPJSON
          { "scriptId": "$GAS_SCRIPT_ID", "rootDir": "." }
          CLASPJSON

      # Step output, not an inline ternary expression repeated in every
      # later step - matches deploy-vercel.yml and this project's own
      # established preference (see lessons.md's Sprint 4 entry).
      - name: Determine deploy target
        id: target
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            echo "deployment_id=${{ secrets.GAS_STAGING_DEPLOYMENT_ID }}" >> "$GITHUB_OUTPUT"
            echo "web_app_url=${{ secrets.GAS_STAGING_WEB_APP_URL }}" >> "$GITHUB_OUTPUT"
            echo "label=staging" >> "$GITHUB_OUTPUT"
          else
            echo "deployment_id=${{ secrets.GAS_PROD_DEPLOYMENT_ID }}" >> "$GITHUB_OUTPUT"
            echo "web_app_url=${{ secrets.GAS_WEB_APP_URL }}" >> "$GITHUB_OUTPUT"
            echo "label=production" >> "$GITHUB_OUTPUT"
          fi

      - name: Push source to the Apps Script project
        working-directory: gas
        run: clasp push --force

      - name: Update the target deployment in place
        working-directory: gas
        run: clasp deploy -i "${{ steps.target.outputs.deployment_id }}" -d "Deployed from ${{ github.sha }} (${{ steps.target.outputs.label }})"

      - name: Smoke test the deployment
        # No expected-commit check here, unlike deploy-vercel.yml - Apps
        # Script's health response has no commit field to compare against
        # (see gas/Code.js's renderHealthResponse comment), and
        # smoke-test.js already treats that as a real, disclosed platform
        # difference rather than a mismatch.
        run: node scripts/smoke-test.js "${{ steps.target.outputs.web_app_url }}?endpoint=health"

      - name: Comment the staging URL on the PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const url = `${{ steps.target.outputs.web_app_url }}`;
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `**Apps Script staging deployment updated and smoke-tested:** ${url}?endpoint=health\\n\\nThis is a persistent staging deployment (stable URL, unlike a fresh Vercel preview) updated in place by this PR.`
            });

      # Only wired for the production path - same reasoning as
      # deploy-vercel.yml: a staging-deploy failure is already visible to
      # whoever opened the PR as a failing check.
      - name: Notify on failure
        if: failure() && github.event_name != 'pull_request'
        uses: ./.github/actions/notify-on-failure
        with:
          webhook-url: ${{ secrets.ALERT_WEBHOOK_URL }}
          workflow-name: 'Deploy to Google Apps Script (production)'
"""
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