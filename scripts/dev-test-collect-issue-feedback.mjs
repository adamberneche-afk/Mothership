// Local verification harness for scripts/collect-issue-feedback.js.
//
// Same rationale as the other dev-test-*.mjs harnesses: no live GitHub
// writes here, everything runs against a hand-rolled fake octokit.
//
// Usage: node scripts/dev-test-collect-issue-feedback.mjs

import { collectFeedbackForSpoke, collectFeedbackForAllSpokes } from './collect-issue-feedback.js';

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

// `issues`: array of issue objects (with `html_url`/`reactions`) returned by
// issues.listForRepo, regardless of what `labels`/`state` filter was passed -
// this fake doesn't need to model GitHub's actual filtering, only that the
// real script asks for the right label.
// `failLiveWritesCount`: simulates a stale-sha conflict on the decision-log
// write (e.g. a concurrent heartbeat append) - throws that many times before
// letting the write through, to verify collectFeedbackForSpoke's retry
// behavior (same technique as dev-test-prune-logs.mjs).
function makeFakeOctokit({ files = {}, issues = [], failLiveWritesCount = 0 } = {}) {
  const calls = { getContent: [], createOrUpdateFileContents: [], listForRepo: [] };
  const store = { ...files };
  let remainingFailures = failLiveWritesCount;
  return {
    calls,
    store,
    repos: {
      getContent: async ({ owner, repo, path }) => {
        calls.getContent.push({ owner, repo, path });
        const key = `${owner}/${repo}:${path}`;
        if (store[key] === undefined) throw new Error('404 not found');
        return { data: { content: Buffer.from(JSON.stringify(store[key])).toString('base64'), sha: `sha-${key}` } };
      },
      createOrUpdateFileContents: async (params) => {
        calls.createOrUpdateFileContents.push(params);
        if (params.path === 'ai_decision_log.json' && remainingFailures > 0) {
          remainingFailures--;
          throw new Error('409 Conflict: sha mismatch');
        }
        const key = `${params.owner}/${params.repo}:${params.path}`;
        store[key] = JSON.parse(Buffer.from(params.content, 'base64').toString('utf8'));
        return { data: {} };
      }
    },
    issues: {
      listForRepo: async ({ owner, repo, labels }) => {
        calls.listForRepo.push({ owner, repo, labels });
        return { data: issues };
      }
    }
  };
}

function issueWith(htmlUrl, { thumbsUp = 0, thumbsDown = 0 } = {}) {
  return { html_url: htmlUrl, reactions: { '+1': thumbsUp, '-1': thumbsDown } };
}

function createdEntry(issueUrl, extra = {}) {
  return { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'abc123', outcome: 'created', issueUrl, summary: 'x', ...extra };
}

function skippedEntry(extra = {}) {
  return { timestamp: '2026-08-01T00:00:00Z', mode: 'debug', commitSha: 'def456', outcome: 'no_findings', issueUrl: null, summary: null, ...extra };
}

// --- Tests -------------------------------------------------------------------

async function testAttachesFeedbackToMatchingEntryWithNegativeReactions() {
  console.log('an issue with -1 reactions gets feedback attached to its matching decision-log entry');
  const octokit = makeFakeOctokit({
    files: { 'o/r:ai_decision_log.json': [createdEntry('https://github.com/o/r/issues/1')] },
    issues: [issueWith('https://github.com/o/r/issues/1', { thumbsDown: 2, thumbsUp: 1 })]
  });
  const result = await collectFeedbackForSpoke(octokit, { owner: 'o', repo: 'r' });
  check('reports one entry updated', result.updated === 1);
  const stored = octokit.store['o/r:ai_decision_log.json'][0];
  check('feedback.thumbsDown recorded correctly', stored.feedback.thumbsDown === 2);
  check('feedback.thumbsUp recorded correctly', stored.feedback.thumbsUp === 1);
  check('feedback.checkedAt is a real ISO timestamp', typeof stored.feedback.checkedAt === 'string' && !Number.isNaN(new Date(stored.feedback.checkedAt).getTime()));
}

async function testLeavesEntryUntouchedWhenNoNegativeReactions() {
  console.log('an issue with no negative reactions is left untouched - no feedback field added, no write happens');
  const octokit = makeFakeOctokit({
    files: { 'o/r:ai_decision_log.json': [createdEntry('https://github.com/o/r/issues/2')] },
    issues: [issueWith('https://github.com/o/r/issues/2', { thumbsUp: 3, thumbsDown: 0 })]
  });
  const result = await collectFeedbackForSpoke(octokit, { owner: 'o', repo: 'r' });
  check('reports zero entries updated', result.updated === 0);
  check('no write happened', octokit.calls.createOrUpdateFileContents.length === 0);
  check('the entry has no feedback field', octokit.store['o/r:ai_decision_log.json'][0].feedback === undefined);
}

async function testSkipsEntriesWithNoIssueUrl() {
  console.log('a decision-log entry with no issueUrl (never created) is skipped entirely - nothing to match a reaction to');
  const octokit = makeFakeOctokit({
    files: { 'o/r:ai_decision_log.json': [skippedEntry()] },
    issues: [issueWith('https://github.com/o/r/issues/99', { thumbsDown: 5 })]
  });
  const result = await collectFeedbackForSpoke(octokit, { owner: 'o', repo: 'r' });
  check('reports zero entries updated', result.updated === 0);
  check('no write happened', octokit.calls.createOrUpdateFileContents.length === 0);
}

