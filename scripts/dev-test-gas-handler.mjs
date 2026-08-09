// Local verification harness for gas/autonomous_agent.js's processRequest(),
// the Apps Script port of api/autonomous_agent.js. Same rationale as
// dev-test-handler.mjs: nothing here calls GitHub, the AI API, or a real
// Apps Script deployment - every github/aiFetch call is a hand-rolled fake,
// loaded via the same vm-based harness (scripts/gas-test-harness.mjs) real
// Apps Script uses to run these files, so what's tested here is exactly
// what a real deployment executes.
//
// Usage: node scripts/dev-test-gas-handler.mjs

import { loadGasGlobals } from './gas-test-harness.mjs';
import { strict as assert } from 'assert';

const { processRequest } = loadGasGlobals('constants.js', 'github.js', 'autonomous_agent.js');

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

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}
function unb64(str) {
  return Buffer.from(str, 'base64').toString('utf8');
}

// `decisionLog: null` simulates the file not existing yet (getContent 404s).
// Pass an array (even []) to simulate an existing log with that content.
// Also answers the hub's own global-context files (universal_lessons.md
// etc.), unlike the spoke-scoped ai_decision_log.json/lessons.md/
// NORTH_STAR.md paths - autonomous_agent.js now fetches those from the hub
// repo via the same client instead of reading local disk.
function makeFakeGithub({ decisionLog = null, issuesCreatedToday = [], commitSha = 'abc123', diffFiles, hubOwner = 'adamberneche-afk', hubRepo = 'Mothership' } = {}) {
  const calls = { issuesCreate: [], getContent: [], createOrUpdateFileContents: [] };
  let currentLog = decisionLog;
  let currentSha = decisionLog !== null ? 'fake-sha-0' : null;
  const files = diffFiles ?? [
    { filename: 'src/thing.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-old\n+new' }
  ];
  const hubFiles = new Set(['universal_lessons.md', 'north_star_framework.md', 'hub_lessons.md']);

  return {
    calls,
    repos: {
      getContent: ({ owner, repo, path }) => {
        calls.getContent.push(path);
        if (path === 'ai_decision_log.json') {
          if (currentLog === null) throw new Error('404 not found');
          return { data: { content: b64(JSON.stringify(currentLog)), sha: currentSha } };
        }
        if (path === 'lessons.md' || path === 'NORTH_STAR.md') {
          return { data: { content: b64('fake local context') } };
        }
        if (owner === hubOwner && repo === hubRepo && hubFiles.has(path)) {
          return { data: { content: b64('fake hub context') } };
        }
        throw new Error('404 not found');
      },
      createOrUpdateFileContents: (params) => {
        calls.createOrUpdateFileContents.push(params);
        if (params.path === 'ai_decision_log.json') {
          currentLog = JSON.parse(unb64(params.content));
          currentSha = `fake-sha-${calls.createOrUpdateFileContents.length}`;
        }
        return { data: {} };
      },
      listCommits: () => ({ data: commitSha ? [{ sha: commitSha }] : [] }),
      getCommit: () => ({ data: { files } })
    },
    issues: {
      listForRepo: () => ({ data: issuesCreatedToday }),
      create: (params) => {
        calls.issuesCreate.push(params);
        return { data: { html_url: 'https://github.com/fake/fake/issues/999' } };
      }
    }
  };
}

function makeFakeAiFetch(aiJsonContent) {
  let callCount = 0;
  const aiFetch = () => {
    callCount++;
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ choices: [{ message: { content: aiJsonContent } }] })
    };
  };
  aiFetch.callCount = () => callCount;
  return aiFetch;
}

const FINDING_JSON = JSON.stringify({
  has_findings: true,
  action_summary: 'Found a thing',
  code_patch: '- old\n+ new',
  value_impact: { reasoning: 'This matters because...' }
});

const NO_FINDING_JSON = JSON.stringify({
  has_findings: false,
  action_summary: '',
  code_patch: '',
  value_impact: { reasoning: '' }
});

const BASE_DEPS = { base64Encode: b64, base64Decode: unb64 };

// --- Safety rails ------------------------------------------------------------

function testDryRunNeverCreatesIssue() {
  console.log('Dry-run mode never calls issues.create');
  const github = makeFakeGithub();
  const aiFetch = makeFakeAiFetch(FINDING_JSON);
  const { httpStatus, body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, github, aiFetch, dryRunOverride: true }
  );
  check('httpStatus is 200', httpStatus === 200);
  check('status is DryRunFinding', body.status === 'DryRunFinding');
  check('dryRun is true', body.dryRun === true);
  check('wouldCreate is present', !!body.wouldCreate?.title);
  check('issues.create was never called', github.calls.issuesCreate.length === 0);
}

function testRateCapBlocksAtLimit() {
  console.log('Live mode blocks once the daily cap is reached');
  const cap = 3;
  const todayIssues = Array.from({ length: cap }, (_, i) => ({
    created_at: new Date().toISOString(),
    number: i
  }));
  const github = makeFakeGithub({ issuesCreatedToday: todayIssues });
  const aiFetch = makeFakeAiFetch(FINDING_JSON);
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, github, aiFetch, dryRunOverride: false, config: { rateCapPerRepoPerDay: cap } }
  );
  check('status is Skipped once at cap', body.status === 'Skipped');
  check('reason mentions rate cap', /rate cap/i.test(body.reason || ''));
  check('issues.create was never called', github.calls.issuesCreate.length === 0);
}

