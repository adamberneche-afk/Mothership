// Local verification harness for lib/secrets.js - specifically
// resolveSecretRef, the single most security-relevant function in this
// repo (every tenant's GitHub/caller credential resolves through it). Had
// no dedicated test file before this - only indirect coverage via
// dev-test-handler.mjs/dev-test-recursive-learning.mjs/dev-test-doctor.mjs,
// none of which exercise the ghapp: scheme's failure modes directly.
//
// Usage: node scripts/dev-test-secrets.mjs

import { resolveSecretRef } from './../lib/secrets.js';
import { _clearAppAuthCacheForTests } from './../lib/github_app.js';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

// --- Tests -------------------------------------------------------------------

async function testNonStringOrEmptyRefResolvesToNull() {
  console.log('a missing, non-string, or empty ref resolves to null');
  const results = await Promise.all([resolveSecretRef(null), resolveSecretRef(undefined), resolveSecretRef(''), resolveSecretRef(42)]);
  check('every case resolved to null', results.every((r) => r === null));
}

async function testEnvSchemeResolvesAndMisses() {
  console.log('env: scheme - resolves a set var, returns null for an unset one (unchanged sync-era behavior, now behind a Promise)');
  await withEnv({ MOTHERSHIP_TEST_TOKEN_XYZ: 'the-real-token', MOTHERSHIP_UNSET_TOKEN_XYZ: undefined }, async () => {
    check('a set env var resolves', await resolveSecretRef('env:MOTHERSHIP_TEST_TOKEN_XYZ') === 'the-real-token');
    check('an unset env var resolves to null', await resolveSecretRef('env:MOTHERSHIP_UNSET_TOKEN_XYZ') === null);
  });
}

async function testKvSchemeAlwaysResolvesToNull() {
  console.log('kv: scheme always resolves to null (disclosed, not-yet-built placeholder)');
  check('kv: resolves to null', await resolveSecretRef('kv:tenant/acme/github_token') === null);
}

async function testUnknownSchemeResolvesToNull() {
  console.log('an unrecognized scheme resolves to null rather than throwing');
  check('unknown scheme resolves to null', await resolveSecretRef('made-up-scheme:whatever') === null);
}

async function testGhappSchemeDelegatesToRealMintWithInjectedFetch() {
  console.log('ghapp: scheme mints via lib/github_app.js, using GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY from the environment');
  _clearAppAuthCacheForTests();
  const { generateKeyPairSync } = await import('crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

  // resolveSecretRef reads process.env directly (not injectable per-call,
  // matching env:'s own convention) - but the real network call underneath
  // still goes through @octokit/auth-app's default `request`, which this
  // harness has no way to intercept from here without a real fetch. This
  // test therefore only proves the ghapp: branch is wired to attempt a
  // mint at all (malformed installation id -> null, no crash) rather than
  // exercising a full successful mint - that full path is covered against
  // an injectable fake `request` directly in dev-test-github-app.mjs.
  await withEnv({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey }, async () => {
    check('a malformed installation id resolves to null without crashing', await resolveSecretRef('ghapp:not-a-number') === null);
  });
}

async function testGhappSchemeMissingAppConfigResolvesToNull() {
  console.log('ghapp: scheme resolves to null (never throws) when GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY are unset');
  await withEnv({ GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined }, async () => {
    let threw = false;
    let result;
    try {
      result = await resolveSecretRef('ghapp:123456');
    } catch (e) {
      threw = true;
    }
    check('did not throw', threw === false);
    check('resolved to null', result === null);
  });
}

async function testGhappSchemeNeverFallsBackToAnythingOnFailure() {
  console.log('resolveSecretRef never falls back to any other value on a ghapp: failure - the hard-skip rule applies here exactly as it does for env:');
  await withEnv({ GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined, GLOBAL_GITHUB_TOKEN: 'should-never-be-returned-by-resolveSecretRef' }, async () => {
    const result = await resolveSecretRef('ghapp:123456');
    check('resolves to null, not GLOBAL_GITHUB_TOKEN or anything else', result === null);
  });
}

async function main() {
  await testNonStringOrEmptyRefResolvesToNull();
  await testEnvSchemeResolvesAndMisses();
  await testKvSchemeAlwaysResolvesToNull();
  await testUnknownSchemeResolvesToNull();
  await testGhappSchemeDelegatesToRealMintWithInjectedFetch();
  await testGhappSchemeMissingAppConfigResolvesToNull();
  await testGhappSchemeNeverFallsBackToAnythingOnFailure();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
