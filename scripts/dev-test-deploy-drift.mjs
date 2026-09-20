// Local verification harness for the deploy-drift trio:
// scripts/deploy-drift-expected-marker.js (pure git-log wrapper),
// scripts/deploy-drift-stamp.js (writes the marker file), and
// scripts/deploy-drift.js (evaluate/publish against a fake octokit, no
// real GitHub writes). Ported from KOS's own equivalent test files
// (tests/tools/deploy-drift-*.test.js), adapted to this repo's plain
// check()-based harness convention instead of node:test.
//
// expected-marker/stamp tests run against a REAL, disposable scratch git
// repo (mkdtemp + `git init`) rather than this session's own repo - same
// idea as KOS's tests running against KOS's real history, but Mothership's
// tests build their own tiny throwaway history instead so the exact
// commit count/order is fully controlled and the real repo is never
// touched or depended on.
//
// Usage: node scripts/dev-test-deploy-drift.mjs

import { expectedDeployMarker } from './deploy-drift-expected-marker.js';
import { stamp, MARKER_FILE, MARKER_CONSTANT } from './deploy-drift-stamp.js';
import { evaluateReport, buildDriftIssueBody, publishDriftStatus } from './deploy-drift.js';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
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

// --- Scratch git repo helper --------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeScratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-drift-test-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}

