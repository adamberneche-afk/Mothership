// Local verification harness for gas/autonomous_agent.js's processRequest()
// and finalizeReviewResult_() - the Apps Script port of api/autonomous_agent.js,
// now split into an enqueue half (processRequest, called synchronously from
// doPost) and a finalize half (finalizeReviewResult_, called by
// harvestReviewResults() once a human-built Workspace Studio Flow has
// answered - see gas/review_queue.js's header comment for the full
// mechanics). Same rationale as every other dev-test-gas-*.mjs harness:
// nothing here calls GitHub, an AI API, or a real Apps Script deployment -
// every github/sheet call is a hand-rolled fake, loaded via the same
// vm-based harness (scripts/gas-test-harness.mjs) real Apps Script uses to
// run these files, so what's tested here is exactly what a real deployment
// executes.
//
// Usage: node scripts/dev-test-gas-handler.mjs

import { loadGasGlobals } from './gas-test-harness.mjs';
import { makeFakeSheet } from './gas-sheet-fakes.mjs';
import { strict as assert } from 'assert';

const { processRequest, finalizeReviewResult_ } = loadGasGlobals('constants.js', 'github.js', 'review_queue.js', 'autonomous_agent.js');

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
function makeFakeGithub({
  decisionLog = null, issuesCreatedToday = [], commitSha = 'abc123', diffFiles,
  hubOwner = 'adamberneche-afk', hubRepo = 'Mothership', commitAuthorLogin, missingLocalFiles = []
} = {}) {
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
          if (missingLocalFiles.includes(path)) throw new Error('404 not found');
          return { data: { content: b64(`fake content of ${path}`) } };
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
      getCommit: () => ({
        data: {
          files,
          ...(commitAuthorLogin ? { author: { login: commitAuthorLogin } } : {})
        }
      })
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

// Wraps a fake github client in the githubFactory shape processRequest now
// expects (decision #1: real per-tenant credentials, not one shared
// client) - records which token each call resolved to.
function makeFakeGithubFactory(github) {
  const tokensUsed = [];
  const factory = (token) => { tokensUsed.push(token); return github; };
  factory.tokensUsed = tokensUsed;
  return factory;
}

// Fake hub-side client for usage-log reads/writes AND, when no
// spokesOverride/tenantsOverride is passed, spokes.json/tenants.json
// reads too - a separate credential/client from the tenant-scoped one, per
// gas/autonomous_agent.js's header comment.
function makeFakeHubGithub({ hubOwner = 'adamberneche-afk', hubRepo = 'Mothership' } = {}) {
  const logs = {}; // tenantId -> usage entries[]
  const writes = [];
  const hubFiles = { 'universal_lessons.md': 'fake hub context', 'north_star_framework.md': 'fake hub context', 'hub_lessons.md': 'fake hub context' };
  return {
    _logs: logs,
    _writes: writes,
    repos: {
      getContent: ({ owner, repo, path }) => {
        if (owner !== hubOwner || repo !== hubRepo) throw new Error('404 not found');
        if (hubFiles[path] !== undefined) return { data: { content: b64(hubFiles[path]) } };
        if (path.startsWith('usage/')) {
          const tenantId = path.replace(/^usage\//, '').replace(/\.json$/, '');
          if (!logs[tenantId]) throw new Error('404 not found');
          return { data: { content: b64(JSON.stringify(logs[tenantId])), sha: `sha-${tenantId}` } };
        }
        throw new Error('404 not found'); // spokes.json/tenants.json: use spokesOverride/tenantsOverride in tests instead
      },
      createOrUpdateFileContents: (params) => {
        writes.push(params);
        const tenantId = params.path.replace(/^usage\//, '').replace(/\.json$/, '');
        logs[tenantId] = JSON.parse(unb64(params.content));
        return { data: {} };
      }
    }
  };
}

// Reads back the PromptText column (index 6) of the most recently
// appendRow()'d ReviewQueue row - what a diff-ordering/truncation
// assertion needs to inspect now, since there's no aiFetch payload to
// capture anymore (see review_queue.js's RQ column map).
function lastQueuedPrompt(sheet) {
  const rows = sheet._rows;
  return rows.length ? rows[rows.length - 1][6] : '';
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

// Registers the plain 'o'/'r' owner/repo pair every non-multi-tenancy test
// below uses, as a real registered spoke on a tenant with no callerKeyRef -
// these tests exist to exercise queuing/dedup/dry-run/etc., not tenant
// resolution, and processRequest() now rejects an owner/repo that isn't a
// registered spoke outright (see autonomous_agent.js's resolveTenantIdForSpoke
// header comment), so they need a real registration to keep reaching the
// behavior they're actually testing. Multi-tenancy-specific tests below
// override both fields explicitly with their own fixtures (TWO_TENANT_SPOKES/
// TWO_TENANTS, or a deliberately-unregistered owner/repo) later in the same
// object literal, which wins over this default.
const GENERIC_SPOKE = [
  { tenantId: 'generic', owner: 'o', repo: 'r', addedAt: '2026-08-13T00:00:00Z', status: 'active' }
];
const GENERIC_TENANT = [
  { tenantId: 'generic', name: 'Generic test tenant', status: 'active', plan: 'internal', quota: { reviewsPerMonth: null }, createdAt: '2026-08-13T00:00:00Z' }
];

const BASE_DEPS = {
  base64Encode: b64, base64Decode: unb64,
  spokesOverride: GENERIC_SPOKE, tenantsOverride: GENERIC_TENANT
};

const TWO_TENANT_SPOKES = [
  { tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' },
  { tenantId: 'globex', owner: 'globex-org', repo: 'globex-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' }
];
const TWO_TENANTS = [
  { tenantId: 'acme', name: 'Acme', status: 'active', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:ACME_TEST_TOKEN', createdAt: '2026-08-13T00:00:00Z' },
  { tenantId: 'globex', name: 'Globex', status: 'active', plan: 'trial', quota: { reviewsPerMonth: 2 }, githubCredentialRef: 'env:GLOBEX_TEST_TOKEN', callerKeyRef: 'env:GLOBEX_TEST_CALLER_KEY', createdAt: '2026-08-13T00:00:00Z' }
];

// A fake Script Properties store for resolveSecretRef's env: scheme.
function makeFakeScriptProperties(props) {
  return { getProperty: (key) => (props[key] !== undefined ? props[key] : null) };
}

// --- Enqueue half: processRequest() only queues, never answers directly ----

function testProcessRequestQueuesInsteadOfAnswering() {
  console.log('processRequest() queues a row and responds "Queued" - no more inline AI call/answer');
  const github = makeFakeGithub();
  const sheet = makeFakeSheet();
  const { httpStatus, body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), reviewQueueSheet: sheet, dryRunOverride: true }
  );
  check('httpStatus is 200', httpStatus === 200);
  check('status is Queued', body.status === 'Queued');
  check('dryRun field is present', body.dryRun === true);
  check('exactly one row was queued', sheet._rows.length === 1);
  check('queued row carries owner/repo/mode/commitSha/READY', sheet._rows[0].slice(1, 6).join('|') === 'o|r|debug|abc123|READY');
  check('queued row carries a real prompt', sheet._rows[0][6].includes('MODE: DEBUG'));
}

function testProcessRequestDedupsARepeatedQueueAttempt() {
  console.log('processRequest() does not queue a second row for the same owner/repo/mode/commit while one is still pending');
  const github = makeFakeGithub();
  const sheet = makeFakeSheet();
  processRequest({ owner: 'o', repo: 'r', mode: 'debug' }, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), reviewQueueSheet: sheet, dryRunOverride: true });
  const { body } = processRequest({ owner: 'o', repo: 'r', mode: 'debug' }, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), reviewQueueSheet: sheet, dryRunOverride: true });
  check('still only one row queued', sheet._rows.length === 1);
  check('second call reports already queued', /already queued/i.test(body.reason || ''));
}

