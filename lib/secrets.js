// Canonical tenant-registry + credential-resolution helpers, extracted from
// what used to be 6 byte-identical Node-side copies of the same functions:
// api/autonomous_agent.js, api/recursive_learning.js, scripts/doctor.js,
// scripts/health-report.js, scripts/prune-logs.js,
// scripts/collect-issue-feedback.js (plus matching embedded string-literal
// copies inside setup_hub.py, kept re-synced - see that file's generated
// file list).
//
// resolveSecretRef is async as of the ghapp: scheme below (minting an
// installation token is a real network call, via lib/github_app.js) -
// every call site now needs `await`. Confirmed call sites at the time of
// this change: api/autonomous_agent.js (callerKeyRef + githubCredentialRef
// resolution), api/recursive_learning.js's runForTenant and
// runForSharedPool, and scripts/doctor.js/health-report.js/prune-logs.js/
// collect-issue-feedback.js's resolveOctokitForSpoke-style helpers.
//
// gas/constants.js stays the separate, synchronous GAS-side home for this
// same logic (Apps Script has no `import`, so it can't use this module
// directly, and has no asymmetric-RSA-sign primitive either - ghapp: is
// Vercel-only this sprint, disclosed in README) - it cross-references this
// file as the canonical Node behavior spec, same convention
// gas/autonomous_agent.js already uses for api/autonomous_agent.js.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { mintInstallationToken } from './github_app.js';

export const SPOKES_REGISTRY_PATH = 'spokes.json';
export const TENANTS_REGISTRY_PATH = 'tenants.json';
export const PLANS_REGISTRY_PATH = 'plans.json';
export const DEFAULT_TENANT_ID = 'default';

// Reads a hub-root JSON file straight off local disk (every Node caller of
// this module runs with this repo checked out alongside it - a Vercel
// function's own deployment, or a GitHub Actions job). Missing file,
// unreadable, or not a JSON array all come back as [] rather than
// throwing - callers treat an empty registry as "nothing registered yet",
// not an error.
export function loadJsonArrayFromDisk(relativePath) {
  const fullPath = join(process.cwd(), relativePath);
  if (!existsSync(fullPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

export function loadSpokesRegistry() {
  return loadJsonArrayFromDisk(SPOKES_REGISTRY_PATH);
}

export function loadTenantsRegistry() {
  return loadJsonArrayFromDisk(TENANTS_REGISTRY_PATH);
}

// plans.json (hub root, git-committed, non-secret - Stripe price IDs and
// Payment Link URLs aren't sensitive, same reasoning tenants.json/
// spokes.json already establish for config-as-committed-data) is the
// source of truth for real multi-tier pricing: one entry per tier,
// {planId, name, stripePriceId, stripePaymentLinkUrl, reviewsPerMonth}. The
// operator creates the actual Stripe Prices/Payment Links by hand and fills
// this in to match - see README's setup steps.
export function loadPlansRegistry() {
  return loadJsonArrayFromDisk(PLANS_REGISTRY_PATH);
}

export function findPlan(planId, plans) {
  return plans.find(p => p && p.planId === planId) || null;
}

export function findPlanByStripePriceId(stripePriceId, plans) {
  return plans.find(p => p && p.stripePriceId === stripePriceId) || null;
}

// Finds which tenant a given owner/repo belongs to. Falls back to
// DEFAULT_TENANT_ID for anything not found in spokes.json - a deliberate
// backward-compatibility choice, not a security feature: it preserves the
// original zero-registration behavior for spokes nobody has migrated into
// the tenant model yet.
export function resolveTenantIdForSpoke(owner, repo, spokes) {
  const match = spokes.find(s => s && s.owner === owner && s.repo === repo);
  return (match && match.tenantId) || DEFAULT_TENANT_ID;
}

export function findTenant(tenantId, tenants) {
  return tenants.find(t => t && t.tenantId === tenantId) || null;
}

// githubCredentialRef/callerKeyRef use a `scheme:value` format:
//   env:VAR_NAME - reads an env var directly. This is what keeps the
//     "default" tenant working exactly as before with zero migration -
//     tenants.json seeds it with "env:GLOBAL_GITHUB_TOKEN".
//   kv:some/path - reserved for a future non-GitHub-credential secret. A
//     git-committed JSON file can't hold a raw secret without permanently
//     leaking it into git history, so this scheme has no local fallback.
//   ghapp:<installation_id> - mints a short-lived GitHub App installation
//     token via lib/github_app.js. The installation id itself is NOT
//     sensitive (it's a non-exploitable pointer, safe to commit in
//     tenants.json in plaintext, same as "env:GLOBAL_GITHUB_TOKEN" is safe
//     today) - the only secret is the App's own private key
//     (GITHUB_APP_PRIVATE_KEY), one operator-held env var at the same
//     trust tier GLOBAL_GITHUB_TOKEN already occupies.
//
// Every failure mode - malformed ref, missing App config, a revoked or
// suspended installation, GitHub unreachable - resolves to `null` here,
// never a thrown exception and never a fallback to a broader credential.
// Enforcing that the calling tenant is actually allowed to use this
// credential (status === 'active') is the CALLER's job, same as it already
// is for env: - this function only resolves a ref, it doesn't gate access.
export async function resolveSecretRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] || null;
  if (ref.startsWith('kv:')) return null; // see the scheme comment above
  if (ref.startsWith('ghapp:')) {
    return mintInstallationToken(ref.slice(6), {
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY
    });
  }
  return null;
}