async function testDoesNotRewriteWhenFeedbackCountsAreUnchanged() {
  console.log('an entry that already has the same feedback counts is left as-is - no pointless write on an unchanged reaction count');
  const existingFeedback = { thumbsDown: 2, thumbsUp: 0, checkedAt: '2026-08-01T00:00:00Z' };
  const octokit = makeFakeOctokit({
    files: { 'o/r:ai_decision_log.json': [createdEntry('https://github.com/o/r/issues/3', { feedback: existingFeedback })] },
    issues: [issueWith('https://github.com/o/r/issues/3', { thumbsDown: 2, thumbsUp: 0 })]
  });
  const result = await collectFeedbackForSpoke(octokit, { owner: 'o', repo: 'r' });
  check('reports zero entries updated', result.updated === 0);
  check('no write happened', octokit.calls.createOrUpdateFileContents.length === 0);
}

async function testRetriesOnWriteConflictAndSucceeds() {
  console.log('retries on a stale-sha write conflict and succeeds on a later attempt, re-reading the log fresh each time');
  const octokit = makeFakeOctokit({
    files: { 'o/r:ai_decision_log.json': [createdEntry('https://github.com/o/r/issues/4')] },
    issues: [issueWith('https://github.com/o/r/issues/4', { thumbsDown: 1 })],
    failLiveWritesCount: 1
  });
  const result = await collectFeedbackForSpoke(octokit, { owner: 'o', repo: 'r' });
  check('eventually succeeds', result.updated === 1);
  check('the write was attempted twice (one failure, one success)', octokit.calls.createOrUpdateFileContents.length === 2);
  check('feedback ends up recorded correctly', octokit.store['o/r:ai_decision_log.json'][0].feedback.thumbsDown === 1);
}

async function testGivesUpAfterMaxAttempts() {
  console.log('gives up and throws after exhausting retries on a persistent conflict');
  const octokit = makeFakeOctokit({
    files: { 'o/r:ai_decision_log.json': [createdEntry('https://github.com/o/r/issues/5')] },
    issues: [issueWith('https://github.com/o/r/issues/5', { thumbsDown: 1 })],
    failLiveWritesCount: 99
  });
  let threw = false;
  try {
    await collectFeedbackForSpoke(octokit, { owner: 'o', repo: 'r' }, { maxAttempts: 3 });
  } catch (e) {
    threw = true;
  }
  check('throws after exhausting retries', threw === true);
  check('attempted exactly maxAttempts times', octokit.calls.createOrUpdateFileContents.length === 3);
}

async function testCollectFeedbackForAllSpokesUsesTheRealRegistryAndSkipsOnError() {
  console.log('collectFeedbackForAllSpokes reads the real spokes.json and continues past a per-spoke error');
  // This repo's actual spokes.json has real entries - no fs mocking needed.
  // getContent 404s for each spoke's log -> empty log -> zero updates, not an error.
  const octokit = makeFakeOctokit({ files: {}, issues: [] });
  const results = await collectFeedbackForAllSpokes(octokit);
  check('at least one spoke was processed', results.length >= 1);
  check('no result is an error (missing log treated as empty, not a failure)', results.every((r) => !r.error));
}

async function testEachSpokeIsCheckedWithItsOwnTenantCredentialWhenFactoryIsSupplied() {
  console.log("Multi-tenancy: with octokitFactory supplied, each spoke's feedback is collected using ITS tenant's own resolved credential, not the hub token");
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  const acmeOctokit = makeFakeOctokit({
    files: { 'acme-org/acme-repo:ai_decision_log.json': [createdEntry('https://github.com/acme-org/acme-repo/issues/1')] },
    issues: [issueWith('https://github.com/acme-org/acme-repo/issues/1', { thumbsDown: 1 })]
  });
  const hubOctokit = makeFakeOctokit({});
  const tokensRequested = [];
  const octokitFactory = (token) => { tokensRequested.push(token); return token === 'acme-secret-token' ? acmeOctokit : hubOctokit; };
  const spokesOverride = [{ tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' }];
  const tenantsOverride = [{ tenantId: 'acme', name: 'Acme', status: 'active', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:ACME_TEST_TOKEN', createdAt: '2026-08-13T00:00:00Z' }];
  const results = await collectFeedbackForAllSpokes(hubOctokit, { octokitFactory, spokesOverride, tenantsOverride });
  check("acme's own token was resolved and used", tokensRequested.includes('acme-secret-token'));
  check("acme's spoke was checked via its own fake octokit, not the hub one", acmeOctokit.calls.listForRepo.length > 0);
  check('the hub octokit was never asked about the acme spoke', hubOctokit.calls.listForRepo.every(c => c.owner !== 'acme-org'));
  check('the acme spoke result has no error and reports the update', results[0]?.owner === 'acme-org' && !results[0]?.error && results[0]?.updated === 1);
  delete process.env.ACME_TEST_TOKEN;
}

async function main() {
  await testAttachesFeedbackToMatchingEntryWithNegativeReactions();
  await testLeavesEntryUntouchedWhenNoNegativeReactions();
  await testSkipsEntriesWithNoIssueUrl();
  await testDoesNotRewriteWhenFeedbackCountsAreUnchanged();
  await testRetriesOnWriteConflictAndSucceeds();
  await testGivesUpAfterMaxAttempts();
  await testCollectFeedbackForAllSpokesUsesTheRealRegistryAndSkipsOnError();
  await testEachSpokeIsCheckedWithItsOwnTenantCredentialWhenFactoryIsSupplied();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
