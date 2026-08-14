// GitHub's own App-level webhook - handles `installation` events
// (deleted/suspend/unsuspend) to make credential revocation PROACTIVE
// rather than only lazy. lib/github_app.js's mintInstallationToken/
// lib/secrets.js's ghapp: scheme already fail closed the next time a
// revoked installation's credential is resolved (a hard skip, never a
// fallback) - this endpoint makes that immediate: as soon as GitHub tells
// us an installation was removed or suspended, the matching tenant is
// flipped to `status: 'suspended'` right away, before any request would
// have hit the lazy failure path at all.
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

import { createHmac, timingSafeEqual } from 'crypto';
import { updateJsonRegistryEntryWithRetry } from '../lib/registry_writer.js';

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

export async function handleGithubAppWebhook(rawBody, signatureHeader, {
  webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET,
  hubOctokit,
  hubOwner = process.env.HUB_GITHUB_OWNER || 'adamberneche-afk',
  hubRepo = process.env.HUB_GITHUB_REPO || 'Mothership'
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
    return { httpStatus: 200, body: { status: result.changed ? 'Suspended' : 'AlreadySuspended', tenantId } };
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
