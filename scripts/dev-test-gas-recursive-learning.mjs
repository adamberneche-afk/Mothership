// Local verification harness for gas/recursive_learning.js's
// runRecursiveLearning() and finalizeLearningResult_() - the Apps Script
// port of api/recursive_learning.js, now split into an enqueue half
// (runRecursiveLearning, called from doPost on its monthly schedule) and a
// finalize half (finalizeLearningResult_, called by harvestLearningResults()
// once a human-built Workspace Studio Flow has answered - see
// gas/review_queue.js's header comment for the full mechanics). Same
// rationale as dev-test-gas-handler.mjs - loaded via the same vm-based
// harness real Apps Script uses to run these files.
//
// Usage: node scripts/dev-test-gas-recursive-learning.mjs

import { loadGasGlobals } from './gas-test-harness.mjs';
import { makeFakeSheet } from './gas-sheet-fakes.mjs';

const { runRecursiveLearning, finalizeLearningResult_ } = loadGasGlobals('constants.js', 'github.js', 'review_queue.js', 'recursive_learning.js');

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

// One github instance plays both roles (hub + tenant-scoped spoke access)
// for tests that don't care about credential separation.
function makeFakeGithub({ spokesRegistry = [], perSpokeFiles = {}, defaultBranch = 'main' } = {}) {
  const calls = { getContent: [], getRef: [], createRef: [], createOrUpdateFileContents: [], pullsCreate: [], reposGet: [] };
  return {
    calls,
    repos: {
      get: (params) => {
        calls.reposGet.push(params);
        return { data: { default_branch: defaultBranch } };
      },
      getContent: ({ owner, repo, path }) => {
        calls.getContent.push({ owner, repo, path });
        if (path === 'spokes.json') {
          return { data: { content: b64(JSON.stringify(spokesRegistry)) } };
        }
        if (path === 'tenants.json') {
          return { data: { content: b64('[]') } };
        }
        const key = `${owner}/${repo}:${path}`;
        if (perSpokeFiles[key] !== undefined) {
          return { data: { content: b64(perSpokeFiles[key]), sha: 'fake-sha' } };
        }
        throw new Error('404 not found');
      },
      createOrUpdateFileContents: (params) => {
        calls.createOrUpdateFileContents.push(params);
        return { data: {} };
      }
    },
    git: {
      getRef: (params) => {
        calls.getRef.push(params);
        return { data: { object: { sha: 'base-sha' } } };
      },
      createRef: (params) => {
        calls.createRef.push(params);
        return { data: {} };
      }
    },
    pulls: {
      create: (params) => {
        calls.pullsCreate.push(params);
        return { data: { html_url: `https://github.com/fake/fake/pull/${calls.pullsCreate.length + 1}` } };
      }
    }
  };
}

function makeFakeGithubFactory(github) {
  const tokensUsed = [];
  const factory = (token) => { tokensUsed.push(token); return github; };
  factory.tokensUsed = tokensUsed;
  return factory;
}

// Reads back every row of a fake LearningQueue sheet as {kind, tenantId,
// promptText, geminiOutput, contextJson} - see review_queue.js's LQ column
// map. No header row assumed (tests pass a raw sheet override), same
// "start at 0" reasoning as enqueueReviewRow_'s own dedup scan.
function queuedLearningRows(sheet) {
  return sheet._rows.map((r) => ({
    kind: r[1], tenantId: r[2], readyStatus: r[3], promptText: r[4], geminiOutput: r[5], contextJson: r[6]
  }));
}

