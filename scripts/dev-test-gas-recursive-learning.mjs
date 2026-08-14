// Local verification harness for gas/recursive_learning.js's
// runRecursiveLearning(), the Apps Script port of api/recursive_learning.js.
// Same rationale as dev-test-gas-handler.mjs - loaded via the same vm-based
// harness real Apps Script uses to run these files.
//
// Usage: node scripts/dev-test-gas-recursive-learning.mjs

import { loadGasGlobals } from './gas-test-harness.mjs';

const { runRecursiveLearning } = loadGasGlobals('constants.js', 'github.js', 'recursive_learning.js');

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

function makeFakeAiFetch(aiJsonContent) {
  let callCount = 0;
  const calls = [];
  const aiFetch = (url, options) => {
    callCount++;
    calls.push({ url, options });
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ choices: [{ message: { content: aiJsonContent } }] })
    };
  };
  aiFetch.callCount = () => callCount;
  aiFetch.calls = calls;
  // The prompt actually sent to the AI - Apps Script's UrlFetchApp uses
  // `payload`, not fetch()'s `body`.
  aiFetch.lastPrompt = () => {
    const last = calls[calls.length - 1];
    return last ? JSON.parse(last.options.payload).messages[0].content : null;
  };
  aiFetch.allPrompts = () => calls.map(c => JSON.parse(c.options.payload).messages[0].content);
  return aiFetch;
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

// --- Tests -------------------------------------------------------------------

function testNoSpokesRegisteredSkips() {
  console.log('No registered spokes skips without calling the AI');
  const github = makeFakeGithub({ spokesRegistry: [] });
  const aiFetch = makeFakeAiFetch(PROPOSAL_JSON);
  const { body } = runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, aiFetch, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('status is Skipped', body.status === 'Skipped');
  check('reason mentions no spokes', /no spokes/i.test(body.reason || ''));
  check('AI was never called', aiFetch.callCount() === 0);
}

function testNoProposalSkips() {
  console.log('AI reporting no cross-spoke pattern skips without opening anything');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const aiFetch = makeFakeAiFetch(NO_PROPOSAL_JSON);
  const { body } = runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, aiFetch, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('status is Completed (the aggregate wrapper)', body.status === 'Completed');
  check('the one tenant result is Skipped', body.results[0]?.status === 'Skipped');
  check('no branch was created', github.calls.createRef.length === 0);
  check('no PR was opened', github.calls.pullsCreate.length === 0);
}

function testDryRunNeverOpensAPR() {
  console.log('Dry-run mode returns the proposal without opening a PR');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const aiFetch = makeFakeAiFetch(PROPOSAL_JSON);
  const { body } = runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, aiFetch, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('dryRun is true', body.dryRun === true);
  const tenantResult = body.results[0];
  check('tenant result status is DryRunProposal', tenantResult?.status === 'DryRunProposal');
  check('proposal is present', !!tenantResult?.proposal?.reasoning);
  check('no branch was created', github.calls.createRef.length === 0);
  check('no PR was opened', github.calls.pullsCreate.length === 0);
}

function testLiveOpensExactlyOnePR() {
  console.log('Live mode opens exactly one PR against the hub itself, never a direct commit to main');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const aiFetch = makeFakeAiFetch(PROPOSAL_JSON);
  const { body } = runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, aiFetch, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const tenantResult = body.results[0];
  check('tenant result status is Success', tenantResult?.status === 'Success');
  check('pullRequestUrl is present', !!tenantResult?.pullRequestUrl);
  check('exactly one branch was created off main', github.calls.createRef.length === 1);
  check('the PR base is main', github.calls.pullsCreate[0]?.base === 'main');
  check('the PR targets the hub repo, not a spoke', github.calls.pullsCreate[0]?.owner === 'hub-owner' && github.calls.pullsCreate[0]?.repo === 'hub-repo');
  check('the PR body names the tenant that prompted it', /tenant `default`/.test(github.calls.pullsCreate[0]?.body || ''));
  check('exactly one PR was opened', github.calls.pullsCreate.length === 1);
  check('only universal_lessons.md was written (north_star_patch was empty)', github.calls.createOrUpdateFileContents.length === 1 && github.calls.createOrUpdateFileContents[0].path === 'universal_lessons.md');
}

