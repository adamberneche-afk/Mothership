// Verifies a real Stripe payment and, only then, provisions a tenant. The
// entire billing surface this sprint is this one event
// (checkout.session.completed) - no subscription lifecycle, no portal, no
// dunning (see lessons.md's dated entry for the full disclosed scope).
//
// Deliberately does NOT reuse api/autonomous_agent.js/api/recursive_learning.js's
// `req.body` convention - Stripe's signature is computed over the exact
// raw request bytes, and Vercel's default body-parsing would discard them
// before this handler ever saw them. `config.api.bodyParser = false` below
// opts out of that, and readRawBody manually drains the request stream
// with an explicit byte cap (a concrete, cheap DoS mitigation - reject and
// stop reading past ~1MB before buffering further). This file's `req.body`
// is NEVER touched anywhere, on purpose.
//
// Uses the official `stripe` package for signature verification
// specifically because real money is on the line here: `constructEvent`
// correctly handles secret rotation, multiple simultaneous v1= signatures,
// and timestamp tolerance in a way a hand-rolled HMAC check would have to
// re-implement and re-verify itself. Every other new endpoint this sprint
// intentionally avoids new dependencies; this is the one deliberate
// exception.
//
// Idempotency: Stripe can and does redeliver the same event (retries on
// any non-2xx, and can occasionally redeliver even after a 200). The new
// tenant's tenantId is DETERMINISTIC (`ghapp-<installationId>`, never
// random) specifically so a duplicate/retried delivery re-derives the
// exact same id - appendToJsonRegistryWithRetry's `decide` callback reads
// tenants.json fresh on every attempt and returns AlreadyProvisioned
// instead of writing again if that id is already there, closing the
// "webhook redelivered/raced twice" double-provisioning risk.
//
// A Stripe Checkout Session's/Payment Link's success_url must be a
// static, side-effect-free "thanks, check back shortly" page
// (dashboard/onboarding-success.html) - NEVER the trigger for
// provisioning. Only this verified, server-to-server webhook provisions
// anything; conflating "the browser reached success_url" with "payment is
// confirmed" would let anyone provision a free tenant just by visiting
// that URL.

import Stripe from 'stripe';
import { verifyOnboardingToken } from '../lib/onboarding_token.js';
import { mintInstallationToken } from '../lib/github_app.js';
import { appendToJsonRegistryWithRetry } from '../lib/registry_writer.js';

export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 1_000_000;

// v1 scope: exactly one plan tier, one Stripe Payment Link - matches this
// sprint's deliberate "single Checkout gate, not a full billing platform"
// scope. Extending to multiple plans needs a per-price lookup (e.g. via
// stripe.checkout.sessions.listLineItems) and is real, disclosed follow-up
// work, not built here.
const DEFAULT_PLAN = 'standard';
const DEFAULT_QUOTA = { reviewsPerMonth: null };

export function readRawBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tenantIdForInstallation(installationId) {
  return `ghapp-${installationId}`;
}

async function provisionTenantForInstallation({ installationId, accountLogin, stripeCustomerId, hubOctokit, hubOwner, hubRepo, now }) {
  const tenantId = tenantIdForInstallation(installationId);
  return appendToJsonRegistryWithRetry(hubOctokit, hubOwner, hubRepo, 'tenants.json', {
    message: `chore: provision tenant for GitHub App installation ${installationId} (self-service onboarding)`,
    decide: (existingTenants) => {
      const existing = existingTenants.find((t) => t && t.tenantId === tenantId);
      if (existing) return { skip: true, result: { status: 'AlreadyProvisioned', tenantId } };
      const entry = {
        tenantId,
        name: accountLogin,
        status: 'active',
        plan: DEFAULT_PLAN,
        quota: DEFAULT_QUOTA,
        githubCredentialRef: `ghapp:${installationId}`,
        installationId: Number(installationId),
        // Recorded for operator support/reconciliation (looking a tenant up
        // in the Stripe dashboard) - not read by any code path this sprint.
        // A dedicated billing/{tenantId}.json file and a doctor.js
        // live-subscription cross-check are real, deliberately deferred
        // follow-up (this sprint's scope is "gate onboarding on a real
        // payment," not a billing platform).
        stripeCustomerId: stripeCustomerId || null,
        createdAt: new Date(now).toISOString()
      };
      return { skip: false, entry, result: { status: 'Provisioned', tenantId } };
    }
  });
}

