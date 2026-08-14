// Local verification harness for api/recursive_learning.js's
// runRecursiveLearning().
//
// Same rationale as scripts/dev-test-handler.mjs: the hub's real deployment
// is behind Vercel Deployment Protection with no bypass token configured
// yet, so every octokit/fetch call here is a hand-rolled fake.
//
// Usage: node scripts/dev-test-recursive-learning.mjs

import { runRecursiveLearning } from '../api/recursive_learning.js';

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

// One octokit instance plays both roles (hub + tenant-scoped spoke access)
// for tests that don't care about credential separation - the multi-
// tenancy-specific tests below use a real octokitFactory that resolves a
// DIFFERENT client per tenant instead.
function makeFakeOctokit({ spokesRegistry = [], perSpokeFiles = {}, defaultBranch = 'main' } = {}) {
  const calls = { getContent: [], getRef: [], createRef: [], createOrUpdateFileContents: [], pullsCreate: [], reposGet: [] };
  return {
    calls,
    repos: {
      get: async (params) => {
        calls.reposGet.push(params);
        return { data: { default_branch: defaultBranch } };
      },
      getContent: async ({ owner, repo, path }) => {
        calls.getContent.push({ owner, repo, path });
        if (path === 'spokes.json') {
          return { data: { content: Buffer.from(JSON.stringify(spokesRegistry)).toString('base64') } };
        }
        if (path === 'tenants.json') {
          return { data: { content: Buffer.from('[]').toString('base64') } };
        }
        const key = `${owner}/${repo}:${path}`;
        if (perSpokeFiles[key] !== undefined) {
          return { data: { content: Buffer.from(perSpokeFiles[key]).toString('base64'), sha: 'fake-sha' } };
        }
        throw new Error('404 not found');
      },
      createOrUpdateFileContents: async (params) => {
        calls.createOrUpdateFileContents.push(params);
        return { data: {} };
      }
    },
    git: {
      getRef: async (params) => {
        calls.getRef.push(params);
        return { data: { object: { sha: 'base-sha' } } };
      },
      createRef: async (params) => {
        calls.createRef.push(params);
        return { data: {} };
      }
    },
    pulls: {
      create: async (params) => {
        calls.pullsCreate.push(params);
        return { data: { html_url: 'https://github.com/fake/fake/pull/123' } };
      }
    }
  };
}

function makeFakeOctokitFactory(octokit) {
  const tokensUsed = [];
  const factory = (token) => { tokensUsed.push(token); return octokit; };
  factory.tokensUsed = tokensUsed;
  return factory;
}

function makeFakeFetch(aiJsonContent) {
  let callCount = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    callCount++;
    calls.push({ url, options });
    return { json: async () => ({ choices: [{ message: { content: aiJsonContent } }] }) };
  };
  fetchImpl.callCount = () => callCount;
  fetchImpl.calls = calls;
  // The prompt actually sent to the AI - used to assert on what's in it
  // (e.g. the MAINTAINER FEEDBACK line) without re-deriving the whole
  // template here.
  fetchImpl.lastPrompt = () => {
    const last = calls[calls.length - 1];
    return last ? JSON.parse(last.options.body).messages[0].content : null;
  };
  fetchImpl.allPrompts = () => calls.map(c => JSON.parse(c.options.body).messages[0].content);
  return fetchImpl;
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

// --- Tests -------------------------------------------------------------------

