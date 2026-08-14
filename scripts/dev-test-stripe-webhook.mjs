// Local verification harness for api/stripe_webhook.js - the highest-
// stakes single file in this sprint (it's what actually provisions a
// tenant). Uses Stripe's own stripe.webhooks.generateTestHeaderString to
// produce real, verifiable signatures fully offline - no network, no real
// Stripe account needed, same "safe on a fork PR" property every other
// harness in this repo already has.
//
// Usage: node scripts/dev-test-stripe-webhook.mjs

import Stripe from 'stripe';
import { generateKeyPairSync } from 'crypto';
import { handleStripeWebhook, readRawBody } from './../api/stripe_webhook.js';
import { signOnboardingToken } from './../lib/onboarding_token.js';
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

const WEBHOOK_SECRET = 'whsec_test_secret';
const stripeForSigning = new Stripe('sk_test_fake_for_signing_only');

function signedPayload(eventBody) {
  const payload = JSON.stringify(eventBody);
  const header = stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { rawBody: Buffer.from(payload), signatureHeader: header };
}

function checkoutCompletedEvent({ id = 'evt_1', sessionId = 'cs_1', clientReferenceId, customer = 'cus_1' } = {}) {
  return {
    id,
    type: 'checkout.session.completed',
    data: { object: { id: sessionId, client_reference_id: clientReferenceId, customer } }
  };
}

// --- Fakes -------------------------------------------------------------------

function makeFakeHubOctokitWithRegistry({ tenants = [], spokes = [] } = {}) {
  const files = {
    'tenants.json': { content: tenants, sha: 'tenants-sha-0' },
    'spokes.json': { content: spokes, sha: 'spokes-sha-0' }
  };
  const calls = { getContent: [], createOrUpdateFileContents: [] };
  let shaCounter = 0;
  let forceConflictOnceForPath = null;

  return {
    calls,
    files,
    forceConflictOnce(path) { forceConflictOnceForPath = path; },
    repos: {
      getContent: async ({ path }) => {
        calls.getContent.push({ path });
        const file = files[path];
        if (!file) { const err = new Error('404 not found'); err.status = 404; throw err; }
        return { data: { content: Buffer.from(JSON.stringify(file.content)).toString('base64'), sha: file.sha } };
      },
      createOrUpdateFileContents: async (params) => {
        calls.createOrUpdateFileContents.push(params);
        if (forceConflictOnceForPath === params.path) {
          forceConflictOnceForPath = null;
          // Simulate a DIFFERENT concurrent writer's commit landing between
          // this call's read and write - injects a competing entry
          // directly, then reports the conflict, so the retry's re-read
          // sees it.
          const file = files[params.path];
          const competingTenant = { tenantId: 'ghapp-999999', name: 'raced-in-by-another-writer', status: 'active', plan: 'standard', quota: { reviewsPerMonth: null }, githubCredentialRef: 'ghapp:999999', installationId: 999999, createdAt: new Date().toISOString() };
          file.content = params.path === 'tenants.json' ? [...file.content, competingTenant] : file.content;
          shaCounter++;
          file.sha = `sha-${shaCounter}`;
          const err = new Error('409 Conflict');
          err.status = 409;
          throw err;
        }
        const file = files[params.path];
        if (file && params.sha !== file.sha) {
          const err = new Error('409 Conflict');
          err.status = 409;
          throw err;
        }
        const newContent = JSON.parse(Buffer.from(params.content, 'base64').toString('utf8'));
        shaCounter++;
        files[params.path] = { content: newContent, sha: `sha-${shaCounter}` };
        return { data: {} };
      }
    }
  };
}