// Best-effort: registers a spokes.json entry for every repo this
// installation actually covers, so onboarding is genuinely self-service
// rather than "tenant exists but still needs a manual spoke-registration
// step." Failure here does not fail the whole webhook - the
// payment-linked tenant record is the thing that must not be lost; a
// missing spoke is a lesser, recoverable gap an operator can register by
// hand, and idempotency above already makes a Stripe retry safe either
// way.
async function autoRegisterSpokesForInstallation({ installationId, tenantId, hubOctokit, hubOwner, hubRepo, now, fetchImpl, appId, privateKey, githubAppRequest }) {
  const token = await mintInstallationToken(installationId, { appId, privateKey, request: githubAppRequest });
  if (!token) return { registered: 0, skipped: true, reason: 'could not mint an installation token' };
  let repos;
  try {
    const res = await fetchImpl('https://api.github.com/installation/repositories', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return { registered: 0, skipped: true, reason: `GET /installation/repositories returned ${res.status}` };
    const data = await res.json();
    repos = data.repositories || [];
  } catch (e) {
    return { registered: 0, skipped: true, reason: e.message };
  }

  let registered = 0;
  for (const repo of repos) {
    const [owner, name] = (repo.full_name || '').split('/');
    if (!owner || !name) continue;
    const result = await appendToJsonRegistryWithRetry(hubOctokit, hubOwner, hubRepo, 'spokes.json', {
      message: `chore: register spoke ${owner}/${name} for tenant ${tenantId} (self-service onboarding)`,
      decide: (existingSpokes) => {
        const existing = existingSpokes.find((s) => s && s.owner === owner && s.repo === name);
        if (existing) return { skip: true, result: { added: false } };
        const entry = { tenantId, owner, repo: name, addedAt: new Date(now).toISOString(), status: 'active' };
        return { skip: false, entry, result: { added: true } };
      }
    });
    if (result.added) registered++;
  }
  return { registered, skipped: false };
}

export async function handleStripeWebhook(rawBody, signatureHeader, {
  stripeSecretKey = process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET,
  hubOctokit,
  hubOwner = process.env.HUB_GITHUB_OWNER || 'adamberneche-afk',
  hubRepo = process.env.HUB_GITHUB_REPO || 'Mothership',
  fetchImpl = fetch,
  now = Date.now(),
  stripeClient,
  githubAppId = process.env.GITHUB_APP_ID,
  githubAppPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY,
  githubAppRequest
} = {}) {
  if (!stripeWebhookSecret) {
    return { httpStatus: 500, body: { error: 'STRIPE_WEBHOOK_SECRET is not configured' } };
  }
  const stripe = stripeClient || new Stripe(stripeSecretKey || 'sk_missing');

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signatureHeader, stripeWebhookSecret);
  } catch (e) {
    // The single most important line in this file - a bad/missing/tampered
    // signature is an immediate 400, before the body is even parsed as
    // JSON, let alone acted on.
    return { httpStatus: 400, body: { error: 'invalid signature' } };
  }

  if (event.type !== 'checkout.session.completed') {
    return { httpStatus: 200, body: { status: 'Ignored', reason: `unhandled event type ${event.type}` } };
  }

  const session = event.data.object;
  const claims = session.client_reference_id ? verifyOnboardingToken(session.client_reference_id, { now }) : null;
  if (!claims || !claims.installationId) {
    // Someone completed a checkout without going through
    // api/github_app_callback.js first (a bookmarked/shared/direct hit on
    // the bare Payment Link). Acked, not provisioned, not treated as an
    // error Stripe should retry - surfaced in Vercel's function logs for
    // manual reconciliation rather than a new persisted registry file.
    console.warn(`stripe_webhook: checkout.session.completed with no valid onboarding token (session ${session.id}) - needs manual reconciliation`);
    return { httpStatus: 200, body: { status: 'Unlinked', reason: 'no valid onboarding token on this session' } };
  }

  const { installationId, accountLogin } = claims;
  const provisionResult = await provisionTenantForInstallation({ installationId, accountLogin, stripeCustomerId: session.customer, hubOctokit, hubOwner, hubRepo, now });

  if (provisionResult.status === 'Provisioned') {
    const spokeResult = await autoRegisterSpokesForInstallation({
      installationId, tenantId: provisionResult.tenantId, hubOctokit, hubOwner, hubRepo, now, fetchImpl,
      appId: githubAppId, privateKey: githubAppPrivateKey, githubAppRequest
    });
    return { httpStatus: 200, body: { ...provisionResult, spokes: spokeResult } };
  }

  return { httpStatus: 200, body: provisionResult };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    res.status(413).json({ error: 'payload too large' });
    return;
  }
  const signatureHeader = req.headers['stripe-signature'];
  const { Octokit } = await import('@octokit/rest');
  const hubOctokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
  const result = await handleStripeWebhook(rawBody, signatureHeader, { hubOctokit });
  res.status(result.httpStatus).json(result.body);
}
