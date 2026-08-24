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
function makeFakeOctokit({
  decisionLog = null, issuesCreatedToday = [], commitSha = 'abc123', diffFiles,
  commitAuthorLogin, missingLocalFiles = []
} = {}) {
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
          if (missingLocalFiles.includes(path)) throw new Error('404 not found');
          return { data: { content: Buffer.from(`fake content of ${path}`).toString('base64') } };
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
      getCommit: async () => ({
        data: {
          files,
          ...(commitAuthorLogin ? { author: { login: commitAuthorLogin } } : {})
        }
      })
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

// Wraps a fake octokit in the octokitFactory shape processRequest now
// expects (decision #1: real per-tenant credentials, not one shared
// instance) - records what token each call resolved to, since several
// tests below assert on exactly that.
function makeFakeOctokitFactory(octokit) {
  const tokensUsed = [];
  const factory = (token) => { tokensUsed.push(token); return octokit; };
  factory.tokensUsed = tokensUsed;
  return factory;
}

// Fake hub-side octokit for usage-log writes/reads (a separate credential
// from the tenant-scoped one - see api/autonomous_agent.js's header
// comment on why). Keyed by tenantId, matching usage/{tenantId}.json.
function makeFakeHubOctokit() {
  const logs = {}; // tenantId -> entries[]
  const writes = [];
  return {
    _logs: logs,
    _writes: writes,
    repos: {
      getContent: async ({ path }) => {
        const tenantId = path.replace(/^usage\//, '').replace(/\.json$/, '');
        if (!logs[tenantId]) throw new Error('404 not found');
        return { data: { content: Buffer.from(JSON.stringify(logs[tenantId])).toString('base64'), sha: `sha-${tenantId}` } };
      },
      createOrUpdateFileContents: async (params) => {
        writes.push(params);
        const tenantId = params.path.replace(/^usage\//, '').replace(/\.json$/, '');
        logs[tenantId] = JSON.parse(Buffer.from(params.content, 'base64').toString('utf8'));
        return { data: {} };
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

// Same as makeFakeFetch, but also captures the actual request body sent to
// the AI - needed to assert on which files/text made it into the prompt
// (issue #34's ordering/truncation fix, issue #35's local-context fix).
function makeFakeFetchCapturing(aiJsonContent) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      json: async () => ({ choices: [{ message: { content: aiJsonContent } }] })
    };
  };
  fetchImpl.callCount = () => calls.length;
  fetchImpl.lastPrompt = () => calls[calls.length - 1]?.messages?.[0]?.content ?? '';
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

// A registry with two distinct tenants, each with one spoke - used by every
// multi-tenancy test below so tenant isolation is asserted against real
// separation, not just a single "default" fallback.
const TWO_TENANT_SPOKES = [
  { tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' },
  { tenantId: 'globex', owner: 'globex-org', repo: 'globex-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' }
];
const TWO_TENANTS = [
  { tenantId: 'acme', name: 'Acme', status: 'active', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:ACME_TEST_TOKEN', createdAt: '2026-08-13T00:00:00Z' },
  { tenantId: 'globex', name: 'Globex', status: 'active', plan: 'trial', quota: { reviewsPerMonth: 2 }, githubCredentialRef: 'env:GLOBEX_TEST_TOKEN', callerKeyRef: 'env:GLOBEX_TEST_CALLER_KEY', createdAt: '2026-08-13T00:00:00Z' }
];

// --- Sprint 0: dry-run never files an issue ---------------------------------

async function testDryRunNeverCreatesIssue() {
  console.log('Sprint 0: dry-run mode never calls issues.create');
  const octokit = makeFakeOctokit();
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { httpStatus, body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
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
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: false }
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
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: false }
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
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
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
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
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
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
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
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  const writes = octokit.calls.createOrUpdateFileContents;
  check('exactly one write to the decision log', writes.length === 1);
  const writtenEntries = JSON.parse(Buffer.from(writes[0].content, 'base64').toString('utf8'));
  check('log now has one entry', writtenEntries.length === 1);
  check('entry has the right commitSha/mode/outcome', writtenEntries[0].commitSha === 'abc123' && writtenEntries[0].mode === 'debug' && writtenEntries[0].outcome === 'dry_run_would_create');
  check('no sha sent when the file did not exist yet', writes[0].sha === undefined);
}

async function testReplayOfACreatedDecisionSurfacesIssueUrlAtTopLevel() {
  console.log('Sprint 1 fix: replaying a prior "created" decision surfaces issueUrl at the top level too');
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'created', issueUrl: 'https://github.com/o/r/issues/42', summary: 'Found a thing' }
  ];
  const octokit = makeFakeOctokit({ decisionLog, commitSha: 'abc123' });
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  check('AI was never called', fetchImpl.callCount() === 0);
  check('top-level issueUrl matches the logged one', body.issueUrl === 'https://github.com/o/r/issues/42');
  check('still nested under priorDecision too', body.priorDecision?.issueUrl === 'https://github.com/o/r/issues/42');
}

async function testReplayWithoutAnIssueUrlOmitsTheField() {
  console.log('Sprint 1 fix: replaying a decision with no issueUrl does not add a spurious top-level field');
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'no_findings', issueUrl: null, summary: null }
  ];
  const octokit = makeFakeOctokit({ decisionLog, commitSha: 'abc123' });
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  check('no top-level issueUrl field', body.issueUrl === undefined);
}

// --- Multi-tenancy: credential resolution, isolation, usage, quota --------

async function testUnregisteredSpokeFallsBackToDefaultTenantCredential() {
  console.log('Multi-tenancy: a spoke not in spokes.json falls back to the "default" tenant (backward compat)');
  process.env.GLOBAL_GITHUB_TOKEN = 'the-global-token';
  const octokit = makeFakeOctokit();
  const factory = makeFakeOctokitFactory(octokit);
  const fetchImpl = makeFakeFetch(NO_FINDING_JSON);
  await processRequest(
    { owner: 'not-registered-owner', repo: 'not-registered-repo', mode: 'debug' },
    { octokitFactory: factory, fetchImpl, dryRunOverride: true, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('resolved to GLOBAL_GITHUB_TOKEN, not a tenant-specific one', factory.tokensUsed[0] === 'the-global-token');
  delete process.env.GLOBAL_GITHUB_TOKEN;
}

async function testRegisteredSpokeResolvesItsOwnTenantCredential() {
  console.log("Multi-tenancy: a registered spoke resolves ITS tenant's own credential, not another tenant's or the global one");
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBAL_GITHUB_TOKEN = 'the-global-token';
  const octokit = makeFakeOctokit();
  const factory = makeFakeOctokitFactory(octokit);
  const fetchImpl = makeFakeFetch(NO_FINDING_JSON);
  await processRequest(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug' },
    { octokitFactory: factory, fetchImpl, dryRunOverride: true, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check("resolved to acme's own token, not GLOBAL_GITHUB_TOKEN", factory.tokensUsed[0] === 'acme-secret-token');
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBAL_GITHUB_TOKEN;
}

async function testCallerKeyEnforcedOnlyWhenTenantHasOneConfigured() {
  console.log('Multi-tenancy: a tenant with no callerKeyRef set (acme) accepts any/no callerKey - backward compatible');
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  const octokit = makeFakeOctokit();
  const fetchImpl = makeFakeFetch(NO_FINDING_JSON);
  const { httpStatus } = await processRequest(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug' }, // no callerKey field at all
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('request proceeds (200), no caller-key requirement for this tenant', httpStatus === 200);
  delete process.env.ACME_TEST_TOKEN;
}

async function testCallerKeyRejectedWhenWrongForATenantThatRequiresOne() {
  console.log('Multi-tenancy: a tenant WITH callerKeyRef set (globex) rejects a missing/wrong key with 401');
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  process.env.GLOBEX_TEST_CALLER_KEY = 'globex-caller-key';
  const octokit = makeFakeOctokit();
  const fetchImpl = makeFakeFetch(NO_FINDING_JSON);
  const { httpStatus, body } = await processRequest(
    { owner: 'globex-org', repo: 'globex-repo', mode: 'debug', callerKey: 'wrong-key' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('httpStatus is 401', httpStatus === 401);
  check('AI was never called for a rejected caller', fetchImpl.callCount() === 0);
  delete process.env.GLOBEX_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_CALLER_KEY;
}

async function testCallerKeyAcceptedWhenCorrect() {
  console.log('Multi-tenancy: the correct callerKey for a tenant that requires one proceeds normally');
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  process.env.GLOBEX_TEST_CALLER_KEY = 'globex-caller-key';
  const octokit = makeFakeOctokit();
  const fetchImpl = makeFakeFetch(NO_FINDING_JSON);
  const { httpStatus } = await processRequest(
    { owner: 'globex-org', repo: 'globex-repo', mode: 'debug', callerKey: 'globex-caller-key' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('httpStatus is 200 with the correct key', httpStatus === 200);
  delete process.env.GLOBEX_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_CALLER_KEY;
}

async function testUsageEventRecordedForTheCorrectTenantOnly() {
  console.log("Multi-tenancy: a review run records a usage event under ITS tenant's usage log, never another tenant's");
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  process.env.GLOBEX_TEST_CALLER_KEY = 'globex-caller-key';
  const octokit = makeFakeOctokit();
  const hubOctokit = makeFakeHubOctokit();
  const fetchImpl = makeFakeFetch(NO_FINDING_JSON);
  await processRequest(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit, fetchImpl, dryRunOverride: true, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('exactly one usage write happened', hubOctokit._writes.length === 1);
  check("it was written to acme's usage log path", hubOctokit._writes[0].path === 'usage/acme.json');
  check("globex's usage log was never touched", hubOctokit._logs.globex === undefined);
  const acmeEntries = hubOctokit._logs.acme;
  check('the recorded event is tagged with the right tenantId/eventType', acmeEntries?.[0]?.tenantId === 'acme' && acmeEntries?.[0]?.eventType === 'review_run');
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_CALLER_KEY;
}

async function testQuotaExceededBlocksBeforeTheAiCall() {
  console.log("Multi-tenancy: a tenant over their monthly quota (globex, cap 2) is blocked BEFORE the AI call - no cost incurred");
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  process.env.GLOBEX_TEST_CALLER_KEY = 'globex-caller-key';
  const octokit = makeFakeOctokit();
  const hubOctokit = makeFakeHubOctokit();
  // Pre-seed globex's usage log with 2 review_run events already this month - at the cap.
  const now = new Date('2026-08-13T00:00:00Z');
  hubOctokit._logs.globex = [
    { tenantId: 'globex', timestamp: '2026-08-01T00:00:00Z', eventType: 'review_run' },
    { tenantId: 'globex', timestamp: '2026-08-05T00:00:00Z', eventType: 'review_run' }
  ];
  const fetchImpl = makeFakeFetch(NO_FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'globex-org', repo: 'globex-repo', mode: 'debug', callerKey: 'globex-caller-key' },
    { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit, fetchImpl, dryRunOverride: true, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS, now }
  );
  check('status is Skipped', body.status === 'Skipped');
  check('reason mentions the monthly quota', /quota/i.test(body.reason || ''));
  check('the AI was never called - no cost incurred once over quota', fetchImpl.callCount() === 0);
  delete process.env.GLOBEX_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_CALLER_KEY;
}

async function testQuotaUnderLimitProceedsNormally() {
  console.log('Multi-tenancy: a tenant under their monthly quota proceeds to the AI call normally');
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  process.env.GLOBEX_TEST_CALLER_KEY = 'globex-caller-key';
  const octokit = makeFakeOctokit();
  const hubOctokit = makeFakeHubOctokit();
  const now = new Date('2026-08-13T00:00:00Z');
  hubOctokit._logs.globex = [
    { tenantId: 'globex', timestamp: '2026-08-01T00:00:00Z', eventType: 'review_run' }
  ]; // 1 of 2 used
  const fetchImpl = makeFakeFetch(NO_FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'globex-org', repo: 'globex-repo', mode: 'debug', callerKey: 'globex-caller-key' },
    { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit, fetchImpl, dryRunOverride: true, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS, now }
  );
  check('the AI was called - still under quota', fetchImpl.callCount() === 1);
  check('status is not a quota skip', !/quota/i.test(body.reason || ''));
}

async function testNullQuotaMeansUnlimited() {
  console.log("Multi-tenancy: quota.reviewsPerMonth: null (acme, and the real 'default' tenant) never checks or blocks on usage");
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  const octokit = makeFakeOctokit();
  const hubOctokit = makeFakeHubOctokit();
  // Seed an absurdly high usage count - should be irrelevant for a null quota.
  hubOctokit._logs.acme = Array.from({ length: 500 }, (_, i) => ({ tenantId: 'acme', timestamp: '2026-08-01T00:00:00Z', eventType: 'review_run' }));
  const fetchImpl = makeFakeFetch(NO_FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit, fetchImpl, dryRunOverride: true, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('the AI was still called despite 500 prior events - null quota is unlimited', fetchImpl.callCount() === 1);
  delete process.env.ACME_TEST_TOKEN;
}

// --- Issue #34: diff ordering/truncation puts code before docs, and one -----
// --- huge file can't starve everything after it -----------------------------

async function testDiffOrdersCodeFilesBeforeDocFilesWhenBothCantFit() {
  console.log('Issue #34: when the diff is too big to fit, a doc file yields its slot to a code file');
  // A huge doc file first (as GitHub's file order would have it), then a
  // small real code file - large enough combined to force a choice.
  const hugeDocPatch = '+line\n'.repeat(5000); // way over MAX_DIFF_CHARS on its own
  const diffFiles = [
    { filename: 'DEPLOY_GUIDE.md', status: 'modified', patch: hugeDocPatch },
    { filename: 'src/real_logic.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-buggy\n+fixed' }
  ];
  const octokit = makeFakeOctokit({ diffFiles });
  const fetchImpl = makeFakeFetchCapturing(NO_FINDING_JSON);
  await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  const prompt = fetchImpl.lastPrompt();
  check('the code file made it into the prompt', prompt.includes('src/real_logic.js'));
  check('the code file\'s actual patch text is present', prompt.includes('buggy') && prompt.includes('fixed'));
}

async function testDiffCapsAnySingleFileSoItCannotStarveTheRest() {
  console.log("Issue #34: one file's patch is capped so it can't consume the whole budget alone");
  const hugeCodePatch = '+line\n'.repeat(5000);
  const diffFiles = [
    { filename: 'src/huge_file.js', status: 'modified', patch: hugeCodePatch },
    { filename: 'src/small_file.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-old\n+distinctive_marker' }
  ];
  const octokit = makeFakeOctokit({ diffFiles });
  const fetchImpl = makeFakeFetchCapturing(NO_FINDING_JSON);
  await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  const prompt = fetchImpl.lastPrompt();
  check('the huge file is present but truncated', prompt.includes('src/huge_file.js') && prompt.includes('truncated'));
  check('the small file after it still made it in', prompt.includes('distinctive_marker'));
}

async function testDiffNotesOmittedFilesWhenTheyDontFit() {
  console.log('Issue #34: files that genuinely cannot fit are named in an omission note, not silently dropped');
  // Each patch is well over PER_FILE_MAX_CHARS (2000) on its own, so every
  // file gets capped to ~2000 chars individually - but 7 of those (~14,000
  // chars combined) still can't all fit under the overall MAX_DIFF_CHARS
  // (12000), so at least one must be omitted outright.
  const diffFiles = Array.from({ length: 7 }, (_, i) => ({
    filename: `src/${String.fromCharCode(97 + i)}.js`, // a.js, b.js, ...
    status: 'modified',
    patch: '+line\n'.repeat(3000)
  }));
  const octokit = makeFakeOctokit({ diffFiles });
  const fetchImpl = makeFakeFetchCapturing(NO_FINDING_JSON);
  await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  const prompt = fetchImpl.lastPrompt();
  check('an omission note is present', prompt.includes('omitted'));
  check('the omission note names a specific dropped file', /src\/[a-g]\.js/.test(prompt.slice(prompt.indexOf('omitted'))));
}

// --- Issue #35: bot-authored / generated-data-only commits are skipped -----
// --- before spending an AI call, and local-context files are independent --

async function testBotAuthoredCommitIsSkippedBeforeTheAiCall() {
  console.log('Issue #35: a github-actions[bot]-authored commit is skipped before the AI call');
  const octokit = makeFakeOctokit({ commitAuthorLogin: 'github-actions[bot]' });
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  check('AI was never called', fetchImpl.callCount() === 0);
  check('status is Skipped', body.status === 'Skipped');
  check('reason mentions bot/excluded', /bot|excluded/i.test(body.reason || ''));
}

async function testHumanCommitTouchingOnlyExportsPathIsSkipped() {
  console.log('Issue #35: a commit touching only exports/ paths is skipped even from a human author');
  const diffFiles = [
    { filename: 'exports/2026-08-17-issues.json', status: 'added', patch: '+huge json dump' },
    { filename: 'exports/2026-08-17-issues.md', status: 'added', patch: '+huge md dump' }
  ];
  const octokit = makeFakeOctokit({ diffFiles }); // no bot author set - a human pushed this
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { body } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  check('AI was never called', fetchImpl.callCount() === 0);
  check('status is Skipped', body.status === 'Skipped');
}

async function testNormalCommitFromABotIsNotSkippedIfPathsArentExcluded() {
  console.log('Issue #35 (regression guard): being bot-authored alone already skips - but a mixed human/bot-adjacent path set is not treated as excluded unless ALL files match');
  const diffFiles = [
    { filename: 'src/real_logic.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-old\n+new' },
    { filename: 'exports/data.json', status: 'added', patch: '+data' }
  ];
  const octokit = makeFakeOctokit({ diffFiles }); // human author, mixed paths - NOT all excluded
  const fetchImpl = makeFakeFetch(FINDING_JSON);
  const { httpStatus } = await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  check('AI was still called - not every file matched the excluded prefix', fetchImpl.callCount() === 1);
  check('httpStatus is 200', httpStatus === 200);
}

async function testLocalContextSurvivesWhenOnlyOneFileIsMissing() {
  console.log("Issue #35: a real lessons.md still reaches the prompt even when NORTH_STAR.md 404s");
  const octokit = makeFakeOctokit({ missingLocalFiles: ['NORTH_STAR.md'] });
  const fetchImpl = makeFakeFetchCapturing(NO_FINDING_JSON);
  await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  const prompt = fetchImpl.lastPrompt();
  check('the real lessons.md content reached the prompt', prompt.includes('fake content of lessons.md'));
  check('NORTH_STAR is reported as not found, not silently dropped', prompt.includes('(none found)'));
  check('the whole local context did NOT collapse to "No local context found."', !prompt.includes('No local context found.'));
}

async function testLocalContextIsTheNoneFoundFallbackWhenBothFilesAreMissing() {
  console.log('Issue #35 (regression guard): when BOTH local files are genuinely missing, the fallback text still applies');
  const octokit = makeFakeOctokit({ missingLocalFiles: ['lessons.md', 'NORTH_STAR.md'] });
  const fetchImpl = makeFakeFetchCapturing(NO_FINDING_JSON);
  await processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { octokitFactory: makeFakeOctokitFactory(octokit), fetchImpl, dryRunOverride: true }
  );
  const prompt = fetchImpl.lastPrompt();
  check('falls back to "No local context found."', prompt.includes('No local context found.'));
}

async function main() {
  await testDryRunNeverCreatesIssue();
  await testRateCapBlocksAtLimit();
  await testRateCapAllowsUnderLimit();
  await testNoFindingsResponseCarriesDryRun();
  await testDecisionLogSkipsAlreadyDecidedCommit();
  await testAiErrorDoesNotBlockRetry();
  await testDecisionLogWritesEntryOnNormalRun();
  await testReplayOfACreatedDecisionSurfacesIssueUrlAtTopLevel();
  await testReplayWithoutAnIssueUrlOmitsTheField();
  await testUnregisteredSpokeFallsBackToDefaultTenantCredential();
  await testRegisteredSpokeResolvesItsOwnTenantCredential();
  await testCallerKeyEnforcedOnlyWhenTenantHasOneConfigured();
  await testCallerKeyRejectedWhenWrongForATenantThatRequiresOne();
  await testCallerKeyAcceptedWhenCorrect();
  await testUsageEventRecordedForTheCorrectTenantOnly();
  await testQuotaExceededBlocksBeforeTheAiCall();
  await testQuotaUnderLimitProceedsNormally();
  await testNullQuotaMeansUnlimited();
  await testDiffOrdersCodeFilesBeforeDocFilesWhenBothCantFit();
  await testDiffCapsAnySingleFileSoItCannotStarveTheRest();
  await testDiffNotesOmittedFilesWhenTheyDontFit();
  await testBotAuthoredCommitIsSkippedBeforeTheAiCall();
  await testHumanCommitTouchingOnlyExportsPathIsSkipped();
  await testNormalCommitFromABotIsNotSkippedIfPathsArentExcluded();
  await testLocalContextSurvivesWhenOnlyOneFileIsMissing();
  await testLocalContextIsTheNoneFoundFallbackWhenBothFilesAreMissing();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
