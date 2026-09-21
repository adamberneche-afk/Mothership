// Immediate post-checkout access to the Stripe Customer Portal. The
// operator configures each Payment Link's after-payment redirect (in the
// Stripe Dashboard) to
// `https://<host>/onboarding-success.html?session_id={CHECKOUT_SESSION_ID}`
// - Stripe's own documented templating for exactly this use case.
// dashboard/onboarding-success.html's inline script calls this endpoint
// with that session_id and, if it returns a portal link, redirects there.
//
// A session_id is a bearer credential for portal access once known - it's
// only ever delivered via the success redirect URL itself, the same trust
// model Stripe's own official Customer Portal integration guide uses. This
// endpoint bounds that exposure explicitly: a portal link is only ever
// minted for a session within ~24h of its own `created` timestamp (a
// forwarded/bookmarked/logged old success URL stops working on its own,
// the same "leaked-but-expired" defense lib/onboarding_token.js already
// uses for the onboarding state token).
//
// Verifies real payment before minting anything - payment_status must be
// 'paid', never just "the browser reached this URL" (the exact mistake
// api/stripe_webhook.js's own header comment already warns against for
// onboarding-success.html itself).

export async function getPortalLinkForSession(sessionId, {
  stripeClient,
  now = Date.now(),
  dashboardBaseUrl = process.env.DASHBOARD_BASE_URL,
  maxAgeMs = 24 * 60 * 60 * 1000
} = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'missing session_id' };
  }
  if (!dashboardBaseUrl) {
    // A portal session requires a return_url - refusing loudly (via the
    // caller's error response) rather than guessing one is the same
    // "disclosed gap over silent one" choice as buildSuspensionEmail's
    // fallback in api/github_app_webhook.js.
    return { ok: false, reason: 'DASHBOARD_BASE_URL is not configured' };
  }

  let session;
  try {
    session = await stripeClient.checkout.sessions.retrieve(sessionId);
  } catch (e) {
    return { ok: false, reason: 'could not retrieve session' };
  }
  if (!session || session.payment_status !== 'paid') {
    return { ok: false, reason: 'session is not a paid checkout' };
  }
  if (!session.customer) {
    return { ok: false, reason: 'session has no associated customer' };
  }

  const createdMs = (session.created || 0) * 1000; // Stripe timestamps are in seconds
  if (now - createdMs > maxAgeMs) {
    return { ok: false, reason: 'session_id has expired for portal access' };
  }

  try {
    const portalSession = await stripeClient.billingPortal.sessions.create({
      customer: session.customer,
      return_url: `${dashboardBaseUrl}/install.html`
    });
    return { ok: true, url: portalSession.url };
  } catch (e) {
    return { ok: false, reason: 'could not create a portal session' };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const sessionId = req.query && req.query.session_id;
  const { default: Stripe } = await import('stripe');
  const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_missing');
  const result = await getPortalLinkForSession(sessionId, { stripeClient });
  if (!result.ok) {
    res.status(400).json({ error: result.reason });
    return;
  }
  res.status(200).json({ url: result.url });
}