function testUsesTheRepoActualDefaultBranchNotHardcodedMain() {
  console.log("Uses the hub repo's real default branch instead of assuming 'main'");
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES, defaultBranch: 'trunk' });
  const aiFetch = makeFakeAiFetch(PROPOSAL_JSON);
  runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, aiFetch, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('looked up the default branch via repos.get', github.calls.reposGet.length === 1);
  check('branched off the real default branch, not "main"', github.calls.getRef[0]?.ref === 'heads/trunk');
  check('the PR base is the real default branch, not "main"', github.calls.pullsCreate[0]?.base === 'trunk');
}

function testBase64RoundTripsThroughInjectedFunctions() {
  console.log('Platform port: proposed file content round-trips through base64Encode/Decode correctly');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const aiFetch = makeFakeAiFetch(PROPOSAL_JSON);
  runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, aiFetch, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const write = github.calls.createOrUpdateFileContents[0];
  check('the written content decodes back to the real proposal text', unb64(write.content).includes('Validate before you trust.'));
}

function testPromptIncludesNegativeMaintainerFeedbackSummary() {
  console.log('the prompt includes a MAINTAINER FEEDBACK line naming a real negative-feedback count when scripts/collect-issue-feedback.js has recorded one');
  const filesWithFeedback = {
    ...SPOKE_FILES,
    'fake-owner/fake-spoke:ai_decision_log.json': JSON.stringify([
      { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc', outcome: 'created', issueUrl: 'https://github.com/fake-owner/fake-spoke/issues/1', summary: null, feedback: { thumbsDown: 2, thumbsUp: 0, checkedAt: '2026-08-02T00:00:00Z' } },
      { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'def', outcome: 'no_findings', issueUrl: null, summary: null }
    ])
  };
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: filesWithFeedback });
  const aiFetch = makeFakeAiFetch(NO_PROPOSAL_JSON);
  runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, aiFetch, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const prompt = aiFetch.lastPrompt();
  check('prompt mentions MAINTAINER FEEDBACK', /MAINTAINER FEEDBACK/.test(prompt));
  check('prompt names the real negative-feedback count (1 of the 2 logged decisions)', /1 of the last 2 decisions received negative maintainer feedback/.test(prompt));
}

