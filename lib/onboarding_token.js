// HMAC-signed, short-lived tokens carrying onboarding state between hops of
// the self-service flow (api/onboard_start.js -> GitHub's install redirect
// -> api/github_app_callback.js -> Stripe Checkout -> api/stripe_webhook.js).
//
// Why a signed token instead of a server-side pending-state record: two
// independent signals (GitHub App install, Stripe payment) can otherwise
// arrive in either order, which would normally need a committed
// pending-state file to reconcile them - but Mothership is a PUBLIC repo,
// and a file tying installation IDs to Stripe customer IDs together would
// be a real, avoidable data-exposure surface in permanent git history.
// This flow sidesteps that entirely by enforcing a strict sequence (App
// install completes and is independently re-verified BEFORE a Stripe
// Checkout link is even generated - see api/github_app_callback.js) and
// carrying the confirmed installation identity forward in a signed token
// instead of a database row. No server-side state, nothing to leak,
// nothing to prune.
//
// Security properties, each defending a specific threat:
//   - HMAC-SHA256 over the payload, using a secret only this deployment
//     holds (ONBOARDING_STATE_SECRET) - an attacker without the secret
//     cannot forge a token that verifies, closing the "craft a URL with an
//     arbitrary installation_id/state directly" hijack.
//   - Signature compared via crypto.timingSafeEqual, never `===` - a
//     naive string comparison leaks how many leading bytes matched via
//     response-time differences, letting an attacker guess the signature
//     one byte at a time; timingSafeEqual takes constant time regardless
//     of where the mismatch is.
//   - A short TTL (iat + a few minutes) - a leaked or logged token stops
//     being useful on its own well before anyone could act on it.

import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

function requireSecret() {
  const secret = process.env.ONBOARDING_STATE_SECRET;
  if (!secret) {
    // Fail closed, never sign/verify with an empty or default secret - an
    // unset secret must break onboarding loudly, not silently accept
    // anything.
    throw new Error('ONBOARDING_STATE_SECRET is not configured');
  }
  return secret;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Signs a plain JSON-serializable payload, stamping it with `iat` (unless
// already present - tests can inject a fixed `now`). Returns a
// `<payload>.<signature>` string, both base64url-encoded.
export function signOnboardingToken(payload, { now = Date.now() } = {}) {
  const secret = requireSecret();
  const fullPayload = { iat: now, ...payload };
  const encodedPayload = base64url(JSON.stringify(fullPayload));
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

// Verifies a token produced by signOnboardingToken. Returns the decoded
// payload on success, or null on ANY failure - wrong/missing secret,
// tampered signature, malformed structure, unparseable payload, or an
// expired `iat`. Never throws for a bad TOKEN (only requireSecret's
// missing-config case throws, since that's an environment misconfiguration,
// not attacker input) and deliberately gives the same "invalid" outcome
// for every failure reason, so a caller can't use timing or error detail
// to fingerprint which check failed.
export function verifyOnboardingToken(token, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const secret = requireSecret();
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const lastDot = token.lastIndexOf('.');
  const encodedPayload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);
  if (!encodedPayload || !signature) return null;

  const expectedSignature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  const signatureBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  // Length must match before timingSafeEqual - it throws on mismatched
  // lengths rather than comparing, so this check is required, not
  // optional, and itself leaks nothing useful (an attacker can already see
  // valid tokens' overall shape).
  if (signatureBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(signatureBuf, expectedBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.iat !== 'number') return null;
  if (now - payload.iat > ttlMs || now < payload.iat) return null; // expired, or iat in the future (clock skew/tamper)
  return payload;
}
