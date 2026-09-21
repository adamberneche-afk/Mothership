// Local verification harness for api/customer_portal_link.js (immediate
// post-checkout access) and api/request_portal_link.js (ongoing access for
// a returning customer) - the Stripe Customer Portal integration.
//
// Usage: node scripts/dev-test-customer-portal.mjs

import { getPortalLinkForSession } from './../api/customer_portal_link.js';
import { handleRequestPortalLink } from './../api/request_portal_link.js';

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

function makeFakeStripeClient({
  session,
  portalUrl = 'https://billing.stripe.com/session/fake_portal',
  retrieveThrows,
  createPortalThrows,
  customersListResult
} = {}) {
  const calls = { retrieve: [], portalCreate: [], customersList: [] };
  return {
    calls,
    checkout: {
      sessions: {
        retrieve: async (sessionId) => {
          calls.retrieve.push(sessionId);
          if (retrieveThrows) throw retrieveThrows;
          return session;
        }
      }
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          calls.portalCreate.push(params);
          if (createPortalThrows) throw createPortalThrows;
          return { url: portalUrl };
        }
      }
    },
    customers: {
      list: async (params) => {
        calls.customersList.push(params);
        return customersListResult || { data: [] };
      }
    }
  };
}

function makeFakeSendEmail(result = { sent: true }) {
  const calls = [];
  const impl = async (payload) => { calls.push(payload); return result; };
  impl.calls = calls;
  return impl;
}

// --- Tests: api/customer_portal_link.js -------------------------------------

async function testMissingSessionIdIsRejected() {
  console.log('getPortalLinkForSession rejects a missing session_id without calling Stripe at all');
  const stripeClient = makeFakeStripeClient({});
  const result = await getPortalLinkForSession(undefined, { stripeClient, dashboardBaseUrl: 'https://mothership.example' });
  check('rejected', result.ok === false);
  check('never called Stripe', stripeClient.calls.retrieve.length === 0);
}

async function testMissingDashboardBaseUrlFailsClosed() {
  console.log('getPortalLinkForSession fails closed (never guesses a return_url) when DASHBOARD_BASE_URL is not configured');
  const stripeClient = makeFakeStripeClient({ session: { payment_status: 'paid', customer: 'cus_1', created: Math.floor(Date.now() / 1000) } });
  const result = await getPortalLinkForSession('cs_1', { stripeClient, dashboardBaseUrl: undefined });
  check('rejected', result.ok === false);
  check('the reason names the missing config', /DASHBOARD_BASE_URL/.test(result.reason));
  check('never even called Stripe', stripeClient.calls.retrieve.length === 0);
}

async function testValidFreshPaidSessionMintsARealPortalLink() {
  console.log('a valid, fresh, paid checkout session mints a real portal link with the correct customer/return_url');
  const now = 1_700_000_000_000;
  const session = { payment_status: 'paid', customer: 'cus_valid', created: Math.floor(now / 1000) - 60 };
  const stripeClient = makeFakeStripeClient({ session, portalUrl: 'https://billing.stripe.com/p/real' });
  const result = await getPortalLinkForSession('cs_valid', { stripeClient, now, dashboardBaseUrl: 'https://mothership.example' });
  check('ok', result.ok === true);
  check('returns the real portal URL', result.url === 'https://billing.stripe.com/p/real');
  check('portal session created for the right customer', stripeClient.calls.portalCreate[0].customer === 'cus_valid');
  check('return_url points at install.html', stripeClient.calls.portalCreate[0].return_url === 'https://mothership.example/install.html');
}

async function testUnpaidSessionIsRejected() {
  console.log('getPortalLinkForSession rejects a session that hasn\'t actually been paid - reaching this URL proves nothing on its own');
  const session = { payment_status: 'unpaid', customer: 'cus_1', created: Math.floor(Date.now() / 1000) };
  const stripeClient = makeFakeStripeClient({ session });
  const result = await getPortalLinkForSession('cs_unpaid', { stripeClient, dashboardBaseUrl: 'https://mothership.example' });
  check('rejected', result.ok === false);
  check('never minted a portal session', stripeClient.calls.portalCreate.length === 0);
}

async function testSessionWithNoCustomerIsRejected() {
  console.log('a session with no associated customer is rejected');
  const session = { payment_status: 'paid', customer: null, created: Math.floor(Date.now() / 1000) };
  const stripeClient = makeFakeStripeClient({ session });
  const result = await getPortalLinkForSession('cs_no_customer', { stripeClient, dashboardBaseUrl: 'https://mothership.example' });
  check('rejected', result.ok === false);
}

