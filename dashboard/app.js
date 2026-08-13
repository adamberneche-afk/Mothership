// Client-side port of scripts/health-report.js's buildReportForSpoke -
// same metrics, same window, same status inference - reading straight from
// GitHub's public REST API instead of via octokit/Actions, since
// Mothership and every spoke are public repos and this data is all
// unauthenticated-readable. No backend of this dashboard's own exists or
// is needed.
//
// Known, disclosed limitation: unauthenticated GitHub API calls are capped
// at 60 requests/hour per IP. Fine for a single-operator dashboard opened a
// few times a day; would need a caching proxy (the same Apps Script
// deployment in gas/ could serve this read-only, authenticated, with a
// much higher cap) if usage ever grows past that. This is surfaced to the
// user (footer copy + the rate-limited status below) rather than left as
// just a code comment - hitting it should look distinctly different from
// an actual problem, not paint every spoke red.
//
// A short-lived sessionStorage cache (CACHE_TTL_MS below) sits in front of
// the per-spoke calls specifically because of that cap. A passive trigger
// (the initial load, returning to a backgrounded tab, the browser reporting
// connectivity restored) skips the network entirely for any spoke whose
// cache is still fresh - real budget savings, not just an instant repaint.
// An explicit user action (clicking Refresh, pressing 'r') always forces a
// real fetch regardless of freshness, on the theory that a user who just
// asked for current data shouldn't silently get served something up to
// CACHE_TTL_MS old - see loadDashboard's `force` parameter. Either way, a
// stale (expired) cache entry is still shown instantly as a placeholder
// while the real fetch runs in the background (stale-while-revalidate),
// rather than going blank while waiting.

const HUB_OWNER = 'adamberneche-afk';
const HUB_REPO = 'Mothership';
const HUB_ISSUE_LABEL = 'cto-hub-auto';
const REPORT_WINDOW_DAYS = 7;
const GITHUB_API = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 45000;
const CACHE_PREFIX = 'mothership-dashboard:';
const BASE_TITLE = document.title;

// The hub's own scheduled automation - "is the swarm's own machinery
// actually running," not spoke activity. ci.yml is deliberately excluded:
// it's a PR/push code-quality gate, not a scheduled operational signal an
// operator needs a glance at here.
const HUB_WORKFLOWS = [
  { file: 'self-reflect.yml', label: 'Hub Self-Reflection' },
  { file: 'health-report.yml', label: 'Health Report' },
  { file: 'recursive-learning.yml', label: 'Recursive Learning' },
  { file: 'prune-logs.yml', label: 'Prune Decision Logs' },
];

// Human labels for the raw decision-log outcome enum (ai_decision_log.json's
// `outcome` field) - shown in the "Outcome breakdown" column instead of the
// snake_case identifiers those files actually store.
const OUTCOME_LABELS = {
  created: 'Issue created',
  dry_run_would_create: 'Would create (dry-run)',
  rate_capped: 'Skipped (rate cap)',
  no_diff_skip: 'Skipped (no diff)',
  invalid_ai_response: 'Skipped (invalid AI response)',
  no_findings: 'Skipped (no findings)',
  ai_error: 'Skipped (AI call failed)',
  unknown: 'Unknown outcome',
};

function outcomeLabel(key) {
  return OUTCOME_LABELS[key] || key;
}

// --- sessionStorage cache, guarded against every way it can fail ---------
// Private-browsing mode, a full quota, or storage disabled outright can all
// make sessionStorage throw on read or write - caching is a nice-to-have,
// never something that should crash the dashboard, so every access is
// wrapped and a failure just means "behave as if there's no cache."

function readCache(key, { ignoreTtl = false } = {}) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!ignoreTtl && Date.now() - entry.ts > CACHE_TTL_MS) return null;
    return entry;
  } catch (e) {
    return null;
  }
}

function writeCache(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), value }));
  } catch (e) {
    // ignore - private browsing / quota exceeded / storage disabled
  }
}

function spokeCacheKey(owner, repo) {
  return `${CACHE_PREFIX}spoke:${owner}/${repo}`;
}

const SPOKES_CACHE_KEY = `${CACHE_PREFIX}spokes.json`;

// --- localStorage durable fallback, for genuinely offline use ------------
// The sessionStorage cache above exists purely to cut request volume and
// deliberately forgets everything the moment the tab/browser session ends
// - it was never meant as an offline store. This second, separate layer
// is: no TTL, no expiry, survives across sessions (days, if that's how
// long it's been since the tab was last online), and is read ONLY as a
// last resort when there's nothing fresher to show - a genuinely offline
// load (a brand-new tab, zero network) still shows real "last known status
// as of 3 days ago" data instead of a bare failure message. Same guarded
// try/catch pattern as the sessionStorage helpers: a failure here just
// means "no offline fallback available," never a crash.
const LAST_KNOWN_PREFIX = 'mothership-dashboard-last-known:';

