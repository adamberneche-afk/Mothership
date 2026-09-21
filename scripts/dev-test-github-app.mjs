// Local verification harness for lib/github_app.js.
//
// Uses a real, throwaway RSA keypair generated at test-run time (never a
// committed PEM fixture - that would look like a leaked secret to any
// scanner and IS a real key, unlike a fake token string) so the actual
// JWT-signing path (@octokit/auth-app + universal-github-app-jwt) runs for
// real. Only the network layer is faked, via the `request` injection seam
// @octokit/auth-app already exposes - same dependency-injection convention
// as octokitFactory/fetchImpl everywhere else in this repo.
//
// Usage: node scripts/dev-test-github-app.mjs

import { generateKeyPairSync } from 'crypto';
import {
  mintInstallationToken,
  normalizePrivateKeyPem,
  _clearAppAuthCacheForTests
} from './../lib/github_app.js';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

// --- Fixtures ----------------------------------------------------------------

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// A second, distinct keypair - used to prove a cache entry for one
// (appId, privateKey) pair never leaks into a request using a different
// one (the cross-installation/cross-config leak test).
const { privateKey: otherPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// Matches @octokit/request's callable interface: (route, params) => { data }.
// `responses` maps installation id -> either a fixture object or a function
// returning one, so tests can simulate revoked/suspended/erroring
// installations distinctly per id.
function makeFakeRequest(responses = {}) {
  const calls = [];
  const request = async (route, params) => {
    calls.push({ route, params });
    if (route !== 'POST /app/installations/{installation_id}/access_tokens') {
      throw new Error(`unexpected route in fake: ${route}`);
    }
    const id = String(params.installation_id);
    const fixture = responses[id];
    if (!fixture) {
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    }
    if (typeof fixture === 'function') return fixture();
    return { data: fixture };
  };
  request.calls = calls;
  return request;
}

function tokenFixture(token, expiresInMs = 60 * 60 * 1000, now = Date.now()) {
  return { token, expires_at: new Date(now + expiresInMs).toISOString() };
}

// --- Tests -------------------------------------------------------------------

async function testMintsARealTokenAgainstAFakedNetworkCall() {
  console.log('mintInstallationToken mints via a real JWT signed with the fixture key, verified against the fake network layer');
  _clearAppAuthCacheForTests();
  const request = makeFakeRequest({ '111': tokenFixture('tok-for-111') });
  const token = await mintInstallationToken('111', { appId: 1, privateKey, request });
  check('a token was returned', token === 'tok-for-111');
  check('exactly one network call was made', request.calls.length === 1);
  check('the JWT sent as bearer auth looks like a 3-part token', /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(request.calls[0].params.headers.authorization.replace(/^bearer/i, 'Bearer')));
}

async function testCachesWithinExpiryAndDoesNotReMint() {
  console.log('mintInstallationToken caches within the expiry margin - a second call for the same installation makes no new network call');
  _clearAppAuthCacheForTests();
  const request = makeFakeRequest({ '222': tokenFixture('tok-for-222', 60 * 60 * 1000) });
  const first = await mintInstallationToken('222', { appId: 1, privateKey, request });
  const second = await mintInstallationToken('222', { appId: 1, privateKey, request });
  check('both calls returned the same cached token', first === 'tok-for-222' && second === 'tok-for-222');
  check('only one network call happened - the second was served from cache', request.calls.length === 1);
}

async function testACachedTokenForOneInstallationNeverLeaksToAnother() {
  console.log('a cached token for installation A is never returned for installation B (the cross-installation leak test)');
  _clearAppAuthCacheForTests();
  const request = makeFakeRequest({
    '333': tokenFixture('tok-for-333'),
    '444': tokenFixture('tok-for-444')
  });
  const tokenA = await mintInstallationToken('333', { appId: 1, privateKey, request });
  const tokenB = await mintInstallationToken('444', { appId: 1, privateKey, request });
  check('installation 333 got its own token', tokenA === 'tok-for-333');
  check('installation 444 got its own, different token', tokenB === 'tok-for-444');
  check('two separate network calls happened, one per installation', request.calls.length === 2);
}

async function testACachedTokenNeverLeaksAcrossDifferentAppCredentials() {
  console.log('a cached token minted under one (appId, privateKey) pair is never returned for a different pair, even for the same installation id');
  _clearAppAuthCacheForTests();
  const requestA = makeFakeRequest({ '555': tokenFixture('tok-app-A') });
  const requestB = makeFakeRequest({ '555': tokenFixture('tok-app-B') });
  const tokenA = await mintInstallationToken('555', { appId: 1, privateKey, request: requestA });
  const tokenB = await mintInstallationToken('555', { appId: 2, privateKey: otherPrivateKey, request: requestB });
  check('the first app credential minted its own token', tokenA === 'tok-app-A');
  check('the second, distinct app credential minted its own token, not a cached one from the first', tokenB === 'tok-app-B');
}

async function testMalformedInstallationIdNeverCallsTheNetwork() {
  console.log('a malformed installation id is rejected before any network call - zero fetch calls');
  _clearAppAuthCacheForTests();
  const request = makeFakeRequest({});
  const results = await Promise.all([
    mintInstallationToken('not-a-number', { appId: 1, privateKey, request }),
    mintInstallationToken('', { appId: 1, privateKey, request }),
    mintInstallationToken(null, { appId: 1, privateKey, request }),
    mintInstallationToken('0', { appId: 1, privateKey, request })
  ]);
  check('every malformed id resolved to null', results.every((r) => r === null));
  check('zero network calls were made', request.calls.length === 0);
}

async function testMissingAppConfigNeverCallsTheNetwork() {
  console.log('missing appId or privateKey resolves to null without any network call');
  _clearAppAuthCacheForTests();
  const request = makeFakeRequest({ '666': tokenFixture('should-never-be-returned') });
  const noAppId = await mintInstallationToken('666', { appId: undefined, privateKey, request });
  const noKey = await mintInstallationToken('666', { appId: 1, privateKey: undefined, request });
  check('missing appId resolves to null', noAppId === null);
  check('missing privateKey resolves to null', noKey === null);
  check('zero network calls were made for either case', request.calls.length === 0);
}

async function testMalformedPrivateKeyResolvesToNullNeverThrows() {
  console.log('a malformed private key resolves to null, never throws, and never reaches the network');
  _clearAppAuthCacheForTests();
  const request = makeFakeRequest({ '777': tokenFixture('should-never-be-returned') });
  let threw = false;
  let result;
  try {
    result = await mintInstallationToken('777', { appId: 1, privateKey: 'not a real pem at all', request });
  } catch (e) {
    threw = true;
  }
  check('did not throw', threw === false);
  check('resolved to null', result === null);
  check('zero network calls were made', request.calls.length === 0);
}

async function testRevokedOrUninstalledInstallationResolvesToNullNeverThrows() {
  console.log('a revoked/uninstalled installation (404 from GitHub) resolves to null, never throws, never falls back to anything');
  _clearAppAuthCacheForTests();
  const request = makeFakeRequest({}); // no fixture for '888' -> fake throws a 404
  let threw = false;
  let result;
  try {
    result = await mintInstallationToken('888', { appId: 1, privateKey, request });
  } catch (e) {
    threw = true;
  }
  check('did not throw', threw === false);
  check('resolved to null', result === null);
}

async function testGithubUnreachableResolvesToNullNeverThrows() {
  console.log('GitHub unreachable (network error, no .status) resolves to null, never throws');
  _clearAppAuthCacheForTests();
  const request = async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); };
  let threw = false;
  let result;
  try {
    result = await mintInstallationToken('999', { appId: 1, privateKey, request });
  } catch (e) {
    threw = true;
  }
  check('did not throw', threw === false);
  check('resolved to null', result === null);
}

