// Local verification harness for api/autonomous_agent.js's processRequest().
//
// The hub's real deployment is behind Vercel Deployment Protection and
// nothing here calls GitHub or the AI API for real - every octokit/fetch
// call is a hand-rolled fake. This is what "verify Sprint 0/1/2" means until
// a Vercel protection-bypass token exists for live testing: run this,
// confirm every assertion passes.
//
// Usage: node scripts/dev-test-handler.mjs

import { processRequest } from '../api/autonomous_agent.js';
import { strict as assert } from 'assert';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

// --- Fakes -----------------------------------------------------------------

// `decisionLog: null` simulates the file not existing yet (getContent 404s).
// Pass an array (even []) to simulate an existing log with that content.
function makeFakeOctokit({ decisionLog = null, issuesCreatedToday = [], commitSha = 'abc123', diffFiles } = {}) {
  const calls = { issuesCreate: [], getContent: [], createOrUpdateFileContents: [] };
  let currentLog = decisionLog;
  let currentSha = decisionLog !== null ? 'fake-sha-0' : null;
  const files = diffFiles ?? [
    { filename: 'src/thing.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-old\n+new' }
  ];

  return {
    calls,
    repos: {
      getContent: async ({ path }) => {
        calls.getContent.push(path);
        if (path === 'ai_decision_log.json') {
          if (currentLog === null) throw new Error('404 not found');
          return { data: { content: Buffer.from(JSON.stringify(currentLog)).toString('base64'), sha: currentSha } };
        }
        if (path === 'lessons.md' || path === 'NORTH_STAR.md') {
          return { data: { content: Buffer.from('fake local context').toString('base64') } };
        }
        throw new Error('404 not found');
      },
      createOrUpdateFileContents: async (params) => {
        calls.createOrUpdateFileContents.push(params);
        if (params.path === 'ai_decision_log.json') {
          currentLog = JSON.parse(Buffer.from(params.content, 'base64').toString('utf8'));
          currentSha = `fake-sha-${calls.createOrUpdateFileContents.length}`;
        }
        return { data: {} };
      },
      listCommits: async () => ({ data: commitSha ? [{ sha: commitSha }] : [] }),
      getCommit: async () => ({ data: { files } })
    },
    issues: {
      listForRepo: async () => ({ data: issuesCreatedToday }),
      create: async (params) => {
        calls.issuesCreate.push(params);
        return { data: { html_url: 'https://github.com/fake/fake/issues/999' } };
      }
    }
  };
}

function makeFakeFetch(aiJsonContent) {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    return {
      json: async () => ({ choices: [{ message: { content: aiJsonContent } }] })
    };
  };
  fetchImpl.callCount = () => callCount;
  return fetchImpl;
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

// --- Sprint 0: dry-run never files an issue ---------------------------------

async function testDryRunNeverCreatesIssue() {
  console.log('Sprint 0: dry-run mode never calls issues.create');
  const octokit = makeFakeOctokit();
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { httpStatus, body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokit, fetchImpl, dryRunOverride: true }
  );
  check('httpStatus is 200', httpStatus === 200);
  check('status is DryRunFinding', body.status === 'DryRunFinding');
  check('dryRun is true', body.dryRun === true);
  check('wouldCreate is present', !!body.wouldCreate?.title);
  check('issues.create was never called', octokit.calls.issuesCreate.length === 0);
}

// --- Sprint 0: live mode respects the rate cap ------------------------------

async function testRateCapBlocksAtLimit() {
  console.log('Sprint 0: live mode blocks once the daily cap is reached');
  const cap = 3;
  process.env.RATE_CAP_PER_REPO_PER_DAY = String(cap);
  const todayIssues = Array.from({ length: cap }, (_, i) => ({
    created_at: new Date().toISOString(),
    number: i
  }));
  const octokit = makeFakeOctokit({ issuesCreatedToday: todayIssues });
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokit, fetchImpl, dryRunOverride: false }
  );
  check('status is Skipped once at cap', body.status === 'Skipped');
  check('reason mentions rate cap', /rate cap/i.test(body.reason || ''));
  check('issues.create was never called', octokit.calls.issuesCreate.length === 0);
  delete process.env.RATE_CAP_PER_REPO_PER_DAY;
}