function readLastKnown(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeLastKnown(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), value }));
  } catch (e) {
    // ignore - private browsing / quota exceeded / storage disabled
  }
}

function lastKnownSpokeKey(owner, repo) {
  return `${LAST_KNOWN_PREFIX}spoke:${owner}/${repo}`;
}

const SPOKES_LAST_KNOWN_KEY = `${LAST_KNOWN_PREFIX}spokes.json`;

function hubWorkflowCacheKey(file) {
  return `${CACHE_PREFIX}hub-workflow:${file}`;
}

function lastKnownHubWorkflowKey(file) {
  return `${LAST_KNOWN_PREFIX}hub-workflow:${file}`;
}

// Only real, successful reports are worth caching - caching a transient
// failure (rate-limited/timed out/couldn't load) would just serve that same
// failure back on the next load within the TTL window instead of trying
// again, which is the opposite of what the cache is for.
const FAILURE_STATUSES = new Set(["couldn't load", 'rate-limited', 'timed out']);

// --- fetch helpers ---------------------------------------------------------

// Rate-limit detail for a failed request. Every endpoint this dashboard
// calls (repo contents, issue listing on a public repo) 404s on a missing
// resource - it doesn't 403 - so a 403 here is treated as the 60-req/hr cap
// rather than trying to distinguish it further. Deliberately does NOT
// require reading x-ratelimit-remaining/-reset to make that call: this is a
// cross-origin fetch to api.github.com, and browsers only expose the
// CORS-safelisted response headers to JS unless the server adds an
// Access-Control-Expose-Headers header naming the rest - so those headers
// may not be readable at all. When they are, the reset time is shown too;
// when they aren't, the status still correctly reads "rate-limited" instead
// of falling through to a falsely-alarming generic "couldn't load".
function rateLimitInfo(res) {
  if (res.status !== 403) return null;
  const resetHeader = res.headers.get('x-ratelimit-reset');
  return { resetAt: resetHeader ? new Date(Number(resetHeader) * 1000) : null };
}

// A hung request (flaky network, captive portal) used to leave the Refresh
// button disabled and the status stuck on "Loading…" forever, with no way
// to recover short of a hard reload. A timeout turns that into a distinct,
// recoverable status instead of an indefinite wait.
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github.v3+json' }, signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`${url} -> ${res.status}`);
      err.status = res.status;
      err.rateLimited = rateLimitInfo(res);
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      const timeoutErr = new Error(`${url} timed out after ${FETCH_TIMEOUT_MS}ms`);
      timeoutErr.timedOut = true;
      throw timeoutErr;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// GitHub's Contents API returns base64 wrapped at 60 chars/line - atob()
