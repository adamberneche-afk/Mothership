// Local verification harness for api/health.js's buildHealthResponse - the
// smoke-test target for the new deploy-vercel.yml CD pipeline.
//
// Usage: node scripts/dev-test-health.mjs

import { buildHealthResponse } from './../api/health.js';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

function testAlwaysReportsStatusOk() {
  console.log('buildHealthResponse always reports status: ok - it has no external calls that could fail');
  const result = buildHealthResponse({ now: 1_700_000_000_000, env: {} });
  check('status is ok', result.status === 'ok');
}

function testTimestampReflectsTheInjectedNow() {
  console.log('the timestamp is a real ISO string derived from the injected `now`, not a frozen constant');
  const result = buildHealthResponse({ now: 1_700_000_000_000, env: {} });
  check('timestamp matches', result.timestamp === new Date(1_700_000_000_000).toISOString());
}

function testCommitReflectsVercelGitCommitShaWhenSet() {
  console.log('commit reflects VERCEL_GIT_COMMIT_SHA when Vercel has set it - lets a smoke test confirm the EXPECTED commit actually deployed, not just that something answered');
  const result = buildHealthResponse({ now: 1_700_000_000_000, env: { VERCEL_GIT_COMMIT_SHA: 'abc1234' } });
  check('commit is the real sha', result.commit === 'abc1234');
}

function testCommitIsNullWhenUnset() {
  console.log('commit is null (not undefined, not a fabricated value) when VERCEL_GIT_COMMIT_SHA is unset - e.g. a local run outside Vercel');
  const result = buildHealthResponse({ now: 1_700_000_000_000, env: {} });
  check('commit is null', result.commit === null);
}

async function main() {
  testAlwaysReportsStatusOk();
  testTimestampReflectsTheInjectedNow();
  testCommitReflectsVercelGitCommitShaWhenSet();
  testCommitIsNullWhenUnset();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