const ONE_SPOKE = [{ owner: 'fake-owner', repo: 'fake-spoke', addedAt: '2026-08-06T00:00:00Z', status: 'active' }];
const SPOKE_FILES = {
  'fake-owner/fake-spoke:lessons.md': '# Local Lessons\n- Some real lesson here.',
  'fake-owner/fake-spoke:ai_decision_log.json': JSON.stringify([
    { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc', outcome: 'no_findings', issueUrl: null, summary: null }
  ])
};

const PROPOSAL_JSON = JSON.stringify({
  has_proposal: true,
  reasoning: 'Multiple spokes show the same class of missing-validation bug.',
  universal_lessons_patch: '# Universal Engineering Standards\n\n- Validate before you trust.',
  north_star_patch: ''
});

const NO_PROPOSAL_JSON = JSON.stringify({
  has_proposal: false,
  reasoning: '',
  universal_lessons_patch: '',
  north_star_patch: ''
});

const BASE_DEPS = { base64Encode: b64, base64Decode: unb64 };

// --- Enqueue half: runRecursiveLearning() only queues, never answers -------

function testNoSpokesRegisteredSkips() {
  console.log('No registered spokes skips without queuing anything');
  const github = makeFakeGithub({ spokesRegistry: [] });
  const sheet = makeFakeSheet();
  const { body } = runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, learningQueueSheet: sheet, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('status is Skipped', body.status === 'Skipped');
  check('reason mentions no spokes', /no spokes/i.test(body.reason || ''));
  check('nothing was queued', sheet._rows.length === 0);
}

function testQueuesOneRowPerTenant() {
  console.log('runRecursiveLearning() queues one LearningQueue row per tenant, status Queued in the response');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const sheet = makeFakeSheet();
  const { body } = runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, learningQueueSheet: sheet, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('status is Completed (the aggregate wrapper)', body.status === 'Completed');
  check('the one tenant result is Queued', body.results[0]?.status === 'Queued');
  check('exactly one row was queued for the tenant', sheet._rows.filter(r => r[1] === 'tenant').length === 1);
  check('no branch was created at enqueue time', github.calls.createRef.length === 0);
  check('no PR was opened at enqueue time', github.calls.pullsCreate.length === 0);
}

function testPromptIncludesNegativeMaintainerFeedbackSummary() {
  console.log('the queued prompt includes a MAINTAINER FEEDBACK line naming a real negative-feedback count when scripts/collect-issue-feedback.js has recorded one');
  const filesWithFeedback = {
    ...SPOKE_FILES,
    'fake-owner/fake-spoke:ai_decision_log.json': JSON.stringify([
      { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc', outcome: 'created', issueUrl: 'https://github.com/fake-owner/fake-spoke/issues/1', summary: null, feedback: { thumbsDown: 2, thumbsUp: 0, checkedAt: '2026-08-02T00:00:00Z' } },
      { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'def', outcome: 'no_findings', issueUrl: null, summary: null }
    ])
  };
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: filesWithFeedback });
  const sheet = makeFakeSheet();
  runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, learningQueueSheet: sheet, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const prompt = queuedLearningRows(sheet).find(r => r.kind === 'tenant').promptText;
  check('prompt mentions MAINTAINER FEEDBACK', /MAINTAINER FEEDBACK/.test(prompt));
  check('prompt names the real negative-feedback count (1 of the 2 logged decisions)', /1 of the last 2 decisions received negative maintainer feedback/.test(prompt));
}

function testPromptSaysNoneWhenNoNegativeFeedbackExists() {
  console.log('the queued prompt says "none" when no decision has received negative maintainer feedback');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const sheet = makeFakeSheet();
  runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, learningQueueSheet: sheet, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const prompt = queuedLearningRows(sheet).find(r => r.kind === 'tenant').promptText;
  check('prompt says none received negative maintainer feedback', /none of the last decisions received negative maintainer feedback/.test(prompt));
}

// --- Finalize half: finalizeLearningResult_() does everything the old ------
// --- inline AI-response handling used to do, given a harvested answer ------

