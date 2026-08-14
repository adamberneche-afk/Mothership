// Local verification harness for api/github_app_webhook.js - the
// proactive suspend/unsuspend path for GitHub App installation events.
//
// Usage: node scripts/dev-test-github-app-webhook.mjs

import { createHmac } from 'crypto';
import { handleGithubAppWebhook, verifyGithubWebhookSignature, readRawBody } from './../api/github_app_webhook.js';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

const WEBHOOK_SECRET = 'gh-webhook-test-secret';

function signedEvent(eventBody) {
  const payload = Buffer.from(JSON.stringify(eventBody));
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex')}`;
  return { rawBody: payload, signatureHeader: signature };
}

function installationEvent(action, installationId) {
  return { action, installation: { id: installationId } };
}

function makeFakeHubOctokitWithTenants(tenants) {
  const files = { 'tenants.json': { content: tenants, sha: 'tenants-sha-0' } };
  const calls = { getContent: [], createOrUpdateFileContents: [] };
  let shaCounter = 0;
  return {
    calls,
    files,
    repos: {
      getContent: async ({ path }) => {
        calls.getContent.push({ path });
        const file = files[path];
        if (!file) { const err = new Error('404 not found'); err.status = 404; throw err; }
        return { data: { content: Buffer.from(JSON.stringify(file.content)).toString('base64'), sha: file.sha } };
      },
      createOrUpdateFileContents: async (params) => {
        calls.createOrUpdateFileContents.push(params);
        const newContent = JSON.parse(Buffer.from(params.content, 'base64').toString('utf8'));
        shaCounter++;
        files[params.path] = { content: newContent, sha: `sha-${shaCounter}` };
        return { data: {} };
      }
    }
  };
}

// --- Tests -------------------------------------------------------------------

function testVerifyRejectsATamperedBody() {
  console.log('verifyGithubWebhookSignature rejects a tampered body');
  const { rawBody, signatureHeader } = signedEvent(installationEvent('deleted', 1));
  const tampered = Buffer.concat([rawBody, Buffer.from('x')]);
  check('rejected', verifyGithubWebhookSignature(tampered, signatureHeader, WEBHOOK_SECRET) === false);
}

function testVerifyRejectsWrongSecret() {
  console.log('verifyGithubWebhookSignature rejects a signature computed with the wrong secret');
  const { rawBody, signatureHeader } = signedEvent(installationEvent('deleted', 1));
  check('rejected', verifyGithubWebhookSignature(rawBody, signatureHeader, 'a-totally-different-secret') === false);
}

function testVerifyAcceptsARealSignature() {
  console.log('verifyGithubWebhookSignature accepts a correctly signed body');
  const { rawBody, signatureHeader } = signedEvent(installationEvent('deleted', 1));
  check('accepted', verifyGithubWebhookSignature(rawBody, signatureHeader, WEBHOOK_SECRET) === true);
}

