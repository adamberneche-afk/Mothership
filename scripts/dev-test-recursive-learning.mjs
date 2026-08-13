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
  const { body } = await runRecursiveLearning({}, { octokit, fetchImpl, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('status is Skipped', body.status === 'Skipped');
  check('reason mentions no spokes', /no spokes/i.test(body.reason || ''));
  check('AI was never called', fetchImpl.callCount() === 0);
}

async function testNoProposalSkips() {
  console.log('Sprint 2: AI reporting no cross-spoke pattern skips without opening anything');
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const fetchImpl = makeFakeFetch(NO_PROPOSAL_JSON);
  const { body } = await runRecursiveLearning({}, { octokit, fetchImpl, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('status is Skipped', body.status === 'Skipped');
  check('no branch was created', octokit.calls.createRef.length === 0);
  check('no PR was opened', octokit.calls.pullsCreate.length === 0);
}

async function testDryRunNeverOpensAPR() {
  console.log('Sprint 2: dry-run mode returns the proposal without opening a PR');
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const fetchImpl = makeFakeFetch(PROPOSAL_JSON);
  const { body } = await runRecursiveLearning({}, { octokit, fetchImpl, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('status is DryRunProposal', body.status === 'DryRunProposal');
  check('dryRun is true', body.dryRun === true);
  check('proposal is present', !!body.proposal?.reasoning);
  check('no branch was created', octokit.calls.createRef.length === 0);
  check('no PR was opened', octokit.calls.pullsCreate.length === 0);
}

async function testLiveOpensExactlyOnePR() {
  console.log('Sprint 2: live mode opens exactly one PR against the hub itself, never a direct commit to main');
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const fetchImpl = makeFakeFetch(PROPOSAL_JSON);
  const { body } = await runRecursiveLearning({}, { octokit, fetchImpl, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  check('status is Success', body.status === 'Success');
  check('pullRequestUrl is present', !!body.pullRequestUrl);
  check('exactly one branch was created off main', octokit.calls.createRef.length === 1);
  check('the PR base is main', octokit.calls.pullsCreate[0]?.base === 'main');
  check('the PR targets the hub repo, not a spoke', octokit.calls.pullsCreate[0]?.owner === 'hub-owner' && octokit.calls.pullsCreate[0]?.repo === 'hub-repo');
  check('exactly one PR was opened', octokit.calls.pullsCreate.length === 1);
  check('only universal_lessons.md was written (north_star_patch was empty)', octokit.calls.createOrUpdateFileContents.length === 1 && octokit.calls.createOrUpdateFileContents[0].path === 'universal_lessons.md');
}

async function testUsesTheRepoActualDefaultBranchNotHardcodedMain() {
  console.log("Sprint 2 fix: uses the hub repo's real default branch instead of assuming 'main'");
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES, defaultBranch: 'trunk' });
  const fetchImpl = makeFakeFetch(PROPOSAL_JSON);
  await runRecursiveLearning({}, { octokit, fetchImpl, dryRunOverride: false, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
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
  await runRecursiveLearning({}, { octokit, fetchImpl, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const prompt = fetchImpl.lastPrompt();
  check('prompt mentions MAINTAINER FEEDBACK', /MAINTAINER FEEDBACK/.test(prompt));
  check('prompt names the real negative-feedback count (1 of the 2 logged decisions)', /1 of the last 2 decisions received negative maintainer feedback/.test(prompt));
}

async function testPromptSaysNoneWhenNoNegativeFeedbackExists() {
  console.log('the prompt says "none" when no decision has received negative maintainer feedback');
  const octokit = makeFakeOctokit({ spokesRegistry: ONE_SPOKE, perSpokeFiles: SPOKE_FILES });
  const fetchImpl = makeFakeFetch(NO_PROPOSAL_JSON);
  await runRecursiveLearning({}, { octokit, fetchImpl, dryRunOverride: true, hubOwner: 'hub-owner', hubRepo: 'hub-repo' });
  const prompt = fetchImpl.lastPrompt();
  check('prompt says none received negative maintainer feedback', /none of the last decisions received negative maintainer feedback/.test(prompt));
}

async function main() {
  await testNoSpokesRegisteredSkips();
  await testNoProposalSkips();
  await testDryRunNeverOpensAPR();
  await testLiveOpensExactlyOnePR();
  await testUsesTheRepoActualDefaultBranchNotHardcodedMain();
  await testPromptIncludesNegativeMaintainerFeedbackSummary();
  await testPromptSaysNoneWhenNoNegativeFeedbackExists();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
