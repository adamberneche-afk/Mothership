// Ongoing Customer Portal access for a returning customer who no longer
// has their original success-redirect link (see
// api/customer_portal_link.js's header comment for that immediate path).
// dashboard/manage.html posts a plain email address here.
//
// The core anti-enumeration property, stated explicitly: this ALWAYS
// returns the identical response regardless of whether the email matches
// a real Stripe customer - never turning "check if this address has an
// account" into a working customer-existence oracle. A match silently
// gets a fresh portal link emailed to them (reusing lib/email.js, the same
// fail-soft capability api/github_app_webhook.js's suspension notice
// already uses); a non-match gets nothing, and neither case is
// distinguishable from the response alone.
//
// Rate-limited by email, best-effort only - an in-memory Map keyed by
// normalized email, scoped to a single warm serverless instance. Disclosed
// limitation, not overclaimed: this does NOT protect against a burst
// spread across multiple cold-started instances or multiple IPs. A real,
// distributed rate limiter is real follow-up work if abuse is observed;
// this is a cheap first layer, not a promise of one.

import { sendEmail } from '../lib/email.js';

const DEFAULT_RATE_LIMIT_STATE = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 request per email per minute, best-effort

const GENERIC_RESPONSE = {
  status: 'Requested',
  message: "If that email has an account, we've sent a link to manage your subscription."
};

export async function handleRequestPortalLink({ email }, {
  stripeClient,
  sendEmailImpl = sendEmail,
  dashboardBaseUrl = process.env.DASHBOARD_BASE_URL,
  now = Date.now(),
  rateLimitState = DEFAULT_RATE_LIMIT_STATE,
  rateLimitWindowMs = RATE_LIMIT_WINDOW_MS
} = {}) {
  // Malformed/missing input still gets the identical generic response -
  // there's nothing more specific to leak here either, and it keeps the
  // "one response, always" property simple to reason about.
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return GENERIC_RESPONSE;
  }

  const normalizedEmail = email.trim().toLowerCase();

  const lastRequestAt = rateLimitState.get(normalizedEmail);
  if (lastRequestAt !== undefined && now - lastRequestAt < rateLimitWindowMs) {
    return GENERIC_RESPONSE; // rate-limited - still the identical response, nothing leaked
  }
  rateLimitState.set(normalizedEmail, now);

  if (!dashboardBaseUrl) return GENERIC_RESPONSE; // nothing to build a return_url from - fail soft

  try {
    const customers = await stripeClient.customers.list({ email: normalizedEmail, limit: 1 });
    const customer = customers && customers.data && customers.data[0];
    if (customer) {
      const portalSession = await stripeClient.billingPortal.sessions.create({
        customer: customer.id,
        return_url: `${dashboardBaseUrl}/install.html`
      });
      await sendEmailImpl({
        to: normalizedEmail,
        subject: 'Manage your Mothership subscription',
        html: `<p>Here's your link to manage your Mothership subscription:</p><p><a href="${portalSession.url}">Manage subscription</a></p><p>This link is personal and time-limited - don't share it. If you didn't request this, you can ignore this email.</p>`
      });
    }
  } catch (e) {
    // Fail-soft, and deliberately no different a response than "not found"
    // - a Stripe/email failure must not be distinguishable from a genuine
    // non-match either.
  }

  return GENERIC_RESPONSE;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const { default: Stripe } = await import('stripe');
  const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_missing');
  const result = await handleRequestPortalLink(req.body || {}, { stripeClient });
  res.status(200).json(result);
}
