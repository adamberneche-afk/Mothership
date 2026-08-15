// Local verification harness for scripts/smoke-test.js - the post-deploy
// health check both new CD pipelines (deploy-vercel.yml/
// deploy-apps-script.yml) run before considering a deploy successful.
//
// Usage: node scripts/dev-test-smoke-test.mjs

import { checkHealth, checkHealthWithRetry } from './smoke-test.js';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

function makeFakeFetch(behavior) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return behavior(calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// --- checkHealth (single attempt) -------------------------------------------

async function testHealthyResponseIsOk() {
  console.log('a real {status: "ok"} response is reported healthy');
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { status: 'ok', timestamp: 'x' }));
  const result = await checkHealth('https://example.com/api/health', { fetchImpl });
  check('ok', result.ok === true);
}

async function testNon2xxIsUnhealthy() {
  console.log('a non-2xx HTTP status is reported unhealthy, naming the status code');
  const fetchImpl = makeFakeFetch(() => jsonResponse(500, {}));
  const result = await checkHealth('https://example.com/api/health', { fetchImpl });
  check('not ok', result.ok === false);
  check('names the status', result.reason === 'HTTP 500');
}

async function testMalformedJsonIsUnhealthy() {
  console.log('a response that is not valid JSON is reported unhealthy, not thrown');
  const fetchImpl = makeFakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); } }));
  const result = await checkHealth('https://example.com/api/health', { fetchImpl });
  check('not ok', result.ok === false);
  check('names the real problem', /not valid JSON/.test(result.reason));
}

async function testWrongStatusFieldIsUnhealthy() {
  console.log('a well-formed JSON body that lacks status: "ok" is reported unhealthy');
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { status: 'degraded' }));
  const result = await checkHealth('https://example.com/api/health', { fetchImpl });
  check('not ok', result.ok === false);
  check('quotes the actual body', /degraded/.test(result.reason));
}

async function testTimeoutIsUnhealthyNotThrown() {
  console.log('a fetch that never resolves is reported unhealthy as a timeout once the timeout elapses, never thrown');
  const fetchImpl = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const result = await checkHealth('https://example.com/api/health', { fetchImpl, timeoutMs: 20 });
  check('not ok', result.ok === false);
  check('names it as a timeout', /timed out/.test(result.reason));
}

async function testNetworkErrorIsUnhealthyNotThrown() {
  console.log('a genuine network error (DNS failure, connection refused) is reported unhealthy, never thrown');
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  let threw = false;
  let result;
  try {
    result = await checkHealth('https://example.com/api/health', { fetchImpl });
  } catch (e) {
    threw = true;
  }
  check('did not throw', threw === false);
  check('not ok', result && result.ok === false);
}

async function testCommitMatchIsOk() {
  console.log('when the deployed commit matches what was expected, the check passes');
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { status: 'ok', commit: 'abc1234' }));
  const result = await checkHealth('https://example.com/api/health', { fetchImpl, expectedCommit: 'abc1234' });
  check('ok', result.ok === true);
}

async function testCommitMismatchIsUnhealthy() {
  console.log('when the deployed commit does NOT match what was expected, the check fails - the deploy may not have shipped the new code');
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { status: 'ok', commit: 'old-sha' }));
  const result = await checkHealth('https://example.com/api/health', { fetchImpl, expectedCommit: 'new-sha' });
  check('not ok', result.ok === false);
  check('names both commits', /old-sha/.test(result.reason) && /new-sha/.test(result.reason));
}

async function testNoCommitFieldIsIgnoredWhenNotApplicable() {
  console.log("Apps Script's health response has no commit field at all - the commit check is skipped entirely, not treated as a mismatch (a real, disclosed platform difference)");
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { status: 'ok' }));
  const result = await checkHealth('https://example.com/health', { fetchImpl, expectedCommit: 'abc1234' });
  check('still ok - no commit field to compare against', result.ok === true);
}

async function testHeadersAreForwardedWhenSupplied() {
  console.log('an optional headers object (e.g. the Vercel Deployment Protection bypass header) is forwarded to fetchImpl');
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { status: 'ok' }));
  await checkHealth('https://example.com/api/health', { fetchImpl, headers: { 'x-vercel-protection-bypass': 'secret-token' } });
  check('fetch received the header', fetchImpl.calls[0].options.headers?.['x-vercel-protection-bypass'] === 'secret-token');
}

async function testNoHeadersOptionMeansNoHeadersSent() {
  console.log('omitting headers entirely does not inject an empty object where a caller might not expect one');
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { status: 'ok' }));
  await checkHealth('https://example.com/api/health', { fetchImpl });
  check('headers is undefined, not an empty object', fetchImpl.calls[0].options.headers === undefined);
}

// --- checkHealthWithRetry ----------------------------------------------------

async function testRetrySucceedsOnFirstAttemptWithoutSleeping() {
  console.log('checkHealthWithRetry never sleeps or retries when the first attempt already succeeds');
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { status: 'ok' }));
  let sleptCalls = 0;
  const result = await checkHealthWithRetry('https://example.com/health', { fetchImpl, sleepImpl: async () => { sleptCalls++; } });
  check('ok', result.ok === true);
  check('called fetch exactly once', fetchImpl.calls.length === 1);
  check('never slept', sleptCalls === 0);
}

async function testRetryRecoversAfterTransientFailures() {
  console.log('checkHealthWithRetry recovers if a later attempt succeeds after earlier ones failed (transient propagation lag)');
  const fetchImpl = makeFakeFetch((callNumber) => (callNumber < 3 ? jsonResponse(503, {}) : jsonResponse(200, { status: 'ok' })));
  const result = await checkHealthWithRetry('https://example.com/health', { fetchImpl, maxAttempts: 3, sleepImpl: async () => {} });
  check('eventually ok', result.ok === true);
  check('took exactly 3 attempts', fetchImpl.calls.length === 3);
}

async function testRetryGivesUpAfterMaxAttempts() {
  console.log('checkHealthWithRetry gives up and reports the last failure after maxAttempts, rather than retrying forever');
  const fetchImpl = makeFakeFetch(() => jsonResponse(500, {}));
  let sleptCalls = 0;
  const result = await checkHealthWithRetry('https://example.com/health', { fetchImpl, maxAttempts: 3, sleepImpl: async () => { sleptCalls++; } });
  check('still not ok', result.ok === false);
  check('made exactly 3 attempts', fetchImpl.calls.length === 3);
  check('slept between attempts, not after the last one (2 sleeps for 3 attempts)', sleptCalls === 2);
}

async function main() {
  await testHealthyResponseIsOk();
  await testNon2xxIsUnhealthy();
  await testMalformedJsonIsUnhealthy();
  await testWrongStatusFieldIsUnhealthy();
  await testTimeoutIsUnhealthyNotThrown();
  await testNetworkErrorIsUnhealthyNotThrown();
  await testCommitMatchIsOk();
  await testCommitMismatchIsUnhealthy();
  await testNoCommitFieldIsIgnoredWhenNotApplicable();
  await testHeadersAreForwardedWhenSupplied();
  await testNoHeadersOptionMeansNoHeadersSent();
  await testRetrySucceedsOnFirstAttemptWithoutSleeping();
  await testRetryRecoversAfterTransientFailures();
  await testRetryGivesUpAfterMaxAttempts();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