async function testExpiredSessionIsRejected() {
  console.log('a session older than the ~24h exposure window is rejected - a leaked/bookmarked old success URL stops working on its own');
  const now = 1_700_000_000_000;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const session = { payment_status: 'paid', customer: 'cus_old', created: Math.floor((now - oneDayMs - 60_000) / 1000) };
  const stripeClient = makeFakeStripeClient({ session });
  const result = await getPortalLinkForSession('cs_old', { stripeClient, now, dashboardBaseUrl: 'https://mothership.example' });
  check('rejected as expired', result.ok === false && /expired/.test(result.reason));
  check('never minted a portal session', stripeClient.calls.portalCreate.length === 0);
}

async function testStripeSessionRetrieveFailureNeverThrows() {
  console.log('a Stripe error retrieving the session is caught, never thrown');
  const stripeClient = makeFakeStripeClient({ retrieveThrows: new Error('session not found') });
  let threw = false;
  let result;
  try {
    result = await getPortalLinkForSession('cs_bad', { stripeClient, dashboardBaseUrl: 'https://mothership.example' });
  } catch (e) {
    threw = true;
  }
  check('did not throw', threw === false);
  check('reported as not ok', result && result.ok === false);
}

async function testPortalSessionCreateFailureNeverThrows() {
  console.log('a Stripe error minting the portal session itself is caught, never thrown');
  const session = { payment_status: 'paid', customer: 'cus_1', created: Math.floor(Date.now() / 1000) };
  const stripeClient = makeFakeStripeClient({ session, createPortalThrows: new Error('portal config missing') });
  let threw = false;
  let result;
  try {
    result = await getPortalLinkForSession('cs_1', { stripeClient, dashboardBaseUrl: 'https://mothership.example' });
  } catch (e) {
    threw = true;
  }
  check('did not throw', threw === false);
  check('reported as not ok', result && result.ok === false);
}

// --- Tests: api/request_portal_link.js --------------------------------------

async function testMatchingEmailSendsAPortalLinkButResponseIsGeneric() {
  console.log('a matching email gets a fresh portal link emailed to them - but the API response itself is the identical generic message');
  const stripeClient = makeFakeStripeClient({ customersListResult: { data: [{ id: 'cus_match' }] }, portalUrl: 'https://billing.stripe.com/p/match' });
  const sendEmailImpl = makeFakeSendEmail();
  const result = await handleRequestPortalLink({ email: 'real@customer.com' }, { stripeClient, sendEmailImpl, dashboardBaseUrl: 'https://mothership.example', rateLimitState: new Map() });
  check('an email was sent', sendEmailImpl.calls.length === 1 && sendEmailImpl.calls[0].to === 'real@customer.com');
  check('the email contains the real portal link', sendEmailImpl.calls[0].html.includes('https://billing.stripe.com/p/match'));
  check('the response has the generic status', result.status === 'Requested');
  return result;
}

async function testNonMatchingEmailGetsTheIdenticalResponse() {
  console.log('a non-matching email gets the exact same response as a match - the core anti-enumeration property');
  const matchResult = await testMatchingEmailSendsAPortalLinkButResponseIsGeneric();
  const stripeClient = makeFakeStripeClient({ customersListResult: { data: [] } });
  const sendEmailImpl = makeFakeSendEmail();
  const nonMatchResult = await handleRequestPortalLink({ email: 'nobody@nowhere.com' }, { stripeClient, sendEmailImpl, dashboardBaseUrl: 'https://mothership.example', rateLimitState: new Map() });
  check('no email was sent for the non-match', sendEmailImpl.calls.length === 0);
  check('the response is BYTE-IDENTICAL to the matching-email response', JSON.stringify(nonMatchResult) === JSON.stringify(matchResult));
}

async function testMalformedEmailReturnsGenericWithoutCallingStripe() {
  console.log('a malformed/missing email returns the generic response without ever calling Stripe');
  const stripeClient = makeFakeStripeClient({});
  const noAt = await handleRequestPortalLink({ email: 'not-an-email' }, { stripeClient, dashboardBaseUrl: 'https://mothership.example', rateLimitState: new Map() });
  const missing = await handleRequestPortalLink({}, { stripeClient, dashboardBaseUrl: 'https://mothership.example', rateLimitState: new Map() });
  check('malformed email gets the generic response', noAt.status === 'Requested');
  check('missing email gets the generic response', missing.status === 'Requested');
  check('Stripe was never called for either', stripeClient.calls.customersList.length === 0);
}

