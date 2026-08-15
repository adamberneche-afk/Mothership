// GitHub's own App-level webhook - handles `installation` events
// (deleted/suspend/unsuspend). lib/github_app.js's mintInstallationToken/
// lib/secrets.js's ghapp: scheme already fail closed the moment a revoked
// installation's credential is next resolved (a hard skip, never a
// fallback) - so there is no functional security gap this endpoint closes;
// that lazy path was already correct on its own. What this endpoint
// actually adds is operator-facing clarity: without it, a revoked
// installation just surfaces as a perpetual, ambiguous credential-
// resolution failure (indistinguishable from a misconfigured App ID or a
// transient GitHub outage) until someone investigates. With it, the
// matching tenant is flipped to `status: 'suspended'` with a named
// `suspendedReason` the moment GitHub reports the revocation - immediate
// and legible, rather than eventually-and-unexplained.
//
// HMAC-verified via GITHUB_APP_WEBHOOK_SECRET, same raw-body/no-bodyParser
// discipline as api/stripe_webhook.js (GitHub's signature is computed over
// the exact raw bytes too).
//
// Deliberately conservative on `unsuspend`: only restores a tenant to
// `active` if `suspendedReason` was specifically set by THIS webhook
// (`github_app_uninstalled`) - never silently undoes a status an operator
// set manually for an unrelated reason (e.g. non-payment, abuse). An
// operator's manual suspension always wins.
//
// A suspended tenant otherwise gets zero notification of any kind - they'd
// only discover it when Mothership silently stops working. On a genuinely
// new suspension (never on AlreadySuspended - no point re-notifying), this
// resolves the tenant's email via Stripe (their stripeCustomerId is
// already recorded on the tenant record from api/stripe_webhook.js's
// provisioning) and sends a calm, specific, actionable notice via
// lib/email.js. Fail-soft throughout, matching that module's own
// contract: a Stripe lookup failure or an email-send failure is logged and
// swallowed, never turned into a failure of this webhook's own response -
// a customer not getting an email is a real, but lesser, gap than this
// webhook 500ing over a third-party API having a bad day.

import { createHmac, timingSafeEqual } from 'crypto';
import Stripe from 'stripe';
import { updateJsonRegistryEntryWithRetry } from '../lib/registry_writer.js';
import { sendEmail } from '../lib/email.js';

export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 1_000_000;
const REVOCATION_REASON = 'github_app_uninstalled';

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

export function verifyGithubWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const provided = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return false;
  return timingSafeEqual(provided, expectedBuf);
}

// Pure - the actual email content, built as its own function so it's
// testable without a real Stripe client or mail send.
export function buildSuspensionEmail(tenant, { dashboardBaseUrl = process.env.DASHBOARD_BASE_URL } = {}) {
  const reinstallLine = dashboardBaseUrl
    ? `Reinstall the GitHub App from <a href="${dashboardBaseUrl}/install.html">the install page</a> to restore access.`
    : 'Reinstall the GitHub App on your GitHub organization to restore access.';
  return {
    subject: 'Your Mothership access has been suspended',
    html: `<p>Hi${tenant.name ? ` ${tenant.name}` : ''},</p>
<p>Mothership's access to your repositories was suspended because the GitHub App was uninstalled or suspended on GitHub's side.</p>
<p>${reinstallLine} If this wasn't you, or you have questions, just reply to this email.</p>`
  };
}