function testPromptSaysNoneWhenNoNegativeFeedbackExists() {
  console.log('the prompt says "none" when no decision has received negative maintainer feedback');
  const github = makeFakeGithub({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const aiFetch = makeFakeAiFetch(NO_PROPOSAL_JSON);
  runRecursiveLearning({}, { ...BASE_DEPS, githubFactory: makeFakeGithubFactory(github), hubGithub: github, aiFetch, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const prompt = aiFetch.lastPrompt();
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

function testTwoTenantsGetTwoIndependentPromptsNeverPooled() {
  console.log("Multi-tenancy: two tenants each get their OWN prompt - acme's lessons never appear in globex's prompt or vice versa");
  const acmeGithub = makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES);
  const globexGithub = makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES);
  const githubByToken = { 'acme-secret-token': acmeGithub, 'globex-secret-token': globexGithub };
  const githubFactory = (token) => githubByToken[token];
  const hubGithub = makeFakeHubGithubForTenancy();
  const aiFetch = makeFakeAiFetch(NO_PROPOSAL_JSON);
  const scriptProperties = { getProperty: (key) => ({ ACME_TEST_TOKEN: 'acme-secret-token', GLOBEX_TEST_TOKEN: 'globex-secret-token' }[key] || null) };
  runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, aiFetch, dryRunOverride: true, config: { scriptProperties },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  const prompts = aiFetch.allPrompts();
  check('exactly two AI calls happened - one per tenant', prompts.length === 2);
  const acmePrompt = prompts.find(p => p.includes('acme-org/acme-repo'));
  const globexPrompt = prompts.find(p => p.includes('globex-org/globex-repo'));
  check("acme's prompt contains acme's own lesson", acmePrompt && acmePrompt.includes('Acme-specific lesson about widgets'));
  check("acme's prompt never contains globex's lesson (no cross-tenant pooling)", acmePrompt && !acmePrompt.includes('Globex-specific lesson about gadgets'));
  check("globex's prompt contains globex's own lesson", globexPrompt && globexPrompt.includes('Globex-specific lesson about gadgets'));
  check("globex's prompt never contains acme's lesson (no cross-tenant pooling)", globexPrompt && !globexPrompt.includes('Acme-specific lesson about widgets'));
}

function testEachTenantWithAProposalGetsItsOwnPR() {
  console.log('Multi-tenancy: live mode opens a SEPARATE PR per tenant that has a real proposal, each naming that tenant');
  const acmeGithub = makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES);
  const globexGithub = makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES);
  const githubByToken = { 'acme-secret-token': acmeGithub, 'globex-secret-token': globexGithub };
  const githubFactory = (token) => githubByToken[token];
  const hubGithub = makeFakeHubGithubForTenancy();
  const aiFetch = makeFakeAiFetch(PROPOSAL_JSON);
  const scriptProperties = { getProperty: (key) => ({ ACME_TEST_TOKEN: 'acme-secret-token', GLOBEX_TEST_TOKEN: 'globex-secret-token' }[key] || null) };
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, aiFetch, dryRunOverride: false, config: { scriptProperties },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('two tenant results, both Success', body.results.length === 2 && body.results.every(r => r.status === 'Success'));
  check('exactly two PRs were opened - one per tenant', hubGithub.calls.pullsCreate.length === 2);
  const titles = hubGithub.calls.pullsCreate.map(p => p.title);
  check("one PR explicitly names tenant 'acme'", titles.some(t => t.includes('tenant acme')));
  check("one PR explicitly names tenant 'globex'", titles.some(t => t.includes('tenant globex')));
  check('every PR still targets the hub repo, never a spoke', hubGithub.calls.pullsCreate.every(p => p.owner === 'hub-owner' && p.repo === 'hub-repo'));
}

function testTenantCredentialResolutionUsesTheRightToken() {
  console.log("Multi-tenancy: each tenant's spokes are read with THEIR OWN resolved credential, not a shared/global one");
  const sharedFakeGithub = makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES);
  const factory = makeFakeGithubFactory(sharedFakeGithub);
  const hubGithub = makeFakeHubGithubForTenancy();
  const aiFetch = makeFakeAiFetch(NO_PROPOSAL_JSON);
  const scriptProperties = { getProperty: (key) => ({ ACME_TEST_TOKEN: 'acme-secret-token', GLOBEX_TEST_TOKEN: 'globex-secret-token' }[key] || null) };
  runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory: factory, hubGithub, aiFetch, dryRunOverride: true, config: { scriptProperties },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check("the factory was called once per tenant with each tenant's own resolved token", factory.tokensUsed.includes('acme-secret-token') && factory.tokensUsed.includes('globex-secret-token'));
}

// --- Shared, opt-in, cross-organization learning pool ----------------------
// Mirrors the api/ test file's identical section - see its header comment.

function makeFakeAiFetchRouter(responder) {
  const calls = [];
  const aiFetch = (url, options) => {
    const prompt = JSON.parse(options.payload).messages[0].content;
    calls.push({ url, options, prompt });
    const content = responder(prompt);
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ choices: [{ message: { content } }] })
    };
  };
  aiFetch.calls = calls;
  aiFetch.callCount = () => calls.length;
  aiFetch.allPrompts = () => calls.map(c => c.prompt);
  aiFetch.promptsMatching = (re) => calls.map(c => c.prompt).filter(p => re.test(p));
  return aiFetch;
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

const SCRIPT_PROPERTIES_TWO_TENANT = { getProperty: (key) => ({ ACME_TEST_TOKEN: 'acme-secret-token', GLOBEX_TEST_TOKEN: 'globex-secret-token' }[key] || null) };
const SCRIPT_PROPERTIES_ACME_ONLY = { getProperty: (key) => ({ ACME_TEST_TOKEN: 'acme-secret-token' }[key] || null) };

function makeSharedPoolGithubFactory(mapping) {
  const fallback = makeFakeSpokeGithub({});
  return (token) => mapping[token] || fallback;
}

