// Operator-driven manual tenant provisioning - the escape hatch for
// everything self-service (api/onboard_start.js -> api/github_app_callback.js
// -> api/stripe_webhook.js) can't cover: plan changes, manual suspension,
// or a tenant who can't use a GitHub App at all and needs an `env:`-scoped
// credential set up by hand. Not the primary onboarding path any more -
// that's the self-service flow - but necessary as a correction/override
// tool, and it's what closes the loop on `tenant.status` actually
// mattering (api/autonomous_agent.js's tenant-status gate).
//
// CLI surface: no argument-parsing convention exists anywhere else in this
// repo (every other admin script reads config from env vars only) - this
// is the first, kept deliberately minimal: hand-parsed named flags, no new
// dependency (no commander/yargs).
//
//   node scripts/provision-tenant.js \
//     --tenant-id acme --name "Acme Corp" --plan pro \
//     --credential-ref ghapp:12345678 \
//     [--quota 100] [--caller-key-ref env:ACME_CALLER_KEY] \
//     [--status active] [--spoke owner/repo ...] [--dry-run]
//
// Trust model: writes DIRECTLY to the local tenants.json/spokes.json on
// disk (no PR), same as scripts/prune-logs.js's own direct-write
// precedent. recursive_learning.js's PR-gate exists specifically to put a
// human between UNTRUSTED, AI-generated content and the repo - an
// operator running this CLI by hand, with their own already-trusted
// credentials, already IS that human. Routing an already-reviewed,
// operator-driven change through a review gate would add process with no
// added safety.

import { writeFileSync } from 'fs';
import { loadTenantsRegistry, loadSpokesRegistry, resolveSecretRef } from '../lib/secrets.js';

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CREDENTIAL_SCHEME_PATTERN = /^(env|ghapp|kv):(.*)$/;
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
// Common live-token shapes an operator might mistakenly paste where an
// env: var NAME belongs - a concrete, code-level enforcement of the
// already-documented "never commit a raw credential into tenants.json"
// rule, catching the exact mistake before it becomes a permanent, public
// git-history leak.
const RAW_TOKEN_SHAPE_PATTERN = /^(ghp_|github_pat_|gho_|ghs_|ghu_|sk-)/;
const MAX_ENV_VAR_NAME_LENGTH = 64;
const GHAPP_ID_PATTERN = /^[1-9][0-9]{0,15}$/;
const VALID_STATUSES = ['active', 'suspended'];
const SPOKE_PATTERN = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

function validateCredentialRefShape(ref, fieldName, errors) {
  if (typeof ref !== 'string' || !ref) {
    errors.push(`${fieldName} is required`);
    return;
  }
  const match = ref.match(CREDENTIAL_SCHEME_PATTERN);
  if (!match) {
    errors.push(`${fieldName} must start with env:, ghapp:, or kv: (got '${ref}')`);
    return;
  }
  const [, scheme, value] = match;
  if (scheme === 'kv') {
    errors.push(`${fieldName}: kv: scheme is not implemented yet - see lib/secrets.js`);
    return;
  }
  if (scheme === 'env') {
    // Checked BEFORE the generic name-shape check, and case-insensitively -
    // a value that looks like an actual live credential is a more urgent,
    // more specific problem than a naming-convention mismatch, and must
    // never be masked by the generic "doesn't look like a real env var
    // name" message.
    if (value.length > MAX_ENV_VAR_NAME_LENGTH || RAW_TOKEN_SHAPE_PATTERN.test(value)) {
      errors.push(`${fieldName}: '${value}' looks like it might be a raw token pasted where a variable NAME belongs - never commit a raw credential into tenants.json`);
      return;
    }
    if (!ENV_VAR_NAME_PATTERN.test(value)) {
      errors.push(`${fieldName}: 'env:${value}' doesn't look like a real environment-variable name`);
    }
    return;
  }
  if (scheme === 'ghapp' && !GHAPP_ID_PATTERN.test(value)) {
    errors.push(`${fieldName}: 'ghapp:${value}' is not a valid installation id`);
  }
}

