// Real, Mothership-native scheduled-job watchdog — closes the gap this
// project's own lessons.md documents as its founding incident:
// GLOBAL_GITHUB_TOKEN went invalid and health-report.yml failed silently
// for five straight scheduled runs before anyone noticed. Nothing before
// this checked whether a scheduled workflow's last run actually succeeded,
// or whether a workflow file was even valid in the first place — the
// second, more dangerous failure mode a companion audit (The Pivot
// Ledger's "an invalid workflow file is a more dangerous silence than a
// failing one") documents from a different repo: an unparseable workflow
// file produces no run at all, not even a failing one, so there's no red X
// to eventually notice.
//
// Two checks, one pinned issue (same "update in place, never spam a new
// issue" pattern as health-report.js's publishReport):
//   1. actionlint against every .github/workflows/*.yml file — catches
//      both plain YAML syntax errors and GitHub-Actions-expression-context
//      errors (e.g. a bare secrets.X inside an if:) a generic YAML parser
//      would miss, and is the same tool KOS's own gas-lint.yml already
//      uses for this exact purpose.
//   2. For every workflow file with an `on.schedule` trigger, the most
//      recent scheduled run's conclusion via the Actions API — flagged
//      only if that run's conclusion isn't 'success', never based on how
//      long ago it ran (a monthly-cadence workflow isn't "overdue" a week
//      after running; recursive-learning.yml fires once a month by design).
//
// Usage: node scripts/watchdog.js

import { Octokit } from '@octokit/rest';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const HUB_OWNER = process.env.HUB_GITHUB_OWNER || 'adamberneche-afk';
const HUB_REPO = process.env.HUB_GITHUB_REPO || 'Mothership';
const WATCHDOG_ISSUE_LABEL = 'mothership-watchdog';
const WATCHDOG_ISSUE_TITLE = 'Mothership Scheduled-Job Watchdog';
const WORKFLOWS_DIR = '.github/workflows';

export function listWorkflowFiles(dir = WORKFLOWS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
}

// True if the file's own `on:` block declares a `schedule:` trigger — a
// plain string check, not a YAML parse, deliberately: this needs to keep
// working even for a workflow file actionlint has already flagged as
// invalid, so an already-broken file isn't silently skipped by the
// run-conclusion check too (it just won't have a run history to report on).
export function hasScheduleTrigger(fileContent) {
  return /^\s*schedule:\s*$/m.test(fileContent);
}

// Runs actionlint against every workflow file in one pass. Returns a map
// of filename -> array of finding strings (empty array = clean). actionlint
// itself reports across every file in one non-zero-exit run, so this
// parses its output rather than invoking it once per file.
//
// `execFn` is injectable (same dependency-injection convention as
// octokitFactory/fetchImpl elsewhere in this project) so tests can supply a
// fake instead of requiring the real actionlint binary on the test runner's
// PATH — the CI workflow that actually runs this installs the real one.
export function runActionlint(dir = WORKFLOWS_DIR, { actionlintBin = 'actionlint', execFn = execFileSync } = {}) {
  const results = {};
  for (const f of listWorkflowFiles(dir)) results[f] = [];
  try {
    execFn(actionlintBin, [], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return results; // exit 0 — every file clean
  } catch (e) {
    const output = `${e.stdout || ''}${e.stderr || ''}`;
    for (const line of output.split('\n')) {
      const m = line.match(/^\.github\/workflows\/([^:]+):/);
      if (m && results[m[1]] !== undefined) results[m[1]].push(line.trim());
    }
    return results;
  }
}

export async function checkScheduledWorkflowRuns(octokit, owner, repo, { dir = WORKFLOWS_DIR } = {}) {
  const findings = [];
  for (const f of listWorkflowFiles(dir)) {
    const content = readFileSync(join(dir, f), 'utf8');
    if (!hasScheduleTrigger(content)) continue;
    try {
      const { data } = await octokit.actions.listWorkflowRuns({
        owner, repo, workflow_id: f, event: 'schedule', per_page: 1
      });
      const run = data.workflow_runs[0];
      if (!run) {
        findings.push({ file: f, issue: 'has a schedule trigger but has never had a scheduled run recorded' });
      } else if (run.conclusion && run.conclusion !== 'success') {
        findings.push({ file: f, issue: `last scheduled run concluded '${run.conclusion}' (${run.html_url})` });
      }
    } catch (e) {
      findings.push({ file: f, issue: `could not check run history: ${e.message}` });
    }
  }
  return findings;
}

export function buildWatchdogReport({ yamlFindings, runFindings, checkedAt }) {
  const lines = [];
  lines.push(`_Last checked: ${checkedAt}_`, '');

  const yamlBad = Object.entries(yamlFindings).filter(([, errs]) => errs.length > 0);
  lines.push('## Workflow file validity (actionlint)');
  if (yamlBad.length === 0) {
    lines.push('✅ Every `.github/workflows/*.yml` file is valid.');
  } else {
    for (const [file, errs] of yamlBad) {
      lines.push(`- ❌ **${file}**`);
      for (const e of errs) lines.push(`  - \`${e}\``);
    }
  }
  lines.push('');

  lines.push('## Scheduled-run status');
  if (runFindings.length === 0) {
    lines.push("✅ Every scheduled workflow's most recent run concluded successfully.");
  } else {
    for (const f of runFindings) lines.push(`- ❌ **${f.file}** — ${f.issue}`);
  }

  return lines.join('\n');
}

async function findExistingWatchdogIssue(octokit) {
  const { data } = await octokit.issues.listForRepo({
    owner: HUB_OWNER, repo: HUB_REPO, state: 'all', labels: WATCHDOG_ISSUE_LABEL, per_page: 10
  });
  return data.find((issue) => issue.title === WATCHDOG_ISSUE_TITLE) || null;
}

// Same update-in-place pattern as health-report.js's publishReport — one
// pinned issue, reopened if a human closed it, never a fresh issue per run.
export async function publishWatchdogReport(octokit, body) {
  const existing = await findExistingWatchdogIssue(octokit);
  if (existing) {
    const updateParams = { owner: HUB_OWNER, repo: HUB_REPO, issue_number: existing.number, body };
    const wasClosed = existing.state === 'closed';
    if (wasClosed) updateParams.state = 'open';
    await octokit.issues.update(updateParams);
    return { action: wasClosed ? 'reopened' : 'updated', issueUrl: existing.html_url };
  }
  const created = await octokit.issues.create({
    owner: HUB_OWNER, repo: HUB_REPO, title: WATCHDOG_ISSUE_TITLE, body, labels: [WATCHDOG_ISSUE_LABEL]
  });
  return { action: 'created', issueUrl: created.data.html_url };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
  const yamlFindings = runActionlint();
  checkScheduledWorkflowRuns(octokit, HUB_OWNER, HUB_REPO)
    .then(async (runFindings) => {
      const body = buildWatchdogReport({ yamlFindings, runFindings, checkedAt: new Date().toISOString() });
      const result = await publishWatchdogReport(octokit, body);
      console.log(`Watchdog report ${result.action}: ${result.issueUrl}`);
      const hasFailures = Object.values(yamlFindings).some((e) => e.length > 0) || runFindings.length > 0;
      process.exitCode = hasFailures ? 1 : 0;
    })
    .catch((err) => {
      console.error('Watchdog run failed:', err);
      process.exitCode = 1;
    });
}
