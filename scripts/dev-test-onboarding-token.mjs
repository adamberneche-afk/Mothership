// Local verification harness for lib/onboarding_token.js - the signed
// state-token helper carrying identity between hops of the self-service
// onboarding flow. This is the CSRF/replay defense for a session-less GET
// redirect chain, so its adversarial coverage matters more than most.
//
// Usage: node scripts/dev-test-onboarding-token.mjs

import { signOnboardingToken, verifyOnboardingToken } from './../lib/onboarding_token.js';

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

function testAcceptsATokenItJustSigned() {
  console.log('verifyOnboardingToken accepts a token this process itself just signed, with the right payload intact');
  process.env.ONBOARDING_STATE_SECRET = 'test-secret-1';
  const token = signOnboardingToken({ onboardingId: 'ob-123', installationId: '456' });
  const payload = verifyOnboardingToken(token);
  check('verification succeeds', payload !== null);
  check('the payload round-trips correctly', payload.onboardingId === 'ob-123' && payload.installationId === '456');
  check('iat was stamped automatically', typeof payload.iat === 'number');
  delete process.env.ONBOARDING_STATE_SECRET;
}

function testRejectsATokenSignedWithADifferentSecret() {
  console.log('verifyOnboardingToken rejects a token signed with a different secret (simulates an attacker who does not have ONBOARDING_STATE_SECRET)');
  process.env.ONBOARDING_STATE_SECRET = 'secret-A';
  const token = signOnboardingToken({ onboardingId: 'ob-1' });
  process.env.ONBOARDING_STATE_SECRET = 'secret-B';
  const payload = verifyOnboardingToken(token);
  check('verification fails', payload === null);
  delete process.env.ONBOARDING_STATE_SECRET;
}

function testRejectsATokenWithASingleFlippedSignatureByte() {
  console.log('verifyOnboardingToken rejects a token with one byte of its signature flipped (a real tamper test, not just wrong-secret)');
  process.env.ONBOARDING_STATE_SECRET = 'test-secret-2';
  const token = signOnboardingToken({ onboardingId: 'ob-1' });
  const lastDot = token.lastIndexOf('.');
  const payload = token.slice(0, lastDot);
  let signature = token.slice(lastDot + 1);
  // Flip the first character to something else, preserving length.
  const flippedChar = signature[0] === 'a' ? 'b' : 'a';
  signature = flippedChar + signature.slice(1);
  const tampered = `${payload}.${signature}`;
  check('a single flipped signature byte is rejected', verifyOnboardingToken(tampered) === null);
  delete process.env.ONBOARDING_STATE_SECRET;
}

function testRejectsATokenWithATamperedPayload() {
  console.log('verifyOnboardingToken rejects a token whose payload was swapped for a different, still-validly-encoded one (signature no longer matches)');
  process.env.ONBOARDING_STATE_SECRET = 'test-secret-3';
  const tokenA = signOnboardingToken({ onboardingId: 'victim-installation' });
  const tokenB = signOnboardingToken({ onboardingId: 'attacker-installation' });
  const [, sigA] = tokenA.split('.');
  const [payloadB] = tokenB.split('.');
  const frankenToken = `${payloadB}.${sigA}`; // attacker's payload + victim's signature
  check('a mismatched payload/signature pairing is rejected', verifyOnboardingToken(frankenToken) === null);
  delete process.env.ONBOARDING_STATE_SECRET;
}

function testRejectsAnExpiredToken() {
  console.log('verifyOnboardingToken rejects a token older than the TTL (replay-window test)');
  process.env.ONBOARDING_STATE_SECRET = 'test-secret-4';
  const mintedAt = 1_000_000;
  const token = signOnboardingToken({ onboardingId: 'ob-1' }, { now: mintedAt });
  const stillValid = verifyOnboardingToken(token, { now: mintedAt + 10 * 60 * 1000, ttlMs: 30 * 60 * 1000 });
  const expired = verifyOnboardingToken(token, { now: mintedAt + 31 * 60 * 1000, ttlMs: 30 * 60 * 1000 });
  check('still within TTL verifies fine', stillValid !== null);
  check('past the TTL is rejected', expired === null);
  delete process.env.ONBOARDING_STATE_SECRET;
}

function testRejectsATokenFromTheFuture() {
  console.log('verifyOnboardingToken rejects a token whose iat is in the future (clock skew or tamper)');
  process.env.ONBOARDING_STATE_SECRET = 'test-secret-5';
  const token = signOnboardingToken({ onboardingId: 'ob-1' }, { now: 2_000_000 });
  check('a token minted "in the future" relative to verification time is rejected', verifyOnboardingToken(token, { now: 1_000_000 }) === null);
  delete process.env.ONBOARDING_STATE_SECRET;
}

function testNeverThrowsOnGarbageInput() {
  console.log('verifyOnboardingToken never throws on malformed/garbage input - always resolves to null');
  process.env.ONBOARDING_STATE_SECRET = 'test-secret-6';
  const garbageInputs = [null, undefined, '', 'not-a-token-at-all', 'no-dot-in-here', '.', 'a.', '.b', 42, {}, []];
  let threw = false;
  const results = [];
  for (const input of garbageInputs) {
    try {
      results.push(verifyOnboardingToken(input));
    } catch (e) {
      threw = true;
    }
  }
  check('none of the garbage inputs threw', threw === false);
  check('every garbage input resolved to null', results.every((r) => r === null));
  delete process.env.ONBOARDING_STATE_SECRET;
}

function testMissingSecretThrowsLoudlyRatherThanSigningOrVerifyingWithNothing() {
  console.log('a missing ONBOARDING_STATE_SECRET is a loud configuration error (throws), never a silent "sign/verify with an empty secret"');
  delete process.env.ONBOARDING_STATE_SECRET;
  let signThrew = false;
  try {
    signOnboardingToken({ onboardingId: 'ob-1' });
  } catch (e) {
    signThrew = true;
  }
  check('signOnboardingToken throws when the secret is unset', signThrew === true);

  let verifyThrew = false;
  try {
    verifyOnboardingToken('anything.anything');
  } catch (e) {
    verifyThrew = true;
  }
  check('verifyOnboardingToken throws when the secret is unset (an environment problem, not attacker input)', verifyThrew === true);
}

async function main() {
  testAcceptsATokenItJustSigned();
  testRejectsATokenSignedWithADifferentSecret();
  testRejectsATokenWithASingleFlippedSignatureByte();
  testRejectsATokenWithATamperedPayload();
  testRejectsAnExpiredToken();
  testRejectsATokenFromTheFuture();
  testNeverThrowsOnGarbageInput();
  testMissingSecretThrowsLoudlyRatherThanSigningOrVerifyingWithNothing();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