function testProcessRequestSkipsCleanlyWhenNoQueueSheetConfigured() {
  console.log('processRequest() fails safe (Skipped, not a crash) when QUEUE_SHEET_ID is not configured and no override is given');
  const github = makeFakeGithub();
  const { httpStatus, body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), dryRunOverride: true, config: {} }
  );
  check('httpStatus is 200', httpStatus === 200);
  check('status is Skipped', body.status === 'Skipped');
  check('reason names the missing QUEUE_SHEET_ID', /QUEUE_SHEET_ID/.test(body.reason || ''));
}

// --- Skip paths stay synchronous and unchanged in substance -----------------

function testDecisionLogSkipsAlreadyDecidedCommit() {
  console.log('A logged (non-ai_error) decision for this commit+mode skips queuing entirely');
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'no_findings', issueUrl: null, summary: null }
  ];
  const github = makeFakeGithub({ decisionLog, commitSha: 'abc123' });
  const sheet = makeFakeSheet();
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), reviewQueueSheet: sheet, dryRunOverride: true }
  );
  check('nothing was queued', sheet._rows.length === 0);
  check('status is Skipped', body.status === 'Skipped');
  check('priorDecision reflects the logged outcome', body.priorDecision?.outcome === 'no_findings');
}

function testAiErrorDoesNotBlockRetry() {
  console.log("A logged 'ai_error' outcome does NOT block re-queuing the same commit+mode");
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'ai_error', issueUrl: null, summary: null }
  ];
  const github = makeFakeGithub({ decisionLog, commitSha: 'abc123' });
  const sheet = makeFakeSheet();
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), reviewQueueSheet: sheet, dryRunOverride: true }
  );
  check('a fresh row was queued (not skipped)', sheet._rows.length === 1);
  check('status is Queued', body.status === 'Queued');
}

