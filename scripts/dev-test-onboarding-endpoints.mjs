// Local verification harness for api/onboard_start.js and
// api/github_app_callback.js's core functions - driven directly, never
// through `handler`/`res`, same convention as every other dev-test-*.mjs
// harness in this repo.
//
// Usage: node scripts/dev-test-onboarding-endpoints.mjs

import { generateKeyPairSync } from 'crypto';
import { buildInstallRedirect } from './../api/onboard_start.js';
import { handleInstallCallback } from './../api/github_app_callback.js';
import { verifyOnboardingToken, signOnboardingToken } from './../lib/onboarding_token.js';
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

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

// --- Fakes -------------------------------------------------------------------

// Matches @octokit/auth-app's callable request interface - never invoked
// in these tests (confirmInstallationExists talks to GitHub via a plain
// fetchImpl instead), included only so a stray call is loud, not silent.
function makeFakeFetch({ installationsById = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const match = url.match(/\/app\/installations\/(\d+)$/);
    if (match) {
      const fixture = installationsById[match[1]];
      if (!fixture) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => fixture };
    }
    throw new Error(`unexpected fetch in fake: ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// --- Tests: api/onboard_start.js --------------------------------------------

function testBuildInstallRedirectProducesAValidSignedStateToken() {
  console.log('buildInstallRedirect produces a 302 to GitHub\'s install picker, with a signed, verifiable state token');
  process.env.ONBOARDING_STATE_SECRET = 'onboard-start-test-secret';
  const result = buildInstallRedirect({ generateId: () => 'fixed-onboarding-id', env: { GITHUB_APP_SLUG: 'mothership-test-app' } });
  check('returns a 302', result.httpStatus === 302);
  check('redirects to the right GitHub App slug\'s install picker', result.redirectUrl.startsWith('https://github.com/apps/mothership-test-app/installations/new?state='));
  const stateParam = new URL(result.redirectUrl).searchParams.get('state');
  const claims = verifyOnboardingToken(stateParam);
  check('the state token verifies and carries the onboardingId', claims && claims.onboardingId === 'fixed-onboarding-id');
  delete process.env.ONBOARDING_STATE_SECRET;
}

function testBuildInstallRedirectFailsClosedWithoutAppSlugConfigured() {
  console.log('buildInstallRedirect fails closed (does not redirect anywhere) if GITHUB_APP_SLUG is not configured');
  process.env.ONBOARDING_STATE_SECRET = 'onboard-start-test-secret-2';
  const result = buildInstallRedirect({ env: {} });
  check('returns a 500, not a 302 to a broken URL', result.httpStatus === 500);
  delete process.env.ONBOARDING_STATE_SECRET;
}

const TEST_PLANS = [
  { planId: 'starter', name: 'Starter', stripePriceId: 'price_starter', stripePaymentLinkUrl: 'https://buy.stripe.com/starter', reviewsPerMonth: 50 },
  { planId: 'pro', name: 'Pro', stripePriceId: 'price_pro', stripePaymentLinkUrl: 'https://buy.stripe.com/pro', reviewsPerMonth: null }
];

function testBuildInstallRedirectCarriesAKnownPlanIdIntoTheStateToken() {
  console.log('buildInstallRedirect encodes a valid ?plan= into the signed state token');
  process.env.ONBOARDING_STATE_SECRET = 'onboard-start-plan-test';
  const result = buildInstallRedirect({ generateId: () => 'fixed-id', env: { GITHUB_APP_SLUG: 'mothership-test-app' }, query: { plan: 'pro' }, plans: TEST_PLANS });
  check('returns a 302', result.httpStatus === 302);
  const stateParam = new URL(result.redirectUrl).searchParams.get('state');
  const claims = verifyOnboardingToken(stateParam);
  check('the state token carries the requested planId', claims && claims.planId === 'pro');
  delete process.env.ONBOARDING_STATE_SECRET;
}

function testBuildInstallRedirectRejectsAnUnknownPlan() {
  console.log('buildInstallRedirect rejects an unrecognized ?plan= rather than silently ignoring or defaulting it');
  process.env.ONBOARDING_STATE_SECRET = 'onboard-start-unknown-plan-test';
  const result = buildInstallRedirect({ env: { GITHUB_APP_SLUG: 'mothership-test-app' }, query: { plan: 'not-a-real-plan' }, plans: TEST_PLANS });
  check('returns a 400, not a redirect', result.httpStatus === 400);
  delete process.env.ONBOARDING_STATE_SECRET;
}

function testBuildInstallRedirectWithNoPlanOmitsPlanIdEntirely() {
  console.log('buildInstallRedirect with no ?plan= at all carries no planId (backward-compatible, single-Payment-Link path)');
  process.env.ONBOARDING_STATE_SECRET = 'onboard-start-no-plan-test';
  const result = buildInstallRedirect({ env: { GITHUB_APP_SLUG: 'mothership-test-app' }, plans: TEST_PLANS });
  const stateParam = new URL(result.redirectUrl).searchParams.get('state');
  const claims = verifyOnboardingToken(stateParam);
  check('no planId is present on the claims', !('planId' in claims));
  delete process.env.ONBOARDING_STATE_SECRET;
}

// --- Tests: api/github_app_callback.js --------------------------------------

async function testRejectsACraftedInstallationIdWithAForgedOrAbsentState() {
  console.log('handleInstallCallback rejects a crafted URL with an attacker-supplied installation_id and a forged/absent state - the core hijack scenario');
  process.env.ONBOARDING_STATE_SECRET = 'callback-test-hijack';
  const fetchImpl = makeFakeFetch({ installationsById: { '999': { account: { login: 'victim-org' } } } });
  const env = { GITHUB_APP_ID: 1, GITHUB_APP_PRIVATE_KEY: privateKey, STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test', ONBOARDING_FAILURE_URL: '/failed' };

  const absentState = await handleInstallCallback({ installation_id: '999', setup_action: 'install' }, { fetchImpl, env });
  const forgedState = await handleInstallCallback({ installation_id: '999', setup_action: 'install', state: 'not-a-real-token.fake-signature' }, { fetchImpl, env });

  check('absent state is rejected (redirected to the failure page)', absentState.redirectUrl === '/failed');
  check('forged state is rejected (redirected to the failure page)', forgedState.redirectUrl === '/failed');
  check('confirmInstallationExists was never even called for either rejection', fetchImpl.calls.length === 0);
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testRejectsAWellFormedButExpiredStateEvenWithARealInstallationId() {
  console.log('handleInstallCallback rejects a well-formed but expired state token even with a real installation_id');
  process.env.ONBOARDING_STATE_SECRET = 'callback-test-expired';
  const fetchImpl = makeFakeFetch({ installationsById: { '111': { account: { login: 'acme-org' } } } });
  const env = { GITHUB_APP_ID: 1, GITHUB_APP_PRIVATE_KEY: privateKey, STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test', ONBOARDING_FAILURE_URL: '/failed' };
  const now = 10_000_000;
  const state = signOnboardingToken({ onboardingId: 'ob-1' }, { now });
  const result = await handleInstallCallback({ installation_id: '111', setup_action: 'install', state }, { fetchImpl, env, now: now + 31 * 60 * 1000 });
  check('rejected', result.redirectUrl === '/failed');
  check('never reached GitHub (fails closed on the state check first)', fetchImpl.calls.length === 0);
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testFailsClosedWhenGithubReConfirmationErrors() {
  console.log('handleInstallCallback fails closed (does not proceed to Stripe) when GET /app/installations/{id} itself errors - e.g. revoked immediately after install');
  process.env.ONBOARDING_STATE_SECRET = 'callback-test-revoked';
  const fetchImpl = makeFakeFetch({ installationsById: {} }); // no fixture -> 404 for any id
  const env = { GITHUB_APP_ID: 1, GITHUB_APP_PRIVATE_KEY: privateKey, STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test', ONBOARDING_FAILURE_URL: '/failed' };
  const state = signOnboardingToken({ onboardingId: 'ob-2' });
  const result = await handleInstallCallback({ installation_id: '222', setup_action: 'install', state }, { fetchImpl, env });
  check('rejected, never redirected to Stripe', result.redirectUrl === '/failed');
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testSetupActionRequestIsPendingApprovalNotAFailure() {
  console.log('handleInstallCallback does not proceed to the Stripe redirect when setup_action is "request" (pending org-owner approval) - a distinct, non-error outcome');
  process.env.ONBOARDING_STATE_SECRET = 'callback-test-pending';
  const fetchImpl = makeFakeFetch({});
  const env = { GITHUB_APP_ID: 1, GITHUB_APP_PRIVATE_KEY: privateKey, STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test', ONBOARDING_PENDING_APPROVAL_URL: '/pending' };
  const result = await handleInstallCallback({ setup_action: 'request' }, { fetchImpl, env });
  check('redirected to the pending-approval page, not the failure page', result.redirectUrl === '/pending');
  check('no GitHub confirmation call was made', fetchImpl.calls.length === 0);
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testValidInstallProceedsToStripeWithASignedCheckoutToken() {
  console.log('a valid state + a confirmed real installation proceeds to the Stripe Payment Link with a fresh signed token as client_reference_id');
  process.env.ONBOARDING_STATE_SECRET = 'callback-test-happy-path';
  const fetchImpl = makeFakeFetch({ installationsById: { '333': { account: { login: 'happy-org' } } } });
  const env = { GITHUB_APP_ID: 1, GITHUB_APP_PRIVATE_KEY: privateKey, STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test' };
  const state = signOnboardingToken({ onboardingId: 'ob-3' });
  const result = await handleInstallCallback({ installation_id: '333', setup_action: 'install', state }, { fetchImpl, env });
  check('redirects to the Stripe Payment Link', result.redirectUrl.startsWith('https://buy.stripe.com/test?client_reference_id='));
  const checkoutToken = new URL(result.redirectUrl).searchParams.get('client_reference_id');
  const claims = verifyOnboardingToken(checkoutToken);
  check('the checkout token carries the CONFIRMED installation id and account login', claims && claims.installationId === '333' && claims.accountLogin === 'happy-org');
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testValidInstallWithAPlanRedirectsToThatPlansOwnPaymentLink() {
  console.log('a state token carrying a planId redirects to THAT plan\'s own Stripe Payment Link, re-validated against the current plans.json (not just trusted from the token)');
  process.env.ONBOARDING_STATE_SECRET = 'callback-test-plan-redirect';
  const fetchImpl = makeFakeFetch({ installationsById: { '555': { account: { login: 'plan-org' } } } });
  const env = { GITHUB_APP_ID: 1, GITHUB_APP_PRIVATE_KEY: privateKey, STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/default-fallback' };
  const state = signOnboardingToken({ onboardingId: 'ob-plan', planId: 'starter' });
  const result = await handleInstallCallback({ installation_id: '555', setup_action: 'install', state }, { fetchImpl, env, plans: TEST_PLANS });
  check("redirects to the starter plan's own Payment Link, not the default env var", result.redirectUrl.startsWith('https://buy.stripe.com/starter?client_reference_id='));
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testPlanRemovedBetweenHopsFailsClosed() {
  console.log('a planId carried in the state token that no longer matches any plan in plans.json (removed/renamed between the two hops) fails closed to the failure page, never falls back to a default');
  process.env.ONBOARDING_STATE_SECRET = 'callback-test-plan-removed';
  const fetchImpl = makeFakeFetch({ installationsById: { '666': { account: { login: 'stale-plan-org' } } } });
  const env = { GITHUB_APP_ID: 1, GITHUB_APP_PRIVATE_KEY: privateKey, STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/default-fallback', ONBOARDING_FAILURE_URL: '/failed' };
  const state = signOnboardingToken({ onboardingId: 'ob-stale', planId: 'plan-that-no-longer-exists' });
  const result = await handleInstallCallback({ installation_id: '666', setup_action: 'install', state }, { fetchImpl, env, plans: TEST_PLANS });
  check('rejected, never falls back to the default Payment Link', result.redirectUrl === '/failed');
}

async function testEveryRejectionPathReturnsTheIdenticalGenericFailureRedirect() {
  console.log('every rejection path returns the same generic redirect target regardless of which check failed (anti-fingerprinting)');
  process.env.ONBOARDING_STATE_SECRET = 'callback-test-generic-failure';
  const fetchImpl = makeFakeFetch({});
  const env = { GITHUB_APP_ID: 1, GITHUB_APP_PRIVATE_KEY: privateKey, STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test', ONBOARDING_FAILURE_URL: '/onboarding-failed.html' };

  const badId = await handleInstallCallback({ installation_id: 'not-a-number', setup_action: 'install', state: 'whatever' }, { fetchImpl, env });
  const noState = await handleInstallCallback({ installation_id: '444', setup_action: 'install' }, { fetchImpl, env });
  const revoked = await handleInstallCallback({ installation_id: '444', setup_action: 'install', state: signOnboardingToken({ onboardingId: 'x' }) }, { fetchImpl, env });

  check('all three distinct failure reasons redirect to the exact same URL', badId.redirectUrl === noState.redirectUrl && noState.redirectUrl === revoked.redirectUrl && badId.redirectUrl === '/onboarding-failed.html');
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function main() {
  testBuildInstallRedirectProducesAValidSignedStateToken();
  testBuildInstallRedirectFailsClosedWithoutAppSlugConfigured();
  testBuildInstallRedirectCarriesAKnownPlanIdIntoTheStateToken();
  testBuildInstallRedirectRejectsAnUnknownPlan();
  testBuildInstallRedirectWithNoPlanOmitsPlanIdEntirely();
  await testRejectsACraftedInstallationIdWithAForgedOrAbsentState();
  await testRejectsAWellFormedButExpiredStateEvenWithARealInstallationId();
  await testFailsClosedWhenGithubReConfirmationErrors();
  await testSetupActionRequestIsPendingApprovalNotAFailure();
  await testValidInstallProceedsToStripeWithASignedCheckoutToken();
  await testValidInstallWithAPlanRedirectsToThatPlansOwnPaymentLink();
  await testPlanRemovedBetweenHopsFailsClosed();
  await testEveryRejectionPathReturnsTheIdenticalGenericFailureRedirect();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