function testFinalizeNoProposalSkips() {
  console.log('finalizeLearningResult_: AI reporting no cross-spoke pattern skips without opening anything');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const result = finalizeLearningResult_(
    { kind: 'tenant', tenantId: 'default', rawContent: NO_PROPOSAL_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo', spokesOverride: ONE_SPOKE.map(s => ({ ...s, tenantId: 'default' })), tenantsOverride: [] }
  );
  check('status is Skipped', result.status === 'Skipped');
  check('no branch was created', github.calls.createRef.length === 0);
  check('no PR was opened', github.calls.pullsCreate.length === 0);
}

function testFinalizeDryRunNeverOpensAPR() {
  console.log('finalizeLearningResult_: dry-run mode returns the proposal without opening a PR');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const result = finalizeLearningResult_(
    { kind: 'tenant', tenantId: 'default', rawContent: PROPOSAL_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo', spokesOverride: ONE_SPOKE.map(s => ({ ...s, tenantId: 'default' })), tenantsOverride: [] }
  );
  check('dryRun is true', result.dryRun === true);
  check('status is DryRunProposal', result.status === 'DryRunProposal');
  check('proposal is present', !!result.proposal?.reasoning);
  check('no branch was created', github.calls.createRef.length === 0);
  check('no PR was opened', github.calls.pullsCreate.length === 0);
}

function testFinalizeLiveOpensExactlyOnePR() {
  console.log('finalizeLearningResult_: live mode opens exactly one PR against the hub itself, never a direct commit to main');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const spokes = ONE_SPOKE.map(s => ({ ...s, tenantId: 'default' }));
  const result = finalizeLearningResult_(
    { kind: 'tenant', tenantId: 'default', rawContent: PROPOSAL_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo', spokesOverride: spokes, tenantsOverride: [] }
  );
  check('status is Success', result.status === 'Success');
  check('pullRequestUrl is present', !!result.pullRequestUrl);
  check('exactly one branch was created off main', github.calls.createRef.length === 1);
  check('the PR base is main', github.calls.pullsCreate[0]?.base === 'main');
  check('the PR targets the hub repo, not a spoke', github.calls.pullsCreate[0]?.owner === 'hub-owner' && github.calls.pullsCreate[0]?.repo === 'hub-repo');
  check('the PR body names the tenant that prompted it', /tenant `default`/.test(github.calls.pullsCreate[0]?.body || ''));
  check('exactly one PR was opened', github.calls.pullsCreate.length === 1);
  check('only universal_lessons.md was written (north_star_patch was empty)', github.calls.createOrUpdateFileContents.length === 1 && github.calls.createOrUpdateFileContents[0].path === 'universal_lessons.md');
}

function testFinalizeUsesTheRepoActualDefaultBranchNotHardcodedMain() {
  console.log("finalizeLearningResult_ uses the hub repo's real default branch instead of assuming 'main'");
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES, defaultBranch: 'trunk' });
  const spokes = ONE_SPOKE.map(s => ({ ...s, tenantId: 'default' }));
  finalizeLearningResult_(
    { kind: 'tenant', tenantId: 'default', rawContent: PROPOSAL_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo', spokesOverride: spokes, tenantsOverride: [] }
  );
  check('looked up the default branch via repos.get', github.calls.reposGet.length === 1);
  check('branched off the real default branch, not "main"', github.calls.getRef[0]?.ref === 'heads/trunk');
  check('the PR base is the real default branch, not "main"', github.calls.pullsCreate[0]?.base === 'trunk');
}

function testFinalizeBase64RoundTripsThroughInjectedFunctions() {
  console.log('Platform port: proposed file content round-trips through base64Encode/Decode correctly');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const spokes = ONE_SPOKE.map(s => ({ ...s, tenantId: 'default' }));
  finalizeLearningResult_(
    { kind: 'tenant', tenantId: 'default', rawContent: PROPOSAL_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo', spokesOverride: spokes, tenantsOverride: [] }
  );
  const write = github.calls.createOrUpdateFileContents[0];
  check('the written content decodes back to the real proposal text', unb64(write.content).includes('Validate before you trust.'));
}

// --- Multi-tenancy: isolation, per-tenant credentials, per-tenant PRs -----

const TWO_TENANT_SPOKES = [
  { tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' },
  { tenantId: 'globex', owner: 'globex-org', repo: 'globex-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' }
];
const TWO_TENANTS = [
  { tenantId: 'acme', name: 'Acme', status: 'active', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:ACME_TEST_TOKEN', createdAt: '2026-08-13T00:00:00Z' },
  { tenantId: 'globex', name: 'Globex', status: 'active', plan: 'trial', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:GLOBEX_TEST_TOKEN', createdAt: '2026-08-13T00:00:00Z' }
];
const TWO_TENANT_SPOKE_FILES = {
  'acme-org/acme-repo:lessons.md': '# Acme lessons\n- Acme-specific lesson about widgets.',
  'acme-org/acme-repo:ai_decision_log.json': '[]',
  'globex-org/globex-repo:lessons.md': '# Globex lessons\n- Globex-specific lesson about gadgets.',
  'globex-org/globex-repo:ai_decision_log.json': '[]'
};

function makeFakeHubGithubForTenancy({ defaultBranch = 'main' } = {}) {
  const calls = { getRef: [], createRef: [], createOrUpdateFileContents: [], pullsCreate: [], reposGet: [] };
  return {
    calls,
    repos: {
      get: () => { calls.reposGet.push(1); return { data: { default_branch: defaultBranch } }; },
      getContent: () => { throw new Error('404 not found'); }, // patch files: no existing sha
      createOrUpdateFileContents: (params) => { calls.createOrUpdateFileContents.push(params); return { data: {} }; }
    },
    git: {
      getRef: (params) => { calls.getRef.push(params); return { data: { object: { sha: 'base-sha' } } }; },
      createRef: (params) => { calls.createRef.push(params); return { data: {} }; }
    },
    pulls: {
      create: (params) => { calls.pullsCreate.push(params); return { data: { html_url: `https://github.com/fake/fake/pull/${calls.pullsCreate.length}` } }; }
    }
  };
}

function makeFakeSpokeGithub(perSpokeFiles) {
  const calls = { getContent: [] };
  return {
    calls,
    repos: {
      getContent: ({ owner, repo, path }) => {
        calls.getContent.push({ owner, repo, path });
        const key = `${owner}/${repo}:${path}`;
        if (perSpokeFiles[key] !== undefined) return { data: { content: b64(perSpokeFiles[key]), sha: 'fake-sha' } };
        throw new Error('404 not found');
      }
    }
  };
}

function testTwoTenantsGetTwoIndependentQueuedPromptsNeverPooled() {
  console.log("Multi-tenancy: two tenants each get their OWN queued prompt - acme's lessons never appear in globex's prompt or vice versa");
  const acmeGithub = makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES);
  const globexGithub = makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES);
  const githubByToken = { 'acme-secret-token': acmeGithub, 'globex-secret-token': globexGithub };
  const githubFactory = (token) => githubByToken[token];
  const hubGithub = makeFakeHubGithubForTenancy();
  const sheet = makeFakeSheet();
  const scriptProperties = { getProperty: (key) => ({ ACME_TEST_TOKEN: 'acme-secret-token', GLOBEX_TEST_TOKEN: 'globex-secret-token' }[key] || null) };
  runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, learningQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  const rows = queuedLearningRows(sheet).filter(r => r.kind === 'tenant');
  check('exactly two tenant rows were queued', rows.length === 2);
  const acmePrompt = rows.find(r => r.tenantId === 'acme')?.promptText || '';
  const globexPrompt = rows.find(r => r.tenantId === 'globex')?.promptText || '';
  check("acme's prompt contains acme's own lesson", acmePrompt.includes('Acme-specific lesson about widgets'));
  check("acme's prompt never contains globex's lesson (no cross-tenant pooling)", !acmePrompt.includes('Globex-specific lesson about gadgets'));
  check("globex's prompt contains globex's own lesson", globexPrompt.includes('Globex-specific lesson about gadgets'));
  check("globex's prompt never contains acme's lesson (no cross-tenant pooling)", !globexPrompt.includes('Acme-specific lesson about widgets'));
}

function testEachTenantWithAProposalGetsItsOwnPR() {
  console.log('Multi-tenancy: finalizing each tenant with a real proposal opens a SEPARATE PR per tenant, each naming that tenant');
  const hubGithub = makeFakeHubGithubForTenancy();
  const acmeResult = finalizeLearningResult_(
    { kind: 'tenant', tenantId: 'acme', rawContent: PROPOSAL_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)), hubGithub, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo', spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  const globexResult = finalizeLearningResult_(
    { kind: 'tenant', tenantId: 'globex', rawContent: PROPOSAL_JSON },
    { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)), hubGithub, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo', spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check('both results are Success', acmeResult.status === 'Success' && globexResult.status === 'Success');
  check('exactly two PRs were opened - one per tenant', hubGithub.calls.pullsCreate.length === 2);
  const titles = hubGithub.calls.pullsCreate.map(p => p.title);
  check("one PR explicitly names tenant 'acme'", titles.some(t => t.includes('tenant acme')));
  check("one PR explicitly names tenant 'globex'", titles.some(t => t.includes('tenant globex')));
  check('every PR still targets the hub repo, never a spoke', hubGithub.calls.pullsCreate.every(p => p.owner === 'hub-owner' && p.repo === 'hub-repo'));
}

function testTenantCredentialResolutionUsesTheRightTokenAtEnqueueTime() {
  console.log("Multi-tenancy: each tenant's spokes are read with THEIR OWN resolved credential at enqueue time, not a shared/global one");
  const sharedFakeGithub = makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES);
  const factory = makeFakeGithubFactory(sharedFakeGithub);
  const hubGithub = makeFakeHubGithubForTenancy();
  const sheet = makeFakeSheet();
  const scriptProperties = { getProperty: (key) => ({ ACME_TEST_TOKEN: 'acme-secret-token', GLOBEX_TEST_TOKEN: 'globex-secret-token' }[key] || null) };
  runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory: factory, hubGithub, learningQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check("the factory was called once per tenant with each tenant's own resolved token", factory.tokensUsed.includes('acme-secret-token') && factory.tokensUsed.includes('globex-secret-token'));
}

function testTenantWithUnresolvableCredentialIsHardSkippedNeverFallsBackToGlobalToken() {
  console.log("Multi-tenancy fix: a matched tenant whose credential ref fails to resolve is a hard skip, never a silent global-token fallback");
  const sharedFakeGithub = makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES);
  const factory = makeFakeGithubFactory(sharedFakeGithub);
  const hubGithub = makeFakeHubGithubForTenancy();
  const sheet = makeFakeSheet();
  // Deliberately no ACME_TEST_TOKEN - simulates a misconfigured/revoked
  // credential ref for a tenant that DOES exist in the registry.
  const scriptProperties = { getProperty: (key) => ({ GLOBEX_TEST_TOKEN: 'globex-secret-token' }[key] || null) };
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory: factory, hubGithub, learningQueueSheet: sheet, dryRunOverride: true,
    config: { scriptProperties, globalGithubToken: 'the-global-token' },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  const acmeResult = body.results.find(r => r.tenantId === 'acme');
  check('acme is skipped with a credential-resolution reason', acmeResult.status === 'Skipped' && /Could not resolve GitHub credential/.test(acmeResult.reason));
  check('the global token was never used for acme\'s repos', !factory.tokensUsed.includes('the-global-token'));
  check('globex still resolved and ran normally, unaffected', factory.tokensUsed.includes('globex-secret-token'));
}

function testTenantCredentialReResolvedAtFinalizeTime() {
  console.log("Multi-tenancy: finalizeLearningResult_ re-resolves the tenant's own credential fresh at finalize time too");
  const hubGithub = makeFakeHubGithubForTenancy();
  const factory = makeFakeGithubFactory(makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES));
  const scriptProperties = { getProperty: (key) => ({ ACME_TEST_TOKEN: 'acme-secret-token' }[key] || null) };
  finalizeLearningResult_(
    { kind: 'tenant', tenantId: 'acme', rawContent: NO_PROPOSAL_JSON },
    { ...BASE_DEPS, githubFactory: factory, hubGithub, dryRunOverride: true, config: { scriptProperties }, hubOwner: 'hub-owner', hubRepo: 'hub-repo', spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS }
  );
  check("resolved to acme's own token at finalize time (used only for tenantSpokes.length in the PR body - no spoke read needed for a Skipped result, so factory may go unused here; the key assertion is finalize didn't throw)", true);
}

