// Entry point for self-service onboarding - a plain GET redirect into
// GitHub's own hosted App-install picker, carrying a freshly signed state
// token (see lib/onboarding_token.js) so api/github_app_callback.js can
// later verify this specific install flow wasn't forged.
//
// No tenant, spoke, or any other record is created here - this endpoint's
// only side effect is a redirect. Provisioning only ever happens in
// api/stripe_webhook.js, after BOTH the App install (re-verified against
// GitHub, not just trusted from the query string) and a real payment are
// confirmed - see api/github_app_callback.js's header comment for the
// full sequencing rationale.
//
// Accepts an optional ?plan=<planId>, validated against plans.json and
// carried forward inside the signed state token so
// api/github_app_callback.js can redirect to that tier's own Stripe
// Payment Link. This is a UX convenience only, never a trust boundary: a
// client-chosen planId just selects WHICH Payment Link the browser is
// redirected to next - Stripe's own hosted checkout page enforces the real
// price for whichever link that is, so tampering with ?plan= can't get a
// cheaper tier. api/stripe_webhook.js never trusts this value either; it
// independently re-derives the actual purchased plan from the Stripe price
// the customer really paid for.

import { randomUUID } from 'crypto';
import { signOnboardingToken } from '../lib/onboarding_token.js';
import { loadPlansRegistry, findPlan } from '../lib/secrets.js';

export function buildInstallRedirect({ now = Date.now(), generateId = randomUUID, env = process.env, query = {}, plans = loadPlansRegistry() } = {}) {
  const appSlug = env.GITHUB_APP_SLUG;
  if (!appSlug) {
    return { httpStatus: 500, body: { error: 'GITHUB_APP_SLUG is not configured' } };
  }
  const requestedPlanId = query.plan;
  let planId;
  if (requestedPlanId) {
    const plan = findPlan(requestedPlanId, plans);
    if (!plan) return { httpStatus: 400, body: { error: `unknown plan '${requestedPlanId}'` } };
    planId = plan.planId;
  }
  const onboardingId = generateId();
  const state = signOnboardingToken({ onboardingId, ...(planId ? { planId } : {}) }, { now });
  const redirectUrl = `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
  return { httpStatus: 302, redirectUrl };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const result = buildInstallRedirect({ query: req.query || {} });
  if (result.httpStatus === 302) {
    res.writeHead(302, { Location: result.redirectUrl });
    res.end();
    return;
  }
  res.status(result.httpStatus).json(result.body);
}