function testReplayOfACreatedDecisionSurfacesIssueUrlAtTopLevel() {
  console.log('Replaying a prior "created" decision surfaces issueUrl at the top level too');
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'created', issueUrl: 'https://github.com/o/r/issues/42', summary: 'Found a thing' }
  ];
  const github = makeFakeGithub({ decisionLog, commitSha: 'abc123' });
  const sheet = makeFakeSheet();
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), reviewQueueSheet: sheet, dryRunOverride: true }
  );
  check('nothing was queued', sheet._rows.length === 0);
  check('top-level issueUrl matches the logged one', body.issueUrl === 'https://github.com/o/r/issues/42');
  check('still nested under priorDecision too', body.priorDecision?.issueUrl === 'https://github.com/o/r/issues/42');
}

function testReplayWithoutAnIssueUrlOmitsTheField() {
  console.log('Replaying a decision with no issueUrl does not add a spurious top-level field');
  const decisionLog = [
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'no_findings', issueUrl: null, summary: null }
  ];
  const github = makeFakeGithub({ decisionLog, commitSha: 'abc123' });
  const sheet = makeFakeSheet();
  const { body } = processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), reviewQueueSheet: sheet, dryRunOverride: true }
  );
  check('no top-level issueUrl field', body.issueUrl === undefined);
}