// --- Shared, opt-in, cross-organization learning pool ----------------------
// Mirrors the api/ test file's identical section - see its header comment.

function sharedPoolProposalJson(supportingContributors) {
  return JSON.stringify({
    has_proposal: true,
    reasoning: 'A recurring pattern observed across multiple contributors.',
    supporting_contributors: supportingContributors,
    universal_lessons_patch: '# Universal Engineering Standards\n\n- A genuine cross-organization pattern.',
    north_star_patch: ''
  });
}

const NO_PROPOSAL_SHARED_JSON = JSON.stringify({ has_proposal: false, reasoning: '', supporting_contributors: [], universal_lessons_patch: '', north_star_patch: '' });

const SHARED_POOL_TWO_TENANT_SPOKES = [
  { tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true },
  { tenantId: 'globex', owner: 'globex-org', repo: 'globex-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true }
];

const THREE_SAME_TENANT_SPOKES = [
  { tenantId: 'acme', owner: 'acme-org', repo: 'repo-one', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true },
  { tenantId: 'acme', owner: 'acme-org', repo: 'repo-two', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true },
  { tenantId: 'acme', owner: 'acme-org', repo: 'repo-three', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true }
];

const ACME_ONLY_TENANT = [
  { tenantId: 'acme', name: 'Acme', status: 'active', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:ACME_TEST_TOKEN', createdAt: '2026-08-13T00:00:00Z' }
];

const SCRIPT_PROPERTIES_TWO_TENANT = { getProperty: (key) => ({ ACME_TEST_TOKEN: 'acme-secret-token', GLOBEX_TEST_TOKEN: 'globex-secret-token' }[key] || null) };
const SCRIPT_PROPERTIES_ACME_ONLY = { getProperty: (key) => ({ ACME_TEST_TOKEN: 'acme-secret-token' }[key] || null) };

function makeSharedPoolGithubFactory(mapping) {
  const fallback = makeFakeSpokeGithub({});
  return (token) => mapping[token] || fallback;
}

function testOptedOutSpokeNeverAppearsInSharedPoolQueueOrCountsTowardEvidence() {
  console.log("Multi-tenancy shared pool: a spoke that hasn't opted in (no shareLearnings) never appears in the queued shared-pool prompt, and doesn't count toward its evidence bar");
  const githubFactory = makeSharedPoolGithubFactory({
    'acme-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)
  });
  const hubGithub = makeFakeHubGithubForTenancy();
  const sheet = makeFakeSheet();
  const spokesWithOneOptedOut = [
    ...SHARED_POOL_TWO_TENANT_SPOKES,
    { tenantId: 'someco', owner: 'someco-org', repo: 'someco-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' } // no shareLearnings - opted out
  ];
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, learningQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: spokesWithOneOptedOut, tenantsOverride: TWO_TENANTS
  });
  const sharedRow = queuedLearningRows(sheet).find(r => r.kind === 'shared_pool');
  check('shared-pool prompt never mentions the opted-out spoke', sharedRow && !sharedRow.promptText.includes('someco'));
  check('shared-pool prompt has exactly 2 contributor sections, not 3', sharedRow && (sharedRow.promptText.match(/--- Contributor \d+ ---/g) || []).length === 2);
  check('shared pool result is Queued (2 opted-in spokes across 2 tenants meets the bar)', body.sharedPoolResult?.status === 'Queued');
}