function testOptedOutSpokeNeverAppearsInSharedPoolOrCountsTowardEvidence() {
  console.log("Multi-tenancy shared pool: a spoke that hasn't opted in (no shareLearnings) never appears in the shared-pool prompt, and doesn't count toward its evidence bar");
  const githubFactory = makeSharedPoolGithubFactory({
    'acme-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)
  });
  const hubGithub = makeFakeHubGithubForTenancy();
  const spokesWithOneOptedOut = [
    ...SHARED_POOL_TWO_TENANT_SPOKES,
    { tenantId: 'someco', owner: 'someco-org', repo: 'someco-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' } // no shareLearnings - opted out
  ];
  const aiFetch = makeFakeAiFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2'])));
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, aiFetch, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: spokesWithOneOptedOut, tenantsOverride: TWO_TENANTS
  });
  const sharedPoolPrompt = aiFetch.promptsMatching(/cross-ORGANIZATION/)[0];
  check('shared-pool prompt never mentions the opted-out spoke', sharedPoolPrompt && !sharedPoolPrompt.includes('someco'));
  check('shared-pool prompt has exactly 2 contributor sections, not 3', (sharedPoolPrompt.match(/--- Contributor \d+ ---/g) || []).length === 2);
  check('shared pool result is a DryRunProposal (2 opted-in spokes across 2 tenants meets the bar)', body.sharedPoolResult?.status === 'DryRunProposal');
}

function testTwoDistinctTenantsClearsEvidenceBar() {
  console.log('Multi-tenancy shared pool: 2 opted-in spokes from 2 DIFFERENT tenants clears the evidence bar');
  const githubFactory = makeSharedPoolGithubFactory({
    'acme-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)
  });
  const hubGithub = makeFakeHubGithubForTenancy();
  const aiFetch = makeFakeAiFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2'])));
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, aiFetch, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('shared pool result is accepted (DryRunProposal)', body.sharedPoolResult?.status === 'DryRunProposal');
}

function testThreeDistinctReposSameTenantClearsEvidenceBar() {
  console.log('Multi-tenancy shared pool: 3 opted-in spokes within the SAME tenant clears the evidence bar (lower confidence than cross-tenant, still accepted)');
  const githubFactory = makeSharedPoolGithubFactory({ 'acme-secret-token': makeFakeSpokeGithub({}) });
  const hubGithub = makeFakeHubGithubForTenancy();
  const aiFetch = makeFakeAiFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2', 'Contributor 3'])));
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, aiFetch, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_ACME_ONLY },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: THREE_SAME_TENANT_SPOKES, tenantsOverride: ACME_ONLY_TENANT
  });
  check('shared pool result is accepted (DryRunProposal)', body.sharedPoolResult?.status === 'DryRunProposal');
}

function testBelowBarSkipsStructurallyWithoutCallingAIForSharedPool() {
  console.log('Multi-tenancy shared pool: only 2 opted-in spokes in the SAME tenant cannot meet the bar - skipped before ever calling the AI for the shared pool');
  const githubFactory = makeSharedPoolGithubFactory({ 'acme-secret-token': makeFakeSpokeGithub({}) });
  const hubGithub = makeFakeHubGithubForTenancy();
  const twoSameTenantSpokes = THREE_SAME_TENANT_SPOKES.slice(0, 2);
  const aiFetch = makeFakeAiFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2'])));
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, aiFetch, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_ACME_ONLY },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: twoSameTenantSpokes, tenantsOverride: ACME_ONLY_TENANT
  });
  check('shared pool result is Skipped', body.sharedPoolResult?.status === 'Skipped');
  check('reason mentions not enough opted-in spokes', /not enough opted-in spokes/i.test(body.sharedPoolResult?.reason || ''));
  check('zero AI calls were made for the shared pool specifically', aiFetch.promptsMatching(/cross-ORGANIZATION/).length === 0);
}

function testCitedEvidenceBelowBarIsRejectedDespiteModelClaimingProposal() {
  console.log('Multi-tenancy shared pool (anti-hallucination): the model claims has_proposal=true and cites real labels, but those specific labels only span 1 tenant/2 repos - code rejects it regardless of the claim');
  const githubFactory = makeSharedPoolGithubFactory({
    'acme-secret-token': makeFakeSpokeGithub({}),
    'globex-secret-token': makeFakeSpokeGithub({})
  });
  const hubGithub = makeFakeHubGithubForTenancy();
  const spokes = [
    { tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo-1', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true },
    { tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo-2', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true },
    { tenantId: 'globex', owner: 'globex-org', repo: 'globex-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active', shareLearnings: true }
  ];
  const aiFetch = makeFakeAiFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2'])));
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, aiFetch, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: spokes, tenantsOverride: TWO_TENANTS
  });
  check('shared pool result is Skipped despite has_proposal:true', body.sharedPoolResult?.status === 'Skipped');
  check('reason cites the evidence-bar failure specifically', /cited evidence does not meet/i.test(body.sharedPoolResult?.reason || ''));
  check('no PR was opened', hubGithub.calls.pullsCreate.length === 0);
}

