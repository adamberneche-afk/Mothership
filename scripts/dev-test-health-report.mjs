// Local verification harness for scripts/health-report.js.
//
// Same rationale as the other dev-test-*.mjs harnesses: no live GitHub
// writes here, everything runs against a hand-rolled fake octokit.
//
// Usage: node scripts/dev-test-health-report.mjs

import { buildFullReport, buildReportForSpoke, renderReportMarkdown, publishReport } from './health-report.js';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

// --- Fakes -------------------------------------------------------------------

function makeFakeOctokit({ issuesByRepo = {}, decisionLogByRepo = {}, existingReportIssue = null } = {}) {
  const calls = { listForRepo: [], issuesCreate: [], issuesUpdate: [], getContent: [] };
  let reportIssue = existingReportIssue;
  return {
    calls,
    getReportIssue: () => reportIssue,
    repos: {
      getContent: async ({ owner, repo, path }) => {
        calls.getContent.push({ owner, repo, path });
        const key = `${owner}/${repo}`;
        if (path === 'ai_decision_log.json' && decisionLogByRepo[key] !== undefined) {
          return { data: { content: Buffer.from(JSON.stringify(decisionLogByRepo[key])).toString('base64') } };
        }
        throw new Error('404 not found');
      }
    },
    issues: {
      listForRepo: async ({ owner, repo, labels }) => {
        calls.listForRepo.push({ owner, repo, labels });
        // The report-issue lookup (hub's own repo, REPORT_ISSUE_LABEL) is
        // distinguished from a spoke's cto-hub-auto issue lookup by label.
        if (labels === 'mothership-health-report') {
          return { data: reportIssue ? [reportIssue] : [] };
        }
        const key = `${owner}/${repo}`;
        return { data: issuesByRepo[key] || [] };
      },
      create: async (params) => {
        calls.issuesCreate.push(params);
        reportIssue = { number: 1, title: params.title, html_url: 'https://github.com/fake/fake/issues/1', state: 'open' };
        return { data: reportIssue };
      },
      update: async (params) => {
        calls.issuesUpdate.push(params);
        if (reportIssue && params.issue_number === reportIssue.number && params.state) {
          reportIssue.state = params.state;
        }
        return { data: {} };
      }
    }
  };
}

const NOW = new Date('2026-08-06T00:00:00Z').getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function entryAt(daysAgo, outcome) {
  return { timestamp: new Date(NOW - daysAgo * DAY_MS).toISOString(), mode: 'debug', commitSha: `sha-${daysAgo}`, outcome, issueUrl: null, summary: null };
}

function issueAt(daysAgo) {
  return { created_at: new Date(NOW - daysAgo * DAY_MS).toISOString() };
}

// --- Tests -------------------------------------------------------------------

async function testSpokeReportCountsAndStatusAreCorrect() {
  console.log('Sprint 5: a spoke report counts issues/decisions in the window and infers live status');
  const octokit = makeFakeOctokit({
    issuesByRepo: { 'o/r': [issueAt(1), issueAt(3), issueAt(20)] }, // 2 in a 7-day window, 1 outside
    decisionLogByRepo: {
      'o/r': [entryAt(1, 'created'), entryAt(2, 'no_findings'), entryAt(3, 'no_findings'), entryAt(30, 'created')]
    }
  });
  const report = await buildReportForSpoke(octokit, { owner: 'o', repo: 'r' }, { windowStart: new Date(NOW - 7 * DAY_MS) });
  check('issuesFiled counts only issues inside the window', report.issuesFiled === 2);
  check('entriesInWindow excludes the 30-day-old entry', report.entriesInWindow === 3);
  check('byOutcome tallies correctly', report.byOutcome.created === 1 && report.byOutcome.no_findings === 2);
  check('skipRate is 2/3', Math.abs(report.skipRate - 2 / 3) < 1e-9);
  check("status reflects 'live'", report.capabilityStatus.includes('live'));
}

async function testDryRunOnlySpokeReportsDryRunStatus() {
  console.log('Sprint 5: a spoke with only dry-run findings is reported as dry-run, not live');
  const octokit = makeFakeOctokit({
    issuesByRepo: { 'o/r': [] },
    decisionLogByRepo: { 'o/r': [entryAt(1, 'dry_run_would_create'), entryAt(2, 'no_findings')] }
  });
  const report = await buildReportForSpoke(octokit, { owner: 'o', repo: 'r' }, { windowStart: new Date(NOW - 7 * DAY_MS) });
  check('issuesFiled is 0', report.issuesFiled === 0);
  check("status reflects 'dry-run'", report.capabilityStatus.includes('dry-run'));
}