async function testRateLimitingSkipsStripeAndEmailOnASecondRequestWithinTheWindow() {
  console.log('a second request for the same email within the rate-limit window skips Stripe/email entirely, but still returns the generic response');
  const stripeClient = makeFakeStripeClient({ customersListResult: { data: [{ id: 'cus_rl' }] } });
  const sendEmailImpl = makeFakeSendEmail();
  const rateLimitState = new Map();
  const now = 5_000_000;
  const first = await handleRequestPortalLink({ email: 'repeat@customer.com' }, { stripeClient, sendEmailImpl, dashboardBaseUrl: 'https://mothership.example', rateLimitState, now });
  const second = await handleRequestPortalLink({ email: 'repeat@customer.com' }, { stripeClient, sendEmailImpl, dashboardBaseUrl: 'https://mothership.example', rateLimitState, now: now + 5000 });
  check('first request queries Stripe and sends an email', stripeClient.calls.customersList.length === 1 && sendEmailImpl.calls.length === 1);
  check('second (rate-limited) request does NOT query Stripe or send another email', stripeClient.calls.customersList.length === 1 && sendEmailImpl.calls.length === 1);
  check('both responses are still the identical generic message', JSON.stringify(first) === JSON.stringify(second));
}

async function testRequestAfterTheRateLimitWindowIsAllowedAgain() {
  console.log('a request for the same email AFTER the rate-limit window has passed is allowed through normally');
  const stripeClient = makeFakeStripeClient({ customersListResult: { data: [{ id: 'cus_rl2' }] } });
  const sendEmailImpl = makeFakeSendEmail();
  const rateLimitState = new Map();
  const now = 5_000_000;
  await handleRequestPortalLink({ email: 'later@customer.com' }, { stripeClient, sendEmailImpl, dashboardBaseUrl: 'https://mothership.example', rateLimitState, now });
  await handleRequestPortalLink({ email: 'later@customer.com' }, { stripeClient, sendEmailImpl, dashboardBaseUrl: 'https://mothership.example', rateLimitState, now: now + 61_000 });
  check('the second request, after the window, queried Stripe again', stripeClient.calls.customersList.length === 2);
  check('and sent a second email', sendEmailImpl.calls.length === 2);
}

async function testStripeOrEmailFailureIsSwallowedAndStillReturnsTheGenericResponse() {
  console.log('a Stripe/email failure mid-flow is swallowed - never thrown, and still the identical generic response (not distinguishable from a non-match)');
  const stripeClient = {
    customers: { list: async () => { throw new Error('Stripe is down'); } }
  };
  let threw = false;
  let result;
  try {
    result = await handleRequestPortalLink({ email: 'flaky@customer.com' }, { stripeClient, dashboardBaseUrl: 'https://mothership.example', rateLimitState: new Map() });
  } catch (e) {
    threw = true;
  }
  check('did not throw', threw === false);
  check('still the generic response', result && result.status === 'Requested');
}

async function testMissingDashboardBaseUrlFailsSoftWithoutCallingStripe() {
  console.log('with no DASHBOARD_BASE_URL configured, the request fails soft (generic response) without ever calling Stripe - nothing to build a return_url from');
  const stripeClient = makeFakeStripeClient({ customersListResult: { data: [{ id: 'cus_x' }] } });
  const result = await handleRequestPortalLink({ email: 'someone@customer.com' }, { stripeClient, dashboardBaseUrl: undefined, rateLimitState: new Map() });
  check('still the generic response', result.status === 'Requested');
  check('never called Stripe', stripeClient.calls.customersList.length === 0);
}

async function main() {
  await testMissingSessionIdIsRejected();
  await testMissingDashboardBaseUrlFailsClosed();
  await testValidFreshPaidSessionMintsARealPortalLink();
  await testUnpaidSessionIsRejected();
  await testSessionWithNoCustomerIsRejected();
  await testExpiredSessionIsRejected();
  await testStripeSessionRetrieveFailureNeverThrows();
  await testPortalSessionCreateFailureNeverThrows();

  await testNonMatchingEmailGetsTheIdenticalResponse();
  await testMalformedEmailReturnsGenericWithoutCallingStripe();
  await testRateLimitingSkipsStripeAndEmailOnASecondRequestWithinTheWindow();
  await testRequestAfterTheRateLimitWindowIsAllowedAgain();
  await testStripeOrEmailFailureIsSwallowedAndStillReturnsTheGenericResponse();
  await testMissingDashboardBaseUrlFailsSoftWithoutCallingStripe();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