function testSharedPoolPromptUsesAnonymizedLabelsNotRealNames() {
  console.log('Multi-tenancy shared pool: the prompt sent to the AI uses anonymized "Contributor N" labels, never a real owner/repo name');
  const githubFactory = makeSharedPoolGithubFactory({
    'acme-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)
  });
  const hubGithub = makeFakeHubGithubForTenancy();
  const aiFetch = makeFakeAiFetchRouter(sharedPoolAwareResponder(NO_PROPOSAL_SHARED_JSON));
  runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, aiFetch, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  const sharedPoolPrompt = aiFetch.promptsMatching(/cross-ORGANIZATION/)[0];
  check('shared-pool prompt contains anonymized labels', sharedPoolPrompt.includes('Contributor 1') && sharedPoolPrompt.includes('Contributor 2'));
  check('shared-pool prompt never contains the real owner/repo strings', !sharedPoolPrompt.includes('acme-org/acme-repo') && !sharedPoolPrompt.includes('globex-org/globex-repo'));
}

function testAcceptedSharedProposalOpensPRWithRealNames() {
  console.log('Multi-tenancy shared pool: an accepted, live proposal opens exactly one PR naming the REAL contributing repos/tenants (anonymization is prompt-only, not hidden from the human reviewer)');
  const githubFactory = makeSharedPoolGithubFactory({
    'acme-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES),
    'globex-secret-token': makeFakeSpokeGithub(TWO_TENANT_SPOKE_FILES)
  });
  const hubGithub = makeFakeHubGithubForTenancy();
  const aiFetch = makeFakeAiFetchRouter(sharedPoolAwareResponder(sharedPoolProposalJson(['Contributor 1', 'Contributor 2']), NO_PROPOSAL_JSON));
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, aiFetch, dryRunOverride: false, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('shared pool result is Success', body.sharedPoolResult?.status === 'Success');
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
  const aiFetch = makeFakeAiFetchRouter(sharedPoolAwareResponder(NO_PROPOSAL_SHARED_JSON));
  const { body } = runRecursiveLearning({}, {
    ...BASE_DEPS, githubFactory, hubGithub, aiFetch, dryRunOverride: true, config: { scriptProperties: SCRIPT_PROPERTIES_TWO_TENANT },
    hubOwner: 'hub-owner', hubRepo: 'hub-repo',
    spokesOverride: SHARED_POOL_TWO_TENANT_SPOKES, tenantsOverride: TWO_TENANTS
  });
  check('both tenants still got their own private per-tenant result', body.results.some(r => r.tenantId === 'acme') && body.results.some(r => r.tenantId === 'globex'));
  check('the shared pool ALSO ran (both, not either/or)', !!body.sharedPoolResult);
  check('exactly 3 AI calls happened - one per tenant plus one for the shared pool', aiFetch.callCount() === 3);
}

function main() {
  testNoSpokesRegisteredSkips();
  testNoProposalSkips();
  testDryRunNeverOpensAPR();
  testLiveOpensExactlyOnePR();
  testUsesTheRepoActualDefaultBranchNotHardcodedMain();
  testBase64RoundTripsThroughInjectedFunctions();
  testPromptIncludesNegativeMaintainerFeedbackSummary();
  testPromptSaysNoneWhenNoNegativeFeedbackExists();
  testTwoTenantsGetTwoIndependentPromptsNeverPooled();
  testEachTenantWithAProposalGetsItsOwnPR();
  testTenantCredentialResolutionUsesTheRightToken();
  testOptedOutSpokeNeverAppearsInSharedPoolOrCountsTowardEvidence();
  testTwoDistinctTenantsClearsEvidenceBar();
  testThreeDistinctReposSameTenantClearsEvidenceBar();
  testBelowBarSkipsStructurallyWithoutCallingAIForSharedPool();
  testCitedEvidenceBelowBarIsRejectedDespiteModelClaimingProposal();
  testSharedPoolPromptUsesAnonymizedLabelsNotRealNames();
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