function testQuotaExceededBlocksBeforeQueuing() {
  console.log('Multi-tenancy: a tenant over their monthly quota (globex, cap 2) is blocked BEFORE anything is queued');
  const github = makeFakeGithub();
  const hubGithub = makeFakeHubGithub();
  hubGithub._logs.globex = [
    { tenantId: 'globex', timestamp: '2026-08-01T00:00:00Z', eventType: 'review_run' },
    { tenantId: 'globex', timestamp: '2026-08-05T00:00:00Z', eventType: 'review_run' }
  ];
  const sheet = makeFakeSheet();
  const scriptProperties = makeFakeScriptProperties({ GLOBEX_TEST_TOKEN: 'globex-secret-token', GLOBEX_TEST_CALLER_KEY: 'globex-caller-key' });
  const now = new Date('2026-08-13T00:00:00Z');
  const { body } = processRequest(
    { owner: 'globex-org', repo: 'globex-repo', mode: 'debug', callerKey: 'globex-caller-key' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub, reviewQueueSheet: sheet, dryRunOverride: true, now, config: { scriptProperties }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('status is Skipped', body.status === 'Skipped');
  check('reason mentions the monthly quota', /quota/i.test(body.reason || ''));
  check('nothing was queued once over quota', sheet._rows.length === 0);
}

function testCallerKeyRejectedWhenWrongForATenantThatRequiresOne() {
  console.log('Multi-tenancy: a tenant WITH callerKeyRef set (globex) rejects a missing/wrong key with 401, before queuing');
  const github = makeFakeGithub();
  const hubGithub = makeFakeHubGithub();
  const sheet = makeFakeSheet();
  const scriptProperties = makeFakeScriptProperties({ GLOBEX_TEST_TOKEN: 'globex-secret-token', GLOBEX_TEST_CALLER_KEY: 'globex-caller-key' });
  const { httpStatus } = processRequest(
    { owner: 'globex-org', repo: 'globex-repo', mode: 'debug', callerKey: 'wrong-key' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub, reviewQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('httpStatus is 401', httpStatus === 401);
  check('nothing was queued for a rejected caller', sheet._rows.length === 0);
}

function testCallerKeyAcceptedWhenCorrect() {
  console.log('Multi-tenancy: the correct callerKey for a tenant that requires one proceeds normally');
  const github = makeFakeGithub();
  const hubGithub = makeFakeHubGithub();
  const sheet = makeFakeSheet();
  const scriptProperties = makeFakeScriptProperties({ GLOBEX_TEST_TOKEN: 'globex-secret-token', GLOBEX_TEST_CALLER_KEY: 'globex-caller-key' });
  const { httpStatus } = processRequest(
    { owner: 'globex-org', repo: 'globex-repo', mode: 'debug', callerKey: 'globex-caller-key' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub, reviewQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('httpStatus is 200 with the correct key', httpStatus === 200);
  check('a row was queued', sheet._rows.length === 1);
}

function testUnregisteredSpokeIsRejectedOutright() {
  // Real gap this closed: gas/'s deployment is a publicly-reachable
  // ("Anyone") web app, and resolveTenantIdForSpoke() used to fall back to
  // the "default" tenant - and its GLOBAL_GITHUB_TOKEN-backed credential -
  // for ANY owner/repo, not just this hub's own registered spokes. It now
  // returns no tenant at all for an unmatched owner/repo, and
  // processRequest() rejects the request before any GitHub call runs.
  console.log('Multi-tenancy: an owner/repo that is not a registered spoke of ANY tenant is rejected outright, before any GitHub call runs');
  const github = makeFakeGithub();
  const factory = makeFakeGithubFactory(github);
  const hubGithub = makeFakeHubGithub();
  const sheet = makeFakeSheet();
  const { httpStatus, body } = processRequest(
    { owner: 'not-registered-owner', repo: 'not-registered-repo', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: factory, hubGithub, reviewQueueSheet: sheet, dryRunOverride: true, config: { globalGithubToken: 'the-global-token' }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('httpStatus is 403', httpStatus === 403);
  check('error names the actual problem', /not a registered spoke/i.test(body.error || ''));
  check('no real GitHub API call ever ran with the global token', github.calls.getContent.length === 0);
  check('nothing was queued for a rejected owner/repo', sheet._rows.length === 0);
}

function testRegisteredSpokeResolvesItsOwnTenantCredential() {
  console.log("Multi-tenancy: a registered spoke resolves ITS tenant's own credential, not another tenant's or the global one");
  const github = makeFakeGithub();
  const factory = makeFakeGithubFactory(github);
  const hubGithub = makeFakeHubGithub();
  const sheet = makeFakeSheet();
  const scriptProperties = makeFakeScriptProperties({ ACME_TEST_TOKEN: 'acme-secret-token' });
  processRequest(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: factory, hubGithub, reviewQueueSheet: sheet, dryRunOverride: true, config: { globalGithubToken: 'the-global-token', scriptProperties }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check("resolved to acme's own token, not the global one", factory.tokensUsed[0] === 'acme-secret-token');
}

function testSuspendedTenantIsSkippedBeforeAnyGithubCall() {
  console.log("Multi-tenancy fix: a tenant with status !== 'active' is skipped before any GitHub call");
  const github = makeFakeGithub();
  const hubGithub = makeFakeHubGithub();
  const sheet = makeFakeSheet();
  const scriptProperties = makeFakeScriptProperties({ ACME_TEST_TOKEN: 'acme-secret-token' });
  const suspendedTenants = TWO_TENANTS.map(t => t.tenantId === 'acme' ? { ...t, status: 'suspended' } : t);
  const { httpStatus, body } = processRequest(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub, reviewQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: suspendedTenants }
  );
  check('httpStatus is 200 (a quiet skip, not an error)', httpStatus === 200);
  check("reason mentions the tenant's status", /status is 'suspended'/.test(body.reason));
  check('zero GitHub calls were made for a suspended tenant', github.calls.getContent.length === 0);
  check('nothing was queued for a suspended tenant', sheet._rows.length === 0);
}

function testTenantWithUnresolvableCredentialIsHardSkippedNeverFallsBackToGlobalToken() {
  console.log('Multi-tenancy fix: a matched tenant whose credential ref fails to resolve is a hard skip, never a silent global-token fallback');
  const github = makeFakeGithub();
  const factory = makeFakeGithubFactory(github);
  const hubGithub = makeFakeHubGithub();
  const sheet = makeFakeSheet();
  // Deliberately no ACME_TEST_TOKEN in scriptProperties - simulates a
  // misconfigured/revoked credential ref for a tenant that DOES exist.
  const scriptProperties = makeFakeScriptProperties({});
  const { httpStatus, body } = processRequest(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: factory, hubGithub, reviewQueueSheet: sheet, dryRunOverride: true, config: { globalGithubToken: 'the-global-token', scriptProperties }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('httpStatus is 200 (a quiet skip, not an error)', httpStatus === 200);
  check('reason mentions the credential could not be resolved', /Could not resolve GitHub credential/.test(body.reason));
  check('no real GitHub API call ran with the fallen-back global token', github.calls.getContent.length === 0);
  check('nothing was queued once the credential is unresolvable', sheet._rows.length === 0);
}

function testCallerKeyEnforcedOnlyWhenTenantHasOneConfigured() {
  console.log('Multi-tenancy: a tenant with no callerKeyRef set (acme) accepts any/no callerKey - backward compatible');
  const github = makeFakeGithub();
  const hubGithub = makeFakeHubGithub();
  const sheet = makeFakeSheet();
  const scriptProperties = makeFakeScriptProperties({ ACME_TEST_TOKEN: 'acme-secret-token' });
  const { httpStatus } = processRequest(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub, reviewQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('request proceeds (200), no caller-key requirement for this tenant', httpStatus === 200);
}

function testQuotaUnderLimitProceedsToQueuing() {
  console.log('Multi-tenancy: a tenant under their monthly quota proceeds to queuing normally');
  const github = makeFakeGithub();
  const hubGithub = makeFakeHubGithub();
  hubGithub._logs.globex = [{ tenantId: 'globex', timestamp: '2026-08-01T00:00:00Z', eventType: 'review_run' }]; // 1 of 2 used
  const sheet = makeFakeSheet();
  const scriptProperties = makeFakeScriptProperties({ GLOBEX_TEST_TOKEN: 'globex-secret-token', GLOBEX_TEST_CALLER_KEY: 'globex-caller-key' });
  const now = new Date('2026-08-13T00:00:00Z');
  const { body } = processRequest(
    { owner: 'globex-org', repo: 'globex-repo', mode: 'debug', callerKey: 'globex-caller-key' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub, reviewQueueSheet: sheet, dryRunOverride: true, now, config: { scriptProperties }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('a row was queued - still under quota', sheet._rows.length === 1);
  check('status is not a quota skip', !/quota/i.test(body.reason || ''));
}

function testNullQuotaMeansUnlimited() {
  console.log("Multi-tenancy: quota.reviewsPerMonth: null (acme, and the real 'default' tenant) never checks or blocks on usage");
  const github = makeFakeGithub();
  const hubGithub = makeFakeHubGithub();
  hubGithub._logs.acme = Array.from({ length: 500 }, () => ({ tenantId: 'acme', timestamp: '2026-08-01T00:00:00Z', eventType: 'review_run' }));
  const sheet = makeFakeSheet();
  const scriptProperties = makeFakeScriptProperties({ ACME_TEST_TOKEN: 'acme-secret-token' });
  processRequest(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub, reviewQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('a row was queued despite 500 prior events - null quota is unlimited', sheet._rows.length === 1);
}

// --- Issue #34: diff ordering/truncation puts code before docs, and one -----
// --- huge file can't starve everything after it - now checked in the -------
// --- queued PromptText, since there's no aiFetch payload to capture --------

function testDiffOrdersCodeFilesBeforeDocFilesWhenBothCantFit() {
  console.log('Issue #34: when the diff is too big to fit, a doc file yields its slot to a code file');
  const hugeDocPatch = '+line\n'.repeat(5000);
  const diffFiles = [
    { filename: 'DEPLOY_GUIDE.md', status: 'modified', patch: hugeDocPatch },
    { filename: 'src/real_logic.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-buggy\n+fixed' }
  ];
  const github = makeFakeGithub({ diffFiles });
  const sheet = makeFakeSheet();
  processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), reviewQueueSheet: sheet, dryRunOverride: true }
  );
  const prompt = lastQueuedPrompt(sheet);
  check('the code file made it into the prompt', prompt.includes('src/real_logic.js'));
  check('the code file\'s actual patch text is present', prompt.includes('buggy') && prompt.includes('fixed'));
}

function testDiffCapsAnySingleFileSoItCannotStarveTheRest() {
  console.log("Issue #34: one file's patch is capped so it can't consume the whole budget alone");
  const hugeCodePatch = '+line\n'.repeat(5000);
  const diffFiles = [
    { filename: 'src/huge_file.js', status: 'modified', patch: hugeCodePatch },
    { filename: 'src/small_file.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-old\n+distinctive_marker' }
  ];
  const github = makeFakeGithub({ diffFiles });
  const sheet = makeFakeSheet();
  processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), reviewQueueSheet: sheet, dryRunOverride: true }
  );
  const prompt = lastQueuedPrompt(sheet);
  check('the huge file is present but truncated', prompt.includes('src/huge_file.js') && prompt.includes('truncated'));
  check('the small file after it still made it in', prompt.includes('distinctive_marker'));
}

function testDiffNotesOmittedFilesWhenTheyDontFit() {
  console.log('Issue #34: files that genuinely cannot fit are named in an omission note, not silently dropped');
  const diffFiles = Array.from({ length: 7 }, (_, i) => ({
    filename: `src/${String.fromCharCode(97 + i)}.js`,
    status: 'modified',
    patch: '+line\n'.repeat(3000)
  }));
  const github = makeFakeGithub({ diffFiles });
  const sheet = makeFakeSheet();
  processRequest(
    { owner: 'o', repo: 'r', mode: 'debug' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), reviewQueueSheet: sheet, dryRunOverride: true }
  );
  const prompt = lastQueuedPrompt(sheet);
  check('an omission note is present', prompt.includes('omitted'));
  check('the omission note names a specific dropped file', /src\/[a-g]\.js/.test(prompt.slice(prompt.indexOf('omitted'))));
}

// --- Finalize half: finalizeReviewResult_() does everything the old --------
// --- inline AI-response handling used to do, given a harvested answer ------

function testFinalizeDryRunNeverCreatesIssue() {
  console.log('finalizeReviewResult_: dry-run mode never calls issues.create');
  const github = makeFakeGithub();
  const result = finalizeReviewResult_(
    { owner: 'o', repo: 'r', mode: 'debug', commitSha: 'abc123', rawContent: FINDING_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), dryRunOverride: true }
  );
  check('status is DryRunFinding', result.status === 'DryRunFinding');
  check('dryRun is true', result.dryRun === true);
  check('wouldCreate is present', !!result.wouldCreate?.title);
  check('issues.create was never called', github.calls.issuesCreate.length === 0);
}

function testFinalizeRateCapBlocksAtLimit() {
  console.log('finalizeReviewResult_: live mode blocks once the daily cap is reached');
  const cap = 3;
  const todayIssues = Array.from({ length: cap }, (_, i) => ({ created_at: new Date().toISOString(), number: i }));
  const github = makeFakeGithub({ issuesCreatedToday: todayIssues });
  const result = finalizeReviewResult_(
    { owner: 'o', repo: 'r', mode: 'debug', commitSha: 'abc123', rawContent: FINDING_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), dryRunOverride: false, config: { rateCapPerRepoPerDay: cap } }
  );
  check('status is Skipped once at cap', result.status === 'Skipped');
  check('reason mentions rate cap', /rate cap/i.test(result.reason || ''));
  check('issues.create was never called', github.calls.issuesCreate.length === 0);
}

function testFinalizeRateCapAllowsUnderLimit() {
  console.log('finalizeReviewResult_: live mode creates an issue when under the daily cap');
  const github = makeFakeGithub({ issuesCreatedToday: [] });
  const result = finalizeReviewResult_(
    { owner: 'o', repo: 'r', mode: 'debug', commitSha: 'abc123', rawContent: FINDING_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), dryRunOverride: false, config: { rateCapPerRepoPerDay: 3 } }
  );
  check('status is Success', result.status === 'Success');
  check('dryRun is false', result.dryRun === false);
  check('issues.create was called exactly once', github.calls.issuesCreate.length === 1);
  check('issue carries the hub label', github.calls.issuesCreate[0]?.labels?.includes('cto-hub-auto'));
}

function testFinalizeNoFindingsResponseCarriesDryRun() {
  console.log('finalizeReviewResult_: a no-findings response still carries dryRun');
  const github = makeFakeGithub();
  const result = finalizeReviewResult_(
    { owner: 'o', repo: 'r', mode: 'debug', commitSha: 'abc123', rawContent: NO_FINDING_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), dryRunOverride: true }
  );
  check('status is Skipped', result.status === 'Skipped');
  check('dryRun field is present', result.dryRun === true);
}

function testFinalizeInvalidJsonIsSkippedNotThrown() {
  console.log('finalizeReviewResult_: malformed GeminiFullOutput is a clean Skipped, not a thrown error');
  const github = makeFakeGithub();
  const result = finalizeReviewResult_(
    { owner: 'o', repo: 'r', mode: 'debug', commitSha: 'abc123', rawContent: 'not json at all' },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), dryRunOverride: true }
  );
  check('status is Skipped', result.status === 'Skipped');
  check('reason mentions invalid JSON', /valid JSON/i.test(result.reason || ''));
}