async function testInstallationDeletedSuspendsTheMatchingTenant() {
  console.log('installation.deleted flips the matching tenant to status: suspended, suspendedReason: github_app_uninstalled');
  const { rawBody, signatureHeader } = signedEvent(installationEvent('deleted', 12345));
  const hubOctokit = makeFakeHubOctokitWithTenants([{ tenantId: 'ghapp-12345', name: 'acme', status: 'active', plan: 'standard', quota: { reviewsPerMonth: null }, githubCredentialRef: 'ghapp:12345', installationId: 12345, createdAt: '2026-08-13T00:00:00Z' }]);
  const result = await handleGithubAppWebhook(rawBody, signatureHeader, { webhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('reports Suspended', result.body.status === 'Suspended');
  const tenant = hubOctokit.files['tenants.json'].content.find(t => t.tenantId === 'ghapp-12345');
  check('tenant status is now suspended', tenant.status === 'suspended');
  check('suspendedReason is github_app_uninstalled', tenant.suspendedReason === 'github_app_uninstalled');
}

async function testInstallationSuspendBehavesTheSameAsDeleted() {
  console.log('installation.suspend behaves the same as deleted');
  const { rawBody, signatureHeader } = signedEvent(installationEvent('suspend', 22222));
  const hubOctokit = makeFakeHubOctokitWithTenants([{ tenantId: 'ghapp-22222', name: 'acme', status: 'active', plan: 'standard', quota: { reviewsPerMonth: null }, githubCredentialRef: 'ghapp:22222', installationId: 22222, createdAt: '2026-08-13T00:00:00Z' }]);
  const result = await handleGithubAppWebhook(rawBody, signatureHeader, { webhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('reports Suspended', result.body.status === 'Suspended');
  const tenant = hubOctokit.files['tenants.json'].content.find(t => t.tenantId === 'ghapp-22222');
  check('tenant status is now suspended with the same reason', tenant.status === 'suspended' && tenant.suspendedReason === 'github_app_uninstalled');
}

async function testInstallationUnsuspendRestoresOnlyWhenReasonMatches() {
  console.log('installation.unsuspend restores status: active only when suspendedReason was github_app_uninstalled');
  const { rawBody, signatureHeader } = signedEvent(installationEvent('unsuspend', 33333));
  const hubOctokit = makeFakeHubOctokitWithTenants([{ tenantId: 'ghapp-33333', name: 'acme', status: 'suspended', suspendedReason: 'github_app_uninstalled', plan: 'standard', quota: { reviewsPerMonth: null }, githubCredentialRef: 'ghapp:33333', installationId: 33333, createdAt: '2026-08-13T00:00:00Z' }]);
  const result = await handleGithubAppWebhook(rawBody, signatureHeader, { webhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('reports Restored', result.body.status === 'Restored');
  const tenant = hubOctokit.files['tenants.json'].content.find(t => t.tenantId === 'ghapp-33333');
  check('tenant status is active again', tenant.status === 'active');
  check('suspendedReason was cleared', tenant.suspendedReason === undefined);
}

async function testUnsuspendNeverOverridesAManualSuspension() {
  console.log('installation.unsuspend does NOT restore a tenant an operator suspended manually for a different/absent reason');
  const { rawBody, signatureHeader } = signedEvent(installationEvent('unsuspend', 44444));
  const hubOctokit = makeFakeHubOctokitWithTenants([{ tenantId: 'ghapp-44444', name: 'acme', status: 'suspended', suspendedReason: 'non_payment', plan: 'standard', quota: { reviewsPerMonth: null }, githubCredentialRef: 'ghapp:44444', installationId: 44444, createdAt: '2026-08-13T00:00:00Z' }]);
  const result = await handleGithubAppWebhook(rawBody, signatureHeader, { webhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('reports NotRestored', result.body.status === 'NotRestored');
  const tenant = hubOctokit.files['tenants.json'].content.find(t => t.tenantId === 'ghapp-44444');
  check('tenant is still suspended, for the same original reason', tenant.status === 'suspended' && tenant.suspendedReason === 'non_payment');
  check('no write happened at all for this no-op case', hubOctokit.calls.createOrUpdateFileContents.length === 0);
}

async function testUnrecognizedActionAcksWithoutWriting() {
  console.log('an unrecognized event action 200-acks without writing anything');
  const { rawBody, signatureHeader } = signedEvent(installationEvent('created', 55555));
  const hubOctokit = makeFakeHubOctokitWithTenants([]);
  const result = await handleGithubAppWebhook(rawBody, signatureHeader, { webhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('returns 200', result.httpStatus === 200);
  check('status is Ignored', result.body.status === 'Ignored');
  check('no write happened', hubOctokit.calls.createOrUpdateFileContents.length === 0);
}

async function testTamperedRequestNeverReachesTheRegistry() {
  console.log('a tampered/unsigned request is rejected before any registry read/write');
  const { rawBody } = signedEvent(installationEvent('deleted', 66666));
  const hubOctokit = makeFakeHubOctokitWithTenants([{ tenantId: 'ghapp-66666', name: 'acme', status: 'active', plan: 'standard', quota: { reviewsPerMonth: null }, githubCredentialRef: 'ghapp:66666', installationId: 66666, createdAt: '2026-08-13T00:00:00Z' }]);
  const result = await handleGithubAppWebhook(rawBody, 'sha256=wrong', { webhookSecret: WEBHOOK_SECRET, hubOctokit });
  check('returns 400', result.httpStatus === 400);
  check('no registry access happened at all', hubOctokit.calls.getContent.length === 0 && hubOctokit.calls.createOrUpdateFileContents.length === 0);
}

async function testReadRawBodyRejectsOversizedPayload() {
  console.log('readRawBody rejects a body over the max-byte cap');
  const { Readable } = await import('stream');
  const bigChunk = Buffer.alloc(2000, 'x');
  const req = new Readable({ read() { this.push(bigChunk); this.push(bigChunk); this.push(null); } });
  let threw = false;
  try {
    await readRawBody(req, { maxBytes: 1000 });
  } catch (e) {
    threw = true;
  }
  check('rejects', threw === true);
}

async function main() {
  testVerifyRejectsATamperedBody();
  testVerifyRejectsWrongSecret();
  testVerifyAcceptsARealSignature();
  await testInstallationDeletedSuspendsTheMatchingTenant();
  await testInstallationSuspendBehavesTheSameAsDeleted();
  await testInstallationUnsuspendRestoresOnlyWhenReasonMatches();
  await testUnsuspendNeverOverridesAManualSuspension();
  await testUnrecognizedActionAcksWithoutWriting();
  await testTamperedRequestNeverReachesTheRegistry();
  await testReadRawBodyRejectsOversizedPayload();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