// chokes on embedded newlines, so they're stripped first.
//
// Returns { ok: true, text } on success, or { ok: false, rateLimited,
// timedOut } on failure - deliberately not collapsing every failure to a
// bare `null`, so callers can tell "reached the API, file doesn't exist
// yet" (a spoke that's simply quiet) apart from "couldn't reach the API at
// all" (rate-limited, timed out, or down - a real problem, or at least not
// evidence of anything).
async function fetchDecodedFile(owner, repo, path) {
  try {
    const data = await fetchJson(`${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
    return { ok: true, text: atob(data.content.replace(/\n/g, '')) };
  } catch (e) {
    if (e.status === 404) return { ok: true, text: null }; // file genuinely doesn't exist - not an error
    return { ok: false, rateLimited: e.rateLimited || null, timedOut: !!e.timedOut };
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

// A stray null/non-object entry (a bad manual edit, a trailing-comma
// artifact) used to throw inside buildReportForSpoke and take the whole
// batch down with it - see the per-spoke isolation in loadDashboard for the
// other half of that fix. This half just means a malformed entry never gets
// that far: it's silently dropped rather than crashing anything.
function validSpokes(arr) {
  return arr.filter((s) => s && typeof s === 'object' && typeof s.owner === 'string' && s.owner && typeof s.repo === 'string' && s.repo);
}

function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item);
    (out[k] = out[k] || []).push(item);
  }
  return out;
}

// Same ok/rateLimited/timedOut shape as fetchDecodedFile, wrapping a count
// instead of file text.
async function countIssuesCreatedSince(owner, repo, windowStart) {
  let data;
  try {
    data = await fetchJson(
      `${GITHUB_API}/repos/${owner}/${repo}/issues?state=all&labels=${HUB_ISSUE_LABEL}&sort=created&direction=desc&per_page=100`
    );
  } catch (e) {
    return { ok: false, rateLimited: e.rateLimited || null, timedOut: !!e.timedOut };
  }
  let count = 0;
  for (const issue of data) {
    if (new Date(issue.created_at) < windowStart) break;
    count++;
  }
  return { ok: true, count };
}

// Same ok/rateLimited/timedOut shape as fetchDecodedFile/
// countIssuesCreatedSince, wrapping the most recent run of one workflow.
// GitHub returns `workflow_runs: []` (total_count 0) for a workflow that has
// never run - not a 404 - so `run: null` on success means "never run,"
// genuinely distinct from "couldn't check."
async function fetchLatestWorkflowRun(owner, repo, file) {
  try {
    const data = await fetchJson(`${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${file}/runs?per_page=1`);
    return { ok: true, run: (data.workflow_runs && data.workflow_runs[0]) || null };
  } catch (e) {
    return { ok: false, rateLimited: e.rateLimited || null, timedOut: !!e.timedOut };
  }
}

// Mirrors scripts/health-report.js's buildReportForSpoke - same fields, same
// status-inference rules, plus distinct 'error'/'rate-limited'/'timed out'
// statuses this client-side port needs that the Actions-run original
// doesn't (a failed GitHub API call there is a workflow failure, not a UI
// state to render).
async function buildReportForSpoke(spoke, windowStart) {
  const [issuesResult, logResult] = await Promise.all([
    countIssuesCreatedSince(spoke.owner, spoke.repo, windowStart),
    fetchDecodedFile(spoke.owner, spoke.repo, 'ai_decision_log.json'),
  ]);

  if (!issuesResult.ok || !logResult.ok) {
    const timedOut = issuesResult.timedOut || logResult.timedOut;
    const rateLimited = issuesResult.rateLimited || logResult.rateLimited;
    return {
      owner: spoke.owner,
      repo: spoke.repo,
      issuesFiled: null,
      entriesInWindow: null,
      byOutcome: {},
      skipRate: null,
      capabilityStatus: timedOut ? 'timed out' : rateLimited ? 'rate-limited' : "couldn't load",
      rateLimitResetAt: rateLimited ? rateLimited.resetAt : null,
    };
  }

  const allEntries = safeParseJsonArray(logResult.text);
  const recentEntries = allEntries.filter((e) => e && e.timestamp && new Date(e.timestamp) >= windowStart);

  const byOutcomeGroups = groupBy(recentEntries, (e) => e.outcome || 'unknown');
  const byOutcome = Object.fromEntries(Object.entries(byOutcomeGroups).map(([k, v]) => [k, v.length]));
  const total = recentEntries.length;
  const createdCount = byOutcome.created || 0;
  const dryRunFindingCount = byOutcome.dry_run_would_create || 0;
  const skipRate = total > 0 ? 1 - createdCount / total : null;

  let capabilityStatus;
  if (total === 0) {
    capabilityStatus = 'no decisions logged this window';
  } else if (createdCount > 0) {
    capabilityStatus = 'live';
  } else if (dryRunFindingCount > 0) {
    capabilityStatus = 'dry-run';
  } else {
    capabilityStatus = 'active, no findings';
  }

  return { owner: spoke.owner, repo: spoke.repo, issuesFiled: issuesResult.count, entriesInWindow: total, byOutcome, skipRate, capabilityStatus };
}

// Defense in depth: even after validSpokes filters the obviously-malformed
// entries, buildReportForSpoke is still one unexpected error away from
// taking the whole Promise.all-shaped batch down with it. Wrapping every
// per-spoke call means one spoke's surprise is that spoke's problem, never
// everyone else's.
async function safeBuildReport(spoke, windowStart) {
  try {
    return await buildReportForSpoke(spoke, windowStart);
  } catch (e) {
    return {
      owner: spoke.owner,
      repo: spoke.repo,
      issuesFiled: null,
      entriesInWindow: null,
      byOutcome: {},
      skipRate: null,
      capabilityStatus: "couldn't load",
      rateLimitResetAt: null,
    };
  }
}

// Defense in depth, same reasoning as safeBuildReport above: one workflow's
// unexpected error should never take the others down with it.
async function safeBuildHubWorkflowReport(entry) {
  try {
    return await buildHubWorkflowReport(entry);
  } catch (e) {
    return { file: entry.file, label: entry.label, lastRunAt: null, htmlUrl: null, hubStatus: "couldn't load" };
  }
}

// Mirrors buildReportForSpoke's shape, but classifying a workflow's most
// recent run instead of a spoke's decision log: 'never run' (zero runs
// ever - a real, distinct answer, not a failure), 'in progress' (still
// running), 'healthy' (last completed run succeeded), 'failing' (completed
// with any other conclusion - failure/cancelled/timed_out/etc).
async function buildHubWorkflowReport(entry) {
  const result = await fetchLatestWorkflowRun(HUB_OWNER, HUB_REPO, entry.file);
  if (!result.ok) {
    return {
      file: entry.file,
      label: entry.label,
      lastRunAt: null,
      htmlUrl: null,
      hubStatus: result.timedOut ? 'timed out' : result.rateLimited ? 'rate-limited' : "couldn't load",
      rateLimitResetAt: result.rateLimited ? result.rateLimited.resetAt : null,
    };
  }
  const run = result.run;
  if (!run) {
    return {
      file: entry.file,
      label: entry.label,
      lastRunAt: null,
      htmlUrl: `https://github.com/${HUB_OWNER}/${HUB_REPO}/actions/workflows/${entry.file}`,
      hubStatus: 'never run',
    };
  }
  const hubStatus = run.status !== 'completed' ? 'in progress' : run.conclusion === 'success' ? 'healthy' : 'failing';
  return { file: entry.file, label: entry.label, lastRunAt: run.created_at, htmlUrl: run.html_url, hubStatus };
}

// Only real answers are worth caching - a transient fetch failure isn't,
// same reasoning as FAILURE_STATUSES below (this is the hub-workflow
// equivalent of that same set).
const HUB_FAILURE_STATUSES = new Set(["couldn't load", 'rate-limited', 'timed out']);

// Worst-first: an actively failing or unreachable workflow outranks one
// that's simply never been exercised, which outranks one currently running.
const HUB_STATUS_SEVERITY = {
  "couldn't load": 0,
  'timed out': 0,
  failing: 0,
  'rate-limited': 1,
  'never run': 2,
  'in progress': 3,
  healthy: 4,
};

function hubStatusRank(status) {
  return status in HUB_STATUS_SEVERITY ? HUB_STATUS_SEVERITY[status] : 99;
}

function hubStatusClass(status) {
  if (status === 'healthy') return 'good';
  if (status === 'in progress') return 'neutral';
  if (status === 'never run' || status === 'rate-limited') return 'warn';
  return 'critical'; // failing, couldn't load, timed out
}

function hubStatusLabel(report) {
  let label;
  if (report.hubStatus === 'timed out') {
    label = 'timed out - try again';
  } else if (report.hubStatus === 'rate-limited') {
    label = report.rateLimitResetAt
      ? `rate-limited - retry in ${formatCountdown(report.rateLimitResetAt)}`
      : 'rate-limited - retry later';
  } else {
    label = report.hubStatus;
  }
  if (report.fromCache) return `${label} (cached)`;
  if (report.offlineAsOf) return `${label} (offline - last seen ${formatRelativeTime(new Date(report.offlineAsOf))})`;
  return label;
}

// Ranks worst-first so a real problem is never buried below quiet spokes.
// 'no decisions logged this window' is deliberately NOT treated as bad here
// - it means nothing happened, not that something is wrong.
const STATUS_SEVERITY = {
  "couldn't load": 0,
  'timed out': 0,
  'rate-limited': 1,
  'dry-run': 2,
  'active, no findings': 3,
  'no decisions logged this window': 4,
  live: 5,
};

function statusRank(status) {
  return status in STATUS_SEVERITY ? STATUS_SEVERITY[status] : 99;
}

function statusClass(status) {
  if (status === 'live') return 'good';
  if (status === 'dry-run') return 'warn';
  if (status === 'rate-limited') return 'warn';
  if (status === "couldn't load" || status === 'timed out') return 'critical';
  return 'neutral';
}

function statusLabel(report) {
  let label;
  if (report.capabilityStatus === 'timed out') {
    label = 'timed out - try again';
  } else if (report.capabilityStatus === 'rate-limited') {
    label = report.rateLimitResetAt
      ? `rate-limited - retry in ${formatCountdown(report.rateLimitResetAt)}`
      : 'rate-limited - retry later';
  } else {
    label = report.capabilityStatus;
  }
  if (report.fromCache) return `${label} (cached)`;
  if (report.offlineAsOf) return `${label} (offline - last seen ${formatRelativeTime(new Date(report.offlineAsOf))})`;
  return label;
}

// --- rendering: a keyed reconciliation instead of clear-and-rebuild -------
// Wiping tbody and re-appending fresh rows on every load (including a
// manual Refresh with perfectly good data already on screen) makes the
// table visibly disappear and reappear on every click. Reusing existing
// <tr> elements keyed by owner/repo - updating their cell text in place,
// only adding/removing rows when the actual spoke set changes - means old
// data stays visible until its replacement is ready, and this is also what
// lets a background cache-revalidation patch a single row without touching
// any other spoke's row at all.

function buildRow(report) {
  const row = document.createElement('tr');
  row.dataset.key = `${report.owner}/${report.repo}`;

  const repoCell = document.createElement('td');
  const link = document.createElement('a');
  link.target = '_blank';
  link.rel = 'noopener';
  const newTabHint = document.createElement('span');
  newTabHint.className = 'sr-only';
  newTabHint.textContent = ' (opens in a new tab)';
  link.appendChild(newTabHint);
  repoCell.appendChild(link);
  row.appendChild(repoCell);

  row.appendChild(tdText(''));
  row.appendChild(tdText(''));
  row.appendChild(tdText(''));

  const statusCell = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = 'chip';
  statusCell.appendChild(chip);
  row.appendChild(statusCell);

  row.appendChild(tdText('', true));

  updateRow(row, report);
  return row;
}

function updateRow(row, report) {
  const cells = row.children;

  const link = cells[0].querySelector('a');
  link.href = `https://github.com/${report.owner}/${report.repo}`;
  const label = `${report.owner}/${report.repo}`;
  if (link.firstChild && link.firstChild.nodeType === Node.TEXT_NODE) {
    link.firstChild.textContent = label;
  } else {
    link.insertBefore(document.createTextNode(label), link.firstChild);
  }

  cells[1].textContent = report.issuesFiled === null ? 'n/a' : report.issuesFiled;
  cells[2].textContent = report.entriesInWindow === null ? 'n/a' : report.entriesInWindow;
  cells[3].textContent = report.skipRate === null ? 'n/a' : `${Math.round(report.skipRate * 100)}%`;

  const chip = cells[4].querySelector('.chip');
  // A stale offline fallback always renders neutral regardless of its
  // historical status - a days-old "live" shouldn't paint green at a
  // glance and read as "currently fine," when what's actually known is
  // only "was fine as of however long ago the label says."
  chip.className = `chip chip-${report.offlineAsOf ? 'neutral' : statusClass(report.capabilityStatus)}`;
  chip.textContent = statusLabel(report);

  const outcomes = Object.entries(report.byOutcome).map(([k, v]) => `${outcomeLabel(k)}: ${v}`).join(', ') || 'none';
  cells[5].textContent = outcomes;
  cells[5].className = 'muted';
}

function tdText(text, muted = false) {
  const td = document.createElement('td');
  td.textContent = text;
  if (muted) td.className = 'muted';
  return td;
}

function findRowByKey(tbody, key) {
  for (const row of tbody.children) {
    if (row.dataset.key === key) return row;
  }
  return null;
}

function renderRows(tbody, reports) {
  const sorted = [...reports].sort((a, b) => statusRank(a.capabilityStatus) - statusRank(b.capabilityStatus));
  const seen = new Set();
  let cursor = tbody.firstElementChild;

  for (const report of sorted) {
    const key = `${report.owner}/${report.repo}`;
    seen.add(key);
    let row = findRowByKey(tbody, key);
    if (row) {
      updateRow(row, report);
      if (row !== cursor) tbody.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
    } else {
      row = buildRow(report);
      tbody.insertBefore(row, cursor);
    }
  }

  for (const row of Array.from(tbody.children)) {
    if (!seen.has(row.dataset.key)) row.remove();
  }
}

function upsertReport(reports, report) {
  const idx = reports.findIndex((r) => r.owner === report.owner && r.repo === report.repo);
  if (idx >= 0) reports[idx] = report;
  else reports.push(report);
}

// --- hub-health rows: same keyed-reconciliation shape as the spoke rows
// above, keyed by workflow file instead of owner/repo. findRowByKey/tdText
// below are already generic enough to reuse as-is.

function buildHubRow(report) {
  const row = document.createElement('tr');
  row.dataset.key = report.file;

  const nameCell = document.createElement('td');
  const link = document.createElement('a');
  link.target = '_blank';
  link.rel = 'noopener';
  const newTabHint = document.createElement('span');
  newTabHint.className = 'sr-only';
  newTabHint.textContent = ' (opens in a new tab)';
  link.appendChild(newTabHint);
  nameCell.appendChild(link);
  row.appendChild(nameCell);

  row.appendChild(tdText('', true));

  const statusCell = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = 'chip';
  statusCell.appendChild(chip);
  row.appendChild(statusCell);

  updateHubRow(row, report);
  return row;
}

function updateHubRow(row, report) {
  const cells = row.children;

  const link = cells[0].querySelector('a');
  link.href = report.htmlUrl || `https://github.com/${HUB_OWNER}/${HUB_REPO}/actions`;
  if (link.firstChild && link.firstChild.nodeType === Node.TEXT_NODE) {
    link.firstChild.textContent = report.label;
  } else {
    link.insertBefore(document.createTextNode(report.label), link.firstChild);
  }

  cells[1].textContent = report.lastRunAt ? formatRelativeTime(new Date(report.lastRunAt)) : 'never';
  cells[1].title = report.lastRunAt ? new Date(report.lastRunAt).toLocaleString() : '';

  const chip = cells[2].querySelector('.chip');
  chip.className = `chip chip-${report.offlineAsOf ? 'neutral' : hubStatusClass(report.hubStatus)}`;
  chip.textContent = hubStatusLabel(report);
}

function renderHubRows(tbody, reports) {
  const sorted = [...reports].sort((a, b) => hubStatusRank(a.hubStatus) - hubStatusRank(b.hubStatus));
  const seen = new Set();
  let cursor = tbody.firstElementChild;

  for (const report of sorted) {
    const key = report.file;
    seen.add(key);
    let row = findRowByKey(tbody, key);
    if (row) {
      updateHubRow(row, report);
      if (row !== cursor) tbody.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
    } else {
      row = buildHubRow(report);
      tbody.insertBefore(row, cursor);
    }
  }

  for (const row of Array.from(tbody.children)) {
    if (!seen.has(row.dataset.key)) row.remove();
  }
}

function upsertHubReport(reports, report) {
  const idx = reports.findIndex((r) => r.file === report.file);
  if (idx >= 0) reports[idx] = report;
  else reports.push(report);
}

// --- document title: a backgrounded/pinned tab should still say something -
// Reads liveReports/liveHubReports directly rather than taking them as
// parameters - both sections call this after every render, and threading
// two arrays through every call site added nothing but noise.

function updateDocumentTitle() {
  const hasSpokeProblem = liveReports.some((r) => STATUS_SEVERITY[r.capabilityStatus] === 0);
  const hasHubProblem = liveHubReports.some((r) => HUB_STATUS_SEVERITY[r.hubStatus] === 0);
  document.title = hasSpokeProblem || hasHubProblem ? `⚠ ${BASE_TITLE}` : BASE_TITLE;
}

// --- "Updated Xs/Xm ago" - stays honest without a manual refresh ----------

let lastUpdatedAt = null;
let relativeTimeTimer = null;

function formatRelativeTime(date) {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  // Only the offline last-known fallback (localStorage, no expiry) can
  // realistically age into days - the "Updated ..." line and the
  // sessionStorage cache never live long enough to reach this branch.
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Counts down to a future time instead of up from a past one - the
// rate-limited chip's inverse of formatRelativeTime above, reusing the same
// tick (relativeTimeTimer) rather than a second interval.
function formatCountdown(target) {
  const seconds = Math.round((target.getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function refreshStatusTimestamp(statusEl) {
  if (!lastUpdatedAt) return;
  statusEl.textContent = `Updated ${formatRelativeTime(lastUpdatedAt)} · window: last ${REPORT_WINDOW_DAYS} days · source: api.github.com (unauthenticated, capped at 60 requests/hour)`;
  statusEl.title = lastUpdatedAt.toLocaleString();
}

// --- main load/refresh flow ------------------------------------------------

let loadInFlight = false;
let liveReports = [];
let liveHubReports = [];

// Everything this section touches (spokes.json + per-spoke reports) is
// independent of loadHubHealthSection below - split out so one section's
// failure (or its own early-exit branches) never blocks the other from
// running. Returns true when it's set a terminal status message of its own
// (no spokes.json, no fallback available; or a genuinely empty registry) -
// the caller uses that to know not to overwrite it with a generic "Updated
// ..." timestamp, matching this function's own pre-split behavior exactly.
async function loadSpokeSection(force) {
  const statusEl = document.getElementById('status');
  const tbody = document.getElementById('report-body');
  const emptyEl = document.getElementById('empty-state');
  const windowStart = new Date(Date.now() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const spokesResult = await fetchDecodedFile(HUB_OWNER, HUB_REPO, 'spokes.json');
  let spokes;
  if (spokesResult.ok) {
    spokes = validSpokes(safeParseJsonArray(spokesResult.text));
    writeCache(SPOKES_CACHE_KEY, spokes);
    writeLastKnown(SPOKES_LAST_KNOWN_KEY, spokes);
  } else {
    // Fall back to the last-known spoke list - sessionStorage first (any
    // age within this browser session beats nothing), then the durable
    // localStorage copy if the session itself is fresh too (a brand-new
    // tab with zero network has no sessionStorage entry at all, but may
    // still have a days-old localStorage one from a previous session) -
    // rather than going fully blank over a failure to fetch the registry.
    const fallback = readCache(SPOKES_CACHE_KEY, { ignoreTtl: true }) || readLastKnown(SPOKES_LAST_KNOWN_KEY);
    if (!fallback) {
      statusEl.textContent = spokesResult.timedOut
        ? 'Timed out loading spokes.json - check your connection and try again.'
        : spokesResult.rateLimited
          ? "GitHub's unauthenticated rate limit (60 requests/hour) was hit while loading spokes.json - try again later."
          : "Couldn't reach GitHub to load spokes.json - check your connection and try again.";
      emptyEl.textContent = statusEl.textContent;
      emptyEl.hidden = liveReports.length > 0; // existing rows, if any, stay visible instead of being replaced by this banner
      return true;
    }
    spokes = fallback.value;
    statusEl.textContent = `Showing the last-known spoke list (${spokesResult.timedOut ? 'timed out' : spokesResult.rateLimited ? 'rate-limited' : "couldn't reach GitHub"} just now) - will retry on next refresh.`;
  }

  if (spokes.length === 0) {
    statusEl.textContent = 'spokes.json loaded but no spokes are registered yet.';
    emptyEl.textContent = statusEl.textContent;
    emptyEl.hidden = false;
    liveReports = [];
    renderRows(tbody, liveReports);
    return true;
  }

  emptyEl.hidden = true;

  await Promise.allSettled(
    spokes.map(async (spoke) => {
      const key = spokeCacheKey(spoke.owner, spoke.repo);
      // ignoreTtl: true so an *expired* entry is still readable as a
      // stale-while-revalidate placeholder below - freshness is checked
      // separately via isFresh, since "a cache entry exists" and "it's
      // still within TTL" are different questions here.
      const cached = readCache(key, { ignoreTtl: true });
      const isFresh = !!cached && Date.now() - cached.ts <= CACHE_TTL_MS;

      if (cached) {
        // Instant repaint from cache (fresh or stale) so there's never a
        // blank gap while a fetch is pending.
        upsertReport(liveReports, { ...cached.value, fromCache: true });
        renderRows(tbody, liveReports);
        updateDocumentTitle();
      }

      // A fresh, unforced load stops here - this is the actual budget
      // savings, not just an instant repaint. Forced (explicit Refresh/
      // 'r') or stale/missing always fetches.
      if (isFresh && !force) return;

      const fresh = await safeBuildReport(spoke, windowStart);
      if (!FAILURE_STATUSES.has(fresh.capabilityStatus)) {
        writeCache(key, fresh);
        writeLastKnown(lastKnownSpokeKey(spoke.owner, spoke.repo), fresh);
        upsertReport(liveReports, fresh);
      } else if (!cached) {
        // Nothing fresher (not even a stale sessionStorage entry) was
        // already on screen for this spoke - before giving up and
        // showing a bare failure, check the durable offline fallback.
        // Rendered with its own historical status/numbers, clearly aged-
        // labeled (see statusLabel/updateRow) rather than as if current.
        const lastKnown = readLastKnown(lastKnownSpokeKey(spoke.owner, spoke.repo));
        upsertReport(liveReports, lastKnown ? { ...lastKnown.value, offlineAsOf: lastKnown.ts } : fresh);
      } else {
        upsertReport(liveReports, fresh);
      }
      renderRows(tbody, liveReports);
      updateDocumentTitle();
    })
  );

  // Drop rows for spokes no longer registered (a real change, not a
  // transient hiccup - unlike the fetch-failure paths above, this one
  // should replace what's on screen).
  liveReports = liveReports.filter((r) => spokes.some((s) => s.owner === r.owner && s.repo === r.repo));
  renderRows(tbody, liveReports);
  return false;
}

// The hub's own workflows are a fixed, hardcoded list (HUB_WORKFLOWS) -
// nothing here depends on spokes.json, so this runs fully independently of
// loadSpokeSection above. Same cache-first, stale-while-revalidate,
// force-bypasses-cache shape as the per-spoke loop.
async function loadHubHealthSection(force) {
  const tbody = document.getElementById('hub-health-body');

  await Promise.allSettled(
    HUB_WORKFLOWS.map(async (entry) => {
      const key = hubWorkflowCacheKey(entry.file);
      const cached = readCache(key, { ignoreTtl: true });
      const isFresh = !!cached && Date.now() - cached.ts <= CACHE_TTL_MS;

      if (cached) {
        upsertHubReport(liveHubReports, { ...cached.value, fromCache: true });
        renderHubRows(tbody, liveHubReports);
        updateDocumentTitle();
      }

      if (isFresh && !force) return;

      const fresh = await safeBuildHubWorkflowReport(entry);
      if (!HUB_FAILURE_STATUSES.has(fresh.hubStatus)) {
        writeCache(key, fresh);
        writeLastKnown(lastKnownHubWorkflowKey(entry.file), fresh);
        upsertHubReport(liveHubReports, fresh);
      } else if (!cached) {
        const lastKnown = readLastKnown(lastKnownHubWorkflowKey(entry.file));
        upsertHubReport(liveHubReports, lastKnown ? { ...lastKnown.value, offlineAsOf: lastKnown.ts } : fresh);
      } else {
        upsertHubReport(liveHubReports, fresh);
      }
      renderHubRows(tbody, liveHubReports);
      updateDocumentTitle();
    })
  );
}

// force=true (an explicit Refresh click or 'r' keypress) always fetches
// real data regardless of cache freshness. force=false (the initial load,
// a visibility-triggered or online-triggered refetch) respects the cache -
// skipping the network entirely for anything whose cache is still within
// CACHE_TTL_MS, which is what actually protects the disclosed request
// budget rather than just repainting instantly and fetching anyway.
async function loadDashboard(force = false) {
  if (loadInFlight) return; // ignore a Refresh click (or 'r' keypress) while a load is already running
  loadInFlight = true;

  const statusEl = document.getElementById('status');
  const refreshBtn = document.getElementById('refresh');
  const panels = document.querySelectorAll('.panel');

  refreshBtn.disabled = true;
  refreshBtn.setAttribute('aria-busy', 'true');
  panels.forEach((p) => p.classList.add('refreshing'));
  if (liveReports.length === 0 && liveHubReports.length === 0) {
    statusEl.textContent = 'Loading…'; // only shown on a genuine first-ever load - a refresh with existing rows keeps them visible instead
  }

  try {
    // Two independent sections - one section's own early-exit or failure
    // never blocks the other from loading (same fault-isolation principle
    // already applied per-spoke, extended to per-section).
    const [spokeResult] = await Promise.allSettled([loadSpokeSection(force), loadHubHealthSection(force)]);
    const spokeSetTerminalMessage = spokeResult.status === 'fulfilled' && spokeResult.value === true;

    // A terminal message from the spoke section (no spokes.json, no
    // fallback; or a genuinely empty registry) is meant to stay on screen,
    // not get overwritten by a generic timestamp - matches this function's
    // pre-split behavior, where those branches returned before ever
    // reaching this point.
    if (!spokeSetTerminalMessage) {
      lastUpdatedAt = new Date();
      refreshStatusTimestamp(statusEl);
    }
    if (!relativeTimeTimer) {
      // Same tick re-renders rows too, cheap at this table size, so a
      // rate-limited chip's "retry in Xm" countdown ticks down live
      // instead of sitting frozen between loads (formatCountdown above).
      relativeTimeTimer = setInterval(() => {
        refreshStatusTimestamp(statusEl);
        renderRows(document.getElementById('report-body'), liveReports);
        renderHubRows(document.getElementById('hub-health-body'), liveHubReports);
      }, 15000);
    }
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.removeAttribute('aria-busy');
    panels.forEach((p) => p.classList.remove('refreshing'));
    loadInFlight = false;
  }
}

window.addEventListener('load', () => {
  loadDashboard();

  // Explicit user actions always force a real fetch, bypassing the cache
  // regardless of freshness - see loadDashboard's `force` parameter.
  document.getElementById('refresh').addEventListener('click', () => loadDashboard(true));

  // 'r' triggers the same Refresh action, ignored while focus is in a form
  // field or a modifier is held (so it doesn't fight browser/OS shortcuts).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    loadDashboard(true);
  });

  // A tab left open for a while just sat there with increasingly stale data
  // until someone remembered to click Refresh. Refetching on return-to-tab
  // is the fix, but deliberately unforced: the now-corrected cache means
  // this only actually spends a request on whatever's genuinely past
  // CACHE_TTL_MS per spoke, not a blind poll that would need its own
  // cadence re-tuned every time spokes.json grows (a fixed-interval poll's
  // safe interval shrinks as request-cost-per-cycle grows with spoke
  // count; a visibility-gated, cache-respecting refetch doesn't have that
  // problem - it only ever spends anything when a human is actually
  // looking, and only on what's actually stale).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadDashboard();
  });

  // Self-heals the moment connectivity is restored (e.g. a laptop waking
  // from sleep) instead of sitting in a stale/failed state until a manual
  // click - unforced for the same budget reasons as visibilitychange above.
  window.addEventListener('online', () => loadDashboard());

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
