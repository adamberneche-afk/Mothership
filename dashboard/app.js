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

const HUB_OWNER = 'adamberneche-afk';
const HUB_REPO = 'Mothership';
const HUB_ISSUE_LABEL = 'cto-hub-auto';
const REPORT_WINDOW_DAYS = 7;
const GITHUB_API = 'https://api.github.com';

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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github.v3+json' } });
  if (!res.ok) {
    const err = new Error(`${url} -> ${res.status}`);
    err.status = res.status;
    err.rateLimited = rateLimitInfo(res);
    throw err;
  }
  return res.json();
}

// GitHub's Contents API returns base64 wrapped at 60 chars/line - atob()
// chokes on embedded newlines, so they're stripped first.
//
// Returns { ok: true, text } on success, or { ok: false, rateLimited } on
// failure - deliberately not collapsing every failure to a bare `null`, so
// callers can tell "reached the API, file doesn't exist yet" (a spoke that's
// simply quiet) apart from "couldn't reach the API at all" (rate-limited or
// down - a real problem, or at least not evidence of anything).
async function fetchDecodedFile(owner, repo, path) {
  try {
    const data = await fetchJson(`${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
    return { ok: true, text: atob(data.content.replace(/\n/g, '')) };
  } catch (e) {
    if (e.status === 404) return { ok: true, text: null }; // file genuinely doesn't exist - not an error
    return { ok: false, rateLimited: e.rateLimited || null };
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

// Same ok/rateLimited shape as fetchDecodedFile, wrapping a count instead of
// file text.
async function countIssuesCreatedSince(owner, repo, windowStart) {
  let data;
  try {
    data = await fetchJson(
      `${GITHUB_API}/repos/${owner}/${repo}/issues?state=all&labels=${HUB_ISSUE_LABEL}&sort=created&direction=desc&per_page=100`
    );
  } catch (e) {
    return { ok: false, rateLimited: e.rateLimited || null };
  }
  let count = 0;
  for (const issue of data) {
    if (new Date(issue.created_at) < windowStart) break;
    count++;
  }
  return { ok: true, count };
}

// Mirrors scripts/health-report.js's buildReportForSpoke - same fields, same
// status-inference rules, plus a distinct 'error' status this client-side
// port needs that the Actions-run original doesn't (a failed GitHub API
// call there is a workflow failure, not a UI state to render).
async function buildReportForSpoke(spoke, windowStart) {
  const [issuesResult, logResult] = await Promise.all([
    countIssuesCreatedSince(spoke.owner, spoke.repo, windowStart),
    fetchDecodedFile(spoke.owner, spoke.repo, 'ai_decision_log.json'),
  ]);

  if (!issuesResult.ok || !logResult.ok) {
    const rateLimited = issuesResult.rateLimited || logResult.rateLimited;
    return {
      owner: spoke.owner,
      repo: spoke.repo,
      issuesFiled: null,
      entriesInWindow: null,
      byOutcome: {},
      skipRate: null,
      capabilityStatus: rateLimited ? 'rate-limited' : "couldn't load",
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

// Ranks worst-first so a real problem is never buried below quiet spokes.
// 'no decisions logged this window' is deliberately NOT treated as bad here
// - it means nothing happened, not that something is wrong.
const STATUS_SEVERITY = {
  "couldn't load": 0,
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
  if (status === "couldn't load") return 'critical';
  return 'neutral';
}

function statusLabel(report) {
  if (report.capabilityStatus === 'rate-limited') {
    if (report.rateLimitResetAt) {
      return `rate-limited - retry after ${report.rateLimitResetAt.toLocaleTimeString()}`;
    }
    return 'rate-limited - retry later';
  }
  return report.capabilityStatus;
}

function renderRow(report) {
  const row = document.createElement('tr');
  const skipPct = report.skipRate === null ? 'n/a' : `${Math.round(report.skipRate * 100)}%`;
  const issuesFiled = report.issuesFiled === null ? 'n/a' : report.issuesFiled;
  const outcomes = Object.entries(report.byOutcome)
    .map(([k, v]) => `${outcomeLabel(k)}: ${v}`)
    .join(', ') || 'none';

  const repoCell = document.createElement('td');
  const link = document.createElement('a');
  link.href = `https://github.com/${report.owner}/${report.repo}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.append(`${report.owner}/${report.repo}`);
  const newTabHint = document.createElement('span');
  newTabHint.className = 'sr-only';
  newTabHint.textContent = ' (opens in a new tab)';
  link.appendChild(newTabHint);
  repoCell.appendChild(link);

  row.appendChild(repoCell);
  row.appendChild(tdText(issuesFiled));
  row.appendChild(tdText(report.entriesInWindow === null ? 'n/a' : report.entriesInWindow));
  row.appendChild(tdText(skipPct));

  const statusCell = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = `chip chip-${statusClass(report.capabilityStatus)}`;
  chip.textContent = statusLabel(report);
  statusCell.appendChild(chip);
  row.appendChild(statusCell);

  row.appendChild(tdText(outcomes, true));
  return row;
}

function tdText(text, muted = false) {
  const td = document.createElement('td');
  td.textContent = text;
  if (muted) td.className = 'muted';
  return td;
}

let loadInFlight = false;

async function loadDashboard() {
  if (loadInFlight) return; // ignore a Refresh click while a load is already running
  loadInFlight = true;

  const statusEl = document.getElementById('status');
  const tbody = document.getElementById('report-body');
  const emptyEl = document.getElementById('empty-state');
  const refreshBtn = document.getElementById('refresh');
  refreshBtn.disabled = true;
  refreshBtn.setAttribute('aria-busy', 'true');
  statusEl.textContent = 'Loading…';
  emptyEl.hidden = true;
  emptyEl.textContent = '';
  tbody.innerHTML = '';

  try {
    const windowStart = new Date(Date.now() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const spokesResult = await fetchDecodedFile(HUB_OWNER, HUB_REPO, 'spokes.json');
    if (!spokesResult.ok) {
      statusEl.textContent = spokesResult.rateLimited
        ? "GitHub's unauthenticated rate limit (60 requests/hour) was hit while loading spokes.json - try again later."
        : "Couldn't reach GitHub to load spokes.json - check your connection and try again.";
      emptyEl.textContent = statusEl.textContent;
      emptyEl.hidden = false;
      return;
    }

    const spokes = safeParseJsonArray(spokesResult.text);
    if (spokes.length === 0) {
      statusEl.textContent = 'spokes.json loaded but no spokes are registered yet.';
      emptyEl.textContent = statusEl.textContent;
      emptyEl.hidden = false;
      return;
    }

    const reports = await Promise.all(spokes.map((spoke) => buildReportForSpoke(spoke, windowStart)));
    reports.sort((a, b) => statusRank(a.capabilityStatus) - statusRank(b.capabilityStatus));
    for (const report of reports) {
      tbody.appendChild(renderRow(report));
    }

    statusEl.textContent = `Updated ${new Date().toLocaleString()} · window: last ${REPORT_WINDOW_DAYS} days · source: api.github.com (unauthenticated, capped at 60 requests/hour)`;
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.removeAttribute('aria-busy');
    loadInFlight = false;
  }
}

window.addEventListener('load', () => {
  loadDashboard();
  document.getElementById('refresh').addEventListener('click', loadDashboard);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