// Best-effort, never throws - see this file's header comment for the
// fail-soft contract. Returns the same {sent, reason?} shape
// lib/email.js's sendEmail already uses, plus a distinguishable
// 'no stripeCustomerId'/'no email on file' reason for the cases that never
// even reach sendEmail.
async function notifySuspendedTenant(tenant, { stripeClient, sendEmailImpl = sendEmail, dashboardBaseUrl } = {}) {
  if (!tenant.stripeCustomerId) return { sent: false, reason: 'tenant has no stripeCustomerId on record' };
  try {
    const customer = await stripeClient.customers.retrieve(tenant.stripeCustomerId);
    if (!customer || customer.deleted || !customer.email) {
      return { sent: false, reason: 'no email on file for this Stripe customer' };
    }
    const { subject, html } = buildSuspensionEmail(tenant, { dashboardBaseUrl });
    return await sendEmailImpl({ to: customer.email, subject, html });
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

export async function handleGithubAppWebhook(rawBody, signatureHeader, {
  webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET,
  hubOctokit,
  hubOwner = process.env.HUB_GITHUB_OWNER || 'adamberneche-afk',
  hubRepo = process.env.HUB_GITHUB_REPO || 'Mothership',
  stripeClient,
  stripeSecretKey = process.env.STRIPE_SECRET_KEY,
  sendEmailImpl = sendEmail,
  dashboardBaseUrl = process.env.DASHBOARD_BASE_URL
} = {}) {
  if (!verifyGithubWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    return { httpStatus: 400, body: { error: 'invalid signature' } };
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return { httpStatus: 400, body: { error: 'invalid JSON' } };
  }

  const installationId = event && event.installation && event.installation.id;
  if (!installationId || !['deleted', 'suspend', 'unsuspend'].includes(event.action)) {
    return { httpStatus: 200, body: { status: 'Ignored', reason: `unhandled action ${event && event.action}` } };
  }

  const tenantId = `ghapp-${installationId}`;
  const find = (tenants) => tenants.findIndex((t) => t && t.tenantId === tenantId);

  if (event.action === 'deleted' || event.action === 'suspend') {
    const result = await updateJsonRegistryEntryWithRetry(hubOctokit, hubOwner, hubRepo, 'tenants.json', {
      message: `chore: suspend tenant ${tenantId} (GitHub App ${event.action})`,
      find,
      update: (tenant) => {
        if (tenant.status === 'suspended') return null; // already suspended - nothing to change
        return { ...tenant, status: 'suspended', suspendedReason: REVOCATION_REASON };
      }
    });
    if (!result.found) return { httpStatus: 200, body: { status: 'Ignored', reason: `no tenant found for installation ${installationId}` } };
    let notification;
    if (result.changed) {
      // Only on a genuinely NEW suspension - never re-notify on
      // AlreadySuspended, and never let this delay or fail the response
      // above (the tenants.json write already succeeded).
      const stripe = stripeClient || new Stripe(stripeSecretKey || 'sk_missing');
      notification = await notifySuspendedTenant(result.entry, { stripeClient: stripe, sendEmailImpl, dashboardBaseUrl });
    }
    return { httpStatus: 200, body: { status: result.changed ? 'Suspended' : 'AlreadySuspended', tenantId, ...(notification ? { notification } : {}) } };
  }

  // event.action === 'unsuspend'
  const result = await updateJsonRegistryEntryWithRetry(hubOctokit, hubOwner, hubRepo, 'tenants.json', {
    message: `chore: restore tenant ${tenantId} (GitHub App unsuspend)`,
    find,
    update: (tenant) => {
      // Only restore if THIS webhook is what suspended it - never override
      // an operator's own, unrelated manual suspension.
      if (tenant.suspendedReason !== REVOCATION_REASON) return null;
      const { suspendedReason, ...rest } = tenant;
      return { ...rest, status: 'active' };
    }
  });
  if (!result.found) return { httpStatus: 200, body: { status: 'Ignored', reason: `no tenant found for installation ${installationId}` } };
  return { httpStatus: 200, body: { status: result.changed ? 'Restored' : 'NotRestored', tenantId } };
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
  const signatureHeader = req.headers['x-hub-signature-256'];
  const { Octokit } = await import('@octokit/rest');
  const hubOctokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
  const result = await handleGithubAppWebhook(rawBody, signatureHeader, { hubOctokit });
  res.status(result.httpStatus).json(result.body);
}
