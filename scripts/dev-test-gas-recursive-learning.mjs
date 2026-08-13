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

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