async function testNoActivitySpokeReportsNoDecisionsLogged() {
  console.log('Sprint 5: a spoke with zero decisions this window is reported distinctly from "no findings"');
  const octokit = makeFakeOctokit({ issuesByRepo: { 'o/r': [] }, decisionLogByRepo: { 'o/r': [] } });
  const report = await buildReportForSpoke(octokit, { owner: 'o', repo: 'r' }, { windowStart: new Date(NOW - 7 * DAY_MS) });
  check('skipRate is null (no denominator)', report.skipRate === null);
  check("status mentions no decisions logged", report.capabilityStatus.includes('no decisions logged'));
}

async function testMarkdownRendersEmptySpokeListGracefully() {
  console.log('Sprint 5: rendering a report with zero registered spokes does not error');
  const markdown = renderReportMarkdown({ generatedAt: new Date(NOW).toISOString(), windowDays: 7, spokes: [] });
  check('mentions no spokes registered', /no spokes registered/i.test(markdown));
}

async function testPublishReportCreatesThenUpdatesInPlace() {
  console.log('Sprint 5: publishReport creates once, then updates the same issue on subsequent runs');
  const octokit = makeFakeOctokit({});
  const firstResult = await publishReport(octokit, '# report v1');
  check('first run creates the issue', firstResult.action === 'created');
  check('exactly one issue created', octokit.calls.issuesCreate.length === 1);

  const secondResult = await publishReport(octokit, '# report v2');
  check('second run updates instead of creating a duplicate', secondResult.action === 'updated');
  check('still exactly one issue ever created', octokit.calls.issuesCreate.length === 1);
  check('exactly one update call happened', octokit.calls.issuesUpdate.length === 1);
}

async function testPublishReportReopensAClosedIssue() {
  console.log('Sprint 5 fix: publishReport reopens the pinned issue if a human closed it');
  const octokit = makeFakeOctokit({
    existingReportIssue: { number: 7, title: 'Mothership Health Report', html_url: 'https://github.com/fake/fake/issues/7', state: 'closed' }
  });
  const result = await publishReport(octokit, '# new report');
  check("action is 'reopened', not 'updated'", result.action === 'reopened');
  check('the update call explicitly reopens it', octokit.calls.issuesUpdate[0]?.state === 'open');
  check('the fake issue is now open', octokit.getReportIssue().state === 'open');
}

async function testPublishReportDoesNotTouchStateWhenAlreadyOpen() {
  console.log('Sprint 5: publishReport leaves an already-open issue’s state alone');
  const octokit = makeFakeOctokit({
    existingReportIssue: { number: 7, title: 'Mothership Health Report', html_url: 'https://github.com/fake/fake/issues/7', state: 'open' }
  });
  const result = await publishReport(octokit, '# new report');
  check("action is 'updated'", result.action === 'updated');
  check('no state field was sent', octokit.calls.issuesUpdate[0]?.state === undefined);
}

async function testBuildFullReportUsesRealRegistryWithoutCrashing() {
  console.log('Sprint 5: buildFullReport reads the real (possibly absent) spokes.json without crashing');
  // This branch doesn't have spokes.json yet (Sprint 2 hasn't merged here) -
  // buildFullReport should treat that exactly like an empty registry.
  const octokit = makeFakeOctokit({});
  const report = await buildFullReport(octokit, { now: NOW });
  check('report has a spokes array', Array.isArray(report.spokes));
  check('generatedAt is set', typeof report.generatedAt === 'string');
}

async function main() {
  await testSpokeReportCountsAndStatusAreCorrect();
  await testDryRunOnlySpokeReportsDryRunStatus();
  await testNoActivitySpokeReportsNoDecisionsLogged();
  await testMarkdownRendersEmptySpokeListGracefully();
  await testPublishReportCreatesThenUpdatesInPlace();
  await testPublishReportReopensAClosedIssue();
  await testPublishReportDoesNotTouchStateWhenAlreadyOpen();
  await testBuildFullReportUsesRealRegistryWithoutCrashing();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
