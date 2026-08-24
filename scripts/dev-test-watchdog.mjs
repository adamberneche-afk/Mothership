// Local verification harness for scripts/watchdog.js.
//
// Same rationale as the other dev-test-*.mjs harnesses: no live GitHub
// writes, no real actionlint binary required — everything runs against a
// hand-rolled fake octokit and an injected fake execFn.
//
// Usage: node scripts/dev-test-watchdog.mjs

import {
  listWorkflowFiles,
  hasScheduleTrigger,
  runActionlint,
  checkScheduledWorkflowRuns,
  buildWatchdogReport,
  publishWatchdogReport
} from './watchdog.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

// A real temp directory with real workflow files — hasScheduleTrigger and
// the file-reading half of checkScheduledWorkflowRuns need actual files on
// disk, not a mocked fs.
function makeWorkflowsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function makeFakeOctokitForRuns(runsByWorkflow) {
  const calls = [];
  return {
    calls,
    actions: {
      listWorkflowRuns: async ({ owner, repo, workflow_id, event }) => {
        calls.push({ owner, repo, workflow_id, event });
        const runs = runsByWorkflow[workflow_id];
        if (runs === undefined) throw new Error(`unexpected workflow_id: ${workflow_id}`);
        return { data: { workflow_runs: runs } };
      }
    }
  };
}

function makeFakeOctokitForIssues({ existingIssue = null } = {}) {
  const calls = { listForRepo: [], create: [], update: [] };
  let issue = existingIssue;
  return {
    calls,
    getIssue: () => issue,
    issues: {
      listForRepo: async (params) => {
        calls.listForRepo.push(params);
        return { data: issue ? [issue] : [] };
      },
      create: async (params) => {
        calls.create.push(params);
        issue = { number: 1, html_url: 'https://github.com/fake/fake/issues/1', state: 'open', title: params.title };
        return { data: issue };
      },
      update: async (params) => {
        calls.update.push(params);
        if (issue) {
          issue = { ...issue, body: params.body, state: params.state || issue.state };
        }
        return { data: issue };
      }
    }
  };
}

const SIMPLE_WORKFLOW = 'name: Simple\non:\n  push:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n';
const SCHEDULED_WORKFLOW = "name: Scheduled\non:\n  schedule:\n    - cron: '0 6 * * 1'\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n";

// --- listWorkflowFiles / hasScheduleTrigger ---------------------------------

function testListWorkflowFilesFindsYmlAndYamlSorted() {
  console.log('listWorkflowFiles finds .yml/.yaml files, sorted, ignores everything else');
  const dir = makeWorkflowsDir({ 'z.yml': SIMPLE_WORKFLOW, 'a.yaml': SIMPLE_WORKFLOW, 'notes.txt': 'x' });
  const files = listWorkflowFiles(dir);
  check('finds both workflow files, sorted', JSON.stringify(files) === JSON.stringify(['a.yaml', 'z.yml']));
  rmSync(dir, { recursive: true, force: true });
}

function testListWorkflowFilesReturnsEmptyForMissingDir() {
  console.log('listWorkflowFiles returns [] rather than throwing when the dir does not exist');
  check('empty array for a nonexistent dir', JSON.stringify(listWorkflowFiles('/no/such/dir')) === '[]');
}

function testHasScheduleTriggerDetectsScheduleBlock() {
  console.log('hasScheduleTrigger detects a real schedule: block, not a false positive on the word elsewhere');
  check('detects a real schedule trigger', hasScheduleTrigger(SCHEDULED_WORKFLOW) === true);
  check('does not flag a workflow with no schedule trigger', hasScheduleTrigger(SIMPLE_WORKFLOW) === false);
  check('does not false-positive on "schedule" appearing mid-line', hasScheduleTrigger('# a schedule change\non:\n  push:\n') === false);
}

// --- runActionlint (injected execFn, no real binary needed) -----------------