function testRateCapAllowsUnderLimit() {
  console.log('Live mode creates an issue when under the daily cap');
  const github = makeFakeGithub({ issuesCreatedToday: [] });
  const aiFetch = makeFakeAiFetch(FINDING_JSON);
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, github, aiFetch, dryRunOverride: false, config: { rateCapPerRepoPerDay: 3 } }
  );
  check('status is Success', body.status === 'Success');
  check('dryRun is false', body.dryRun === false);
  check('issues.create was called exactly once', github.calls.issuesCreate.length === 1);
  check('issue carries the hub label', github.calls.issuesCreate[0]?.labels?.includes('cto-hub-auto'));
}

function testNoFindingsResponseCarriesDryRun() {
  console.log('A no-findings response still carries dryRun');
  const github = makeFakeGithub();
  const aiFetch = makeFakeAiFetch(NO_FINDING_JSON);
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, github, aiFetch, dryRunOverride: true }
  );
  check('status is Skipped', body.status === 'Skipped');
  check('dryRun field is present', body.dryRun === true);
}

// --- Decision logging ---------------------------------------------------------

function testDecisionLogSkipsAlreadyDecidedCommit() {
  console.log('A logged (non-ai_error) decision for this commit+mode skips the AI call');
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'no_findings', issueUrl: null, summary: null }
  ];
  const github = makeFakeGithub({ decisionLog, commitSha: 'abc123' });
  const aiFetch = makeFakeAiFetch(FINDING_JSON);
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, github, aiFetch, dryRunOverride: true }
  );
  check('AI was never called', aiFetch.callCount() === 0);
  check('status is Skipped', body.status === 'Skipped');
  check('priorDecision reflects the logged outcome', body.priorDecision?.outcome === 'no_findings');
}

function testAiErrorDoesNotBlockRetry() {
  console.log("A logged 'ai_error' outcome does NOT block retrying the same commit+mode");
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'ai_error', issueUrl: null, summary: null }
  ];
  const github = makeFakeGithub({ decisionLog, commitSha: 'abc123' });
  const aiFetch = makeFakeAiFetch(FINDING_JSON);
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, github, aiFetch, dryRunOverride: true }
  );
  check('AI was called (not skipped)', aiFetch.callCount() === 1);
  check('a real decision was reached', body.status === 'DryRunFinding');
}

function testDecisionLogWritesEntryOnNormalRun() {
  console.log('A normal run appends a well-formed entry to the decision log');
  const github = makeFakeGithub({ decisionLog: null, commitSha: 'abc123' }); // no log file yet
  const aiFetch = makeFakeAiFetch(FINDING_JSON);
  processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, github, aiFetch, dryRunOverride: true }
  );
  const writes = github.calls.createOrUpdateFileContents;
  check('exactly one write to the decision log', writes.length === 1);
  const writtenEntries = JSON.parse(unb64(writes[0].content));
  check('log now has one entry', writtenEntries.length === 1);
  check('entry has the right commitSha/mode/outcome', writtenEntries[0].commitSha === 'abc123' && writtenEntries[0].mode === 'debug' && writtenEntries[0].outcome === 'dry_run_would_create');
  check('no sha sent when the file did not exist yet', writes[0].sha === undefined);
}

function testReplayOfACreatedDecisionSurfacesIssueUrlAtTopLevel() {
  console.log('Replaying a prior "created" decision surfaces issueUrl at the top level too');
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'created', issueUrl: 'https://github.com/o/r/issues/42', summary: 'Found a thing' }
  ];
  const github = makeFakeGithub({ decisionLog, commitSha: 'abc123' });
  const aiFetch = makeFakeAiFetch(FINDING_JSON);
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, github, aiFetch, dryRunOverride: true }
  );
  check('AI was never called', aiFetch.callCount() === 0);
  check('top-level issueUrl matches the logged one', body.issueUrl === 'https://github.com/o/r/issues/42');
  check('still nested under priorDecision too', body.priorDecision?.issueUrl === 'https://github.com/o/r/issues/42');
}

function testReplayWithoutAnIssueUrlOmitsTheField() {
  console.log('Replaying a decision with no issueUrl does not add a spurious top-level field');
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'no_findings', issueUrl: null, summary: null }
  ];
  const github = makeFakeGithub({ decisionLog, commitSha: 'abc123' });
  const aiFetch = makeFakeAiFetch(FINDING_JSON);
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, github, aiFetch, dryRunOverride: true }
  );
  check('no top-level issueUrl field', body.issueUrl === undefined);
}

// --- Platform port: base64 round-trips through the injected functions -------

function testBase64RoundTripsThroughInjectedFunctions() {
  console.log('Platform port: content written to the decision log round-trips through base64Encode/Decode correctly');
  const github = makeFakeGithub({ decisionLog: [], commitSha: 'abc123' });
  const aiFetch = makeFakeAiFetch(FINDING_JSON);
  processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, github, aiFetch, dryRunOverride: true }
  );
  const writes = github.calls.createOrUpdateFileContents;
  const decoded = JSON.parse(unb64(writes[0].content));
  check('the written entry is valid JSON after a real base64 round-trip', Array.isArray(decoded) && decoded.length === 1);
}

function main() {
  testDryRunNeverCreatesIssue();
  testRateCapBlocksAtLimit();
  testRateCapAllowsUnderLimit();
  testNoFindingsResponseCarriesDryRun();
  testDecisionLogSkipsAlreadyDecidedCommit();
  testAiErrorDoesNotBlockRetry();
  testDecisionLogWritesEntryOnNormalRun();
  testReplayOfACreatedDecisionSurfacesIssueUrlAtTopLevel();
  testReplayWithoutAnIssueUrlOmitsTheField();
  testBase64RoundTripsThroughInjectedFunctions();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