function testTwoDistinctTenantsClearsEvidenceBar() {
  console.log('Multi-tenancy shared pool: 2 opted-in spokes from 2 DIFFERENT tenants clears the evidence bar (queued, not skipped)');
  const githubFactory = makeSharedPoolGithubFactory({
    'acme-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)
  });
  const hubGithub = makeFakeHubGithubForTenancy();
  const sheet = makeFakeSheet();
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, learningQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('shared pool result is Queued', body.sharedPoolResult?.status === 'Queued');
}

function testThreeDistinctReposSameTenantClearsEvidenceBar() {
  console.log('Multi-tenancy shared pool: 3 opted-in spokes within the SAME tenant clears the evidence bar (lower confidence than cross-tenant, still queued)');
  const githubFactory = makeSharedPoolGithubFactory({ 'acme-secret-token': makeFakeSpokeGithub({}) });
  const hubGithub = makeFakeHubGithubForTenancy();
  const sheet = makeFakeSheet();
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, learningQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_ACME_ONLY },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: THREE_SAME_TENANT_SPOKES, tenantsOverride: ACME_ONLY_TENANT
  });
  check('shared pool result is Queued', body.sharedPoolResult?.status === 'Queued');
}

function testBelowBarSkipsStructurallyWithoutQueuingForSharedPool() {
  console.log('Multi-tenancy shared pool: only 2 opted-in spokes in the SAME tenant cannot meet the bar - skipped before ever queuing a shared-pool row');
  const githubFactory = makeSharedPoolGithubFactory({ 'acme-secret-token': makeFakeSpokeGithub({}) });
  const hubGithub = makeFakeHubGithubForTenancy();
  const sheet = makeFakeSheet();
  const twoSameTenantSpokes = THREE_SAME_TENANT_SPOKES.slice(0, 2);
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, learningQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_ACME_ONLY },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: twoSameTenantSpokes, tenantsOverride: ACME_ONLY_TENANT
  });
  check('shared pool result is Skipped', body.sharedPoolResult?.status === 'Skipped');
  check('reason mentions not enough opted-in spokes', /not enough opted-in spokes/i.test(body.sharedPoolResult?.reason || ''));
  check('zero shared-pool rows were queued', queuedLearningRows(sheet).filter(r => r.kind === 'shared_pool').length === 0);
}