function testRunActionlintReturnsAllCleanOnZeroExit() {
  console.log('runActionlint: every file reports clean when actionlint exits 0');
  const dir = makeWorkflowsDir({ 'a.yml': SIMPLE_WORKFLOW, 'b.yml': SIMPLE_WORKFLOW });
  const fakeExec = () => ''; // exits 0, no throw
  const results = runActionlint(dir, { execFn: fakeExec });
  check('both files present with empty finding arrays', results['a.yml'].length === 0 && results['b.yml'].length === 0);
  rmSync(dir, { recursive: true, force: true });
}

function testRunActionlintAttributesFindingsToTheRightFile() {
  console.log('runActionlint: findings are attributed to the specific file actionlint named, not every file');
  const dir = makeWorkflowsDir({ 'good.yml': SIMPLE_WORKFLOW, 'bad.yml': SIMPLE_WORKFLOW });
  const fakeExec = () => {
    const err = new Error('exit 1');
    err.stdout = '.github/workflows/bad.yml:3:5: unexpected key "foo"\n';
    err.stderr = '';
    throw err;
  };
  const results = runActionlint(dir, { execFn: fakeExec });
  check('bad.yml has the finding', results['bad.yml'].length === 1 && results['bad.yml'][0].includes('unexpected key'));
  check('good.yml stays clean', results['good.yml'].length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// --- checkScheduledWorkflowRuns ---------------------------------------------

async function testChecksOnlyScheduledWorkflowsNotEveryFile() {
  console.log('checkScheduledWorkflowRuns only queries workflows that actually declare a schedule trigger');
  const dir = makeWorkflowsDir({ 'push-only.yml': SIMPLE_WORKFLOW, 'scheduled.yml': SCHEDULED_WORKFLOW });
  const octokit = makeFakeOctokitForRuns({ 'scheduled.yml': [{ conclusion: 'success', html_url: 'https://x/1' }] });
  const findings = await checkScheduledWorkflowRuns(octokit, 'o', 'r', { dir });
  check('only the scheduled workflow was queried', octokit.calls.length === 1 && octokit.calls[0].workflow_id === 'scheduled.yml');
  check('a successful last run produces no finding', findings.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

async function testFlagsAFailedLastScheduledRun() {
  console.log('checkScheduledWorkflowRuns flags a scheduled workflow whose last run concluded failure');
  const dir = makeWorkflowsDir({ 'scheduled.yml': SCHEDULED_WORKFLOW });
  const octokit = makeFakeOctokitForRuns({ 'scheduled.yml': [{ conclusion: 'failure', html_url: 'https://x/2' }] });
  const findings = await checkScheduledWorkflowRuns(octokit, 'o', 'r', { dir });
  check('exactly one finding', findings.length === 1);
  check('finding names the file and the real run URL', findings[0].file === 'scheduled.yml' && findings[0].issue.includes('https://x/2'));
}

async function testFlagsAScheduledWorkflowWithNoRunHistoryAtAll() {
  console.log('checkScheduledWorkflowRuns flags a schedule trigger with zero recorded runs, rather than treating "no data" as success');
  const dir = makeWorkflowsDir({ 'scheduled.yml': SCHEDULED_WORKFLOW });
  const octokit = makeFakeOctokitForRuns({ 'scheduled.yml': [] });
  const findings = await checkScheduledWorkflowRuns(octokit, 'o', 'r', { dir });
  check('flags the missing run history', findings.length === 1 && findings[0].issue.includes('never had a scheduled run'));
  rmSync(dir, { recursive: true, force: true });
}

async function testDoesNotFlagAMonthlyWorkflowJustForBeingOld() {
  console.log("checkScheduledWorkflowRuns judges only the most recent run's conclusion, never how long ago it ran");
  const dir = makeWorkflowsDir({ 'monthly.yml': SCHEDULED_WORKFLOW });
  // A real success from a month ago should never be treated as "overdue."
  const octokit = makeFakeOctokitForRuns({ 'monthly.yml': [{ conclusion: 'success', html_url: 'https://x/3' }] });
  const findings = await checkScheduledWorkflowRuns(octokit, 'o', 'r', { dir });
  check('no finding for an old-but-successful run', findings.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// --- buildWatchdogReport -----------------------------------------------------

function testReportShowsAllCleanWhenNothingFailed() {
  console.log('buildWatchdogReport reports both sections clean when there is nothing to flag');
  const body = buildWatchdogReport({ yamlFindings: { 'a.yml': [] }, runFindings: [], checkedAt: '2026-01-01T00:00:00.000Z' });
  check('yaml section says clean', body.includes('Every `.github/workflows/*.yml` file is valid'));
  check('run section says clean', body.includes("Every scheduled workflow's most recent run concluded successfully"));
}

function testReportListsBothKindsOfFindingWhenPresent() {
  console.log('buildWatchdogReport lists a specific bad file and a specific bad run when both are present');
  const body = buildWatchdogReport({
    yamlFindings: { 'bad.yml': ['bad.yml:1: some error'], 'good.yml': [] },
    runFindings: [{ file: 'sched.yml', issue: "last scheduled run concluded 'failure'" }],
    checkedAt: '2026-01-01T00:00:00.000Z'
  });
  check('names the bad yaml file', body.includes('bad.yml') && body.includes('some error'));
  check('does not mention the clean file as a finding', !body.includes('good.yml'));
  check('names the failed scheduled run', body.includes('sched.yml') && body.includes('failure'));
}

// --- publishWatchdogReport (pinned-issue update-in-place) -------------------

async function testCreatesTheIssueWhenNoneExistsYet() {
  console.log('publishWatchdogReport creates the pinned issue on the very first run');
  const octokit = makeFakeOctokitForIssues();
  const result = await publishWatchdogReport(octokit, 'body v1');
  check('action is created', result.action === 'created');
  check('created with the watchdog label', octokit.calls.create[0].labels.includes('mothership-watchdog'));
}

async function testUpdatesTheSameIssueInPlaceOnASubsequentRun() {
  console.log('publishWatchdogReport updates the same pinned issue in place, never creating a second one');
  const octokit = makeFakeOctokitForIssues({
    existingIssue: { number: 7, html_url: 'https://github.com/fake/fake/issues/7', state: 'open', title: 'Mothership Scheduled-Job Watchdog' }
  });
  const result = await publishWatchdogReport(octokit, 'body v2');
  check('action is updated, not created', result.action === 'updated');
  check('no new issue was created', octokit.calls.create.length === 0);
  check('the update targets issue 7', octokit.calls.update[0].issue_number === 7);
}

async function testReopensTheIssueIfAHumanClosedIt() {
  console.log('publishWatchdogReport reopens the pinned issue if a human closed it, rather than silently rewriting a closed issue');
  const octokit = makeFakeOctokitForIssues({
    existingIssue: { number: 9, html_url: 'https://github.com/fake/fake/issues/9', state: 'closed', title: 'Mothership Scheduled-Job Watchdog' }
  });
  const result = await publishWatchdogReport(octokit, 'body v3');
  check('action is reopened', result.action === 'reopened');
  check('the update explicitly sets state to open', octokit.calls.update[0].state === 'open');
}

async function main() {
  testListWorkflowFilesFindsYmlAndYamlSorted();
  testListWorkflowFilesReturnsEmptyForMissingDir();
  testHasScheduleTriggerDetectsScheduleBlock();
  testRunActionlintReturnsAllCleanOnZeroExit();
  testRunActionlintAttributesFindingsToTheRightFile();
  await testChecksOnlyScheduledWorkflowsNotEveryFile();
  await testFlagsAFailedLastScheduledRun();
  await testFlagsAScheduledWorkflowWithNoRunHistoryAtAll();
  await testDoesNotFlagAMonthlyWorkflowJustForBeingOld();
  testReportShowsAllCleanWhenNothingFailed();
  testReportListsBothKindsOfFindingWhenPresent();
  await testCreatesTheIssueWhenNoneExistsYet();
  await testUpdatesTheSameIssueInPlaceOnASubsequentRun();
  await testReopensTheIssueIfAHumanClosedIt();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