// Pure validation, no I/O - takes the caller's already-loaded registries
// so it's trivially testable and reusable from a dry-run.
export function validateTenantInput(input, { existingTenants = [], existingSpokes = [] } = {}) {
  const errors = [];

  if (!input.tenantId || !TENANT_ID_PATTERN.test(input.tenantId)) {
    errors.push(`tenant-id must match ${TENANT_ID_PATTERN} (got '${input.tenantId}')`);
  } else if (existingTenants.some((t) => t && typeof t.tenantId === 'string' && t.tenantId.toLowerCase() === input.tenantId.toLowerCase())) {
    errors.push(`tenant-id '${input.tenantId}' already exists (case-insensitive match)`);
  }

  if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
    errors.push('name is required');
  } else if (/[\n\r`]/.test(input.name)) {
    // tenant.name is embedded raw into a hub-authored PR body in
    // api/recursive_learning.js - an unsanitized name is a real, if minor,
    // Markdown/PR-body injection surface into a PR the hub opens against
    // itself.
    errors.push('name must not contain newlines or backticks');
  }

  const status = input.status || 'active';
  if (!VALID_STATUSES.includes(status)) {
    errors.push(`status must be one of ${VALID_STATUSES.join(', ')} (got '${status}')`);
  }

  if (!input.plan || typeof input.plan !== 'string' || !input.plan.trim()) {
    errors.push('plan is required');
  }

  let reviewsPerMonth = null;
  if (input.quota !== undefined && input.quota !== null && input.quota !== '') {
    const n = Number(input.quota);
    if (!Number.isInteger(n) || n < 1) {
      errors.push(`quota must be a positive integer or omitted for unlimited (got '${input.quota}')`);
    } else {
      reviewsPerMonth = n;
    }
  }

  validateCredentialRefShape(input.credentialRef, 'credential-ref', errors);
  if (input.credentialRef && CREDENTIAL_SCHEME_PATTERN.test(input.credentialRef)) {
    const [, scheme, value] = input.credentialRef.match(CREDENTIAL_SCHEME_PATTERN);
    if (scheme === 'ghapp' && GHAPP_ID_PATTERN.test(value)) {
      const alreadyUsed = existingTenants.find((t) => t && t.githubCredentialRef === `ghapp:${value}`);
      if (alreadyUsed) errors.push(`ghapp:${value} is already used by tenant '${alreadyUsed.tenantId}' - one installation, one tenant`);
    }
  }

  if (input.callerKeyRef) {
    validateCredentialRefShape(input.callerKeyRef, 'caller-key-ref', errors);
  }

  const spokesToAdd = [];
  for (const spokeArg of input.spokes || []) {
    const match = SPOKE_PATTERN.exec(spokeArg);
    if (!match) {
      errors.push(`--spoke '${spokeArg}' must be in owner/repo form`);
      continue;
    }
    const [, owner, repo] = match;
    const existing = existingSpokes.find((s) => s && s.owner === owner && s.repo === repo);
    if (existing && existing.tenantId !== input.tenantId) {
      errors.push(`spoke ${owner}/${repo} is already registered to a different tenant ('${existing.tenantId}')`);
      continue;
    }
    if (existing) continue; // already belongs to this exact tenant - nothing to add
    spokesToAdd.push({ owner, repo });
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    tenant: {
      tenantId: input.tenantId,
      name: input.name.trim(),
      status,
      plan: input.plan.trim(),
      quota: { reviewsPerMonth },
      githubCredentialRef: input.credentialRef,
      ...(input.callerKeyRef ? { callerKeyRef: input.callerKeyRef } : {}),
      createdAt: new Date(input.now || Date.now()).toISOString()
    },
    spokesToAdd
  };
}

// Pure - takes/returns data, never touches fs. The CLI block below does
// the actual read-from-disk/write-to-disk.
export function provisionTenant(input, { existingTenants = [], existingSpokes = [] } = {}) {
  const validation = validateTenantInput(input, { existingTenants, existingSpokes });
  if (!validation.valid) return { status: 'Invalid', errors: validation.errors };

  const spokeEntries = validation.spokesToAdd.map((s) => ({
    tenantId: input.tenantId,
    owner: s.owner,
    repo: s.repo,
    addedAt: new Date(input.now || Date.now()).toISOString(),
    status: 'active'
  }));

  if (input.dryRun) {
    return { status: 'DryRun', tenant: validation.tenant, spokesToAdd: spokeEntries };
  }

  return {
    status: 'Provisioned',
    tenant: validation.tenant,
    spokesToAdd: spokeEntries,
    tenantsJson: [...existingTenants, validation.tenant],
    spokesJson: [...existingSpokes, ...spokeEntries]
  };
}

// --- CLI-only from here down ------------------------------------------------

function parseArgs(argv) {
  const input = { spokes: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--tenant-id': input.tenantId = next(); break;
      case '--name': input.name = next(); break;
      case '--plan': input.plan = next(); break;
      case '--credential-ref': input.credentialRef = next(); break;
      case '--caller-key-ref': input.callerKeyRef = next(); break;
      case '--quota': input.quota = next(); break;
      case '--status': input.status = next(); break;
      case '--spoke': input.spokes.push(next()); break;
      case '--dry-run': input.dryRun = true; break;
      default:
        console.error(`unrecognized argument: ${arg}`);
        process.exitCode = 1;
        return null;
    }
  }
  return input;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = parseArgs(process.argv.slice(2));
  if (input) {
    const existingTenants = loadTenantsRegistry();
    const existingSpokes = loadSpokesRegistry();
    const result = provisionTenant(input, { existingTenants, existingSpokes });

    if (result.status === 'Invalid') {
      console.error('Validation failed:');
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exitCode = 1;
    } else if (result.status === 'DryRun') {
      console.log('Dry run - nothing written. Would create:');
      console.log(JSON.stringify(result.tenant, null, 2));
      if (result.spokesToAdd.length) console.log('And register spokes:', JSON.stringify(result.spokesToAdd, null, 2));
    } else {
      writeFileSync('tenants.json', JSON.stringify(result.tenantsJson, null, 2) + '\n');
      writeFileSync('spokes.json', JSON.stringify(result.spokesJson, null, 2) + '\n');
      console.log(`Provisioned tenant '${result.tenant.tenantId}'${result.spokesToAdd.length ? ` with ${result.spokesToAdd.length} spoke(s)` : ''}.`);
      console.log('tenants.json/spokes.json updated on disk - review and commit:');
      console.log('  git add tenants.json spokes.json');
      console.log(`  git commit -m "chore: provision tenant ${result.tenant.tenantId}"`);
      console.log('  git push');
    }
  }
}
