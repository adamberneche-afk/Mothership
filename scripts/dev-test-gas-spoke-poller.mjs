// Local verification harness for gas/spoke_poller.js - the pull model that
// replaces each spoke's call-hub.yml heartbeat. Covers the watermark rules
// (advance only on a settled result), per-spoke isolation, inactive spokes,
// the status record, trigger installation, the overlap lock, and one
// end-to-end run through the real processRequest() with a tenant that
// requires a caller key - the exact gate the old heartbeat never got past.
//
// Usage: node scripts/dev-test-gas-spoke-poller.mjs

import { loadGasGlobals } from './gas-test-harness.mjs';
import { makeFakeSheet, makeFakeLogger } from './gas-sheet-fakes.mjs';

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

function b64(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function unb64(str) { return Buffer.from(str, 'base64').toString('utf8'); }

function freshContext(seed = {}) {
  return loadGasGlobals('constants.js', 'github.js', 'review_queue.js', 'autonomous_agent.js', 'spoke_poller.js',
    { Logger: makeFakeLogger(), ...seed });
}

function makeProps(initial = {}) {
  const store = { ...initial };
  return {
    _store: store,
    getProperty: (k) => (store[k] !== undefined ? store[k] : null),
    setProperty: (k, v) => { store[k] = String(v); }
  };
}

// A spoke-side github client whose latest commit per repo is set by `heads`.
function makeSpokeGithub(heads, { throwFor = [] } = {}) {
  const calls = { listCommits: [] };
  return {
    calls,
    repos: {
      listCommits: ({ owner, repo }) => {
        calls.listCommits.push(`${owner}/${repo}`);
        if (throwFor.includes(`${owner}/${repo}`)) throw new Error('GitHub 502 for this repo');
        const sha = heads[`${owner}/${repo}`];
        return { data: sha ? [{ sha }] : [] };
      }
    }
  };
}

const SPOKES = [
  { tenantId: 't', owner: 'o', repo: 'a', status: 'active' },
  { tenantId: 't', owner: 'o', repo: 'b', status: 'active' }
];
const TENANTS = [{ tenantId: 't', status: 'active', quota: { reviewsPerMonth: null } }];

function baseDeps(github, props, extra = {}) {
  return {
    githubFactory: () => github, hubGithub: null,
    base64Encode: b64, base64Decode: unb64,
    config: { scriptProperties: props }, props,
    spokesOverride: SPOKES, tenantsOverride: TENANTS,
    now: new Date('2026-10-31T12:00:00Z'),
    ...extra
  };
}

function stubProcess(bodyFor) {
  const calls = [];
  const impl = (req) => {
    calls.push(req);
    return { httpStatus: 200, body: bodyFor(req) };
  };
  impl.calls = calls;
  return impl;
}

function testNewCommitQueuedAdvancesWatermark() {
  console.log('a new commit that queues advances the watermark; the next run on the same commit costs one listCommits and no review');
  const ctx = freshContext();
  const props = makeProps();
  const github = makeSpokeGithub({ 'o/a': 'sha-a1', 'o/b': 'sha-b1' });
  const impl = stubProcess(() => ({ status: 'Queued' }));
  const r1 = ctx.pollSpokes_('debug', baseDeps(github, props, { processRequestImpl: impl }));
  check('both spokes were handed to processRequest', impl.calls.length === 2);
  check('each call carried owner/repo/mode', impl.calls[0].owner === 'o' && impl.calls[0].repo === 'a' && impl.calls[0].mode === 'debug');
  check('both settled', r1.results.every((r) => r.outcome === 'settled'));
  check('watermark for o/a:debug is the commit', props.getProperty('SPOKE_POLL_LAST_o/a:debug') === 'sha-a1');

  const r2 = ctx.pollSpokes_('debug', baseDeps(github, props, { processRequestImpl: impl }));
  check('second run made no new processRequest calls', impl.calls.length === 2);
  check('second run reports both unchanged', r2.results.every((r) => r.outcome === 'unchanged'));
}

function testWatermarkIsPerMode() {
  console.log('a commit settled in debug mode is still reviewed in hunt mode');
  const ctx = freshContext();
  const props = makeProps({ 'SPOKE_POLL_LAST_o/a:debug': 'sha-a1', 'SPOKE_POLL_LAST_o/b:debug': 'sha-b1' });
  const github = makeSpokeGithub({ 'o/a': 'sha-a1', 'o/b': 'sha-b1' });
  const impl = stubProcess(() => ({ status: 'Queued' }));
  ctx.pollSpokes_('hunt', baseDeps(github, props, { processRequestImpl: impl }));
  check('hunt reviewed both spokes', impl.calls.length === 2 && impl.calls.every((c) => c.mode === 'hunt'));
}

function testAlreadyDecidedSettles() {
  console.log("'Already decided' settles the commit (it is what a logged bot/empty-diff skip returns next time)");
  const ctx = freshContext();
  const props = makeProps();
  const github = makeSpokeGithub({ 'o/a': 'sha-a1', 'o/b': 'sha-b1' });
  const impl = stubProcess(() => ({ status: 'Skipped', reason: 'Already decided for this commit in debug mode (no_diff_skip)' }));
  ctx.pollSpokes_('debug', baseDeps(github, props, { processRequestImpl: impl }));
  check('watermark advanced', props.getProperty('SPOKE_POLL_LAST_o/a:debug') === 'sha-a1');
}

function testUnsettledResultIsRetried() {
  console.log('a configuration skip (no queue sheet) leaves the watermark alone, so the next run tries again');
  const ctx = freshContext();
  const props = makeProps();
  const github = makeSpokeGithub({ 'o/a': 'sha-a1', 'o/b': 'sha-b1' });
  const impl = stubProcess(() => ({ status: 'Skipped', reason: 'No queue spreadsheet available' }));
  const r1 = ctx.pollSpokes_('debug', baseDeps(github, props, { processRequestImpl: impl }));
  check('outcome is retry', r1.results.every((r) => r.outcome === 'retry'));
  check('the retry detail carries the reason', /No queue spreadsheet/.test(r1.results[0].detail));
  check('no watermark written', props.getProperty('SPOKE_POLL_LAST_o/a:debug') === null);
  ctx.pollSpokes_('debug', baseDeps(github, props, { processRequestImpl: impl }));
  check('the next run called processRequest again', impl.calls.length === 4);
}

function testNon200IsRetried() {
  console.log('a 401/403/500 from processRequest is never treated as settled');
  const ctx = freshContext();
  const props = makeProps();
  const github = makeSpokeGithub({ 'o/a': 'sha-a1', 'o/b': 'sha-b1' });
  const impl = (req) => ({ httpStatus: 401, body: { error: 'invalid or missing caller key for this tenant' } });
  const r = ctx.pollSpokes_('debug', baseDeps(github, props, { processRequestImpl: impl }));
  check('outcome is retry', r.results.every((x) => x.outcome === 'retry'));
  check('detail names the 401', /^401/.test(r.results[0].detail));
}

function testOneFailingSpokeDoesNotStopTheOthers() {
  console.log('a spoke whose GitHub call throws is recorded as an error and the rest still run');
  const ctx = freshContext();
  const props = makeProps();
  const github = makeSpokeGithub({ 'o/a': 'sha-a1', 'o/b': 'sha-b1' }, { throwFor: ['o/a'] });
  const impl = stubProcess(() => ({ status: 'Queued' }));
  const r = ctx.pollSpokes_('debug', baseDeps(github, props, { processRequestImpl: impl }));
  check('o/a recorded as error', r.results[0].outcome === 'error' && /502/.test(r.results[0].detail));
  check('o/b still settled', r.results[1].outcome === 'settled');
}

function testInactiveSpokeIsSkippedWithoutApiCalls() {
  console.log("a spoke whose status isn't 'active' is skipped before any GitHub call");
  const ctx = freshContext();
  const props = makeProps();
  const github = makeSpokeGithub({ 'o/a': 'sha-a1', 'o/b': 'sha-b1' });
  const impl = stubProcess(() => ({ status: 'Queued' }));
  const spokes = [{ tenantId: 't', owner: 'o', repo: 'a', status: 'archived' }, SPOKES[1]];
  const r = ctx.pollSpokes_('debug', baseDeps(github, props, { processRequestImpl: impl, spokesOverride: spokes }));
  check('o/a reported inactive', r.results[0].outcome === 'inactive' && /archived/.test(r.results[0].detail));
  check('no listCommits for o/a', !github.calls.listCommits.includes('o/a'));
}

function testStatusRecordIsWritten() {
  console.log('every run writes SPOKE_POLL_STATUS with the time, mode and per-spoke results');
  const ctx = freshContext();
  const props = makeProps();
  const github = makeSpokeGithub({ 'o/a': 'sha-a1', 'o/b': null });
  const impl = stubProcess(() => ({ status: 'Queued' }));
  ctx.pollSpokes_('refactor', baseDeps(github, props, { processRequestImpl: impl }));
  const rec = JSON.parse(props.getProperty('SPOKE_POLL_STATUS'));
  check('record has the run time', rec.at === '2026-10-31T12:00:00.000Z');
  check('record has the mode', rec.mode === 'refactor');
  check('an empty repo is no-commits', rec.results[1].outcome === 'no-commits');
}

function testUnknownModeThrows() {
  console.log('an unknown mode is a programming error, not a silent no-op');
  const ctx = freshContext();
  let threw = false;
  try { ctx.pollSpokes_('nope', baseDeps(makeSpokeGithub({}), makeProps())); } catch (e) { threw = /Unknown poll mode/.test(e.message); }
  check('throws Unknown poll mode', threw);
}

// End to end through the real processRequest(): a tenant that requires a
// caller key. The poller must supply it - this is the gate every spoke's
// heartbeat failed for six weeks because its copy of the key was never set.
function testEndToEndPassesCallerKeyGate() {
  console.log('end to end with the real processRequest(): the poller passes a required caller key and queues a review');
  const ctx = freshContext();
  const props = makeProps({ TEST_CALLER_KEY: 'k-123' });
  const sheet = makeFakeSheet();
  const spokeGithub = {
    repos: {
      listCommits: () => ({ data: [{ sha: 'sha-real' }] }),
      getContent: ({ path }) => {
        if (path === 'ai_decision_log.json') throw new Error('404 not found');
        return { data: { content: b64(`content of ${path}`) } };
      },
      getCommit: () => ({ data: { files: [{ filename: 'src/x.js', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }] } }),
      createOrUpdateFileContents: () => ({ data: {} })
    },
    issues: { listForRepo: () => ({ data: [] }), create: () => ({ data: { html_url: 'x' } }) }
  };
  const hubGithub = { repos: { getContent: () => { throw new Error('404 not found'); }, createOrUpdateFileContents: () => ({ data: {} }) } };
  const tenants = [{ tenantId: 't', status: 'active', quota: { reviewsPerMonth: null }, callerKeyRef: 'env:TEST_CALLER_KEY' }];
  const r = ctx.pollSpokes_('debug', {
    githubFactory: () => spokeGithub, hubGithub, base64Encode: b64, base64Decode: unb64,
    config: { scriptProperties: props }, props,
    spokesOverride: [SPOKES[0]], tenantsOverride: tenants,
    reviewQueueSheet: sheet, dryRunOverride: true, now: new Date('2026-10-31T12:00:00Z')
  });
  check('settled as Queued', r.results[0].outcome === 'settled' && /Queued/.test(r.results[0].detail));
  check('one ReviewQueue row was written', sheet._rows.length === 1);
  check('the row is for the polled commit', sheet._rows[0][4] === 'sha-real');
  check('the watermark advanced', props.getProperty('SPOKE_POLL_LAST_o/a:debug') === 'sha-real');

  // And the gate is real: send the wrong key through the same path and
  // processRequest() refuses it, which the poller records as a retry.
  const wrongProps = makeProps({ TEST_CALLER_KEY: 'k-123' });
  const r2 = ctx.pollSpokes_('debug', {
    githubFactory: () => spokeGithub, hubGithub, base64Encode: b64, base64Decode: unb64,
    config: { scriptProperties: wrongProps }, props: wrongProps,
    spokesOverride: [SPOKES[0]], tenantsOverride: tenants,
    reviewQueueSheet: makeFakeSheet(), dryRunOverride: true,
    processRequestImpl: (req, deps) => ctx.processRequest({ ...req, callerKey: 'wrong' }, deps)
  });
  check('a wrong key is a retry, not settled', r2.results[0].outcome === 'retry' && /^401/.test(r2.results[0].detail));
}

function testInstallTriggersIsIdempotent() {
  console.log('installSpokePollerTriggers installs the three handlers once and never duplicates them');
  const created = [];
  const builder = (fn) => {
    const b = {
      timeBased: () => b, everyHours: () => b, onWeekDay: () => b, atHour: () => b,
      create: () => { created.push(fn); return { getHandlerFunction: () => fn }; }
    };
    return b;
  };
  const ScriptApp = {
    WeekDay: { WEDNESDAY: 'WED', SUNDAY: 'SUN' },
    newTrigger: (fn) => builder(fn),
    getProjectTriggers: () => created.map((fn) => ({ getHandlerFunction: () => fn }))
  };
  const ctx = freshContext({ ScriptApp });
  const first = ctx.installSpokePollerTriggers();
  check('first run installs three', first.length === 3);
  check('the three handlers', ['pollSpokesDebug', 'pollSpokesHunt', 'pollSpokesRefactor'].every((h) => created.includes(h)));
  const second = ctx.installSpokePollerTriggers();
  check('second run installs none', second.length === 0 && created.length === 3);
}

function testOverlappingRunIsSkipped() {
  console.log('a poll that cannot take the script lock skips instead of overlapping');
  const LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) };
  const ctx = freshContext({ LockService });
  check('returns null without polling', ctx.pollSpokesDebug() === null);
}

testNewCommitQueuedAdvancesWatermark();
testWatermarkIsPerMode();
testAlreadyDecidedSettles();
testUnsettledResultIsRetried();
testNon200IsRetried();
testOneFailingSpokeDoesNotStopTheOthers();
testInactiveSpokeIsSkippedWithoutApiCalls();
testStatusRecordIsWritten();
testUnknownModeThrows();
testEndToEndPassesCallerKeyGate();
testInstallTriggersIsIdempotent();
testOverlappingRunIsSkipped();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