function testFinalizeWritesDecisionLogEntry() {
  console.log('finalizeReviewResult_: a normal run appends a well-formed entry to the decision log');
  const github = makeFakeGithub({ decisionLog: null, commitSha: 'abc123' }); // no log file yet
  finalizeReviewResult_(
    { owner: 'o', repo: 'r', mode: 'debug', commitSha: 'abc123', rawContent: FINDING_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), dryRunOverride: true }
  );
  const writes = github.calls.createOrUpdateFileContents;
  check('exactly one write to the decision log', writes.length === 1);
  const writtenEntries = JSON.parse(unb64(writes[0].content));
  check('log now has one entry', writtenEntries.length === 1);
  check('entry has the right commitSha/mode/outcome', writtenEntries[0].commitSha === 'abc123' && writtenEntries[0].mode === 'debug' && writtenEntries[0].outcome === 'dry_run_would_create');
  check('no sha sent when the file did not exist yet', writes[0].sha === undefined);
}

function testFinalizeRecordsUsageForTheCorrectTenantOnly() {
  console.log("Multi-tenancy: finalizeReviewResult_ records a usage event under ITS tenant's usage log, never another tenant's");
  const github = makeFakeGithub();
  const hubGithub = makeFakeHubGithub();
  const scriptProperties = makeFakeScriptProperties({ ACME_TEST_TOKEN: 'acme-secret-token' });
  finalizeReviewResult_(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug', commitSha: 'abc123', rawContent: NO_FINDING_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub, dryRunOverride: true, config: { scriptProperties }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('exactly one usage write happened', hubGithub._writes.length === 1);
  check("it was written to acme's usage log path", hubGithub._writes[0].path === 'usage/acme.json');
  check("globex's usage log was never touched", hubGithub._logs.globex === undefined);
  const acmeEntries = hubGithub._logs.acme;
  check('the recorded event is tagged with the right tenantId/eventType', acmeEntries?.[0]?.tenantId === 'acme' && acmeEntries?.[0]?.eventType === 'review_run');
}

function testFinalizeReResolvesTheCorrectTenantCredential() {
  console.log('finalizeReviewResult_ re-resolves the spoke\'s own tenant credential fresh, not a persisted one');
  const github = makeFakeGithub({ issuesCreatedToday: [] });
  const factory = makeFakeGithubFactory(github);
  const hubGithub = makeFakeHubGithub();
  const scriptProperties = makeFakeScriptProperties({ ACME_TEST_TOKEN: 'acme-secret-token' });
  finalizeReviewResult_(
    { owner: 'acme-org', repo: 'acme-repo', mode: 'debug', commitSha: 'abc123', rawContent: FINDING_JSON },
    { ...BASE_DEPS, githubFactory: factory, hubGithub, dryRunOverride: false, config: { scriptProperties, rateCapPerRepoPerDay: 3 }, spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check("resolved to acme's own token at finalize time", factory.tokensUsed.includes('acme-secret-token'));
}

// --- Platform port: base64 round-trips through the injected functions -------

function testBase64RoundTripsThroughInjectedFunctions() {
  console.log('Platform port: content written to the decision log round-trips through base64Encode/Decode correctly');
  const github = makeFakeGithub({ decisionLog: [], commitSha: 'abc123' });
  finalizeReviewResult_(
    { owner: 'o', repo: 'r', mode: 'debug', commitSha: 'abc123', rawContent: FINDING_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), dryRunOverride: true }
  );
  const writes = github.calls.createOrUpdateFileContents;
  const decoded = JSON.parse(unb64(writes[0].content));
  check('the written entry is valid JSON after a real base64 round-trip', Array.isArray(decoded) && decoded.length === 1);
}

async function main() {
  testProcessRequestQueuesInsteadOfAnswering();
  testProcessRequestDedupsARepeatedQueueAttempt();
  testProcessRequestSkipsCleanlyWhenNoQueueSheetConfigured();
  testDecisionLogSkipsAlreadyDecidedCommit();
  testAiErrorDoesNotBlockRetry();
  testReplayOfACreatedDecisionSurfacesIssueUrlAtTopLevel();
  testReplayWithoutAnIssueUrlOmitsTheField();
  testQuotaExceededBlocksBeforeQueuing();
  testSuspendedTenantIsSkippedBeforeAnyGithubCall();
  testTenantWithUnresolvableCredentialIsHardSkippedNeverFallsBackToGlobalToken();
  testCallerKeyEnforcedOnlyWhenTenantHasOneConfigured();
  testCallerKeyRejectedWhenWrongForATenantThatRequiresOne();
  testCallerKeyAcceptedWhenCorrect();
  testUnregisteredSpokeIsRejectedOutright();
  testRegisteredSpokeResolvesItsOwnTenantCredential();
  testQuotaUnderLimitProceedsToQueuing();
  testNullQuotaMeansUnlimited();
  testDiffOrdersCodeFilesBeforeDocFilesWhenBothCantFit();
  testDiffCapsAnySingleFileSoItCannotStarveTheRest();
  testDiffNotesOmittedFilesWhenTheyDontFit();
  testFinalizeDryRunNeverCreatesIssue();
  testFinalizeRateCapBlocksAtLimit();
  testFinalizeRateCapAllowsUnderLimit();
  testFinalizeNoFindingsResponseCarriesDryRun();
  testFinalizeInvalidJsonIsSkippedNotThrown();
  testFinalizeWritesDecisionLogEntry();
  testFinalizeRecordsUsageForTheCorrectTenantOnly();
  testFinalizeReResolvesTheCorrectTenantCredential();
  testBase64RoundTripsThroughInjectedFunctions();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