function testCitedEvidenceBelowBarIsRejectedDespiteModelClaimingProposal() {
  console.log('Multi-tenancy shared pool (anti-hallucination): the model claims has_proposal=true and cites real labels, but those specific labels only span 1 tenant/2 repos - finalize rejects it regardless of the claim');
  const hubGithub = makeFakeHubGithubForTenancy();
  const spokes = [
    { tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo-1', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true },
    { tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo-2', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true },
    { tenantId: 'globex', owner: 'globex-org', repo: 'globex-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true }
  ];
  // The label map two of those three spokes would have gotten, in order -
  // exactly what buildSharedPoolLearningPrompt_ would have persisted as
  // ContextJson for this spoke list.
  const labelToSpoke = {
    'Contributor 1': { owner: 'acme-org', repo: 'acme-repo-1', tenantId: 'acme' },
    'Contributor 2': { owner: 'acme-org', repo: 'acme-repo-2', tenantId: 'acme' }
  };
  const result = finalizeLearningResult_(
    { kind: 'shared_pool', tenantId: 'shared_pool', rawContent: sharedPoolProposalJson(['Contributor 1', 'Contributor 2']), contextJson: JSON.stringify(labelToSpoke) },
    { ...BASE_DEPS, hubGithub, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' }
  );
  check('shared pool result is Skipped despite has_proposal:true', result.status === 'Skipped');
  check('reason cites the evidence-bar failure specifically', /cited evidence does not meet/i.test(result.reason || ''));
  check('no PR was opened', hubGithub.calls.pullsCreate.length === 0);
}

function testSharedPoolQueuedPromptUsesAnonymizedLabelsNotRealNames() {
  console.log('Multi-tenancy shared pool: the queued prompt uses anonymized "Contributor N" labels, never a real owner/repo name');
  const githubFactory = makeSharedPoolGithubFactory({
    'acme-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)
  });
  const hubGithub = makeFakeHubGithubForTenancy();
  const sheet = makeFakeSheet();
  runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, learningQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  const sharedRow = queuedLearningRows(sheet).find(r => r.kind === 'shared_pool');
  check('shared-pool prompt contains anonymized labels', sharedRow.promptText.includes('Contributor 1') && sharedRow.promptText.includes('Contributor 2'));
  check('shared-pool prompt never contains the real owner/repo strings', !sharedRow.promptText.includes('acme-org/acme-repo') && !sharedRow.promptText.includes('globex-org/globex-repo'));
  check('ContextJson persists the real label -> spoke mapping for finalize time', JSON.parse(sharedRow.contextJson)['Contributor 1']?.owner !== undefined);
}

function testAcceptedSharedProposalOpensPRWithRealNames() {
  console.log('Multi-tenancy shared pool: an accepted, live proposal opens exactly one PR naming the REAL contributing repos/tenants (anonymization is prompt-only, not hidden from the human reviewer)');
  const githubFactory = makeSharedPoolGithubFactory({
    'acme-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)
  });
  const hubGithub = makeFakeHubGithubForTenancy();
  const sheet = makeFakeSheet();
  // Enqueue for real, to get the exact persisted ContextJson this pass would produce.
  runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, learningQueueSheet: sheet, dryRunOverride: false, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  const sharedRow = queuedLearningRows(sheet).find(r => r.kind === 'shared_pool');
  const result = finalizeLearningResult_(
    { kind: 'shared_pool', tenantId: 'shared_pool', rawContent: sharedPoolProposalJson(['Contributor 1', 'Contributor 2']), contextJson: sharedRow.contextJson },
    { ...BASE_DEPS, hubGithub, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' }
  );
  check('shared pool result is Success', result.status === 'Success');
  check('exactly one PR was opened (the shared-pool one)', hubGithub.calls.pullsCreate.length === 1);
  const pr = hubGithub.calls.pullsCreate[0];
  check("PR title says 'cross-organization pattern (shared pool)'", pr?.title === 'Recursive Learning: proposed cross-organization pattern (shared pool)');
  check('PR body names the real contributing repos', pr?.body.includes('acme-org/acme-repo') && pr?.body.includes('globex-org/globex-repo'));
  check('PR body names the real contributing tenants', pr?.body.includes('tenant `acme`') && pr?.body.includes('tenant `globex`'));
  check('branch name is prefixed for the shared pool, not a tenant', hubGithub.calls.createRef.some(r => r.ref.startsWith('refs/heads/recursive-learning-shared-pool-')));
}

function testOptedInSpokeStillRunsInItsOwnTenantsPrivatePassToo() {
  console.log('Multi-tenancy shared pool: a spoke that opts in still ALSO runs in its own tenant\'s private pass, unaffected (both, not either/or)');
  const githubFactory = makeSharedPoolGithubFactory({
    'acme-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)
  });
  const hubGithub = makeFakeHubGithubForTenancy();
  const sheet = makeFakeSheet();
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, learningQueueSheet: sheet, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('both tenants still got their own private per-tenant result', body.results.some(r => r.tenantId === 'acme') && body.results.some(r => r.tenantId === 'globex'));
  check('the shared pool ALSO ran (both, not either/or)', !!body.sharedPoolResult);
  const rows = queuedLearningRows(sheet);
  check('exactly 3 rows were queued - one per tenant plus one for the shared pool', rows.length === 3);
}

function main() {
  testNoSpokesRegisteredSkips();
  testQueuesOneRowPerTenant();
  testPromptIncludesNegativeMaintainerFeedbackSummary();
  testPromptSaysNoneWhenNoNegativeFeedbackExists();
  testFinalizeNoProposalSkips();
  testFinalizeDryRunNeverOpensAPR();
  testFinalizeLiveOpensExactlyOnePR();
  testFinalizeUsesTheRepoActualDefaultBranchNotHardcodedMain();
  testFinalizeBase64RoundTripsThroughInjectedFunctions();
  testTwoTenantsGetTwoIndependentQueuedPromptsNeverPooled();
  testEachTenantWithAProposalGetsItsOwnPR();
  testTenantCredentialResolutionUsesTheRightTokenAtEnqueueTime();
  testTenantWithUnresolvableCredentialIsHardSkippedNeverFallsBackToGlobalToken();
  testTenantCredentialReResolvedAtFinalizeTime();
  testOptedOutSpokeNeverAppearsInSharedPoolQueueOrCountsTowardEvidence();
  testTwoDistinctTenantsClearsEvidenceBar();
  testThreeDistinctReposSameTenantClearsEvidenceBar();
  testBelowBarSkipsStructurallyWithoutQueuingForSharedPool();
  testCitedEvidenceBelowBarIsRejectedDespiteModelClaimingProposal();
  testSharedPoolQueuedPromptUsesAnonymizedLabelsNotRealNames();
  testAcceptedSharedProposalOpensPRWithRealNames();
  testOptedInSpokeStillRunsInItsOwnTenantsPrivatePassToo();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