function testNormalizePrivateKeyPemUnescapesLiteralBackslashN() {
  console.log('normalizePrivateKeyPem converts \\n-escaped PEM (common env-var mangling) into real newlines');
  const escaped = privateKey.replace(/\n/g, '\\n');
  check('the escaped fixture actually contains literal backslash-n (sanity check on the fixture itself)', escaped.includes('\\n') && !escaped.includes('\n'));
  const normalized = normalizePrivateKeyPem(escaped);
  check('normalization recovers the original real-newline PEM', normalized === privateKey);
}

function testNormalizePrivateKeyPemPassesThroughAlreadyRealNewlines() {
  console.log('normalizePrivateKeyPem leaves an already-correct, real-newline PEM unchanged');
  check('unchanged', normalizePrivateKeyPem(privateKey) === privateKey);
}

function testNormalizePrivateKeyPemRejectsGarbageWithoutThrowing() {
  console.log('normalizePrivateKeyPem rejects malformed/truncated input without throwing');
  check('empty string -> null', normalizePrivateKeyPem('') === null);
  check('undefined -> null', normalizePrivateKeyPem(undefined) === null);
  check('non-string -> null', normalizePrivateKeyPem(12345) === null);
  check('random text -> null', normalizePrivateKeyPem('just some random text, not a PEM at all') === null);
  check('truncated PEM (no END marker) -> null', normalizePrivateKeyPem('-----BEGIN PRIVATE KEY-----\nMIIEvQ==') === null);
}

async function main() {
  await testMintsARealTokenAgainstAFakedNetworkCall();
  await testCachesWithinExpiryAndDoesNotReMint();
  await testACachedTokenForOneInstallationNeverLeaksToAnother();
  await testACachedTokenNeverLeaksAcrossDifferentAppCredentials();
  await testMalformedInstallationIdNeverCallsTheNetwork();
  await testMissingAppConfigNeverCallsTheNetwork();
  await testMalformedPrivateKeyResolvesToNullNeverThrows();
  await testRevokedOrUninstalledInstallationResolvesToNullNeverThrows();
  await testGithubUnreachableResolvesToNullNeverThrows();
  testNormalizePrivateKeyPemUnescapesLiteralBackslashN();
  testNormalizePrivateKeyPemPassesThroughAlreadyRealNewlines();
  testNormalizePrivateKeyPemRejectsGarbageWithoutThrowing();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