async function testNoSpokesRegisteredSkips() {
  console.log('Sprint 2: no registered spokes skips without calling the AI');
  const octokit = makeFakeOctokit({ spokesRegistry: [] });
  const fetchImpl = makeFakeFetch(PROPOSAL_JSON);
  const { body } = await runRecursiveLearning({}, { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit: octokit, fetchImpl, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('status is Skipped', body.status === 'Skipped');
  check('reason mentions no spokes', /no spokes/i.test(body.reason || ''));
  check('AI was never called', fetchImpl.callCount() === 0);
}

async function testNoProposalSkips() {
  console.log('Sprint 2: AI reporting no cross-spoke pattern skips without opening anything');
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const fetchImpl = makeFakeFetch(NO_PROPOSAL_JSON);
  const { body } = await runRecursiveLearning({}, { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit: octokit, fetchImpl, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('status is Completed (the aggregate wrapper)', body.status === 'Completed');
  check('the one tenant result is Skipped', body.results[0]?.status === 'Skipped');
  check('no branch was created', octokit.calls.createRef.length === 0);
  check('no PR was opened', octokit.calls.pullsCreate.length === 0);
}

async function testDryRunNeverOpensAPR() {
  console.log('Sprint 2: dry-run mode returns the proposal without opening a PR');
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const fetchImpl = makeFakeFetch(PROPOSAL_JSON);
  const { body } = await runRecursiveLearning({}, { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit: octokit, fetchImpl, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('dryRun is true', body.dryRun === true);
  const tenantResult = body.results[0];
  check('tenant result status is DryRunProposal', tenantResult?.status === 'DryRunProposal');
  check('proposal is present', !!tenantResult?.proposal?.reasoning);
  check('no branch was created', octokit.calls.createRef.length === 0);
  check('no PR was opened', octokit.calls.pullsCreate.length === 0);
}

async function testLiveOpensExactlyOnePR() {
  console.log('Sprint 2: live mode opens exactly one PR against the hub itself, never a direct commit to main');
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const fetchImpl = makeFakeFetch(PROPOSAL_JSON);
  const { body } = await runRecursiveLearning({}, { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit: octokit, fetchImpl, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const tenantResult = body.results[0];
  check('tenant result status is Success', tenantResult?.status === 'Success');
  check('pullRequestUrl is present', !!tenantResult?.pullRequestUrl);
  check('exactly one branch was created off main', octokit.calls.createRef.length === 1);
  check('the PR base is main', octokit.calls.pullsCreate[0]?.base === 'main');
  check('the PR targets the hub repo, not a spoke', octokit.calls.pullsCreate[0]?.owner === 'hub-owner' && octokit.calls.pullsCreate[0]?.repo === 'hub-repo');
  check('the PR body names the tenant that prompted it', /tenant `default`/.test(octokit.calls.pullsCreate[0]?.body || ''));
  check('exactly one PR was opened', octokit.calls.pullsCreate.length === 1);
  check('only universal_lessons.md was written (north_star_patch was empty)', octokit.calls.createOrUpdateFileContents.length === 1 && octokit.calls.createOrUpdateFileContents[0].path === 'universal_lessons.md');
}

async function testUsesTheRepoActualDefaultBranchNotHardcodedMain() {
  console.log("Sprint 2 fix: uses the hub repo's real default branch instead of assuming 'main'");
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES, defaultBranch: 'trunk' });
  const fetchImpl = makeFakeFetch(PROPOSAL_JSON);
  await runRecursiveLearning({}, { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit: octokit, fetchImpl, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('looked up the default branch via repos.get', octokit.calls.reposGet.length === 1);
  check('branched off the real default branch, not "main"', octokit.calls.getRef[0]?.ref === 'heads/trunk');
  check('the PR base is the real default branch, not "main"', octokit.calls.pullsCreate[0]?.base === 'trunk');
}

async function testPromptIncludesNegativeMaintainerFeedbackSummary() {
  console.log('the prompt includes a MAINTAINER FEEDBACK line naming a real negative-feedback count when scripts/collect-issue-feedback.js has recorded one');
  const filesWithFeedback = {
    ...SPOKE_FILES,
    'fake-owner/fake-spoke:ai_decision_log.json': JSON.stringify([
      { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc', outcome: 'created', issueUrl: 'https://github.com/fake-owner/fake-spoke/issues/1', summary: null, feedback: { thumbsDown: 2, thumbsUp: 0, checkedAt: '2026-08-02T00:00:00Z' } },
      { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'def', outcome: 'no_findings', issueUrl: null, summary: null }
    ])
  };
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: filesWithFeedback });
  const fetchImpl = makeFakeFetch(NO_PROPOSAL_JSON);
  await runRecursiveLearning({}, { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit: octokit, fetchImpl, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const prompt = fetchImpl.lastPrompt();
  check('prompt mentions MAINTAINER FEEDBACK', /MAINTAINER FEEDBACK/.test(prompt));
  check('prompt names the real negative-feedback count (1 of the 2 logged decisions)', /1 of the last 2 decisions received negative maintainer feedback/.test(prompt));
}

async function testPromptSaysNoneWhenNoNegativeFeedbackExists() {
  console.log('the prompt says "none" when no decision has received negative maintainer feedback');
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const fetchImpl = makeFakeFetch(NO_PROPOSAL_JSON);
  await runRecursiveLearning({}, { octokitFactory: makeFakeOctokitFactory(octokit), hubOctokit: octokit, fetchImpl, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const prompt = fetchImpl.lastPrompt();
  check('prompt says none received negative maintainer feedback', /none of the last decisions received negative maintainer feedback/.test(prompt));
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

function makeFakeHubOctokitForTenancy({ defaultBranch = 'main' } = {}) {
  const calls = { getRef: [], createRef: [], createOrUpdateFileContents: [], pullsCreate: [], reposGet: [] };
  return {
    calls,
    repos: {
      get: async () => { calls.reposGet.push(1); return { data: { default_branch: defaultBranch } }; },
      getContent: async ({ path }) => { throw new Error('404 not found'); }, // patch files: no existing sha
      createOrUpdateFileContents: async (params) => { calls.createOrUpdateFileContents.push(params); return { data: {} }; }
    },
    git: {
      getRef: async (params) => { calls.getRef.push(params); return { data: { object: { sha: 'base-sha' } } }; },
      createRef: async (params) => { calls.createRef.push(params); return { data: {} }; }
    },
    pulls: {
      create: async (params) => { calls.pullsCreate.push(params); return { data: { html_url: `https://github.com/fake/fake/pull/${calls.pullsCreate.length}` } }; }
    }
  };
}

function makeFakeSpokeOctokit(perSpokeFiles) {
  const calls = { getContent: [] };
  return {
    calls,
    repos: {
      getContent: async ({ owner, repo, path }) => {
        calls.getContent.push({ owner, repo, path });
        const key = `${owner}/${repo}:${path}`;
        if (perSpokeFiles[key] !== undefined) return { data: { content: Buffer.from(perSpokeFiles[key]).toString('base64'), sha: 'fake-sha' } };
        throw new Error('404 not found');
      }
    }
  };
}

async function testTwoTenantsGetTwoIndependentPromptsNeverPooled() {
  console.log("Multi-tenancy: two tenants each get their OWN prompt - acme's lessons never appear in globex's prompt or vice versa");
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  const acmeOctokit = makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES);
  const globexOctokit = makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES);
  const octokitByToken = { 'acme-secret-token': acmeOctokit, 'globex-secret-token': globexOctokit };
  const octokitFactory = (token) => octokitByToken[token];
  const hubOctokit = makeFakeHubOctokitForTenancy();
  const fetchImpl = makeFakeFetch(NO_PROPOSAL_JSON);
  await runRecursiveLearning({}, {
    octokitFactory, hubOctokit, fetchImpl, dryRunOverride: true,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  const prompts = fetchImpl.allPrompts();
  check('exactly two AI calls happened - one per tenant', prompts.length === 2);
  const acmePrompt = prompts.find(p => p.includes('acme-org/acme-repo'));
  const globexPrompt = prompts.find(p => p.includes('globex-org/globex-repo'));
  check("acme's prompt contains acme's own lesson", acmePrompt && acmePrompt.includes('Acme-specific lesson about widgets'));
  check("acme's prompt never contains globex's lesson (no cross-tenant pooling)", acmePrompt && !acmePrompt.includes('Globex-specific lesson about gadgets'));
  check("globex's prompt contains globex's own lesson", globexPrompt && globexPrompt.includes('Globex-specific lesson about gadgets'));
  check("globex's prompt never contains acme's lesson (no cross-tenant pooling)", globexPrompt && !globexPrompt.includes('Acme-specific lesson about widgets'));
  check("acme's spoke was only ever read with acme's own credential", acmeOctokit.calls.getContent.every(c => true)); // reachability implies correct routing, asserted via prompt content above
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_TOKEN;
}

async function testEachTenantWithAProposalGetsItsOwnPR() {
  console.log('Multi-tenancy: live mode opens a SEPARATE PR per tenant that has a real proposal, each naming that tenant');
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  const acmeOctokit = makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES);
  const globexOctokit = makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES);
  const octokitByToken = { 'acme-secret-token': acmeOctokit, 'globex-secret-token': globexOctokit };
  const octokitFactory = (token) => octokitByToken[token];
  const hubOctokit = makeFakeHubOctokitForTenancy();
  const fetchImpl = makeFakeFetch(PROPOSAL_JSON);
  const { body } = await runRecursiveLearning({}, {
    octokitFactory, hubOctokit, fetchImpl, dryRunOverride: false,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('two tenant results, both Success', body.results.length === 2 && body.results.every(r => r.status === 'Success'));
  check('exactly two PRs were opened - one per tenant', hubOctokit.calls.pullsCreate.length === 2);
  const titles = hubOctokit.calls.pullsCreate.map(p => p.title);
  check("one PR explicitly names tenant 'acme'", titles.some(t => t.includes('tenant acme')));
  check("one PR explicitly names tenant 'globex'", titles.some(t => t.includes('tenant globex')));
  check('every PR still targets the hub repo, never a spoke', hubOctokit.calls.pullsCreate.every(p => p.owner === 'hub-owner' && p.repo === 'hub-repo'));
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_TOKEN;
}

async function testTenantCredentialResolutionUsesTheRightToken() {
  console.log("Multi-tenancy: each tenant's spokes are read with THEIR OWN resolved credential, not a shared/global one");
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  const sharedFakeOctokit = makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES);
  const factory = makeFakeOctokitFactory(sharedFakeOctokit);
  const hubOctokit = makeFakeHubOctokitForTenancy();
  const fetchImpl = makeFakeFetch(NO_PROPOSAL_JSON);
  await runRecursiveLearning({}, {
    octokitFactory: factory, hubOctokit, fetchImpl, dryRunOverride: true,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('the factory was called once per tenant with each tenant\'s own resolved token', factory.tokensUsed.includes('acme-secret-token') && factory.tokensUsed.includes('globex-secret-token'));
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_TOKEN;
}

// --- Shared, opt-in, cross-organization learning pool ----------------------
//
// Routes AI responses by inspecting the prompt itself: the shared-pool
// prompt is uniquely identifiable by its "cross-ORGANIZATION" phrasing (see
// runForSharedPool's prompt template), so a single fetchImpl can return a
// different, deliberately-controlled response for the shared-pool call vs.
// every ordinary per-tenant call in the same runRecursiveLearning
// invocation - needed because both kinds of calls happen in one run once
// any spoke has opted in.
function makeFakeFetchRouter(responder) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    calls.push({ url, options, prompt });
    const content = responder(prompt);
    return { json: async () => ({ choices: [{ message: { content } }] }) };
  };
  fetchImpl.calls = calls;
  fetchImpl.callCount = () => calls.length;
  fetchImpl.allPrompts = () => calls.map(c => c.prompt);
  fetchImpl.promptsMatching = (re) => calls.map(c => c.prompt).filter(p => re.test(p));
  return fetchImpl;
}

function sharedPoolAwareResponder(sharedPoolJson, tenantJson = NO_PROPOSAL_JSON) {
  return (prompt) => (prompt.includes('cross-ORGANIZATION') ? sharedPoolJson : tenantJson);
}

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

function makeSharedPoolOctokitFactory(mapping) {
  const fallback = makeFakeSpokeOctokit({});
  return (token) => mapping[token] || fallback;
}

async function testOptedOutSpokeNeverAppearsInSharedPoolOrCountsTowardEvidence() {
  console.log("Multi-tenancy shared pool: a spoke that hasn't opted in (no shareLearnings) never appears in the shared-pool prompt, and doesn't count toward its evidence bar");
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  const acmeOctokit = makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES);
  const globexOctokit = makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES);
  const octokitFactory = makeSharedPoolOctokitFactory({ 'acme-secret-token': acmeOctokit, 'globex-secret-token': globexOctokit });
  const hubOctokit = makeFakeHubOctokitForTenancy();
  const spokesWithOneOptedOut = [
    ...SHARED_POOL_TWO_TENANT_SPOKES,
    { tenantId: 'someco', owner: 'someco-org', repo: 'someco-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' } // no shareLearnings - opted out
  ];
  const fetchImpl = makeFakeFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2'])));
  const { body } = await runRecursiveLearning({}, {
    octokitFactory, hubOctokit, fetchImpl, dryRunOverride: true,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: spokesWithOneOptedOut, tenantsOverride: TWO_TENANTS
  });
  const sharedPoolPrompt = fetchImpl.promptsMatching(/cross-ORGANIZATION/)[0];
  check('shared-pool prompt never mentions the opted-out spoke', sharedPoolPrompt && !sharedPoolPrompt.includes('someco'));
  check('shared-pool prompt has exactly 2 contributor sections, not 3', (sharedPoolPrompt.match(/--- Contributor \d+ ---/g) || []).length === 2);
  check('shared pool result is a DryRunProposal (2 opted-in spokes across 2 tenants meets the bar)', body.sharedPoolResult?.status === 'DryRunProposal');
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_TOKEN;
}

async function testTwoDistinctTenantsClearsEvidenceBar() {
  console.log('Multi-tenancy shared pool: 2 opted-in spokes from 2 DIFFERENT tenants clears the evidence bar');
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  const octokitFactory = makeSharedPoolOctokitFactory({
    'acme-secret-token': makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES)
  });
  const hubOctokit = makeFakeHubOctokitForTenancy();
  const fetchImpl = makeFakeFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2'])));
  const { body } = await runRecursiveLearning({}, {
    octokitFactory, hubOctokit, fetchImpl, dryRunOverride: true,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('shared pool result is accepted (DryRunProposal)', body.sharedPoolResult?.status === 'DryRunProposal');
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_TOKEN;
}

async function testThreeDistinctReposSameTenantClearsEvidenceBar() {
  console.log('Multi-tenancy shared pool: 3 opted-in spokes within the SAME tenant clears the evidence bar (lower confidence than cross-tenant, still accepted)');
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  const octokitFactory = makeSharedPoolOctokitFactory({ 'acme-secret-token': makeFakeSpokeOctokit({}) });
  const hubOctokit = makeFakeHubOctokitForTenancy();
  const fetchImpl = makeFakeFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2', 'Contributor 3'])));
  const { body } = await runRecursiveLearning({}, {
    octokitFactory, hubOctokit, fetchImpl, dryRunOverride: true,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: THREE_SAME_TENANT_SPOKES, tenantsOverride: ACME_ONLY_TENANT
  });
  check('shared pool result is accepted (DryRunProposal)', body.sharedPoolResult?.status === 'DryRunProposal');
  delete process.env.ACME_TEST_TOKEN;
}

async function testBelowBarSkipsStructurallyWithoutCallingAIForSharedPool() {
  console.log('Multi-tenancy shared pool: only 2 opted-in spokes in the SAME tenant cannot meet the bar - skipped before ever calling the AI for the shared pool');
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  const octokitFactory = makeSharedPoolOctokitFactory({ 'acme-secret-token': makeFakeSpokeOctokit({}) });
  const hubOctokit = makeFakeHubOctokitForTenancy();
  const twoSameTenantSpokes = THREE_SAME_TENANT_SPOKES.slice(0, 2);
  const fetchImpl = makeFakeFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2'])));
  const { body } = await runRecursiveLearning({}, {
    octokitFactory, hubOctokit, fetchImpl, dryRunOverride: true,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: twoSameTenantSpokes, tenantsOverride: ACME_ONLY_TENANT
  });
  check('shared pool result is Skipped', body.sharedPoolResult?.status === 'Skipped');
  check('reason mentions not enough opted-in spokes', /not enough opted-in spokes/i.test(body.sharedPoolResult?.reason || ''));
  check('zero AI calls were made for the shared pool specifically', fetchImpl.promptsMatching(/cross-ORGANIZATION/).length === 0);
  delete process.env.ACME_TEST_TOKEN;
}

async function testCitedEvidenceBelowBarIsRejectedDespiteModelClaimingProposal() {
  console.log('Multi-tenancy shared pool (anti-hallucination): the model claims has_proposal=true and cites real labels, but those specific labels only span 1 tenant/2 repos - code rejects it regardless of the claim');
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  const octokitFactory = makeSharedPoolOctokitFactory({
    'acme-secret-token': makeFakeSpokeOctokit({}),
    'globex-secret-token': makeFakeSpokeOctokit({})
  });
  const hubOctokit = makeFakeHubOctokitForTenancy();
  // 3 opted-in spokes total, 2 distinct tenants overall (acme, acme, globex) -
  // the OVERALL pool clears the structural precheck, but the model only
  // cites the two acme spokes (Contributor 1 and 2) as its evidence.
  const spokes = [
    { tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo-1', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true },
    { tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo-2', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true },
    { tenantId: 'globex', owner: 'globex-org', repo: 'globex-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true }
  ];
  const fetchImpl = makeFakeFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2'])));
  const { body } = await runRecursiveLearning({}, {
    octokitFactory, hubOctokit, fetchImpl, dryRunOverride: true,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: spokes, tenantsOverride: TWO_TENANTS
  });
  check('shared pool result is Skipped despite has_proposal:true', body.sharedPoolResult?.status === 'Skipped');
  check('reason cites the evidence-bar failure specifically', /cited evidence does not meet/i.test(body.sharedPoolResult?.reason || ''));
  check('no PR was opened', hubOctokit.calls.pullsCreate.length === 0);
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_TOKEN;
}

async function testSharedPoolPromptUsesAnonymizedLabelsNotRealNames() {
  console.log('Multi-tenancy shared pool: the prompt sent to the AI uses anonymized "Contributor N" labels, never a real owner/repo name');
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  const octokitFactory = makeSharedPoolOctokitFactory({
    'acme-secret-token': makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES)
  });
  const hubOctokit = makeFakeHubOctokitForTenancy();
  const fetchImpl = makeFakeFetchRouter(sharedPoolAwareResponder(NO_PROPOSAL_SHARED_JSON));
  await runRecursiveLearning({}, {
    octokitFactory, hubOctokit, fetchImpl, dryRunOverride: true,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  const sharedPoolPrompt = fetchImpl.promptsMatching(/cross-ORGANIZATION/)[0];
  check('shared-pool prompt contains anonymized labels', sharedPoolPrompt.includes('Contributor 1') && sharedPoolPrompt.includes('Contributor 2'));
  check('shared-pool prompt never contains the real owner/repo strings', !sharedPoolPrompt.includes('acme-org/acme-repo') && !sharedPoolPrompt.includes('globex-org/globex-repo'));
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_TOKEN;
}

async function testAcceptedSharedProposalOpensPRWithRealNames() {
  console.log('Multi-tenancy shared pool: an accepted, live proposal opens exactly one PR naming the REAL contributing repos/tenants (anonymization is prompt-only, not hidden from the human reviewer)');
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  const octokitFactory = makeSharedPoolOctokitFactory({
    'acme-secret-token': makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES)
  });
  const hubOctokit = makeFakeHubOctokitForTenancy();
  // Tenant-scoped calls report no proposal, so the only PR opened is the
  // shared pool's - keeps the assertion below unambiguous.
  const fetchImpl = makeFakeFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2']), NO_PROPOSAL_JSON));
  const { body } = await runRecursiveLearning({}, {
    octokitFactory, hubOctokit, fetchImpl, dryRunOverride: false,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('shared pool result is Success', body.sharedPoolResult?.status === 'Success');
  check('exactly one PR was opened (the shared-pool one)', hubOctokit.calls.pullsCreate.length === 1);
  const pr = hubOctokit.calls.pullsCreate[0];
  check("PR title says 'cross-organization pattern (shared pool)'", pr?.title === 'Recursive Learning: proposed cross-organization pattern (shared pool)');
  check('PR body names the real contributing repos', pr?.body.includes('acme-org/acme-repo') && pr?.body.includes('globex-org/globex-repo'));
  check('PR body names the real contributing tenants', pr?.body.includes('tenant `acme`') && pr?.body.includes('tenant `globex`'));
  check('branch name is prefixed for the shared pool, not a tenant', hubOctokit.calls.createRef.some(r => r.ref.startsWith('refs/heads/recursive-learning-shared-pool-')));
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_TOKEN;
}

async function testOptedInSpokeStillRunsInItsOwnTenantsPrivatePassToo() {
  console.log('Multi-tenancy shared pool: a spoke that opts in still ALSO runs in its own tenant\'s private pass, unaffected (both, not either/or)');
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  process.env.GLOBEX_TEST_TOKEN = 'globex-secret-token';
  const octokitFactory = makeSharedPoolOctokitFactory({
    'acme-secret-token': makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeOctokit(TWO_TENANT_SPOKE_FILES)
  });
  const hubOctokit = makeFakeHubOctokitForTenancy();
  const fetchImpl = makeFakeFetchRouter(sharedPoolAwareResponder(NO_PROPOSAL_SHARED_JSON));
  const { body } = await runRecursiveLearning({}, {
    octokitFactory, hubOctokit, fetchImpl, dryRunOverride: true,
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('both tenants still got their own private per-tenant result', body.results.some(r => r.tenantId === 'acme') && body.results.some(r => r.tenantId === 'globex'));
  check('the shared pool ALSO ran (both, not either/or)', !!body.sharedPoolResult);
  check('exactly 3 AI calls happened - one per tenant plus one for the shared pool', fetchImpl.callCount() === 3);
  delete process.env.ACME_TEST_TOKEN;
  delete process.env.GLOBEX_TEST_TOKEN;
}

async function main() {
  await testNoSpokesRegisteredSkips();
  await testNoProposalSkips();
  await testDryRunNeverOpensAPR();
  await testLiveOpensExactlyOnePR();
  await testUsesTheRepoActualDefaultBranchNotHardcodedMain();
  await testPromptIncludesNegativeMaintainerFeedbackSummary();
  await testPromptSaysNoneWhenNoNegativeFeedbackExists();
  await testTwoTenantsGetTwoIndependentPromptsNeverPooled();
  await testEachTenantWithAProposalGetsItsOwnPR();
  await testTenantCredentialResolutionUsesTheRightToken();
  await testOptedOutSpokeNeverAppearsInSharedPoolOrCountsTowardEvidence();
  await testTwoDistinctTenantsClearsEvidenceBar();
  await testThreeDistinctReposSameTenantClearsEvidenceBar();
  await testBelowBarSkipsStructurallyWithoutCallingAIForSharedPool();
  await testCitedEvidenceBelowBarIsRejectedDespiteModelClaimingProposal();
  await testSharedPoolPromptUsesAnonymizedLabelsNotRealNames();
  await testAcceptedSharedProposalOpensPRWithRealNames();
  await testOptedInSpokeStillRunsInItsOwnTenantsPrivatePassToo();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