function makeFakeFetchForInstallationRepos(repoFullNames = []) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://api.github.com/installation/repositories') {
      return { ok: true, status: 200, json: async () => ({ repositories: repoFullNames.map((full_name) => ({ full_name })) }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

// Fakes the @octokit/request-shaped call mintInstallationToken makes to
// exchange the App JWT for an installation token - without this, that
// exchange would attempt a real network call and silently fail (returning
// null), which would otherwise make the spoke auto-registration look like
// a no-op rather than actually exercising it.
function makeFakeGithubAppRequest() {
  return async (route, params) => {
    if (route === 'POST /app/installations/{installation_id}/access_tokens') {
      return { data: { token: `fake-installation-token-${params.installation_id}`, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() } };
    }
    throw new Error(`unexpected route in fake githubAppRequest: ${route}`);
  };
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    process.env[key] = vars[key];
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

async function testTamperedBodyIsRejected() {
  console.log('handleStripeWebhook rejects a tampered body against an otherwise-valid-looking signature header');
  const { rawBody, signatureHeader } = signedPayload(checkoutCompletedEvent());
  const tamperedBody = Buffer.concat([rawBody, Buffer.from('tampered')]);
  const hubOctokit = makeFakeHubOctokitWithRegistry();
  const result = await handleStripeWebhook(tamperedBody, signatureHeader, { stripeWebhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('returns 400', result.httpStatus === 400);
  check('no tenant was written', hubOctokit.calls.createOrUpdateFileContents.length === 0);
}

async function testMissingSignatureHeaderIsRejected() {
  console.log('handleStripeWebhook rejects a request with a missing Stripe-Signature header');
  const { rawBody } = signedPayload(checkoutCompletedEvent());
  const hubOctokit = makeFakeHubOctokitWithRegistry();
  const result = await handleStripeWebhook(rawBody, undefined, { stripeWebhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('returns 400', result.httpStatus === 400);
}

async function testWrongWebhookSecretIsRejected() {
  console.log('handleStripeWebhook rejects a signature computed with the wrong webhook secret');
  const { rawBody, signatureHeader } = signedPayload(checkoutCompletedEvent());
  const hubOctokit = makeFakeHubOctokitWithRegistry();
  const result = await handleStripeWebhook(rawBody, signatureHeader, { stripeWebhookSecret: 'whsec_a_totally_different_secret', hubOctokit });
  check('returns 400', result.httpStatus === 400);
}

async function testUnhandledEventTypesAreIgnoredWithoutTouchingRegistries() {
  console.log('handleStripeWebhook 200s and ignores event types other than checkout.session.completed, without touching tenants.json');
  const { rawBody, signatureHeader } = signedPayload({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: {} } });
  const hubOctokit = makeFakeHubOctokitWithRegistry();
  const result = await handleStripeWebhook(rawBody, signatureHeader, { stripeWebhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('returns 200', result.httpStatus === 200);
  check('status is Ignored', result.body.status === 'Ignored');
  check('no registry write happened', hubOctokit.calls.createOrUpdateFileContents.length === 0);
}

async function testMissingClientReferenceIdIsRecordedAsUnlinkedNotProvisioned() {
  console.log('handleStripeWebhook records an Unlinked result (no tenant write) when client_reference_id is missing entirely');
  const { rawBody, signatureHeader } = signedPayload(checkoutCompletedEvent({ clientReferenceId: undefined }));
  const hubOctokit = makeFakeHubOctokitWithRegistry();
  const result = await handleStripeWebhook(rawBody, signatureHeader, { stripeWebhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('returns 200 (acked, not an error Stripe should retry)', result.httpStatus === 200);
  check('status is Unlinked', result.body.status === 'Unlinked');
  check('no tenant was written', hubOctokit.calls.createOrUpdateFileContents.length === 0);
}

async function testInvalidOnboardingTokenIsRecordedAsUnlinked() {
  console.log('handleStripeWebhook records Unlinked when client_reference_id fails onboarding-token verification (e.g. someone hit the bare Payment Link directly)');
  process.env.ONBOARDING_STATE_SECRET = 'stripe-webhook-test-secret';
  const { rawBody, signatureHeader } = signedPayload(checkoutCompletedEvent({ clientReferenceId: 'garbage-not-a-real-token' }));
  const hubOctokit = makeFakeHubOctokitWithRegistry();
  const result = await handleStripeWebhook(rawBody, signatureHeader, { stripeWebhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('status is Unlinked', result.body.status === 'Unlinked');
  check('no tenant was written', hubOctokit.calls.createOrUpdateFileContents.length === 0);
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testValidPaymentProvisionsATenantWithTheDeterministicId() {
  console.log('handleStripeWebhook provisions a real tenant with tenantId = ghapp-<installationId>, plus its spokes, on a valid signed payment');
  _clearAppAuthCacheForTests();
  process.env.ONBOARDING_STATE_SECRET = 'stripe-webhook-provision-test';
  const clientReferenceId = signOnboardingToken({ onboardingId: 'ob-1', installationId: '12345', accountLogin: 'acme-org' });
  const { rawBody, signatureHeader } = signedPayload(checkoutCompletedEvent({ clientReferenceId }));
  const hubOctokit = makeFakeHubOctokitWithRegistry();
  const fetchImpl = makeFakeFetchForInstallationRepos(['acme-org/widget-service', 'acme-org/gadget-api']);
  const result = await handleStripeWebhook(rawBody, signatureHeader, {
    stripeWebhookSecret: WEBHOOK_SECRET, hubOctokit, fetchImpl,
    githubAppId: 1, githubAppPrivateKey: privateKey, githubAppRequest: makeFakeGithubAppRequest()
  });
  check('returns 200', result.httpStatus === 200);
  check('status is Provisioned', result.body.status === 'Provisioned');
  check('the tenantId is deterministic from the installation id', result.body.tenantId === 'ghapp-12345');
  const tenants = hubOctokit.files['tenants.json'].content;
  const newTenant = tenants.find((t) => t.tenantId === 'ghapp-12345');
  check('the new tenant record exists with the right credential ref', !!newTenant && newTenant.githubCredentialRef === 'ghapp:12345');
  check("the new tenant's name is the confirmed account login", newTenant.name === 'acme-org');
  check("the new tenant's stripeCustomerId is recorded from the session", newTenant.stripeCustomerId === 'cus_1');
  check('both installation repos got registered as spokes', hubOctokit.files['spokes.json'].content.some(s => s.owner === 'acme-org' && s.repo === 'widget-service') && hubOctokit.files['spokes.json'].content.some(s => s.owner === 'acme-org' && s.repo === 'gadget-api'));
  check('both new spokes are attributed to the new tenant', hubOctokit.files['spokes.json'].content.every(s => s.tenantId === 'ghapp-12345'));
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testDuplicateDeliveryOfTheSameEventIsIdempotent() {
  console.log('calling handleStripeWebhook twice with the same event produces exactly one tenants.json write, second call returns AlreadyProvisioned');
  _clearAppAuthCacheForTests();
  process.env.ONBOARDING_STATE_SECRET = 'stripe-webhook-idempotency-test';
  const clientReferenceId = signOnboardingToken({ onboardingId: 'ob-2', installationId: '54321', accountLogin: 'dup-org' });
  const { rawBody, signatureHeader } = signedPayload(checkoutCompletedEvent({ id: 'evt_dup', sessionId: 'cs_dup', clientReferenceId }));
  const hubOctokit = makeFakeHubOctokitWithRegistry();
  const fetchImpl = makeFakeFetchForInstallationRepos([]);
  const deps = { stripeWebhookSecret: WEBHOOK_SECRET, hubOctokit, fetchImpl, githubAppId: 1, githubAppPrivateKey: privateKey, githubAppRequest: makeFakeGithubAppRequest() };

  const first = await handleStripeWebhook(rawBody, signatureHeader, deps);
  const second = await handleStripeWebhook(rawBody, signatureHeader, deps);

  check('first delivery provisions', first.body.status === 'Provisioned');
  check('second (duplicate) delivery reports AlreadyProvisioned', second.body.status === 'AlreadyProvisioned');
  check('exactly one tenant with this id exists, not two', hubOctokit.files['tenants.json'].content.filter(t => t.tenantId === 'ghapp-54321').length === 1);
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testSimulatedConcurrentRaceStillYieldsExactlyOneTenant() {
  console.log('a simulated race (another writer commits between this call\'s read and write) still yields exactly one tenant record via the retry-with-fresh-read path');
  _clearAppAuthCacheForTests();
  process.env.ONBOARDING_STATE_SECRET = 'stripe-webhook-race-test';
  // The "other writer" injects tenantId ghapp-999999 - simulate THIS
  // delivery being for that same installation id, racing itself.
  const clientReferenceId = signOnboardingToken({ onboardingId: 'ob-3', installationId: '999999', accountLogin: 'race-org' });
  const { rawBody, signatureHeader } = signedPayload(checkoutCompletedEvent({ id: 'evt_race', sessionId: 'cs_race', clientReferenceId }));
  const hubOctokit = makeFakeHubOctokitWithRegistry();
  hubOctokit.forceConflictOnce('tenants.json');
  const fetchImpl = makeFakeFetchForInstallationRepos([]);
  const result = await handleStripeWebhook(rawBody, signatureHeader, { stripeWebhookSecret: WEBHOOK_SECRET, hubOctokit, fetchImpl, githubAppId: 1, githubAppPrivateKey: privateKey, githubAppRequest: makeFakeGithubAppRequest() });
  check('the retry detects the now-present entry and reports AlreadyProvisioned rather than erroring or duplicating', result.body.status === 'AlreadyProvisioned');
  check('exactly one tenant with this id exists after the race', hubOctokit.files['tenants.json'].content.filter(t => t.tenantId === 'ghapp-999999').length === 1);
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testProvisionedTenantAlwaysUsesGhappSchemeNeverEnv() {
  console.log("a newly-provisioned tenant's githubCredentialRef always follows the ghapp:<installationId> convention, never env:");
  _clearAppAuthCacheForTests();
  process.env.ONBOARDING_STATE_SECRET = 'stripe-webhook-scheme-test';
  const clientReferenceId = signOnboardingToken({ onboardingId: 'ob-4', installationId: '777', accountLogin: 'scheme-org' });
  const { rawBody, signatureHeader } = signedPayload(checkoutCompletedEvent({ id: 'evt_scheme', sessionId: 'cs_scheme', clientReferenceId }));
  const hubOctokit = makeFakeHubOctokitWithRegistry();
  const fetchImpl = makeFakeFetchForInstallationRepos([]);
  await handleStripeWebhook(rawBody, signatureHeader, { stripeWebhookSecret: WEBHOOK_SECRET, hubOctokit, fetchImpl, githubAppId: 1, githubAppPrivateKey: privateKey, githubAppRequest: makeFakeGithubAppRequest() });
  const newTenant = hubOctokit.files['tenants.json'].content.find(t => t.tenantId === 'ghapp-777');
  check('githubCredentialRef starts with ghapp:', !!newTenant && newTenant.githubCredentialRef.startsWith('ghapp:'));
  delete process.env.ONBOARDING_STATE_SECRET;
}

async function testReadRawBodyRejectsOversizedPayloadWithoutBufferingItAll() {
  console.log('readRawBody rejects a body over the max-byte cap without buffering the whole thing (DoS mitigation)');
  const { Readable } = await import('stream');
  const bigChunk = Buffer.alloc(2000, 'x');
  const req = new Readable({
    read() {
      this.push(bigChunk);
      this.push(bigChunk);
      this.push(bigChunk);
      this.push(null);
    }
  });
  let threw = false;
  try {
    await readRawBody(req, { maxBytes: 1000 });
  } catch (e) {
    threw = true;
  }
  check('rejects once the cap is exceeded', threw === true);
}

async function main() {
  await testTamperedBodyIsRejected();
  await testMissingSignatureHeaderIsRejected();
  await testWrongWebhookSecretIsRejected();
  await testUnhandledEventTypesAreIgnoredWithoutTouchingRegistries();
  await testMissingClientReferenceIdIsRecordedAsUnlinkedNotProvisioned();
  await testInvalidOnboardingTokenIsRecordedAsUnlinked();
  await testValidPaymentProvisionsATenantWithTheDeterministicId();
  await testDuplicateDeliveryOfTheSameEventIsIdempotent();
  await testSimulatedConcurrentRaceStillYieldsExactlyOneTenant();
  await testProvisionedTenantAlwaysUsesGhappSchemeNeverEnv();
  await testReadRawBodyRejectsOversizedPayloadWithoutBufferingItAll();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
