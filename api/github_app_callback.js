// GitHub's post-install redirect target - a GET request anyone can, in
// principle, craft and hit directly with an arbitrary installation_id.
// Two independent layers close that off:
//
//   1. `state` must verify against ONBOARDING_STATE_SECRET (see
//      lib/onboarding_token.js) - an attacker without the secret cannot
//      produce a token that passes verification, so a forged/absent
//      state is rejected before anything else runs.
//   2. Even with a VALID state token, `installation_id` is independently
//      re-confirmed against GitHub itself (lib/github_app.js's
//      confirmInstallationExists, authenticated with the App's own JWT -
//      never trusting the browser-supplied query string alone). This
//      closes the narrower case of a leaked-but-still-valid state token
//      being replayed against a DIFFERENT installation_id than the one it
//      was actually issued for.
//
// This endpoint's only side effect is a redirect - no tenant, no spoke, no
// file write, nothing persisted server-side. Mothership is a PUBLIC repo;
// a committed pending-state file tying installation IDs to Stripe
// customer IDs together would be a real, avoidable data-exposure surface
// in permanent git history. Provisioning only happens in
// api/stripe_webhook.js, gated on a REAL payment - never on reaching this
// endpoint or any redirect target it points at.
//
// Every rejection path returns the identical generic failure redirect
// regardless of WHICH check failed (bad state vs malformed id vs GitHub
// unreachable all look the same from outside) - so probing this URL can't
// be used to fingerprint which defense exists or tripped.
//
// Real multi-tier pricing: an optional planId carried in the verified
// state claims (chosen back at api/onboard_start.js) selects which of
// plans.json's Payment Links to redirect to next - re-validated against
// the CURRENT plans.json here, not just trusted as a bare string. This is
// a UX convenience only, never a trust boundary: it picks which link the
// browser visits, not what price is actually charged - Stripe's own
// hosted checkout enforces that, and api/stripe_webhook.js independently
// re-derives the real purchased plan from the real Stripe price.

import { verifyOnboardingToken, signOnboardingToken } from '../lib/onboarding_token.js';
import { confirmInstallationExists } from '../lib/github_app.js';
import { loadPlansRegistry, findPlan } from '../lib/secrets.js';

const INSTALLATION_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

function failureResult(env) {
  return { httpStatus: 302, redirectUrl: env.ONBOARDING_FAILURE_URL || '/onboarding-failed.html' };
}

function pendingApprovalResult(env) {
  return { httpStatus: 302, redirectUrl: env.ONBOARDING_PENDING_APPROVAL_URL || '/onboarding-pending-approval.html' };
}

export async function handleInstallCallback(query, { now = Date.now(), fetchImpl = fetch, env = process.env, plans = loadPlansRegistry() } = {}) {
  const { installation_id: installationId, setup_action: setupAction, state } = query || {};

  // GitHub sends setup_action: 'request' (no installation_id at all) when
  // the installing user isn't an org owner and approval is still pending -
  // a distinct, non-error outcome, not a failure.
  if (setupAction === 'request') {
    return pendingApprovalResult(env);
  }

  if (!INSTALLATION_ID_PATTERN.test(String(installationId || ''))) return failureResult(env);

  const claims = verifyOnboardingToken(state, { now });
  if (!claims) return failureResult(env);

  const account = await confirmInstallationExists(installationId, {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    fetchImpl
  });
  if (!account) return failureResult(env); // revoked, App suspended, GitHub down, malformed config - fail closed, never proceed to payment

  // The plan chosen back at api/onboard_start.js (if any) travels forward
  // in the verified state claims - re-looked-up against the CURRENT
  // plans.json (not just trusted as a bare string) so a plan removed/
  // renamed between the two hops fails closed rather than redirecting
  // somewhere stale. No planId at all (a pre-multi-tier link, or a client
  // that skipped ?plan=) falls back to STRIPE_PAYMENT_LINK_URL for
  // backward compatibility. Either way, this only ever selects WHICH
  // Payment Link the browser is sent to next - Stripe's own hosted
  // checkout enforces the real price for that link, and
  // api/stripe_webhook.js independently re-derives the actual purchased
  // plan from the real Stripe price, never from this choice.
  let paymentLinkUrl = env.STRIPE_PAYMENT_LINK_URL;
  if (claims.planId) {
    const plan = findPlan(claims.planId, plans);
    if (!plan || !plan.stripePaymentLinkUrl) return failureResult(env);
    paymentLinkUrl = plan.stripePaymentLinkUrl;
  }
  if (!paymentLinkUrl) return failureResult(env);

  // Carries the CONFIRMED installation identity forward - never re-derived
  // from the original, less-trusted `state` claims alone - as a fresh
  // signed token used as the Stripe Payment Link's client_reference_id.
  // api/stripe_webhook.js verifies this same way before provisioning
  // anything.
  const checkoutToken = signOnboardingToken({
    onboardingId: claims.onboardingId,
    installationId: String(installationId),
    accountLogin: account.login
  }, { now });

  return { httpStatus: 302, redirectUrl: `${paymentLinkUrl}?client_reference_id=${encodeURIComponent(checkoutToken)}` };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const result = await handleInstallCallback(req.query || {});
  res.writeHead(result.httpStatus, { Location: result.redirectUrl });
  res.end();
}
