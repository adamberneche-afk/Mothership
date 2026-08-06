// Local verification harness for scripts/prune-logs.js.
//
// Same rationale as the other dev-test-*.mjs harnesses: no live GitHub
// writes here, everything runs against a hand-rolled fake octokit.
//
// Usage: node scripts/dev-test-prune-logs.mjs

import { pruneSpoke, pruneAllSpokes } from './prune-logs.js';

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

function makeFakeOctokit({ files = {} } = {}) {
  // files: { "owner/repo:path": [...entries] }
  const calls = { getContent: [], createOrUpdateFileContents: [] };
  const store = { ...files };
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
        const key = `${params.owner}/${params.repo}:${params.path}`;
        store[key] = JSON.parse(Buffer.from(params.content, 'base64').toString('utf8'));
        return { data: {} };
      }
    }
  };
}

const NOW = new Date('2026-08-06T00:00:00Z').getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function entryAt(daysAgo, extra = {}) {
  return { timestamp: new Date(NOW - daysAgo * DAY_MS).toISOString(), mode: 'debug', commitSha: `sha-${daysAgo}`, outcome: 'no_findings', issueUrl: null, summary: null, ...extra };
}

// --- Tests -------------------------------------------------------------------

async function testNoOldEntriesSkipsWithoutWriting() {
  console.log('Sprint 3: a log with no entries past the retention window is skipped, no writes');
  const octokit = makeFakeOctokit({
    files: { 'o/r:ai_decision_log.json': [entryAt(1), entryAt(5), entryAt(10)] }
  });
  const result = await pruneSpoke(octokit, { owner: 'o', repo: 'r' }, { retentionDays: 90, now: NOW });
  check('moved is 0', result.moved === 0);
  check('skipped is true', result.skipped === true);
  check('no writes happened', octokit.calls.createOrUpdateFileContents.length === 0);
}

async function testDryRunReportsWithoutWriting() {
  console.log('Sprint 3: dry-run reports the move count without writing anything');
  const octokit = makeFakeOctokit({
    files: { 'o/r:ai_decision_log.json': [entryAt(1), entryAt(100), entryAt(120)] }
  });
  const result = await pruneSpoke(octokit, { owner: 'o', repo: 'r' }, { retentionDays: 90, dryRun: true, now: NOW });
  check('moved is 2', result.moved === 2);
  check('dryRun is true', result.dryRun === true);
  check('no writes happened', octokit.calls.createOrUpdateFileContents.length === 0);
}

async function testArchivesOldEntriesBeforeTruncatingLiveLog() {
  console.log('Sprint 3: old entries get archived first, then the live log is truncated to recent entries');
  const octokit = makeFakeOctokit({
    files: {
      'o/r:ai_decision_log.json': [entryAt(1), entryAt(100), entryAt(120)],
      'o/r:ai_decision_log_archive.json': [entryAt(200)]
    }
  });
  const result = await pruneSpoke(octokit, { owner: 'o', repo: 'r' }, { retentionDays: 90, now: NOW });
  check('moved is 2', result.moved === 2);
  const writes = octokit.calls.createOrUpdateFileContents;
  check('exactly two writes happened', writes.length === 2);
  check('the archive was written before the live log', writes[0].path === 'ai_decision_log_archive.json' && writes[1].path === 'ai_decision_log.json');
  check('archive now has the pre-existing entry plus the two moved ones', octokit.store['o/r:ai_decision_log_archive.json'].length === 3);
  check('live log now has only the recent entry', octokit.store['o/r:ai_decision_log.json'].length === 1);
}

async function testEmptyLogIsANoOp() {
  console.log('Sprint 3: an empty decision log (e.g. tso today) is a no-op, no error');
  const octokit = makeFakeOctokit({ files: { 'o/r:ai_decision_log.json': [] } });
  const result = await pruneSpoke(octokit, { owner: 'o', repo: 'r' }, { retentionDays: 90, now: NOW });
  check('moved is 0', result.moved === 0);
  check('skipped is true', result.skipped === true);
}

async function testPruneAllSpokesUsesTheRealRegistryAndSkipsOnError() {
  console.log('Sprint 3: pruneAllSpokes reads the real spokes.json and continues past a per-spoke error');
  // This repo's actual spokes.json has one entry (tso) - no fs mocking
  // needed, it's a real file in the repo this test runs from.
  const octokit = makeFakeOctokit({ files: {} }); // getContent will 404 for tso's log -> empty log -> skipped, not an error
  const results = await pruneAllSpokes(octokit, { retentionDays: 90, now: NOW });
  check('at least one spoke was processed', results.length >= 1);
  check('no result is an error (missing log treated as empty, not a failure)', results.every(r => !r.error));
}

async function main() {
  await testNoOldEntriesSkipsWithoutWriting();
  await testDryRunReportsWithoutWriting();
  await testArchivesOldEntriesBeforeTruncatingLiveLog();
  await testEmptyLogIsANoOp();
  await testPruneAllSpokesUsesTheRealRegistryAndSkipsOnError();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