async function testRateCapAllowsUnderLimit() {
  console.log('Sprint 0: live mode creates an issue when under the daily cap');
  process.env.RATE_CAP_PER_REPO_PER_DAY = '3';
  const octokit = makeFakeOctokit({ issuesCreatedToday: [] });
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokit, fetchImpl, dryRunOverride: false }
  );
  check('status is Success', body.status === 'Success');
  check('dryRun is false', body.dryRun === false);
  check('issues.create was called exactly once', octokit.calls.issuesCreate.length === 1);
  check('issue carries the hub label', octokit.calls.issuesCreate[0]?.labels?.includes('cto-hub-auto'));
  delete process.env.RATE_CAP_PER_REPO_PER_DAY;
}

// --- Every response branch carries dryRun -----------------------------------

async function testNoFindingsResponseCarriesDryRun() {
  console.log('Sprint 0: a no-findings response still carries dryRun');
  const octokit = makeFakeOctokit();
  const fetchImpl = makeFakeFetch(NO_FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokit, fetchImpl, dryRunOverride: true }
  );
  check('status is Skipped', body.status === 'Skipped');
  check('dryRun field is present', body.dryRun === true);
}

// --- Sprint 1: decision logging dedup + write ------------------------------

async function testDecisionLogSkipsAlreadyDecidedCommit() {
  console.log('Sprint 1: a logged (non-ai_error) decision for this commit+mode skips the AI call');
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'no_findings', issueUrl: null, summary: null }
  ];
  const octokit = makeFakeOctokit({ decisionLog, commitSha: 'abc123' });
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokit, fetchImpl, dryRunOverride: true }
  );
  check('AI was never called', fetchImpl.callCount() === 0);
  check('status is Skipped', body.status === 'Skipped');
  check('priorDecision reflects the logged outcome', body.priorDecision?.outcome === 'no_findings');
}

async function testAiErrorDoesNotBlockRetry() {
  console.log("Sprint 1: a logged 'ai_error' outcome does NOT block retrying the same commit+mode");
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'ai_error', issueUrl: null, summary: null }
  ];
  const octokit = makeFakeOctokit({ decisionLog, commitSha: 'abc123' });
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokit, fetchImpl, dryRunOverride: true }
  );
  check('AI was called (not skipped)', fetchImpl.callCount() === 1);
  check('a real decision was reached', body.status === 'DryRunFinding');
}

async function testDecisionLogWritesEntryOnNormalRun() {
  console.log('Sprint 1: a normal run appends a well-formed entry to the decision log');
  const octokit = makeFakeOctokit({ decisionLog: null, commitSha: 'abc123' }); // no log file yet
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokit, fetchImpl, dryRunOverride: true }
  );
  const writes = octokit.calls.createOrUpdateFileContents;
  check('exactly one write to the decision log', writes.length === 1);
  const writtenEntries = JSON.parse(Buffer.from(writes[0].content, 'base64').toString('utf8'));
  check('log now has one entry', writtenEntries.length === 1);
  check('entry has the right commitSha/mode/outcome', writtenEntries[0].commitSha === 'abc123' && writtenEntries[0].mode === 'debug' && writtenEntries[0].outcome === 'dry_run_would_create');
  check('no sha sent when the file did not exist yet', writes[0].sha === undefined);
}

async function main() {
  await testDryRunNeverCreatesIssue();
  await testRateCapBlocksAtLimit();
  await testRateCapAllowsUnderLimit();
  await testNoFindingsResponseCarriesDryRun();
  await testDecisionLogSkipsAlreadyDecidedCommit();
  await testAiErrorDoesNotBlockRetry();
  await testDecisionLogWritesEntryOnNormalRun();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