function commitFile(dir, relPath, content, message) {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(dir, 'add', relPath);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

// --- expectedDeployMarker ----------------------------------------------

function testExpectedMarkerAgreesWithAnIndependentGitLog() {
  console.log('expectedDeployMarker agrees with an independently-run git log over the same tracked files');
  const dir = makeScratchRepo();
  try {
    commitFile(dir, 'gas/Code.js', 'v1', 'add Code.js');
    const expected = commitFile(dir, 'gas/github.js', 'v1', 'add github.js');

    const result = expectedDeployMarker({ files: ['gas/Code.js', 'gas/github.js'], cwd: dir });
    check('matches the real HEAD sha', result.sha === expected);
    check('returns the full 40-char sha, not abbreviated', /^[0-9a-f]{40}$/.test(result.sha));
    check('carries a commit subject', result.subject === 'add github.js');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testExpectedMarkerPicksTheMostRecentCommitAcrossMultipleFiles() {
  console.log('expectedDeployMarker picks the most recent commit across MULTIPLE tracked files, not just the first one listed');
  const dir = makeScratchRepo();
  try {
    const laterSha = commitFile(dir, 'gas/Code.js', 'v1', 'add Code.js');
    // github.js listed FIRST in the tracked-files array below, but touched
    // in an EARLIER commit - if this only looked at files[0] it would
    // report the stale sha instead of the real most-recent one.
    commitFile(dir, 'gas/github.js', 'v1', 'add github.js (earlier)');
    // Re-commit Code.js after github.js so Code.js is genuinely the latest.
    writeFileSync(join(dir, 'gas/Code.js'), 'v2');
    git(dir, 'add', 'gas/Code.js');
    git(dir, 'commit', '-q', '-m', 'update Code.js (latest)');
    const trueLatest = git(dir, 'rev-parse', 'HEAD');

    const result = expectedDeployMarker({ files: ['gas/github.js', 'gas/Code.js'], cwd: dir });
    check('reports the genuinely most recent commit', result.sha === trueLatest);
    check('not the stale first-file commit', result.sha !== laterSha || trueLatest === laterSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testExpectedMarkerExcludesUntrackedFilesFromTheFileList() {
  console.log('expectedDeployMarker only reports files that actually exist at HEAD, e.g. the marker file before it is ever committed');
  const dir = makeScratchRepo();
  try {
    commitFile(dir, 'gas/Code.js', 'v1', 'add Code.js');
    const result = expectedDeployMarker({ files: ['gas/Code.js', 'gas/deploy_version_marker.js'], cwd: dir });
    check('the not-yet-committed file is excluded from the resolved list', !result.files.includes('gas/deploy_version_marker.js'));
    check('the real file is still included', result.files.includes('gas/Code.js'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testExpectedMarkerReturnsNullShaWhenNoTrackedFileExists() {
  console.log('expectedDeployMarker returns a null sha (not a throw) when none of the tracked files exist at HEAD yet');
  const dir = makeScratchRepo();
  try {
    // An empty repo has no HEAD at all yet - the cat-file existence check
    // for every candidate file fails, same code path as "repo has commits
    // but none touch these files."
    const result = expectedDeployMarker({ files: ['gas/Code.js'], cwd: dir });
    check('sha is null', result.sha === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- stamp ---------------------------------------------------------------

function testStampWritesTheRealHeadShaIntoTheMarkerFile() {
  console.log('stamp() writes the scratch repo\'s real HEAD sha into the marker file, replacing the placeholder');
  const dir = makeScratchRepo();
  try {
    mkdirSync(join(dir, 'gas'), { recursive: true });
    writeFileSync(join(dir, 'gas/deploy_version_marker.js'), `const ${MARKER_CONSTANT} = '0000000000000000000000000000000000000000';\n`);
    git(dir, 'add', 'gas/deploy_version_marker.js');
    git(dir, 'commit', '-q', '-m', 'seed marker file');
    const headSha = git(dir, 'rev-parse', 'HEAD');

    const result = stamp({ cwd: dir });
    check('reports the real HEAD sha', result.sha === headSha);
    const updated = readFileSync(join(dir, MARKER_FILE), 'utf8');
    check('the file on disk now contains that sha', updated.includes(`'${headSha}'`));
    check('the placeholder zero-sha is gone', !updated.includes("'0000000000000000000000000000000000000000'"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testStampThrowsAHelpfulErrorWhenTheConstantIsMissing() {
  console.log('stamp() throws a helpful error (does not silently write nothing) when the marker constant is not found in the expected shape');
  const dir = makeScratchRepo();
  try {
    mkdirSync(join(dir, 'gas'), { recursive: true });
    writeFileSync(join(dir, 'gas/deploy_version_marker.js'), '// no constant declared here\n');
    git(dir, 'add', 'gas/deploy_version_marker.js');
    git(dir, 'commit', '-q', '-m', 'seed a broken marker file');

    let threw = false;
    try {
      stamp({ cwd: dir });
    } catch (e) {
      threw = true;
      check('the error names the missing constant', e.message.includes(MARKER_CONSTANT));
    }
    check('stamp() threw rather than silently no-op-ing', threw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- evaluateReport --------------------------------------------------------

const REAL_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function fakeExpectedMarkerFn(sha) {
  return () => (sha ? { sha, committedAt: '2026-01-01T00:00:00Z', subject: 'a real commit' } : { sha: null });
}

function testEvaluateReportRejectsAMalformedSha() {
  console.log('evaluateReport rejects a reported sha that is not a 40-char hex string, before ever consulting git');
  const result = evaluateReport({ reportedSha: 'not-a-real-sha', reportedAt: 'now' }, fakeExpectedMarkerFn(REAL_SHA));
  check('status is invalid', result.status === 'invalid');
  check('reason names the malformed sha', result.reason.includes('not-a-real-sha'));
}

function testEvaluateReportRejectsAnEmptySha() {
  console.log('evaluateReport rejects an empty/missing reported sha');
  const result = evaluateReport({ reportedSha: '', reportedAt: 'now' }, fakeExpectedMarkerFn(REAL_SHA));
  check('status is invalid', result.status === 'invalid');
}

function testEvaluateReportHandlesNoGitHistoryForTrackedFiles() {
  console.log('evaluateReport reports invalid (not a crash) when git has no history at all for the tracked files');
  const result = evaluateReport({ reportedSha: REAL_SHA, reportedAt: 'now' }, fakeExpectedMarkerFn(null));
  check('status is invalid', result.status === 'invalid');
  check('reason explains why', result.reason.includes('no commit history'));
}

function testEvaluateReportMatch() {
  console.log('evaluateReport reports match when the reported sha equals what git expects');
  const result = evaluateReport({ reportedSha: REAL_SHA, reportedAt: 'now' }, fakeExpectedMarkerFn(REAL_SHA));
  check('status is match', result.status === 'match');
}

function testEvaluateReportDrift() {
  console.log('evaluateReport reports drift when the reported sha does not equal what git expects');
  const result = evaluateReport({ reportedSha: OTHER_SHA, reportedAt: 'now' }, fakeExpectedMarkerFn(REAL_SHA));
  check('status is drift', result.status === 'drift');
  check('carries both the expected and reported sha', result.expected.sha === REAL_SHA && result.reportedSha === OTHER_SHA);
}

// --- buildDriftIssueBody -----------------------------------------------

function testBuildDriftIssueBodyNamesBothShas() {
  console.log('buildDriftIssueBody names both the expected and reported sha, and points at the fix');
  const body = buildDriftIssueBody({
    expected: { sha: REAL_SHA, subject: 'a real commit', committedAt: '2026-01-01T00:00:00Z' },
    reportedSha: OTHER_SHA,
    reportedAt: '2026-01-02T00:00:00Z'
  });
  check('names the expected sha', body.includes(REAL_SHA));
  check('names the reported sha', body.includes(OTHER_SHA));
  check('points at clasp deploy as the likely fix', body.includes('clasp deploy'));
}

// --- publishDriftStatus (pinned-issue update-in-place, same shape as watchdog.js) --

function makeFakeOctokitForIssues({ existingIssue = null } = {}) {
  const calls = { listForRepo: [], create: [], update: [], createComment: [] };
  let issue = existingIssue;
  return {
    calls,
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
        if (issue) issue = { ...issue, body: params.body ?? issue.body, state: params.state || issue.state };
        return { data: issue };
      },
      createComment: async (params) => {
        calls.createComment.push(params);
        return { data: {} };
      }
    }
  };
}

async function testPublishDriftStatusCreatesTheIssueOnFirstDrift() {
  console.log('publishDriftStatus creates the pinned drift issue on the first drift report');
  const octokit = makeFakeOctokitForIssues();
  const result = await publishDriftStatus(octokit, { status: 'drift', expected: { sha: REAL_SHA, subject: 's', committedAt: 't' }, reportedSha: OTHER_SHA, reportedAt: 'now' });
  check('action is created', result.action === 'created');
  check('labeled mothership-deploy-drift', octokit.calls.create[0].labels.includes('mothership-deploy-drift'));
}

async function testPublishDriftStatusUpdatesTheSameIssueInPlace() {
  console.log('publishDriftStatus updates the same pinned issue in place on a repeated drift report, never creating a second one');
  const octokit = makeFakeOctokitForIssues({
    existingIssue: { number: 5, html_url: 'https://github.com/fake/fake/issues/5', state: 'open', title: 'Deploy drift: gas/ Apps Script backend' }
  });
  const result = await publishDriftStatus(octokit, { status: 'drift', expected: { sha: REAL_SHA, subject: 's', committedAt: 't' }, reportedSha: OTHER_SHA, reportedAt: 'now' });
  check('action is updated', result.action === 'updated');
  check('no new issue created', octokit.calls.create.length === 0);
  check('targets issue 5', octokit.calls.update[0].issue_number === 5);
}

async function testPublishDriftStatusReopensAHumanClosedIssue() {
  console.log('publishDriftStatus reopens the pinned issue if a human closed it, rather than silently rewriting a closed issue');
  const octokit = makeFakeOctokitForIssues({
    existingIssue: { number: 8, html_url: 'https://github.com/fake/fake/issues/8', state: 'closed', title: 'Deploy drift: gas/ Apps Script backend' }
  });
  const result = await publishDriftStatus(octokit, { status: 'drift', expected: { sha: REAL_SHA, subject: 's', committedAt: 't' }, reportedSha: OTHER_SHA, reportedAt: 'now' });
  check('action is reopened', result.action === 'reopened');
  check('the update explicitly sets state to open', octokit.calls.update[0].state === 'open');
}

async function testPublishDriftStatusNeverOpensAnIssueForAMatch() {
  console.log('publishDriftStatus never creates an issue for a clean match - a gas/ that has never drifted should have no tracking issue at all');
  const octokit = makeFakeOctokitForIssues();
  const result = await publishDriftStatus(octokit, { status: 'match', expected: { sha: REAL_SHA, subject: 's', committedAt: 't' }, reportedSha: REAL_SHA, reportedAt: 'now' });
  check('action is none', result.action === 'none');
  check('no issue was created', octokit.calls.create.length === 0);
}

async function testPublishDriftStatusClosesAnOpenIssueOnceCleanAgain() {
  console.log('publishDriftStatus closes an open drift issue, with a resolution comment, once a clean report arrives');
  const octokit = makeFakeOctokitForIssues({
    existingIssue: { number: 12, html_url: 'https://github.com/fake/fake/issues/12', state: 'open', title: 'Deploy drift: gas/ Apps Script backend' }
  });
  const result = await publishDriftStatus(octokit, { status: 'match', expected: { sha: REAL_SHA, subject: 's', committedAt: 't' }, reportedSha: REAL_SHA, reportedAt: 'now' });
  check('action is closed', result.action === 'closed');
  check('a resolution comment was posted first', octokit.calls.createComment.length === 1 && octokit.calls.createComment[0].body.includes(REAL_SHA));
  check('the issue was actually closed', octokit.calls.update[0].state === 'closed');
}

async function testPublishDriftStatusLeavesAnAlreadyClosedIssueAloneOnAMatch() {
  console.log('publishDriftStatus does nothing to an already-closed issue on a clean match - never reopens or re-comments on old, resolved drift');
  const octokit = makeFakeOctokitForIssues({
    existingIssue: { number: 3, html_url: 'https://github.com/fake/fake/issues/3', state: 'closed', title: 'Deploy drift: gas/ Apps Script backend' }
  });
  const result = await publishDriftStatus(octokit, { status: 'match', expected: { sha: REAL_SHA, subject: 's', committedAt: 't' }, reportedSha: REAL_SHA, reportedAt: 'now' });
  check('action is none', result.action === 'none');
  check('nothing was updated or commented', octokit.calls.update.length === 0 && octokit.calls.createComment.length === 0);
}

async function main() {
  testExpectedMarkerAgreesWithAnIndependentGitLog();
  testExpectedMarkerPicksTheMostRecentCommitAcrossMultipleFiles();
  testExpectedMarkerExcludesUntrackedFilesFromTheFileList();
  testExpectedMarkerReturnsNullShaWhenNoTrackedFileExists();
  testStampWritesTheRealHeadShaIntoTheMarkerFile();
  testStampThrowsAHelpfulErrorWhenTheConstantIsMissing();
  testEvaluateReportRejectsAMalformedSha();
  testEvaluateReportRejectsAnEmptySha();
  testEvaluateReportHandlesNoGitHistoryForTrackedFiles();
  testEvaluateReportMatch();
  testEvaluateReportDrift();
  testBuildDriftIssueBodyNamesBothShas();
  await testPublishDriftStatusCreatesTheIssueOnFirstDrift();
  await testPublishDriftStatusUpdatesTheSameIssueInPlace();
  await testPublishDriftStatusReopensAHumanClosedIssue();
  await testPublishDriftStatusNeverOpensAnIssueForAMatch();
  await testPublishDriftStatusClosesAnOpenIssueOnceCleanAgain();
  await testPublishDriftStatusLeavesAnAlreadyClosedIssueAloneOnAMatch();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
