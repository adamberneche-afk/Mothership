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
// much higher cap) if usage ever grows past that.

const HUB_OWNER = 'adamberneche-afk';
const HUB_REPO = 'Mothership';
const HUB_ISSUE_LABEL = 'cto-hub-auto';
const REPORT_WINDOW_DAYS = 7;
const GITHUB_API = 'https://api.github.com';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github.v3+json' } });
  if (!res.ok) {
    const err = new Error(`${url} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// GitHub's Contents API returns base64 wrapped at 60 chars/line - atob()
// chokes on embedded newlines, so they're stripped first.
async function fetchDecodedFile(owner, repo, path) {
  try {
    const data = await fetchJson(`${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
    return atob(data.content.replace(/\n/g, ''));
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

async function countIssuesCreatedSince(owner, repo, windowStart) {
  let data;
  try {
    data = await fetchJson(
      `${GITHUB_API}/repos/${owner}/${repo}/issues?state=all&labels=${HUB_ISSUE_LABEL}&sort=created&direction=desc&per_page=100`
    );
  } catch (e) {
    return null; // couldn't reach the issues API - distinct from "reached it, zero results"
  }
  let count = 0;
  for (const issue of data) {
    if (new Date(issue.created_at) < windowStart) break;
    count++;
  }
  return count;
}

// Mirrors scripts/health-report.js's buildReportForSpoke exactly - same
// fields, same status-inference rules. Any change to that function's logic
// should be reflected here too.
async function buildReportForSpoke(spoke, windowStart) {
  const issuesFiled = await countIssuesCreatedSince(spoke.owner, spoke.repo, windowStart);
  const logText = await fetchDecodedFile(spoke.owner, spoke.repo, 'ai_decision_log.json');
  const allEntries = safeParseJsonArray(logText);
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

  return { owner: spoke.owner, repo: spoke.repo, issuesFiled, entriesInWindow: total, byOutcome, skipRate, capabilityStatus };
}

function statusClass(status) {
  if (status === 'live') return 'good';
  if (status === 'dry-run') return 'warn';
  if (status === 'no decisions logged this window') return 'critical';
  return 'neutral';
}

function renderRow(report) {
  const row = document.createElement('tr');
  const skipPct = report.skipRate === null ? 'n/a' : `${Math.round(report.skipRate * 100)}%`;
  const issuesFiled = report.issuesFiled === null ? 'n/a' : report.issuesFiled;
  const outcomes = Object.entries(report.byOutcome)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || 'none';

  const repoCell = document.createElement('td');
  const link = document.createElement('a');
  link.href = `https://github.com/${report.owner}/${report.repo}`;
  link.textContent = `${report.owner}/${report.repo}`;
  link.target = '_blank';
  link.rel = 'noopener';
  repoCell.appendChild(link);

  row.appendChild(repoCell);
  row.appendChild(tdText(issuesFiled));
  row.appendChild(tdText(report.entriesInWindow));
  row.appendChild(tdText(skipPct));

  const statusCell = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = `chip chip-${statusClass(report.capabilityStatus)}`;
  chip.textContent = report.capabilityStatus;
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

async function loadDashboard() {
  const statusEl = document.getElementById('status');
  const tbody = document.getElementById('report-body');
  const emptyEl = document.getElementById('empty-state');
  statusEl.textContent = 'Loading…';
  emptyEl.hidden = true;
  tbody.innerHTML = '';

  const windowStart = new Date(Date.now() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const spokesText = await fetchDecodedFile(HUB_OWNER, HUB_REPO, 'spokes.json');
  const spokes = safeParseJsonArray(spokesText);

  if (spokes.length === 0) {
    statusEl.textContent = 'Could not load spokes.json, or no spokes are registered.';
    emptyEl.hidden = false;
    return;
  }

  for (const spoke of spokes) {
    const report = await buildReportForSpoke(spoke, windowStart);
    tbody.appendChild(renderRow(report));
  }

  statusEl.textContent = `Updated ${new Date().toLocaleString()} · window: last ${REPORT_WINDOW_DAYS} days · source: api.github.com (unauthenticated)`;
}

window.addEventListener('load', () => {
  loadDashboard();
  document.getElementById('refresh').addEventListener('click', loadDashboard);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
