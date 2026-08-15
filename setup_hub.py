import os
import subprocess

def setup_hub():
    print("Initializing the AI Mothership (Hub)...")

    # Define the core files for the Hub
    hub_files = [
        # 1. THE UNIVERSAL CONTEXT
        {
            "path": "universal_lessons.md",
            "content": "# Universal Engineering Standards\n\n- **Security**: Never commit API keys; use environment variables.\n- **Quality**: All code must be typed (TypeScript) or linted.\n- **Architecture**: Prefer flat logic over deep nesting.\n- **Documentation**: Every Spoke must maintain a NORTH_STAR.md."
        },
        {
            "path": "north_star_framework.md",
            "content": "# Global North Star Framework\n\n## Core Values\n- **Efficiency without Anxiety**: UX should feel fast and calm.\n- **Invisible Complexity**: The AI handles the mess; the user sees the magic.\n- **Forgiving Design**: Always provide a path to undo or go back."
        },
        {
            "path": "spokes.json",
            "content": "[]"
        },
        {
            # Multi-tenancy registry (see lessons.md's multi-tenancy entry).
            # Starts empty - a fresh hub has zero spokes and needs no tenant
            # entries yet. Every script that resolves a tenant's credential
            # falls back to GLOBAL_GITHUB_TOKEN when no tenant is found, so
            # an empty registry here is fully backward-compatible with the
            # single-tenant, zero-config setup this installer has always
            # produced.
            "path": "tenants.json",
            "content": "[]"
        },
        {
            # Real multi-tier pricing registry (see lib/secrets.js's
            # loadPlansRegistry/findPlan/findPlanByStripePriceId). Starts
            # empty - a fresh hub has no Stripe Prices/Payment Links
            # created yet. The operator creates the real Stripe Prices/
            # Payment Links by hand (a manual, business-side step, same
            # pattern as GitHub App registration) and fills this file in to
            # match before self-service onboarding can complete a checkout -
            # see README's setup steps.
            "path": "plans.json",
            "content": "[]"
        },

        # Canonical tenant-registry + credential-resolution helpers (see
        # lib/secrets.js's own header comment) - lives outside api/ and
        # scripts/ since every Node-side entry point imports from it.
        {
            "path": "lib/secrets.js",
            "content": """// Canonical tenant-registry + credential-resolution helpers, extracted from
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
}"""
        },

        # GitHub App JWT/installation-token minting - see that file's own
        # header comment for the design rationale.
        {
            "path": "lib/github_app.js",
            "content": """// Mints short-lived GitHub App installation access tokens - the backing
// implementation for lib/secrets.js's `ghapp:<installation_id>` scheme.
//
// Uses @octokit/auth-app (official, same vendor family as this repo's only
// other dependency, @octokit/rest) rather than hand-rolling RS256 JWT
// signing or adding a generic JWT library - it already handles JWT
// construction, the installation-token exchange, and expiry-aware caching
// (an internal LRU, see its own README's "Implementation details") so
// there's materially less hand-written crypto/cache code in this repo to
// audit than either alternative.
//
// Fail-closed contract, matching resolveSecretRef's existing rule for a
// broken env: ref: every failure mode here (missing/malformed App
// credentials, a revoked or suspended installation, GitHub unreachable)
// resolves to `null`, never a thrown exception a caller has to remember to
// catch and never a fallback to a broader credential. Enforcing the tenant
// is actually allowed to use this credential (status === 'active') is the
// caller's job, same as it already is for env: - this module has no
// concept of tenants.json at all.

import { createAppAuth } from '@octokit/auth-app';

const INSTALLATION_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

// One createAppAuth instance per distinct (appId, privateKey) pair,
// reused across calls so its internal token cache/expiry-refresh logic
// actually gets to do its job instead of re-minting on every call. Keyed
// by both fields (not just appId) so a test harness swapping in a
// different fake key per scenario never accidentally reuses another
// scenario's cached auth instance/token.
const authInstances = new Map();

function getAppAuth({ appId, privateKey, request }) {
  const key = `${appId}::${privateKey}`;
  let instance = authInstances.get(key);
  if (!instance) {
    instance = createAppAuth({ appId, privateKey, request });
    authInstances.set(key, instance);
  }
  return instance;
}

// GitHub App private keys are routinely mangled by copy/paste through an
// env-var UI (Vercel, GitHub Actions secrets) that doesn't preserve real
// newlines - a PEM pasted or templated in often arrives with literal
// backslash-n sequences instead. Normalize before handing it to
// @octokit/auth-app, and return null (never throw) if what's left still
// doesn't look like a PEM - a malformed key must fail closed exactly like
// any other unresolvable credential, not crash the request path.
export function normalizePrivateKeyPem(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const pem = raw.includes('\\\\n') ? raw.replace(/\\\\n/g, '\\n') : raw;
  const looksLikePem = /-----BEGIN (RSA )?PRIVATE KEY-----[\\s\\S]+-----END (RSA )?PRIVATE KEY-----/.test(pem);
  return looksLikePem ? pem : null;
}

// Mints (or returns a still-valid cached) installation access token.
// Returns the token string, or null on ANY failure - malformed
// installationId, missing App config, a revoked/uninstalled installation,
// an App suspended by GitHub, or GitHub simply being unreachable. Callers
// must treat null exactly like a broken env: ref: a hard skip, never a
// fallback to a wider credential.
export async function mintInstallationToken(installationId, { appId, privateKey, request } = {}) {
  if (!INSTALLATION_ID_PATTERN.test(String(installationId || ''))) return null;
  if (!appId) return null;
  const normalizedKey = normalizePrivateKeyPem(privateKey);
  if (!normalizedKey) return null;
  try {
    const auth = getAppAuth({ appId, privateKey: normalizedKey, request });
    const authentication = await auth({ type: 'installation', installationId: Number(installationId) });
    return (authentication && authentication.token) || null;
  } catch (e) {
    // Covers every failure mode uniformly: 404 (revoked/uninstalled), 401/403
    // (bad App credentials or a suspended App), malformed key rejected by
    // the signing step, network/5xx errors. None of these should ever
    // surface as an uncaught exception up through resolveSecretRef.
    return null;
  }
}

// Confirms an installation is real and currently active, authenticated as
// the App itself (a JWT, via auth({type: 'app'})) rather than trusting a
// browser-supplied installation_id query-string value - this is the
// second half of api/github_app_callback.js's defense against a crafted
// URL naming an arbitrary installation_id (the first half is the signed
// state token). Returns the installation's `account` info (login/id/type)
// on success, or null on ANY failure (malformed id, missing config,
// revoked/uninstalled, GitHub unreachable) - same fail-closed contract as
// mintInstallationToken, never a thrown exception.
export async function confirmInstallationExists(installationId, { appId, privateKey, fetchImpl = fetch } = {}) {
  if (!INSTALLATION_ID_PATTERN.test(String(installationId || ''))) return null;
  if (!appId) return null;
  const normalizedKey = normalizePrivateKeyPem(privateKey);
  if (!normalizedKey) return null;
  try {
    const auth = getAppAuth({ appId, privateKey: normalizedKey });
    const appAuthentication = await auth({ type: 'app' });
    if (!appAuthentication || !appAuthentication.token) return null;
    const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}`, {
      headers: { Authorization: `Bearer ${appAuthentication.token}`, Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return null; // 404 revoked/uninstalled, 401/403 bad/suspended App, 5xx GitHub down
    const data = await res.json();
    return (data && data.account) || null;
  } catch (e) {
    return null;
  }
}

// Test-only reset hook - authInstances is module-level state, so a test
// harness running multiple mint scenarios with different fake
// appId/privateKey fixtures needs a clean slate between them.
export function _clearAppAuthCacheForTests() {
  authInstances.clear();
}"""
        },

        # Signed state tokens for the self-service onboarding flow.
        {
            "path": "lib/onboarding_token.js",
            "content": """// HMAC-signed, short-lived tokens carrying onboarding state between hops of
// the self-service flow (api/onboard_start.js -> GitHub's install redirect
// -> api/github_app_callback.js -> Stripe Checkout -> api/stripe_webhook.js).
//
// Why a signed token instead of a server-side pending-state record: two
// independent signals (GitHub App install, Stripe payment) can otherwise
// arrive in either order, which would normally need a committed
// pending-state file to reconcile them - but Mothership is a PUBLIC repo,
// and a file tying installation IDs to Stripe customer IDs together would
// be a real, avoidable data-exposure surface in permanent git history.
// This flow sidesteps that entirely by enforcing a strict sequence (App
// install completes and is independently re-verified BEFORE a Stripe
// Checkout link is even generated - see api/github_app_callback.js) and
// carrying the confirmed installation identity forward in a signed token
// instead of a database row. No server-side state, nothing to leak,
// nothing to prune.
//
// Security properties, each defending a specific threat:
//   - HMAC-SHA256 over the payload, using a secret only this deployment
//     holds (ONBOARDING_STATE_SECRET) - an attacker without the secret
//     cannot forge a token that verifies, closing the "craft a URL with an
//     arbitrary installation_id/state directly" hijack.
//   - Signature compared via crypto.timingSafeEqual, never `===` - a
//     naive string comparison leaks how many leading bytes matched via
//     response-time differences, letting an attacker guess the signature
//     one byte at a time; timingSafeEqual takes constant time regardless
//     of where the mismatch is.
//   - A short TTL (iat + a few minutes) - a leaked or logged token stops
//     being useful on its own well before anyone could act on it.

import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

function requireSecret() {
  const secret = process.env.ONBOARDING_STATE_SECRET;
  if (!secret) {
    // Fail closed, never sign/verify with an empty or default secret - an
    // unset secret must break onboarding loudly, not silently accept
    // anything.
    throw new Error('ONBOARDING_STATE_SECRET is not configured');
  }
  return secret;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Signs a plain JSON-serializable payload, stamping it with `iat` (unless
// already present - tests can inject a fixed `now`). Returns a
// `<payload>.<signature>` string, both base64url-encoded.
export function signOnboardingToken(payload, { now = Date.now() } = {}) {
  const secret = requireSecret();
  const fullPayload = { iat: now, ...payload };
  const encodedPayload = base64url(JSON.stringify(fullPayload));
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

// Verifies a token produced by signOnboardingToken. Returns the decoded
// payload on success, or null on ANY failure - wrong/missing secret,
// tampered signature, malformed structure, unparseable payload, or an
// expired `iat`. Never throws for a bad TOKEN (only requireSecret's
// missing-config case throws, since that's an environment misconfiguration,
// not attacker input) and deliberately gives the same "invalid" outcome
// for every failure reason, so a caller can't use timing or error detail
// to fingerprint which check failed.
export function verifyOnboardingToken(token, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const secret = requireSecret();
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const lastDot = token.lastIndexOf('.');
  const encodedPayload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);
  if (!encodedPayload || !signature) return null;

  const expectedSignature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  const signatureBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  // Length must match before timingSafeEqual - it throws on mismatched
  // lengths rather than comparing, so this check is required, not
  // optional, and itself leaks nothing useful (an attacker can already see
  // valid tokens' overall shape).
  if (signatureBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(signatureBuf, expectedBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.iat !== 'number') return null;
  if (now - payload.iat > ttlMs || now < payload.iat) return null; // expired, or iat in the future (clock skew/tamper)
  return payload;
}"""
        },

        # Shared read-modify-write-with-retry helper for tenants.json/spokes.json.
        {
            "path": "lib/registry_writer.js",
            "content": """// Shared read-modify-write-with-retry helper for appending to a hub-root
// JSON array file (tenants.json, spokes.json) via the GitHub Contents API.
// Generalizes the retry-on-conflict pattern scripts/prune-logs.js already
// uses for ai_decision_log.json - factored out here because
// api/stripe_webhook.js's tenant-provisioning write needs the exact same
// shape, and a third real caller is a good point to share it rather than
// hand-copy it again.

export async function readJsonArrayFile(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { entries: Array.isArray(parsed) ? parsed : [], sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

export async function writeJsonArrayFile(octokit, owner, repo, path, entries, sha, message) {
  const content = Buffer.from(JSON.stringify(entries, null, 2)).toString('base64');
  const params = { owner, repo, path, message, content };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

// Appends one entry to a hub-root JSON registry, re-reading fresh on every
// retry attempt so a conflict discovered mid-retry (e.g. a DIFFERENT
// writer already added the exact entry this call was about to add) is
// detected as "already present -> skip", not blindly retried into a
// duplicate. `decide(freshEntries)` is called against the just-read data
// on every attempt and must return either:
//   { skip: true, result }             - don't write anything, return `result` as-is
//   { skip: false, entry, result }     - append `entry`, then return `result`
// This is what makes a call like "provision a tenant for this
// installation id" safe to run twice (a genuine Stripe webhook retry, or
// two near-simultaneous deliveries racing each other) - whichever call
// loses the race sees the winner's entry on its next re-read and skips,
// rather than creating a duplicate or clobbering the file with a stale sha.
export async function appendToJsonRegistryWithRetry(octokit, owner, repo, path, { decide, message, maxAttempts = 3 }) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { entries, sha } = await readJsonArrayFile(octokit, owner, repo, path);
    const decision = decide(entries);
    if (decision.skip) return decision.result;
    try {
      await writeJsonArrayFile(octokit, owner, repo, path, [...entries, decision.entry], sha, message);
      return decision.result;
    } catch (e) {
      lastError = e;
      // Most likely a stale-sha conflict from a concurrent writer - loop
      // and re-read from scratch, which will see that writer's change and
      // re-run `decide` against it.
    }
  }
  throw lastError;
}

// Updates one existing entry in a hub-root JSON registry (e.g. flipping a
// tenant's status), same retry-on-conflict shape as
// appendToJsonRegistryWithRetry. `find(freshEntries)` returns the index to
// update, or -1 if no matching entry exists (returns `{found: false}`
// without writing). `update(existingEntry)` returns the replacement entry,
// or `null` to mean "found it, but nothing needs to change" (returns
// `{found: true, changed: false, entry: existingEntry}` without writing -
// e.g. an unsuspend webhook arriving for a tenant that isn't suspended for
// the reason this webhook is allowed to undo).
export async function updateJsonRegistryEntryWithRetry(octokit, owner, repo, path, { find, update, message, maxAttempts = 3 }) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { entries, sha } = await readJsonArrayFile(octokit, owner, repo, path);
    const index = find(entries);
    if (index === -1) return { found: false };
    const updatedEntry = update(entries[index]);
    if (updatedEntry === null) return { found: true, changed: false, entry: entries[index] };
    const newEntries = entries.slice();
    newEntries[index] = updatedEntry;
    try {
      await writeJsonArrayFile(octokit, owner, repo, path, newEntries, sha, message);
      return { found: true, changed: true, entry: updatedEntry };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}"""
        },

        # Transactional email (suspension notice, portal-link requests) -
        # see lib/email.js's own header comment for the fail-soft contract.
        {
            "path": "lib/email.js",
            "content": """// Transactional email, used for two things: notifying a customer when
// api/github_app_webhook.js suspends their tenant (they'd otherwise only
// discover it when Mothership silently stops working), and delivering a
// fresh Customer Portal link on request (see api/request_portal_link.js).
//
// resend (official npm package, simple HTTP API, generous free tier) is
// the one deliberate new dependency for this - flagged as swappable if the
// operator already has a preferred provider, since the actual integration
// surface is one API call (`resend.emails.send`).
//
// Fail-soft by design, matching this project's existing "decision-log
// writes are best-effort" convention (ai_decision_log.json,
// usage/{tenantId}.json): a failed or misconfigured send is logged and
// swallowed here - it must NEVER fail the webhook/request it's attached
// to. A suspended tenant not getting an email is a real, but lesser, gap
// than a webhook 500ing because a third-party mail API had a bad day.

import { Resend } from 'resend';

// Returns { sent: true } on success, or { sent: false, reason } on any
// failure - missing config, a Resend API error, a network error - never
// throws.
export async function sendEmail({ to, subject, html }, {
  apiKey = process.env.RESEND_API_KEY,
  fromEmail = process.env.NOTIFICATION_FROM_EMAIL,
  resendClient
} = {}) {
  if (!to || !subject || !html) {
    return { sent: false, reason: 'to/subject/html are all required' };
  }
  if (!apiKey || !fromEmail) {
    console.warn(`lib/email.js: RESEND_API_KEY/NOTIFICATION_FROM_EMAIL not configured - email to ${to} ("${subject}") was not sent`);
    return { sent: false, reason: 'not configured' };
  }
  const client = resendClient || new Resend(apiKey);
  try {
    const result = await client.emails.send({ from: fromEmail, to, subject, html });
    if (result && result.error) {
      console.warn(`lib/email.js: Resend rejected the send to ${to}: ${result.error.message || result.error}`);
      return { sent: false, reason: result.error.message || String(result.error) };
    }
    return { sent: true };
  } catch (e) {
    console.warn(`lib/email.js: failed to send email to ${to}: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}"""
        },

        # 2. THE CENTRAL INTELLIGENCE (Vercel Worker)
        {
            "path": "api/autonomous_agent.js",
            "content": """import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadSpokesRegistry, loadTenantsRegistry, resolveTenantIdForSpoke, findTenant, resolveSecretRef } from '../lib/secrets.js';

// Caps how much diff text gets forwarded to the LLM per run - keeps prompt
// size and API cost bounded.
const MAX_DIFF_CHARS = 12000;

// Every issue this handler files is tagged with this label. GitHub creates
// the label automatically on first use. It's how the rate cap below counts
// "issues the hub created" without confusing them with anything a human
// filed manually, and it's what the health-report/decision-log tooling
// filters on too.
const HUB_ISSUE_LABEL = 'cto-hub-auto';

const DECISION_LOG_PATH = 'ai_decision_log.json';
// Overflow guard so the log can't grow unbounded before a real retention
// policy exists (that's scripts/prune-logs.js's job, not this handler's).
const DECISION_LOG_MAX_ENTRIES = 500;
// How many of the most recent decisions get fed back into the prompt as
// context, so the model doesn't re-report something already logged.
const PRIOR_DECISIONS_CONTEXT_COUNT = 5;

const USAGE_LOG_MAX_ENTRIES = 5000;

// This hub's own identity, for writing its own usage/{tenantId}.json logs -
// same env vars api/recursive_learning.js already uses for the same reason
// (it also writes to this repo, proposing PRs against itself).
const DEFAULT_HUB_OWNER = 'adamberneche-afk';
const DEFAULT_HUB_REPO = 'Mothership';

const MODE_INSTRUCTIONS = {
  debug: 'Review the RECENT CODE CHANGES below for bugs, unsafe patterns, and code quality issues actually present in this diff. Only report something you can point to directly in the diff text.',
  hunt: "Review the RECENT CODE CHANGES below for silent logic errors - places where the code runs without crashing but produces a wrong result. You cannot execute code or run tests; base findings only on what's visible in the diff text.",
  refactor: 'Review the RECENT CODE CHANGES below for opportunities to simplify complex logic, remove redundancy, or improve maintainability. Only report something you can point to directly in the diff text.'
};

// --- Multi-tenancy: data model + credential resolution -----------------
//
// spokes.json/tenants.json are both hub-root files, read from local disk the
// same way universal_lessons.md/north_star_framework.md already are - no
// octokit call needed, since this Vercel function's own checkout already
// has them. loadSpokesRegistry/loadTenantsRegistry/resolveTenantIdForSpoke/
// findTenant/resolveSecretRef now live in ../lib/secrets.js (imported
// above) - deduped out of what used to be 6 byte-identical Node-side
// copies of the same functions, see that file's header comment.

// Counts issues carrying HUB_ISSUE_LABEL that were created since UTC
// midnight today, for the rate cap below. Derived on-demand from GitHub's
// primary issue list (not the Search API, which lags real-time) - there is
// no database in this stack, so "how many have we filed today" has to be
// computed from GitHub itself every time, not tracked in memory (a Vercel
// function's memory doesn't survive between invocations anyway).
async function countHubIssuesCreatedTodayUTC(octokit, owner, repo) {
  const { data } = await octokit.issues.listForRepo({
    owner, repo, state: 'all', labels: HUB_ISSUE_LABEL,
    sort: 'created', direction: 'desc', per_page: 100
  });
  const startOfDayUTC = new Date();
  startOfDayUTC.setUTCHours(0, 0, 0, 0);
  let count = 0;
  for (const issue of data) {
    // Sorted newest-first, so the moment we hit one from before today we
    // can stop - everything after it is even older.
    if (new Date(issue.created_at) < startOfDayUTC) break;
    count++;
  }
  return count;
}

// Reads the spoke's decision log. Missing file (404), an unreachable repo,
// or corrupted JSON all come back as an empty log rather than throwing -
// the log is a memory aid, not a source of truth the rest of the handler
// depends on to function.
async function readDecisionLog(octokit, owner, repo) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: DECISION_LOG_PATH });
    let entries = [];
    try {
      const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      if (Array.isArray(parsed)) entries = parsed;
    } catch (e) {
      entries = []; // corrupted log - treat as empty rather than fail the request
    }
    return { entries, sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

// Appends one entry to the spoke's decision log via read-modify-write.
// Best-effort: a logging failure must never fail the request - the actual
// decision (skip/create/etc.) has already been made and returned by the
// time this runs. Retries a few times on a stale sha (another invocation
// wrote in between) by re-reading and reapplying the write.
async function appendDecisionLogEntry(octokit, owner, repo, entry) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { entries, sha } = await readDecisionLog(octokit, owner, repo);
      const updated = [...entries, entry].slice(-DECISION_LOG_MAX_ENTRIES);
      const content = Buffer.from(JSON.stringify(updated, null, 2)).toString('base64');
      const params = {
        owner, repo, path: DECISION_LOG_PATH,
        message: `chore: log ${entry.mode} decision (${entry.outcome})`,
        content
      };
      if (sha) params.sha = sha;
      await octokit.repos.createOrUpdateFileContents(params);
      return;
    } catch (e) {
      // Most likely a 409 from another invocation writing between our read
      // and write - loop and retry with a fresh sha. On the last attempt,
      // swallow it: telemetry loss, not a request failure.
    }
  }
}

function makeLogEntry({ mode, commitSha, outcome, issueUrl = null, summary = null }) {
  return { timestamp: new Date().toISOString(), mode, commitSha, outcome, issueUrl, summary };
}

// --- Usage metering (hooks only - see lessons.md's dated entry) --------
//
// Lives in the HUB repo (usage/{tenantId}.json), not the spoke - the whole
// point is the operator/billing system can read every tenant's usage
// without needing per-spoke access, matching how a tenant's OWN credential
// (decision #1) is scoped only to their own repos and couldn't write here
// anyway. Written via hubOctokit, a SEPARATE credential from the
// tenant-scoped one used for spoke operations - see processRequest's
// factory-vs-hubOctokit split below.
//
// Same read-modify-write-with-retry shape as appendDecisionLogEntry/
// scripts/prune-logs.js - reused, not reinvented.
function usageLogPath(tenantId) {
  return `usage/${tenantId}.json`;
}

async function readUsageLog(hubOctokit, hubOwner, hubRepo, tenantId) {
  try {
    const { data } = await hubOctokit.repos.getContent({ owner: hubOwner, repo: hubRepo, path: usageLogPath(tenantId) });
    let entries = [];
    try {
      const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      if (Array.isArray(parsed)) entries = parsed;
    } catch (e) {
      entries = [];
    }
    return { entries, sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

async function recordUsageEvent(hubOctokit, hubOwner, hubRepo, event) {
  if (!hubOctokit) return; // no hub-write credential configured - see handler()
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { entries, sha } = await readUsageLog(hubOctokit, hubOwner, hubRepo, event.tenantId);
      const updated = [...entries, event].slice(-USAGE_LOG_MAX_ENTRIES);
      const content = Buffer.from(JSON.stringify(updated, null, 2)).toString('base64');
      const params = {
        owner: hubOwner, repo: hubRepo, path: usageLogPath(event.tenantId),
        message: `chore: record ${event.eventType} usage for tenant ${event.tenantId}`,
        content
      };
      if (sha) params.sha = sha;
      await hubOctokit.repos.createOrUpdateFileContents(params);
      return;
    } catch (e) {
      // Same reasoning as appendDecisionLogEntry: best-effort, retry on a
      // likely stale-sha conflict, swallow on the last attempt - a metering
      // gap is a billing-accuracy problem to notice later, not a reason to
      // fail the actual review request.
    }
  }
}

// Sums this calendar month's 'review_run' events for a tenant, for the
// quota check below. `reviewsPerMonth: null` (the "default" tenant's value)
// means unlimited - never even reads the usage log in that case.
async function countReviewsThisMonth(hubOctokit, hubOwner, hubRepo, tenantId, now) {
  const { entries } = await readUsageLog(hubOctokit, hubOwner, hubRepo, tenantId);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return entries.filter(e => e && e.eventType === 'review_run' && new Date(e.timestamp) >= monthStart).length;
}

// The actual decision logic, factored out of the Vercel handler so it can
// be driven by a local test harness (scripts/dev-test-handler.mjs) with a
// fake octokit/fetch instead of hitting GitHub and the AI API for real.
// `dryRunOverride` lets tests force a specific dry-run state instead of
// reading the DRY_RUN_MODE env var.
//
// `octokitFactory(token)` replaces a single injected `octokit` instance -
// multi-tenancy means the credential used for a spoke's own repo operations
// now depends on which tenant that spoke belongs to (decision #1: each
// tenant supplies their own, not one shared master token), so it can't be
// constructed once outside this function anymore. `hubOctokit` is a
// SEPARATE, already-constructed client scoped to the hub's own repo (still
// GLOBAL_GITHUB_TOKEN under the hood - see handler() below) - it's what
// usage-log writes and quota reads use, since a tenant's own credential has
// no access to the hub repo at all.
export async function processRequest(reqBody, { octokitFactory, hubOctokit, fetchImpl = fetch, dryRunOverride, now = new Date(), spokesOverride, tenantsOverride } = {}) {
  const { owner, repo, mode, callerKey } = reqBody || {};

  if (!owner || !repo || !mode) {
    return { httpStatus: 400, body: { error: 'owner, repo, and mode are required' } };
  }

  const taskInstruction = MODE_INSTRUCTIONS[mode];
  if (!taskInstruction) {
    return { httpStatus: 400, body: { error: `Unknown mode: ${mode}` } };
  }

  // TENANT RESOLUTION + CALLER AUTHENTICATION.
  //
  // Real, disclosed gap this closes a first step toward: spoke-to-hub POSTs
  // carried ZERO credential before this - any caller who knew the hub URL
  // could trigger a review for any registered owner/repo. The check below
  // is deliberately opt-in per tenant: a tenant with no `callerKeyRef` set
  // (true for "default" today) skips verification entirely, preserving
  // today's exact zero-auth behavior for anything not yet migrated. A
  // tenant that HAS set one gets it strictly enforced. Migrating a tenant
  // to enforced caller-auth is then just a config change, not a breaking
  // flag day for spokes that were already working.
  //
  // spokesOverride/tenantsOverride let tests inject a registry instead of
  // reading this checkout's real spokes.json/tenants.json - same
  // dependency-injection convention as dryRunOverride/octokitFactory.
  const spokes = spokesOverride || loadSpokesRegistry();
  const tenants = tenantsOverride || loadTenantsRegistry();
  const tenantId = resolveTenantIdForSpoke(owner, repo, spokes);
  const tenant = findTenant(tenantId, tenants);

  // SAFETY RAIL 1: dry-run mode. Defaults to true so a missing/misconfigured
  // env var never files a real issue by accident - DRY_RUN_MODE has to be
  // explicitly set to the string "false" in Vercel to go live. Every
  // response from this point on carries `dryRun` so callers (and the
  // decision log / health report built on top of this) can always tell
  // which mode produced it. Computed up front (moved ahead of tenant/
  // credential handling below) so the tenant-status gate can use it too.
  const dryRun = dryRunOverride !== undefined
    ? dryRunOverride
    : process.env.DRY_RUN_MODE !== 'false';

  // TENANT STATUS GATE: an explicitly non-'active' tenant (suspended, e.g.
  // for a failed payment) must never be served, checked before any
  // GitHub call - including the credential resolution below - so a
  // suspended tenant costs nothing, not even a failed auth attempt.
  // `status` is optional for backward compat: a record with no `status`
  // field, or the "default" tenant's seeded "active", is always served -
  // only an EXPLICIT non-'active' value skips. (Found while building the
  // GitHub App credential path: `status` was defined in tenants.json's own
  // schema but never actually read anywhere in this handler until now.)
  if (tenant && tenant.status && tenant.status !== 'active') {
    return { httpStatus: 200, body: { status: 'Skipped', reason: `Tenant status is '${tenant.status}', not 'active'`, dryRun } };
  }

  const requiredCallerKey = tenant ? await resolveSecretRef(tenant.callerKeyRef) : null;
  if (requiredCallerKey && callerKey !== requiredCallerKey) {
    return { httpStatus: 401, body: { error: 'invalid or missing caller key for this tenant' } };
  }

  // Credential for this request's SPOKE operations - the tenant's own
  // token (decision #1), resolved via the same env:/kv: scheme as the
  // caller key above. GLOBAL_GITHUB_TOKEN is used ONLY for the true
  // legacy/pre-migration case: no tenant record matched this spoke at all
  // (mirrors resolveTenantIdForSpoke's own backward-compatibility
  // fallback). A tenant that DID match but whose credential ref fails to
  // resolve (unset env var, revoked/misconfigured ref) is a hard skip, not
  // a fallback - silently widening to the hub's own broad
  // GLOBAL_GITHUB_TOKEN here would be exactly backwards: a tenant whose
  // credential is broken or was just revoked should lose access, not gain
  // the operator's own token against their repo. (Inert while only one
  // tenant with one credential path existed; a real, live bug the moment a
  // second, revocable per-tenant credential does - fixed here before that
  // becomes true.)
  let spokeToken;
  if (tenant) {
    spokeToken = await resolveSecretRef(tenant.githubCredentialRef);
    if (!spokeToken) {
      return { httpStatus: 200, body: { status: 'Skipped', reason: `Could not resolve GitHub credential for tenant '${tenantId}'`, dryRun } };
    }
  } else {
    spokeToken = process.env.GLOBAL_GITHUB_TOKEN;
  }
  const octokit = octokitFactory(spokeToken);

  // Fetch Global Context from Hub
  const universalLessonsPath = join(process.cwd(), 'universal_lessons.md');
  const globalNorthStarPath = join(process.cwd(), 'north_star_framework.md');
  const hubLessonsPath = join(process.cwd(), 'hub_lessons.md');

  const universalLessons = existsSync(universalLessonsPath)
    ? readFileSync(universalLessonsPath, 'utf8')
    : "";
  const globalNorthStar = existsSync(globalNorthStarPath)
    ? readFileSync(globalNorthStarPath, 'utf8')
    : "";
  const hubLessons = existsSync(hubLessonsPath)
    ? readFileSync(hubLessonsPath, 'utf8')
    : "";

  // Fetch Local Context from the Spoke repo
  let localContext = "No local context found.";
  try {
    const { data: lsData } = await octokit.repos.getContent({ owner, repo, path: 'lessons.md' });
    const { data: nsData } = await octokit.repos.getContent({ owner, repo, path: 'NORTH_STAR.md' });
    localContext = `
      LOCAL LESSONS: ${Buffer.from(lsData.content, 'base64').toString()}
      LOCAL NORTH STAR: ${Buffer.from(nsData.content, 'base64').toString()}
    `;
  } catch (e) {
    localContext = "No local context found.";
  }

  // Find the spoke's latest commit sha up front - both the decision-log
  // dedup check below and the diff fetch further down need it, so fetch it
  // once and reuse it instead of calling listCommits twice.
  let latestCommitSha = null;
  try {
    const { data: commits } = await octokit.repos.listCommits({ owner, repo, per_page: 1 });
    if (commits.length > 0) latestCommitSha = commits[0].sha;
  } catch (e) {
    latestCommitSha = null;
  }

  // DECISION LOGGING: don't re-run the AI (or spend the diff-fetch call) on
  // a commit+mode combination already decided. An 'ai_error' outcome means
  // the AI call itself failed last time (not that a real decision was
  // made), so those don't block a retry - everything else does.
  const { entries: decisionLog } = await readDecisionLog(octokit, owner, repo);
  if (latestCommitSha) {
    const priorEntry = decisionLog.find(
      e => e.commitSha === latestCommitSha && e.mode === mode && e.outcome !== 'ai_error'
    );
    if (priorEntry) {
      const body = {
        status: 'Skipped',
        reason: `Already decided for this commit in ${mode} mode (${priorEntry.outcome})`,
        dryRun,
        priorDecision: priorEntry
      };
      // A caller checking body.issueUrl (the shape a live 'created' response
      // uses) would otherwise only find it nested under priorDecision on a
      // replay - surface it at the top level too when the prior decision
      // actually filed one.
      if (priorEntry.issueUrl) body.issueUrl = priorEntry.issueUrl;
      return { httpStatus: 200, body };
    }
  }

  const logOutcome = (outcome, extra = {}) => {
    if (!latestCommitSha) return; // nothing meaningful to key the entry on
    return appendDecisionLogEntry(octokit, owner, repo, makeLogEntry({ mode, commitSha: latestCommitSha, outcome, ...extra }));
  };

  const hubOwner = process.env.HUB_GITHUB_OWNER || DEFAULT_HUB_OWNER;
  const hubRepo = process.env.HUB_GITHUB_REPO || DEFAULT_HUB_REPO;
  const recordUsage = (eventType, extra = {}) =>
    recordUsageEvent(hubOctokit, hubOwner, hubRepo, { tenantId, timestamp: new Date().toISOString(), eventType, mode, owner, repo, ...extra });

  // Fetch REAL CODE context: the diff of the spoke's latest commit.
  //
  // Every "audit" used to run with zero actual code in the prompt - only
  // lessons.md/NORTH_STAR.md, which are notes files, not source. That
  // guaranteed the LLM would hallucinate a plausible-looking bug + patch
  // every single run, since it had nothing real to look at. If there's no
  // usable diff (empty commit, binary-only changes, repo unreachable, huge
  // commit GitHub won't return patches for), we skip the AI call and the
  // issue entirely instead of asking it to invent something out of nothing.
  let codeDiff = null;
  if (latestCommitSha) {
    try {
      const { data: commitDetail } = await octokit.repos.getCommit({ owner, repo, ref: latestCommitSha });
      const patches = (commitDetail.files || [])
        .filter(f => typeof f.patch === 'string' && f.patch.length > 0)
        .map(f => `--- ${f.filename} (${f.status}) ---\\n${f.patch}`)
        .join('\\n\\n');
      if (patches.length > 0) {
        codeDiff = patches.length > MAX_DIFF_CHARS
          ? patches.slice(0, MAX_DIFF_CHARS) + `\\n\\n[... diff truncated at ${MAX_DIFF_CHARS} chars ...]`
          : patches;
      }
    } catch (e) {
      codeDiff = null;
    }
  }

  if (!codeDiff) {
    await logOutcome('no_diff_skip');
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No usable code diff found for the latest commit', dryRun } };
  }

  // BILLING/QUOTA GATE, tenant-scoped - placed before the AI call
  // deliberately (not just before filing, like the rate cap below), since
  // the AI call is the actual cost-incurring event the hub is metering
  // (decision #2: one shared AI_API_KEY, usage attributed per tenant). A
  // tenant with `quota.reviewsPerMonth: null` (the "default" tenant's
  // value, and the only one seeded today) is never checked - unlimited.
  // This is a hooks-only, no-payment-processor gate: it enforces a number
  // already in tenants.json, it doesn't invoice anyone.
  const monthlyQuota = tenant && tenant.quota && tenant.quota.reviewsPerMonth;
  if (typeof monthlyQuota === 'number') {
    const usedThisMonth = await countReviewsThisMonth(hubOctokit, hubOwner, hubRepo, tenantId, now);
    if (usedThisMonth >= monthlyQuota) {
      await logOutcome('quota_exceeded');
      return {
        httpStatus: 200,
        body: { status: 'Skipped', reason: `Monthly review quota reached (${usedThisMonth}/${monthlyQuota} reviews this month)`, dryRun }
      };
    }
  }

  const priorDecisionsContext = decisionLog.length > 0
    ? decisionLog
        .slice(-PRIOR_DECISIONS_CONTEXT_COUNT)
        .map(e => `- [${e.timestamp}] mode=${e.mode} outcome=${e.outcome}${e.summary ? `: ${e.summary}` : ''}`)
        .join('\\n')
    : 'None yet.';

  const prompt = `
    ROLE: Senior AI CTO. MODE: ${mode.toUpperCase()}.
    GLOBAL STANDARDS: ${universalLessons}
    GLOBAL NORTH STAR: ${globalNorthStar}
    HUB LESSONS: ${hubLessons}
    LOCAL CONTEXT: ${localContext}

    PRIOR DECISIONS (most recent ${PRIOR_DECISIONS_CONTEXT_COUNT} for this repo - do not re-report
    something already logged here as decided unless the diff below clearly
    shows something new):
    ${priorDecisionsContext}

    RECENT CODE CHANGES (diff of the latest commit):
    ${codeDiff}

    TASK: ${taskInstruction}
    If you find nothing worth reporting, set "has_findings" to false and
    leave "code_patch" and "value_impact.reasoning" as empty strings - do
    not invent an issue just to have something to say.
    Respond with ONLY valid JSON, exactly this shape:
    {
      "has_findings": boolean,
      "action_summary": string,
      "code_patch": string,
      "value_impact": { "reasoning": string }
    }
  `;

  const aiResponse = await fetchImpl(`${process.env.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    })
  });

  const aiData = await aiResponse.json();
  const rawContent = aiData?.choices?.[0]?.message?.content;

  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    // Treated as an infra/API failure, not a real decision - doesn't block
    // a retry of this same commit+mode on the next run.
    await logOutcome('ai_error', { summary: 'AI returned no content' });
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'AI returned no content', dryRun } };
  }

  // This is the actual cost-incurring event the quota gate above protects
  // against overrunning - record it now that the AI call genuinely
  // happened, regardless of what it decided. `aiData.usage` is an OpenAI-
  // compatible response field some providers populate and some don't -
  // captured when present, never fabricated when it's not.
  await recordUsage('review_run', aiData && aiData.usage ? { usage: aiData.usage } : {});

  // Parse and STRICTLY VALIDATE the AI's response before acting on it.
  //
  // A JSON.parse failure does not fabricate a synthetic result and file an
  // issue anyway, and a successful parse is checked field-by-field (non-empty
  // strings for action_summary/code_patch/value_impact.reasoning) before use.
  // Unmet validation returns a 200 "Skipped" response instead of posting.
  let result;
  try {
    result = JSON.parse(rawContent);
  } catch (parseError) {
    await logOutcome('invalid_ai_response', { summary: 'AI did not return valid JSON' });
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: 'AI did not return valid JSON', raw: rawContent.slice(0, 500), dryRun }
    };
  }

  if (result.has_findings !== true) {
    await logOutcome('no_findings');
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'AI reported no findings', dryRun } };
  }

  const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
  const isValidShape =
    isNonEmptyString(result.action_summary) &&
    isNonEmptyString(result.code_patch) &&
    result.value_impact &&
    typeof result.value_impact === 'object' &&
    isNonEmptyString(result.value_impact.reasoning);

  if (!isValidShape) {
    await logOutcome('invalid_ai_response', { summary: 'AI response did not match the required shape' });
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: 'AI response did not match the required shape', raw: rawContent.slice(0, 500), dryRun }
    };
  }

  const issueTitle = `CTO HUB: ${mode.toUpperCase()} Action`;
  const issueBody = `### Value Impact\\n${result.value_impact.reasoning}\\n\\n### Patch\\n\\`\\`\\`\\n${result.code_patch}\\n\\`\\`\\``;
  const summary = result.action_summary.slice(0, 200);

  // SAFETY RAIL 1 (continued): a real, validated finding - but dry-run mode
  // means we report what we *would* have filed instead of actually filing it.
  if (dryRun) {
    await logOutcome('dry_run_would_create', { summary });
    return {
      httpStatus: 200,
      body: { status: 'DryRunFinding', dryRun: true, wouldCreate: { title: issueTitle, body: issueBody } }
    };
  }

  // SAFETY RAIL 2: a hard cap on how many issues this handler will file
  // against one repo per day, live mode only. This is what stands between
  // a misbehaving prompt/model and a repeat of the ~1,974-issue incident -
  // even if validation above somehow passes bad data every run, this bounds
  // the damage to a handful of issues instead of one every 30 minutes for
  // months.
  const cap = Number(process.env.RATE_CAP_PER_REPO_PER_DAY || 3);
  const countToday = await countHubIssuesCreatedTodayUTC(octokit, owner, repo);
  if (countToday >= cap) {
    await logOutcome('rate_capped', { summary });
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: `Rate cap reached (${countToday}/${cap} issues filed today)`, dryRun }
    };
  }

  const created = await octokit.issues.create({
    owner, repo,
    title: issueTitle,
    body: issueBody,
    labels: [HUB_ISSUE_LABEL]
  });

  await logOutcome('created', { issueUrl: created.data.html_url, summary });
  await recordUsage('issue_created', { issueUrl: created.data.html_url });

  return { httpStatus: 200, body: { status: "Success", dryRun, issueUrl: created.data.html_url } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // octokitFactory defers Octokit construction until processRequest knows
  // which tenant's credential to use (decision #1) - hubOctokit stays the
  // one, hub-repo-scoped credential (still GLOBAL_GITHUB_TOKEN) used only
  // for this hub's own usage-log writes/quota reads, never for a tenant's
  // spoke operations.
  const octokitFactory = (token) => new Octokit({ auth: token });
  const hubOctokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  try {
    const { httpStatus, body } = await processRequest(req.body, { octokitFactory, hubOctokit, fetchImpl: fetch });
    return res.status(httpStatus).json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}"""
        },
        {
            "path": "api/recursive_learning.js",
            "content": """import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SPOKES_REGISTRY_PATH, TENANTS_REGISTRY_PATH, DEFAULT_TENANT_ID, findTenant, resolveSecretRef } from '../lib/secrets.js';

// How many of a spoke's most recent decision-log entries get included in
// the cross-spoke summary prompt - enough to see a pattern, not so much
// that one busy spoke drowns out the others.
const RECENT_DECISIONS_PER_SPOKE = 10;

// The hub's own identity - needed because this endpoint opens a PR against
// itself, unlike autonomous_agent.js, which always operates on a spoke
// passed in the request body. Overridable via env var (and via the
// `hubOwner`/`hubRepo` options below, for tests) in case this code is ever
// deployed under a different repo.
const DEFAULT_HUB_OWNER = 'adamberneche-afk';
const DEFAULT_HUB_REPO = 'Mothership';

async function safeGetTextContent(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
}

function safeParseJsonArray(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Looks up the hub repo's actual default branch instead of assuming 'main' -
// correct today, but a hardcoded assumption is exactly the kind of thing
// that silently breaks later if the default branch is ever renamed.
async function getDefaultBranch(octokit, owner, repo) {
  try {
    const { data } = await octokit.repos.get({ owner, repo });
    return data.default_branch || 'main';
  } catch (e) {
    return 'main';
  }
}

// --- Multi-tenancy: same data model/resolution as api/autonomous_agent.js
// (see that file's header comment for the full rationale) - ported here so
// the Recursive Learning Loop never pools two tenants' spoke data into one
// cross-spoke prompt, which would otherwise be a real, silent isolation
// leak specific to this endpoint's whole purpose (finding patterns ACROSS
// spokes).

function groupSpokesByTenant(spokes) {
  const byTenant = {};
  for (const spoke of spokes) {
    if (!spoke || !spoke.owner || !spoke.repo) continue;
    const tenantId = spoke.tenantId || DEFAULT_TENANT_ID;
    (byTenant[tenantId] = byTenant[tenantId] || []).push(spoke);
  }
  return byTenant;
}

// findTenant/resolveSecretRef now live in ../lib/secrets.js (imported
// above) - deduped out of what used to be 6 byte-identical Node-side
// copies of the same functions, see that file's header comment.

// --- Shared, opt-in, cross-organization learning pool -----------------------
//
// Repo-scoped opt-in (spoke.shareLearnings === true), NOT tenant-scoped -
// deliberately: whether a codebase's patterns are safe to pool into a wider
// corpus is a property of that codebase, not of who's paying for it. A repo
// that opts in still ALSO runs in its own tenant's private runForTenant pass
// above - this is purely additive, nothing existing changes.
//
// Two structural safeguards against exactly the failure mode this feature
// exists to avoid ("co-mingle/hallucinate codebase"):
//   1. The per-spoke context sent to the AI is labeled with an anonymized
//      "Contributor N" tag instead of the real owner/repo. There's no
//      actual source code to redact here in the first place (this loop
//      never fetches diffs, only lessons.md/decision-log text - same as
//      runForTenant's per-spoke fetch above), but a real org/repo name
//      could still get echoed back into the merged, hub-global lessons
//      text, so it's kept out of the model's view entirely.
//   2. The model must CITE which anonymized contributors back its proposal
//      (`supporting_contributors`) - and that citation is verified in CODE
//      against the real spokes those labels map to (distinct tenants /
//      distinct repos), never just trusted because the model said
//      "has_proposal: true". Same "validate the claim, don't trust the
//      free-text self-report" discipline already applied to
//      has_findings/has_proposal everywhere else in this project.
const MIN_DISTINCT_TENANTS_CROSS_ORG = 2;
const MIN_DISTINCT_REPOS_SAME_TENANT = 3;

function selectSharedPoolSpokes(spokes) {
  return spokes.filter(s => s && s.owner && s.repo && s.shareLearnings === true);
}

// Cheap precondition, checked before spending an AI call: can this set of
// opted-in spokes even theoretically satisfy the evidence bar yet?
function poolCouldSatisfyEvidenceBar(sharedPoolSpokes) {
  const distinctTenants = new Set(sharedPoolSpokes.map(s => s.tenantId || DEFAULT_TENANT_ID));
  if (distinctTenants.size >= MIN_DISTINCT_TENANTS_CROSS_ORG) return true;
  return sharedPoolSpokes.length >= MIN_DISTINCT_REPOS_SAME_TENANT;
}

// The anti-hallucination gate: given the labels the model actually cited,
// counts DISTINCT real tenants and DISTINCT real repos behind them and
// checks that against the locked bar - never trusts "has_proposal: true"
// on its own.
function citedEvidenceMeetsBar(citedLabels, labelToSpoke) {
  const citedSpokes = citedLabels.map(label => labelToSpoke[label]).filter(Boolean);
  const distinctRepoKeys = new Set(citedSpokes.map(s => `${s.owner}/${s.repo}`));
  const distinctTenantIds = new Set(citedSpokes.map(s => s.tenantId));
  if (distinctTenantIds.size >= MIN_DISTINCT_TENANTS_CROSS_ORG) return true;
  if (distinctRepoKeys.size >= MIN_DISTINCT_REPOS_SAME_TENANT) return true;
  return false;
}

// Builds and runs the shared cross-organization pass - parallel in shape to
// runForTenant, but spans every tenant's opted-in spokes in one pool
// instead of being confined to one tenant.
async function runForSharedPool({ sharedPoolSpokes, tenants, octokitFactory, hubOctokit, fetchImpl, dryRun, universalLessons, globalNorthStar, HUB_OWNER, HUB_REPO }) {
  if (sharedPoolSpokes.length === 0) {
    return { pool: 'shared', status: 'Skipped', reason: 'No spokes opted into the shared learning pool', dryRun };
  }
  if (!poolCouldSatisfyEvidenceBar(sharedPoolSpokes)) {
    return { pool: 'shared', status: 'Skipped', reason: 'Not enough opted-in spokes yet to meet the cross-organization evidence bar', dryRun };
  }

  // Per-spoke credential resolution still happens per-spoke, not once - the
  // pool spans multiple tenants' repos, so each one is still fetched using
  // ITS OWN resolved tenant credential, exactly like runForTenant, just
  // inside one aggregating loop instead of one tenant-scoped loop.
  const labelToSpoke = {};
  const perSpokeContext = [];
  for (let i = 0; i < sharedPoolSpokes.length; i++) {
    const spoke = sharedPoolSpokes[i];
    const label = `Contributor ${i + 1}`;
    const tenantId = spoke.tenantId || DEFAULT_TENANT_ID;
    const tenant = findTenant(tenantId, tenants);
    // Same rules/rationale as runForTenant's identical fix: a matched
    // tenant whose credential ref fails to resolve is excluded from this
    // round of the shared pool entirely (never a silent fallback to a
    // broader credential) - one misconfigured contributor shouldn't abort
    // the whole cross-organization pass, so this is a `continue`, not a
    // hard return.
    let spokeToken;
    if (tenant) {
      spokeToken = await resolveSecretRef(tenant.githubCredentialRef);
      if (!spokeToken) continue;
    } else {
      spokeToken = process.env.GLOBAL_GITHUB_TOKEN;
    }
    const octokit = octokitFactory(spokeToken);

    labelToSpoke[label] = { owner: spoke.owner, repo: spoke.repo, tenantId };

    const lessons = await safeGetTextContent(octokit, spoke.owner, spoke.repo, 'lessons.md');
    const decisionLogText = await safeGetTextContent(octokit, spoke.owner, spoke.repo, 'ai_decision_log.json');
    const recentDecisions = safeParseJsonArray(decisionLogText).slice(-RECENT_DECISIONS_PER_SPOKE);
    const negativeFeedbackCount = recentDecisions.filter((d) => d && d.feedback && d.feedback.thumbsDown > 0).length;
    const feedbackSummary = negativeFeedbackCount > 0
      ? `${negativeFeedbackCount} of the last ${recentDecisions.length} decisions received negative maintainer feedback (a real thumbs-down reaction on the filed issue).`
      : 'none of the last decisions received negative maintainer feedback.';

    perSpokeContext.push({ label, lessons: lessons || 'No lessons.md found.', recentDecisions, feedbackSummary });
  }

  const perSpokeSection = perSpokeContext.map(s => `
    --- ${s.label} ---
    LESSONS: ${s.lessons}
    RECENT HUB DECISIONS: ${JSON.stringify(s.recentDecisions)}
    MAINTAINER FEEDBACK: ${s.feedbackSummary}
  `).join('\\n');

  const prompt = `
    ROLE: Senior AI CTO performing a cross-ORGANIZATION retrospective across
    every repo that has opted into a shared learning pool. These
    contributors belong to DIFFERENT organizations/customers - you are only
    given anonymized labels ("Contributor N"), never real names, precisely
    so nothing organization-identifying ends up in a shared standard.
    CURRENT GLOBAL STANDARDS (universal_lessons.md): ${universalLessons}
    CURRENT GLOBAL NORTH STAR (north_star_framework.md): ${globalNorthStar}

    PER-CONTRIBUTOR CONTEXT:
    ${perSpokeSection}

    TASK: Look for a genuine pattern that recurs across MULTIPLE DISTINCT
    contributors above - not something specific to only one - that the
    CURRENT GLOBAL STANDARDS or GLOBAL NORTH STAR don't already cover. You
    MUST list every contributor label your proposal is actually evidenced
    by in "supporting_contributors" - a proposal with no real, cited
    supporting evidence will be rejected regardless of what you say in
    "has_proposal". Never phrase the proposed lesson text in terms of a
    specific contributor or organization - describe only the underlying,
    general engineering principle. If you find one, propose it as the
    FULL, updated text of universal_lessons.md and/or north_star_framework.md
    (not a diff - the complete file content with your addition folded in).
    If nothing genuinely cross-cutting stands out, set "has_proposal" to
    false, leave both patch fields as empty strings, and leave
    "supporting_contributors" as an empty array - do not invent a pattern
    just to have something to propose.
    Respond with ONLY valid JSON, exactly this shape:
    {
      "has_proposal": boolean,
      "reasoning": string,
      "supporting_contributors": string[],
      "universal_lessons_patch": string,
      "north_star_patch": string
    }
  `;

  const aiResponse = await fetchImpl(`${process.env.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    })
  });

  const aiData = await aiResponse.json();
  const rawContent = aiData?.choices?.[0]?.message?.content;

  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return { pool: 'shared', status: 'Skipped', reason: 'AI returned no content', dryRun };
  }

  let result;
  try {
    result = JSON.parse(rawContent);
  } catch (parseError) {
    return { pool: 'shared', status: 'Skipped', reason: 'AI did not return valid JSON', raw: rawContent.slice(0, 500), dryRun };
  }

  if (result.has_proposal !== true) {
    return { pool: 'shared', status: 'Skipped', reason: 'AI found no cross-organization pattern worth proposing', dryRun };
  }

  const isNonEmptyStringSP = (v) => typeof v === 'string' && v.trim().length > 0;
  const hasAnyPatch = isNonEmptyStringSP(result.universal_lessons_patch) || isNonEmptyStringSP(result.north_star_patch);
  const citedLabels = Array.isArray(result.supporting_contributors) ? result.supporting_contributors : [];
  const isValidShape = isNonEmptyStringSP(result.reasoning) && hasAnyPatch && citedLabels.length > 0;

  if (!isValidShape) {
    return { pool: 'shared', status: 'Skipped', reason: 'AI response did not match the required shape', raw: rawContent.slice(0, 500), dryRun };
  }

  // The critical anti-hallucination gate - see this function's header
  // comment. Rejects the proposal outright if the model's own cited
  // evidence doesn't actually clear the bar, regardless of has_proposal.
  if (!citedEvidenceMeetsBar(citedLabels, labelToSpoke)) {
    return { pool: 'shared', status: 'Skipped', reason: 'Cited evidence does not meet the cross-organization bar (needs 2+ distinct tenants, or 3+ distinct repos within one tenant)', dryRun };
  }

  const supportingSpokes = citedLabels.map(label => labelToSpoke[label]).filter(Boolean);

  if (dryRun) {
    return { pool: 'shared', status: 'DryRunProposal', dryRun: true, proposal: result, supportingSpokes };
  }

  // Live: same "propose via PR against the hub, never push directly"
  // mechanism as runForTenant - real names are used here in the PR body
  // (built from the code-side labelToSpoke map, never from model output),
  // since the human reviewing/merging already has full visibility into
  // spokes.json/tenants.json. The anonymization boundary is the model's
  // own reasoning, not the operator reading the PR.
  const defaultBranch = await getDefaultBranch(hubOctokit, HUB_OWNER, HUB_REPO);
  const { data: baseRef } = await hubOctokit.git.getRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `heads/${defaultBranch}` });
  const branchName = `recursive-learning-shared-pool-${Date.now()}`;
  await hubOctokit.git.createRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `refs/heads/${branchName}`, sha: baseRef.object.sha });

  const filesToUpdate = [];
  if (isNonEmptyStringSP(result.universal_lessons_patch)) {
    filesToUpdate.push({ path: 'universal_lessons.md', content: result.universal_lessons_patch });
  }
  if (isNonEmptyStringSP(result.north_star_patch)) {
    filesToUpdate.push({ path: 'north_star_framework.md', content: result.north_star_patch });
  }

  for (const file of filesToUpdate) {
    let existingSha;
    try {
      const { data } = await hubOctokit.repos.getContent({ owner: HUB_OWNER, repo: HUB_REPO, path: file.path, ref: branchName });
      existingSha = data.sha;
    } catch (e) {
      existingSha = undefined;
    }
    const params = {
      owner: HUB_OWNER, repo: HUB_REPO, path: file.path, branch: branchName,
      message: `docs: recursive-learning proposal for ${file.path} (shared cross-organization pool)`,
      content: Buffer.from(file.content).toString('base64')
    };
    if (existingSha) params.sha = existingSha;
    await hubOctokit.repos.createOrUpdateFileContents(params);
  }

  const supportingList = supportingSpokes.map(s => `\\`${s.owner}/${s.repo}\\` (tenant \\`${s.tenantId}\\`)`).join(', ');
  const pr = await hubOctokit.pulls.create({
    owner: HUB_OWNER, repo: HUB_REPO,
    title: `Recursive Learning: proposed cross-organization pattern (shared pool)`,
    head: branchName,
    base: defaultBranch,
    body: `### Reasoning\\n${result.reasoning}\\n\\n### Supporting repos\\n${supportingList}\\n\\n---\\nGenerated automatically by \\`api/recursive_learning.js\\` from a pattern the model reported recurring across the repos above - all opted into the shared learning pool (\\`shareLearnings: true\\`) and spanning ${new Set(supportingSpokes.map(s => s.tenantId)).size} distinct tenant(s). This is a proposal, not a decision - review before merging, and consider whether this generalization is fair to every contributing organization.`
  });

  return { pool: 'shared', status: 'Success', dryRun: false, pullRequestUrl: pr.data.html_url, supportingSpokes };
}

// Builds and runs one tenant's independent cross-spoke proposal - the unit
// of work this whole redesign scopes tenant-isolation around. Only ever
// sees this tenant's own spokes' lessons.md/ai_decision_log.json; never
// pools another tenant's data into the same prompt.
async function runForTenant({ tenantId, tenantSpokes, tenant, octokitFactory, hubOctokit, fetchImpl, dryRun, universalLessons, globalNorthStar, HUB_OWNER, HUB_REPO }) {
  // Same rules/rationale as api/autonomous_agent.js's identical fix:
  // GLOBAL_GITHUB_TOKEN is used only for the true legacy/no-tenant-matched
  // case; a tenant that DID match but whose credential ref fails to
  // resolve is a hard skip, never a silent fallback to a broader,
  // hub-operator-owned credential reading this tenant's own repos.
  let spokeToken;
  if (tenant) {
    spokeToken = await resolveSecretRef(tenant.githubCredentialRef);
    if (!spokeToken) {
      return { tenantId, status: 'Skipped', reason: `Could not resolve GitHub credential for tenant '${tenantId}'`, dryRun };
    }
  } else {
    spokeToken = process.env.GLOBAL_GITHUB_TOKEN;
  }
  const octokit = octokitFactory(spokeToken);

  const perSpokeContext = [];
  for (const spoke of tenantSpokes) {
    const lessons = await safeGetTextContent(octokit, spoke.owner, spoke.repo, 'lessons.md');
    const decisionLogText = await safeGetTextContent(octokit, spoke.owner, spoke.repo, 'ai_decision_log.json');
    const recentDecisions = safeParseJsonArray(decisionLogText).slice(-RECENT_DECISIONS_PER_SPOKE);
    // scripts/collect-issue-feedback.js attaches a `feedback` field (from
    // issue reactions - a real "this was wrong" signal from the spoke's own
    // maintainer) to matching entries. Summarized here rather than dumped
    // raw, same reasoning as RECENT_DECISIONS_PER_SPOKE's own cap - enough
    // signal to see a pattern, not so much detail it drowns out everything
    // else in the prompt.
    const negativeFeedbackCount = recentDecisions.filter((d) => d && d.feedback && d.feedback.thumbsDown > 0).length;
    const feedbackSummary = negativeFeedbackCount > 0
      ? `${negativeFeedbackCount} of the last ${recentDecisions.length} decisions received negative maintainer feedback (a real thumbs-down reaction on the filed issue).`
      : 'none of the last decisions received negative maintainer feedback.';
    perSpokeContext.push({
      owner: spoke.owner,
      repo: spoke.repo,
      lessons: lessons || 'No lessons.md found.',
      recentDecisions,
      feedbackSummary
    });
  }

  const perSpokeSection = perSpokeContext.map(s => `
    --- ${s.owner}/${s.repo} ---
    LESSONS: ${s.lessons}
    RECENT HUB DECISIONS: ${JSON.stringify(s.recentDecisions)}
    MAINTAINER FEEDBACK: ${s.feedbackSummary}
  `).join('\\n');

  const prompt = `
    ROLE: Senior AI CTO performing a cross-project retrospective across every
    connected spoke belonging to ONE customer (tenant "${tenantId}") - never
    mix in patterns from any other tenant's projects, even if you happen to
    know about them; a proposal here must be justifiable from this tenant's
    own spokes alone.
    CURRENT GLOBAL STANDARDS (universal_lessons.md): ${universalLessons}
    CURRENT GLOBAL NORTH STAR (north_star_framework.md): ${globalNorthStar}

    PER-SPOKE CONTEXT:
    ${perSpokeSection}

    TASK: Look for a genuine pattern that recurs across TWO OR MORE spokes
    above - not something specific to only one project - that the CURRENT
    GLOBAL STANDARDS or GLOBAL NORTH STAR don't already cover. Weigh a
    MAINTAINER FEEDBACK signal that recurs across multiple spokes as real
    evidence too - if several spokes show negative feedback on a similar
    kind of finding, that's a sign a check should be adjusted or suppressed,
    not just repeated. If you find one, propose it as the FULL, updated text
    of universal_lessons.md and/or north_star_framework.md (not a diff - the
    complete file content with your addition folded in). If nothing
    genuinely cross-cutting stands out, set "has_proposal" to false and
    leave both patch fields as empty strings - do not invent a pattern just
    to have something to propose.
    Respond with ONLY valid JSON, exactly this shape:
    {
      "has_proposal": boolean,
      "reasoning": string,
      "universal_lessons_patch": string,
      "north_star_patch": string
    }
  `;

  const aiResponse = await fetchImpl(`${process.env.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    })
  });

  const aiData = await aiResponse.json();
  const rawContent = aiData?.choices?.[0]?.message?.content;

  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return { tenantId, status: 'Skipped', reason: 'AI returned no content', dryRun };
  }

  let result;
  try {
    result = JSON.parse(rawContent);
  } catch (parseError) {
    return { tenantId, status: 'Skipped', reason: 'AI did not return valid JSON', raw: rawContent.slice(0, 500), dryRun };
  }

  if (result.has_proposal !== true) {
    return { tenantId, status: 'Skipped', reason: 'AI found no cross-spoke pattern worth proposing', dryRun };
  }

  const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
  const hasAnyPatch = isNonEmptyString(result.universal_lessons_patch) || isNonEmptyString(result.north_star_patch);
  const isValidShape = isNonEmptyString(result.reasoning) && hasAnyPatch;

  if (!isValidShape) {
    return { tenantId, status: 'Skipped', reason: 'AI response did not match the required shape', raw: rawContent.slice(0, 500), dryRun };
  }

  if (dryRun) {
    return { tenantId, status: 'DryRunProposal', dryRun: true, proposal: result };
  }

  // Live: propose via a PR against the hub itself, using hubOctokit (the
  // hub's own credential - a tenant's own token has no access to the hub
  // repo at all, by design) - never push directly to the default branch.
  // The PR body names which tenant's data prompted it, so the human
  // reviewing/merging can judge whether generalizing a customer-specific
  // pattern into the shared global standard is appropriate - this
  // disclosure is what keeps "propose via PR, human merges" an adequate
  // isolation safeguard instead of a silent cross-tenant leak.
  const defaultBranch = await getDefaultBranch(hubOctokit, HUB_OWNER, HUB_REPO);
  const { data: baseRef } = await hubOctokit.git.getRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `heads/${defaultBranch}` });
  const branchName = `recursive-learning-${tenantId}-${Date.now()}`;
  await hubOctokit.git.createRef({ owner: HUB_OWNER, repo: HUB_REPO, ref: `refs/heads/${branchName}`, sha: baseRef.object.sha });

  const filesToUpdate = [];
  if (isNonEmptyString(result.universal_lessons_patch)) {
    filesToUpdate.push({ path: 'universal_lessons.md', content: result.universal_lessons_patch });
  }
  if (isNonEmptyString(result.north_star_patch)) {
    filesToUpdate.push({ path: 'north_star_framework.md', content: result.north_star_patch });
  }

  for (const file of filesToUpdate) {
    let existingSha;
    try {
      const { data } = await hubOctokit.repos.getContent({ owner: HUB_OWNER, repo: HUB_REPO, path: file.path, ref: branchName });
      existingSha = data.sha;
    } catch (e) {
      existingSha = undefined;
    }
    const params = {
      owner: HUB_OWNER, repo: HUB_REPO, path: file.path, branch: branchName,
      message: `docs: recursive-learning proposal for ${file.path} (tenant ${tenantId})`,
      content: Buffer.from(file.content).toString('base64')
    };
    if (existingSha) params.sha = existingSha;
    await hubOctokit.repos.createOrUpdateFileContents(params);
  }

  const pr = await hubOctokit.pulls.create({
    owner: HUB_OWNER, repo: HUB_REPO,
    title: `Recursive Learning: proposed cross-spoke updates (tenant ${tenantId})`,
    head: branchName,
    base: defaultBranch,
    body: `### Reasoning\\n${result.reasoning}\\n\\n---\\nGenerated automatically by \\`api/recursive_learning.js\\` from patterns observed across ${tenantSpokes.length} spoke(s) belonging to **tenant \\`${tenantId}\\`** (\\`${tenant?.name || tenantId}\\`). This is a proposal, not a decision - review before merging, and consider whether generalizing a pattern from one customer's projects into the shared global standard is appropriate before doing so.`
  });

  return { tenantId, status: 'Success', dryRun: false, pullRequestUrl: pr.data.html_url };
}

// The actual logic, factored out of the Vercel handler the same way
// autonomous_agent.js's processRequest is, so it can be driven by a local
// mock harness instead of hitting GitHub/the AI API for real.
//
// `octokitFactory(token)` replaces a single injected `octokit` instance,
// mirroring api/autonomous_agent.js's own multi-tenancy redesign - each
// tenant's spokes get read with THEIR OWN credential (decision #1), not one
// shared token. `hubOctokit` is a separate, already-constructed client
// scoped to the hub's own repo/token, used for reading spokes.json/
// tenants.json and for the PR/branch operations against the hub itself.
export async function runRecursiveLearning(reqBody, { octokitFactory, hubOctokit, fetchImpl = fetch, dryRunOverride, hubOwner, hubRepo, spokesOverride, tenantsOverride } = {}) {
  const HUB_OWNER = hubOwner || process.env.HUB_GITHUB_OWNER || DEFAULT_HUB_OWNER;
  const HUB_REPO = hubRepo || process.env.HUB_GITHUB_REPO || DEFAULT_HUB_REPO;

  // Same safety rail as autonomous_agent.js, and the same env var - a
  // proposal is a lower-stakes action than filing an issue (it's a PR
  // someone has to review and merge, not something posted unattended), but
  // this still shouldn't go live before Sprint 0's rail has been verified.
  const dryRun = dryRunOverride !== undefined
    ? dryRunOverride
    : process.env.DRY_RUN_MODE !== 'false';

  const spokes = spokesOverride || safeParseJsonArray(await safeGetTextContent(hubOctokit, HUB_OWNER, HUB_REPO, SPOKES_REGISTRY_PATH));

  if (spokes.length === 0) {
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No spokes registered in spokes.json', dryRun } };
  }

  const tenants = tenantsOverride || safeParseJsonArray(await safeGetTextContent(hubOctokit, HUB_OWNER, HUB_REPO, TENANTS_REGISTRY_PATH));
  const byTenant = groupSpokesByTenant(spokes);

  const universalLessonsPath = join(process.cwd(), 'universal_lessons.md');
  const globalNorthStarPath = join(process.cwd(), 'north_star_framework.md');
  const universalLessons = existsSync(universalLessonsPath) ? readFileSync(universalLessonsPath, 'utf8') : "";
  const globalNorthStar = existsSync(globalNorthStarPath) ? readFileSync(globalNorthStarPath, 'utf8') : "";

  // One independent run per tenant - never pooled. See runForTenant's own
  // comment on why the prompt itself also says this explicitly.
  const results = [];
  for (const [tenantId, tenantSpokes] of Object.entries(byTenant)) {
    const tenant = findTenant(tenantId, tenants);
    results.push(await runForTenant({
      tenantId, tenantSpokes, tenant, octokitFactory, hubOctokit, fetchImpl, dryRun,
      universalLessons, globalNorthStar, HUB_OWNER, HUB_REPO
    }));
  }

  // Additional, separate pass: repos that opted in (spoke.shareLearnings)
  // get pooled together regardless of which tenant owns them, looking for
  // patterns that recur ACROSS organizations - see runForSharedPool's own
  // header comment for the anonymization/anti-hallucination safeguards.
  // Not a tenant, so it isn't forced into the `results` array shape above.
  const sharedPoolSpokes = selectSharedPoolSpokes(spokes);
  const sharedPoolResult = await runForSharedPool({
    sharedPoolSpokes, tenants, octokitFactory, hubOctokit, fetchImpl, dryRun,
    universalLessons, globalNorthStar, HUB_OWNER, HUB_REPO
  });

  return { httpStatus: 200, body: { status: 'Completed', dryRun, tenantCount: results.length, results, sharedPoolResult } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const octokitFactory = (token) => new Octokit({ auth: token });
  const hubOctokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  try {
    const { httpStatus, body } = await runRecursiveLearning(req.body, { octokitFactory, hubOctokit, fetchImpl: fetch });
    return res.status(httpStatus).json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}"""
        },

        # Self-service onboarding entry point - GET redirect into GitHub's
        # own install picker with a signed state token.
        {
            "path": "api/onboard_start.js",
            "content": """// Entry point for self-service onboarding - a plain GET redirect into
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
}"""
        },

        # GitHub's post-install redirect target - re-verifies the installation
        # against GitHub itself before proceeding to Stripe Checkout.
        {
            "path": "api/github_app_callback.js",
            "content": """// GitHub's post-install redirect target - a GET request anyone can, in
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
}"""
        },

        # Verifies a real Stripe payment and, only then, provisions a tenant.
        {
            "path": "api/stripe_webhook.js",
            "content": """// Verifies a real Stripe payment and, only then, provisions a tenant. The
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
// Real multi-tier pricing: the actual purchased plan is re-derived from
// what Stripe says was really paid for (stripe.checkout.sessions.
// listLineItems, matched against plans.json by Stripe price ID) - never
// trusted from anything client-supplied. An unrecognized price (e.g. the
// operator added a new Payment Link but forgot to update plans.json) does
// NOT silently default to any plan - it's surfaced as 'UnrecognizedPrice'
// for manual reconciliation, the same "disclosed gap over silent one"
// treatment as the 'Unlinked' case below.
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
import { appendToJsonRegistryWithRetry, readJsonArrayFile } from '../lib/registry_writer.js';
import { loadPlansRegistry, findPlanByStripePriceId } from '../lib/secrets.js';

export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 1_000_000;

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

// Looks up the real plan the customer actually paid for, from Stripe's own
// record of the checkout session's line items - never from anything the
// client supplied. Returns the matching plans.json entry, or null if the
// session has no resolvable price or that price doesn't match any known
// plan (a real, disclosed gap - see handleStripeWebhook's 'UnrecognizedPrice'
// result - never silently defaulted).
async function resolvePlanForSession(stripe, sessionId, plans) {
  let lineItems;
  try {
    lineItems = await stripe.checkout.sessions.listLineItems(sessionId, { expand: ['data.price'] });
  } catch (e) {
    return null;
  }
  const firstItem = lineItems && lineItems.data && lineItems.data[0];
  const priceId = firstItem && firstItem.price && firstItem.price.id;
  if (!priceId) return null;
  return findPlanByStripePriceId(priceId, plans);
}

async function provisionTenantForInstallation({ installationId, accountLogin, stripeCustomerId, plan, hubOctokit, hubOwner, hubRepo, now }) {
  const tenantId = tenantIdForInstallation(installationId);
  return appendToJsonRegistryWithRetry(hubOctokit, hubOwner, hubRepo, 'tenants.json', {
    message: `chore: provision tenant for GitHub App installation ${installationId} (self-service onboarding, plan ${plan.planId})`,
    decide: (existingTenants) => {
      const existing = existingTenants.find((t) => t && t.tenantId === tenantId);
      if (existing) return { skip: true, result: { status: 'AlreadyProvisioned', tenantId } };
      const entry = {
        tenantId,
        name: accountLogin,
        status: 'active',
        plan: plan.planId,
        quota: { reviewsPerMonth: plan.reviewsPerMonth ?? null },
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
  githubAppRequest,
  plans = loadPlansRegistry()
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
  const tenantId = tenantIdForInstallation(installationId);

  // Cheap, best-effort idempotency pre-check BEFORE spending a Stripe API
  // call to resolve the plan: a redelivered/duplicate event for a tenant
  // that's already provisioned must report AlreadyProvisioned regardless
  // of whether the plan lookup below would succeed right now (a session's
  // line items are not guaranteed to stay resolvable forever) - the actual
  // write-path idempotency check inside provisionTenantForInstallation
  // still re-verifies this atomically against a fresh read, so a race
  // landing between this check and that one is still handled correctly,
  // just possibly with one redundant plan lookup.
  const { entries: existingTenants } = await readJsonArrayFile(hubOctokit, hubOwner, hubRepo, 'tenants.json');
  if (existingTenants.some((t) => t && t.tenantId === tenantId)) {
    return { httpStatus: 200, body: { status: 'AlreadyProvisioned', tenantId } };
  }

  const plan = await resolvePlanForSession(stripe, session.id, plans);
  if (!plan) {
    // A payment Stripe genuinely confirmed, but for a price that doesn't
    // match any entry in plans.json - most likely the operator added a new
    // Payment Link/Price without updating plans.json to match. Acked (not
    // retried by Stripe) but never provisioned under a guessed/default
    // plan - surfaced for manual reconciliation instead, same treatment as
    // the 'Unlinked' case above.
    console.warn(`stripe_webhook: checkout.session.completed (session ${session.id}) has no price matching any plan in plans.json - needs manual reconciliation`);
    return { httpStatus: 200, body: { status: 'UnrecognizedPrice', reason: 'no plan in plans.json matches this session\\'s Stripe price' } };
  }

  const provisionResult = await provisionTenantForInstallation({ installationId, accountLogin, stripeCustomerId: session.customer, plan, hubOctokit, hubOwner, hubRepo, now });

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
}"""
        },

        # GitHub's own App-level webhook - proactive suspend/unsuspend on
        # installation.deleted/suspend/unsuspend.
        {
            "path": "api/github_app_webhook.js",
            "content": """// GitHub's own App-level webhook - handles `installation` events
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
}"""
        },

        # 3. MEMORY MANAGEMENT
        {
            "path": "scripts/prune-logs.js",
            "content": """// Real implementation of the "Maintenance Scripts" capability README always
// claimed. The previous version of this file was a no-op stub
// ("Pruner initialized. Ready for Sunday maintenance.") that nothing ever
// invoked and that didn't touch a single decision log.
//
// Runs as a plain GitHub Actions script (no AI, no Vercel call) - it only
// needs a GitHub token with cross-repo write access, mirrored here as the
// GLOBAL_GITHUB_TOKEN Actions secret on this repo (the Vercel env var of
// the same name doesn't reach an Actions runner).
//
// Usage: node scripts/prune-logs.js
//   Env: RETENTION_DAYS (default 90), DRY_RUN=true to report without writing

import { Octokit } from '@octokit/rest';
import { loadSpokesRegistry, loadTenantsRegistry, resolveTenantIdForSpoke, findTenant, resolveSecretRef } from '../lib/secrets.js';

const DECISION_LOG_PATH = 'ai_decision_log.json';
const ARCHIVE_LOG_PATH = 'ai_decision_log_archive.json';
const DEFAULT_RETENTION_DAYS = 90;

// loadSpokesRegistry/loadTenantsRegistry/resolveTenantIdForSpoke/findTenant/
// resolveSecretRef now live in ../lib/secrets.js (imported above) - deduped
// out of what used to be 6 byte-identical Node-side copies of the same
// functions, see that file's header comment.

async function readJsonArrayFile(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { entries: Array.isArray(parsed) ? parsed : [], sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

async function writeJsonArrayFile(octokit, owner, repo, path, entries, sha, message) {
  const content = Buffer.from(JSON.stringify(entries, null, 2)).toString('base64');
  const params = { owner, repo, path, message, content };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

// Entries without a parseable timestamp are treated as "recent" (kept) -
// safer to keep something we can't date than to silently archive it.
function partitionByAge(entries, retentionDays, now) {
  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const recent = [];
  const old = [];
  for (const entry of entries) {
    const t = entry && entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
    if (!Number.isNaN(t) && t < cutoffMs) old.push(entry);
    else recent.push(entry);
  }
  return { recent, old };
}

// A stable identity for a decision-log entry, used to dedupe against what's
// already archived. timestamp+commitSha+mode is unique per real decision;
// this is not a general-purpose object hash, just enough to recognize "this
// exact entry already made it into the archive."
function archiveKeyFor(entry) {
  return `${entry && entry.timestamp}|${entry && entry.commitSha}|${entry && entry.mode}`;
}

// Prunes one spoke's decision log. Archive-then-truncate: the archive write
// happens first, so a failure between the two writes leaves an entry
// duplicated in both files (safe, idempotent on the next run) rather than
// lost.
//
// Retries the whole read-partition-write cycle a few times on failure - most
// likely a stale-sha conflict from a heartbeat run (autonomous_agent.js)
// appending a new decision entry in the same window this pruner is reading
// and writing. Re-reading from scratch each attempt picks up that new entry
// instead of clobbering it.
//
// The archive write itself is deduped against what's already there before
// writing (and skipped entirely if there's nothing new). Without this, a
// retry triggered by the *live-log* write failing - after the *archive*
// write on that same attempt already succeeded - would re-append the same
// "old" entries to the archive a second time on the next attempt, since
// re-reading from scratch recomputes the same `old` set from an
// as-yet-untruncated live log. That's a real duplicate within one
// invocation's retry loop, not just the safe, eventually-consistent
// duplication the archive-then-truncate ordering is meant to allow for
// across separate runs.
export async function pruneSpoke(octokit, spoke, { retentionDays = DEFAULT_RETENTION_DAYS, dryRun = false, now = Date.now(), maxAttempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { entries: liveEntries, sha: liveSha } = await readJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH);
    const { recent, old } = partitionByAge(liveEntries, retentionDays, now);

    if (old.length === 0) {
      return { owner: spoke.owner, repo: spoke.repo, moved: 0, skipped: true };
    }

    if (dryRun) {
      return { owner: spoke.owner, repo: spoke.repo, moved: old.length, dryRun: true };
    }

    try {
      const { entries: archiveEntries, sha: archiveSha } = await readJsonArrayFile(octokit, spoke.owner, spoke.repo, ARCHIVE_LOG_PATH);
      const archivedKeys = new Set(archiveEntries.map(archiveKeyFor));
      const newToArchive = old.filter((entry) => !archivedKeys.has(archiveKeyFor(entry)));
      if (newToArchive.length > 0) {
        const updatedArchive = [...archiveEntries, ...newToArchive];
        await writeJsonArrayFile(octokit, spoke.owner, spoke.repo, ARCHIVE_LOG_PATH, updatedArchive, archiveSha, 'chore: archive old decision-log entries');
      }
      await writeJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH, recent, liveSha, 'chore: prune archived entries from decision log');
      return { owner: spoke.owner, repo: spoke.repo, moved: old.length, dryRun: false };
    } catch (e) {
      lastError = e;
      // Loop and retry with a fresh read on the next iteration.
    }
  }
  throw lastError;
}

// Multi-tenancy: each spoke's decision log is pruned using ITS tenant's own
// resolved credential when `octokitFactory` is supplied in `options`
// (decision #1 in lessons.md's multi-tenancy entry) - falls back to the
// single `octokit` passed in when octokitFactory isn't given, so existing
// single-tenant callers/tests keep working unchanged.
export async function pruneAllSpokes(octokit, options = {}) {
  const { octokitFactory, spokesOverride, tenantsOverride, ...pruneOptions } = options;
  const spokes = spokesOverride || loadSpokesRegistry();
  const tenants = tenantsOverride || loadTenantsRegistry();
  const results = [];
  for (const spoke of spokes) {
    try {
      let spokeOctokit = octokit;
      if (octokitFactory) {
        const tenantId = resolveTenantIdForSpoke(spoke.owner, spoke.repo, spokes);
        const tenant = findTenant(tenantId, tenants);
        // Read-only-adjacent maintenance script - best-effort-with-some-token
        // is the right behavior here (matches doctor.js/health-report.js/
        // collect-issue-feedback.js's identical, deliberate fallback),
        // unlike the hard-skip rule in api/autonomous_agent.js/
        // api/recursive_learning.js.
        const resolved = tenant ? await resolveSecretRef(tenant.githubCredentialRef) : null;
        const token = resolved || process.env.GLOBAL_GITHUB_TOKEN;
        spokeOctokit = octokitFactory(token);
      }
      results.push(await pruneSpoke(spokeOctokit, spoke, pruneOptions));
    } catch (e) {
      results.push({ owner: spoke.owner, repo: spoke.repo, error: e.message });
    }
  }
  return results;
}

// CLI entry point - only runs when this file is executed directly, not
// when the test harness imports pruneSpoke/pruneAllSpokes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const retentionDays = Number(process.env.RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  const dryRun = process.env.DRY_RUN === 'true';
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
  const octokitFactory = (token) => new Octokit({ auth: token });

  pruneAllSpokes(octokit, { retentionDays, dryRun, octokitFactory })
    .then((results) => {
      console.log(JSON.stringify(results, null, 2));
      if (results.some((r) => r.error)) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}"""
        },
        {
            "path": "scripts/health-report.js",
            "content": """// Real, Mothership-native health reporting - replaces the health-report.yml
// PR #1 deleted, which was a non-functional copy-paste from tso (referenced
// scripts/health-analyzer.js and Prisma, neither of which exist in this
// repo, and posted comments literally saying "Auto-generated by TSO Health
// System"). This one reports on the hub/swarm's own health, not a spoke's.
//
// Runs as a plain GitHub Actions script (no AI, no Vercel call) - like
// prune-logs.js, it only needs a GitHub token, mirrored as the
// GLOBAL_GITHUB_TOKEN Actions secret on this repo.
//
// Multi-tenancy: each spoke's own data (issues filed, decision log) is read
// using ITS tenant's own resolved credential when octokitFactory is
// supplied (decision #1 in lessons.md's multi-tenancy entry) - falls back
// to the single `octokit` passed to buildFullReport when octokitFactory
// isn't given, so existing single-tenant callers/tests keep working
// unchanged. The report itself (and the pinned issue it publishes to) stay
// hub-wide/operator-facing - this is about using the right credential to
// read each spoke, not about splitting the report per tenant.
//
// Usage: node scripts/health-report.js

import { Octokit } from '@octokit/rest';
import { loadSpokesRegistry, loadTenantsRegistry, resolveTenantIdForSpoke, findTenant, resolveSecretRef } from '../lib/secrets.js';

const DECISION_LOG_PATH = 'ai_decision_log.json';
const HUB_ISSUE_LABEL = 'cto-hub-auto';
const REPORT_ISSUE_LABEL = 'mothership-health-report';
const REPORT_ISSUE_TITLE = 'Mothership Health Report';
const REPORT_WINDOW_DAYS = 7;

const HUB_OWNER = process.env.HUB_GITHUB_OWNER || 'adamberneche-afk';
const HUB_REPO = process.env.HUB_GITHUB_REPO || 'Mothership';

// loadSpokesRegistry/loadTenantsRegistry/resolveTenantIdForSpoke/findTenant/
// resolveSecretRef now live in ../lib/secrets.js (imported above) - deduped
// out of what used to be 6 byte-identical Node-side copies of the same
// functions, see that file's header comment.

async function safeGetTextContent(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
}

function safeParseJsonArray(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item);
    (out[k] = out[k] || []).push(item);
  }
  return out;
}

async function countIssuesCreatedSince(octokit, owner, repo, windowStart) {
  const { data } = await octokit.issues.listForRepo({
    owner, repo, state: 'all', labels: HUB_ISSUE_LABEL, sort: 'created', direction: 'desc', per_page: 100
  });
  let count = 0;
  for (const issue of data) {
    if (new Date(issue.created_at) < windowStart) break;
    count++;
  }
  return count;
}

// Builds the report for a single spoke. Exported separately from
// buildFullReport so tests can drive it directly without needing a real
// spokes.json on disk.
export async function buildReportForSpoke(octokit, spoke, { windowStart }) {
  const issuesFiled = await countIssuesCreatedSince(octokit, spoke.owner, spoke.repo, windowStart);
  const logText = await safeGetTextContent(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH);
  const allEntries = safeParseJsonArray(logText);
  const recentEntries = allEntries.filter((e) => e && e.timestamp && new Date(e.timestamp) >= windowStart);

  const byOutcomeGroups = groupBy(recentEntries, (e) => e.outcome || 'unknown');
  const byOutcome = Object.fromEntries(Object.entries(byOutcomeGroups).map(([k, v]) => [k, v.length]));
  const total = recentEntries.length;
  const createdCount = byOutcome.created || 0;
  const dryRunFindingCount = byOutcome.dry_run_would_create || 0;
  const skipRate = total > 0 ? 1 - createdCount / total : null;

  // Live/dry-run status is INFERRED from observed decision-log outcomes,
  // not read from Vercel config - a GitHub Actions runner has no way to
  // read the hub's Vercel env vars directly.
  let capabilityStatus;
  if (total === 0) {
    capabilityStatus = 'no decisions logged this window (heartbeat may not have run, or spoke was recently added)';
  } else if (createdCount > 0) {
    capabilityStatus = 'live (created at least one issue this window)';
  } else if (dryRunFindingCount > 0) {
    capabilityStatus = 'dry-run (reported findings, filed nothing)';
  } else {
    capabilityStatus = 'active, no real findings this window';
  }

  return { owner: spoke.owner, repo: spoke.repo, issuesFiled, entriesInWindow: total, byOutcome, skipRate, capabilityStatus };
}

export async function buildFullReport(octokit, { now = Date.now(), windowDays = REPORT_WINDOW_DAYS, octokitFactory, spokesOverride, tenantsOverride } = {}) {
  const spokes = spokesOverride || loadSpokesRegistry();
  const tenants = tenantsOverride || loadTenantsRegistry();
  const windowStart = new Date(now - windowDays * 24 * 60 * 60 * 1000);
  const generatedAt = new Date(now).toISOString();

  // Read-only diagnostic tool - best-effort-with-some-token is the right
  // behavior here (matches doctor.js/prune-logs.js/collect-issue-feedback.js's
  // identical, deliberate fallback), unlike the hard-skip rule in
  // api/autonomous_agent.js/api/recursive_learning.js.
  const resolveOctokitForSpoke = async (spoke) => {
    if (!octokitFactory) return octokit;
    const tenantId = resolveTenantIdForSpoke(spoke.owner, spoke.repo, spokes);
    const tenant = findTenant(tenantId, tenants);
    const resolved = tenant ? await resolveSecretRef(tenant.githubCredentialRef) : null;
    const token = resolved || process.env.GLOBAL_GITHUB_TOKEN;
    return octokitFactory(token);
  };

  const spokeReports = [];
  for (const spoke of spokes) {
    try {
      spokeReports.push(await buildReportForSpoke(await resolveOctokitForSpoke(spoke), spoke, { windowStart }));
    } catch (e) {
      spokeReports.push({ owner: spoke.owner, repo: spoke.repo, error: e.message });
    }
  }

  return { generatedAt, windowDays, spokes: spokeReports };
}

export function renderReportMarkdown(report) {
  const lines = [];
  lines.push('# Mothership Health Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt} · Window: last ${report.windowDays} days`);
  lines.push('');

  if (report.spokes.length === 0) {
    lines.push('_No spokes registered in `spokes.json` yet - nothing to report on._');
    return lines.join('\\n');
  }

  lines.push('| Spoke | Issues Filed | Decisions Logged | Skip Rate | Status |');
  lines.push('|---|---|---|---|---|');
  for (const s of report.spokes) {
    if (s.error) {
      lines.push(`| ${s.owner}/${s.repo} | - | - | - | error: ${s.error} |`);
      continue;
    }
    const skipRatePct = s.skipRate === null ? 'n/a' : `${Math.round(s.skipRate * 100)}%`;
    lines.push(`| ${s.owner}/${s.repo} | ${s.issuesFiled} | ${s.entriesInWindow} | ${skipRatePct} | ${s.capabilityStatus} |`);
  }

  lines.push('');
  lines.push('<details><summary>Outcome breakdown per spoke</summary>');
  lines.push('');
  for (const s of report.spokes) {
    if (s.error) continue;
    lines.push(`- **${s.owner}/${s.repo}**: ${JSON.stringify(s.byOutcome)}`);
  }
  lines.push('');
  lines.push('</details>');

  return lines.join('\\n');
}

async function findExistingReportIssue(octokit) {
  const { data } = await octokit.issues.listForRepo({
    owner: HUB_OWNER, repo: HUB_REPO, state: 'all', labels: REPORT_ISSUE_LABEL, per_page: 10
  });
  return data.find((issue) => issue.title === REPORT_ISSUE_TITLE) || null;
}

// Updates the same pinned issue in place on every run instead of creating a
// new one each time - a deliberate callback to the original issue-spam
// disaster this whole system exists to avoid repeating. Always uses the
// hub's own credential (never a tenant-scoped one) - this issue lives on
// the hub repo itself.
export async function publishReport(octokit, body) {
  const existing = await findExistingReportIssue(octokit);
  if (existing) {
    const updateParams = { owner: HUB_OWNER, repo: HUB_REPO, issue_number: existing.number, body };
    // If a human closed the report issue (e.g. tidying notifications), the
    // update itself doesn't reopen it by default - reopen explicitly, or
    // every future run would keep silently rewriting a closed issue's body
    // instead of surfacing anywhere a maintainer would actually look.
    const wasClosed = existing.state === 'closed';
    if (wasClosed) updateParams.state = 'open';
    await octokit.issues.update(updateParams);
    return { action: wasClosed ? 'reopened' : 'updated', issueUrl: existing.html_url };
  }
  const created = await octokit.issues.create({
    owner: HUB_OWNER, repo: HUB_REPO, title: REPORT_ISSUE_TITLE, body, labels: [REPORT_ISSUE_LABEL]
  });
  return { action: 'created', issueUrl: created.data.html_url };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
  const octokitFactory = (token) => new Octokit({ auth: token });

  buildFullReport(octokit, { octokitFactory })
    .then(async (report) => {
      const body = renderReportMarkdown(report);
      console.log(body);
      const result = await publishReport(octokit, body);
      console.log(JSON.stringify(result));
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}"""
        },

        {
            "path": "scripts/collect-issue-feedback.js",
            "content": """// Closes a real gap: today the only way a spoke maintainer can tell the
// system "this finding was wrong" is closing the issue - nothing reads
// that. GitHub's issue objects already carry a `reactions` summary
// (`{"+1", "-1", laugh, ...}`) on every issue `issues.listForRepo` returns -
// no extra API call needed - so a thumbs-down on a hub-filed issue is a
// free, already-available signal that's simply never been read. This
// script reads it and attaches it to the matching `ai_decision_log.json`
// entry, so `api/recursive_learning.js`/`gas/recursive_learning.js` can
// factor a spoke's negative feedback into what they propose.
//
// Runs as a plain GitHub Actions script (no AI, no Vercel call) - like
// prune-logs.js/health-report.js, it only needs a GitHub token, mirrored as
// the GLOBAL_GITHUB_TOKEN Actions secret on this repo.
//
// Multi-tenancy: each spoke's issues/decision log are read using ITS
// tenant's own resolved credential when octokitFactory is supplied
// (decision #1 in lessons.md's multi-tenancy entry) - falls back to the
// single `octokit` passed to collectFeedbackForAllSpokes when
// octokitFactory isn't given, so existing single-tenant callers/tests keep
// working unchanged.
//
// Usage: node scripts/collect-issue-feedback.js

import { Octokit } from '@octokit/rest';
import { loadSpokesRegistry, loadTenantsRegistry, resolveTenantIdForSpoke, findTenant, resolveSecretRef } from '../lib/secrets.js';

const DECISION_LOG_PATH = 'ai_decision_log.json';
const HUB_ISSUE_LABEL = 'cto-hub-auto';

// loadSpokesRegistry/loadTenantsRegistry/resolveTenantIdForSpoke/findTenant/
// resolveSecretRef now live in ../lib/secrets.js (imported above) - deduped
// out of what used to be 6 byte-identical Node-side copies of the same
// functions, see that file's header comment.

async function readJsonArrayFile(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { entries: Array.isArray(parsed) ? parsed : [], sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

async function writeJsonArrayFile(octokit, owner, repo, path, entries, sha, message) {
  const content = Buffer.from(JSON.stringify(entries, null, 2)).toString('base64');
  const params = { owner, repo, path, message, content };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

async function fetchLabeledIssues(octokit, owner, repo) {
  const { data } = await octokit.issues.listForRepo({
    owner, repo, state: 'all', labels: HUB_ISSUE_LABEL, per_page: 100
  });
  return data;
}

function reactionCounts(issue) {
  const r = issue && issue.reactions;
  return { thumbsUp: (r && r['+1']) || 0, thumbsDown: (r && r['-1']) || 0 };
}

function feedbackChanged(existing, counts) {
  if (!existing) return true;
  return existing.thumbsDown !== counts.thumbsDown || existing.thumbsUp !== counts.thumbsUp;
}

// Collects feedback for one spoke. Only decisions with outcome 'created'
// ever have a non-null issueUrl (confirmed against makeLogEntry in both
// autonomous_agent.js files) - anything else is skipped, there's nothing to
// match a reaction to. Matches by exact issueUrl === issue.html_url string
// equality; both come from the same GitHub field, so this is reliable
// without needing to parse an issue number out of the URL.
//
// Same retry-on-conflict shape as prune-logs.js's pruneSpoke: re-read the
// live log fresh on every attempt, in case a concurrent heartbeat run
// appended a new decision in the same window. Only writes if something
// actually changed - a run with no new reactions writes nothing.
export async function collectFeedbackForSpoke(octokit, spoke, { now = Date.now(), maxAttempts = 3 } = {}) {
  const issues = await fetchLabeledIssues(octokit, spoke.owner, spoke.repo);
  const issuesByUrl = new Map(issues.map((issue) => [issue.html_url, issue]));

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { entries, sha } = await readJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH);

    const updated = entries.map((entry) => {
      if (!entry || !entry.issueUrl) return entry;
      const issue = issuesByUrl.get(entry.issueUrl);
      if (!issue) return entry;
      const counts = reactionCounts(issue);
      // Only a real negative signal is worth recording - a plain thumbs-up
      // with no thumbs-down isn't feedback the system needs to act on.
      if (counts.thumbsDown === 0) return entry;
      if (!feedbackChanged(entry.feedback, counts)) return entry;
      return { ...entry, feedback: { thumbsUp: counts.thumbsUp, thumbsDown: counts.thumbsDown, checkedAt: new Date(now).toISOString() } };
    });

    const changedCount = updated.filter((entry, i) => entry !== entries[i]).length;
    if (changedCount === 0) {
      return { owner: spoke.owner, repo: spoke.repo, updated: 0 };
    }

    try {
      await writeJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH, updated, sha, 'chore: record maintainer feedback on filed issues');
      return { owner: spoke.owner, repo: spoke.repo, updated: changedCount };
    } catch (e) {
      lastError = e;
      // Loop and retry with a fresh read on the next iteration.
    }
  }
  throw lastError;
}

export async function collectFeedbackForAllSpokes(octokit, options = {}) {
  const { octokitFactory, spokesOverride, tenantsOverride, ...collectOptions } = options;
  const spokes = spokesOverride || loadSpokesRegistry();
  const tenants = tenantsOverride || loadTenantsRegistry();
  const results = [];
  for (const spoke of spokes) {
    try {
      let spokeOctokit = octokit;
      if (octokitFactory) {
        const tenantId = resolveTenantIdForSpoke(spoke.owner, spoke.repo, spokes);
        const tenant = findTenant(tenantId, tenants);
        // Read-only-adjacent maintenance script - best-effort-with-some-token
        // is the right behavior here (matches doctor.js/health-report.js/
        // prune-logs.js's identical, deliberate fallback), unlike the
        // hard-skip rule in api/autonomous_agent.js/api/recursive_learning.js.
        const resolved = tenant ? await resolveSecretRef(tenant.githubCredentialRef) : null;
        const token = resolved || process.env.GLOBAL_GITHUB_TOKEN;
        spokeOctokit = octokitFactory(token);
      }
      results.push(await collectFeedbackForSpoke(spokeOctokit, spoke, collectOptions));
    } catch (e) {
      results.push({ owner: spoke.owner, repo: spoke.repo, error: e.message });
    }
  }
  return results;
}

// CLI entry point - only runs when this file is executed directly, not
// when the test harness imports collectFeedbackForSpoke/collectFeedbackForAllSpokes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
  const octokitFactory = (token) => new Octokit({ auth: token });

  collectFeedbackForAllSpokes(octokit, { octokitFactory })
    .then((results) => {
      console.log(JSON.stringify(results, null, 2));
      if (results.some((r) => r.error)) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}"""
        },

        {
            "path": "scripts/doctor.js",
            "content": """// Pre-flight health check for the hub + every registered spoke - checks
// exactly the class of bug found live this session: GLOBAL_GITHUB_TOKEN
// invalid (health-report.yml's 401, undetected through 5 straight runs)
// and a spoke's call-hub.yml missing its hub-URL secret entirely
// (thinkos-server/tais failing 100+ scheduled runs on an unset VERCEL_URL).
// Both were checkable in under a second per repo - nothing before this ran
// that check before something broke in production.
//
// Deliberately workflow_dispatch-only, no schedule (see doctor.yml) - this
// session's whole investigation was triggered by workflows failing
// silently on a schedule nobody was watching; adding another scheduled job
// here risks the identical failure mode this tool exists to catch.
//
// A real, disclosed limitation, not overclaimed: GitHub never exposes a
// repo secret's VALUE via any API, only its name and timestamps. The
// per-spoke secret check below can only confirm something with the right
// NAME exists - it would have caught a fully-unset VERCEL_URL, but not one
// set to an empty string or a wrong value. That's a narrower net than "the
// exact incident," and it's stated as such rather than papered over.
//
// Multi-tenancy: each spoke is checked using ITS OWN tenant's resolved
// GitHub credential (decision #1 in lessons.md's multi-tenancy entry), not
// one shared token - see checkSpokeRepoReachable/checkSpokeHasCallHubWorkflow/
// checkSpokeHasHubUrlSecret's octokitFactory parameter. checkGlobalGithubToken
// still checks the HUB's own token specifically (that's what it's for), via
// the octokit instance the CLI wrapper passes in directly.
//
// Usage: node scripts/doctor.js

import { Octokit } from '@octokit/rest';
import { loadSpokesRegistry, loadTenantsRegistry, resolveTenantIdForSpoke, findTenant, resolveSecretRef } from '../lib/secrets.js';

const CALL_HUB_WORKFLOW_PATH = '.github/workflows/call-hub.yml';
const HUB_URL_SECRET_NAMES = ['VERCEL_URL', 'APPS_SCRIPT_URL'];

// This exact repo's own GLOBAL_GITHUB_TOKEN, readable at Actions runtime -
// a 401 here is precisely this session's own confirmed incident.
//
// `GET /rate_limit` itself doesn't require authentication at all - it
// happily returns 200 for a fully unauthenticated request too. Found this
// the hard way running the real CLI locally: an empty token still reported
// "valid" here, since the endpoint's own 200 doesn't distinguish "no token"
// from "a real, working one." `token` is checked directly, before ever
// calling the API, for exactly the same reason the AI key check below
// short-circuits on empty rather than trusting a response code that can't
// tell the two states apart.
async function checkGlobalGithubToken(octokit, token) {
  if (!token) return { label: 'GLOBAL_GITHUB_TOKEN', ok: false, detail: 'not configured' };
  try {
    await octokit.request('GET /rate_limit');
    return { label: 'GLOBAL_GITHUB_TOKEN', ok: true, detail: 'valid' };
  } catch (e) {
    const status = e && e.status;
    return {
      label: 'GLOBAL_GITHUB_TOKEN',
      ok: false,
      detail: status === 401 ? 'invalid or expired (401)' : `unexpected error (${e.message})`
    };
  }
}

// Same URL-join convention as the real AI call in autonomous_agent.js
// (`${aiBaseUrl}/chat/completions`) - listing models is the standard,
// low-cost way to validate an OpenAI-compatible key without spending
// completion tokens.
async function checkAiKey(fetchImpl, aiBaseUrl, aiApiKey) {
  if (!aiApiKey) return { label: 'AI_API_KEY', ok: false, detail: 'not configured' };
  if (!aiBaseUrl) return { label: 'AI_API_KEY', ok: false, detail: 'AI_BASE_URL not configured' };
  try {
    const res = await fetchImpl(`${aiBaseUrl}/models`, { headers: { Authorization: `Bearer ${aiApiKey}` } });
    if (res.ok) return { label: 'AI_API_KEY', ok: true, detail: 'valid' };
    return { label: 'AI_API_KEY', ok: false, detail: `invalid or unauthorized (${res.status})` };
  } catch (e) {
    return { label: 'AI_API_KEY', ok: false, detail: `unexpected error (${e.message})` };
  }
}

async function checkSpokeRepoReachable(octokit, spoke) {
  const label = `${spoke.owner}/${spoke.repo}: repo reachable`;
  try {
    await octokit.repos.get({ owner: spoke.owner, repo: spoke.repo });
    return { label, ok: true, detail: 'reachable' };
  } catch (e) {
    return { label, ok: false, detail: `not reachable (${e.message})` };
  }
}

async function checkSpokeHasCallHubWorkflow(octokit, spoke) {
  const label = `${spoke.owner}/${spoke.repo}: call-hub.yml exists`;
  try {
    await octokit.repos.getContent({ owner: spoke.owner, repo: spoke.repo, path: CALL_HUB_WORKFLOW_PATH });
    return { label, ok: true, detail: 'found' };
  } catch (e) {
    // A real 404 means the file genuinely doesn't exist - "not wired up" is
    // the accurate, actionable message. Anything else (rate-limited,
    // network error, auth problem) is a different failure entirely and
    // shouldn't be reported as if the spoke were missing its workflow -
    // caught this exact conflation running the real CLI against the
    // unauthenticated API, where a rate-limit on this call looked
    // identical to a missing file until the real status was checked.
    if (e && e.status === 404) return { label, ok: false, detail: 'not found - spoke not wired up' };
    return { label, ok: false, detail: `couldn't check (${e.message})` };
  }
}

// Can only confirm a secret with the right NAME exists - see the file
// header comment. Still catches the "totally forgot to set it" class of
// mistake, which is a real, common failure mode on its own.
async function checkSpokeHasHubUrlSecret(octokit, spoke) {
  const label = `${spoke.owner}/${spoke.repo}: VERCEL_URL or APPS_SCRIPT_URL secret present`;
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/secrets', { owner: spoke.owner, repo: spoke.repo });
    const names = (data.secrets || []).map((s) => s.name);
    const hasOne = HUB_URL_SECRET_NAMES.some((n) => names.includes(n));
    if (hasOne) return { label, ok: true, detail: 'present (name only - value can\\'t be verified)' };
    return { label, ok: false, detail: 'neither VERCEL_URL nor APPS_SCRIPT_URL is set - call-hub.yml will fail' };
  } catch (e) {
    return { label, ok: false, detail: `couldn't list secrets (${e.message})` };
  }
}

// Catches exactly the class of bug this whole file exists to catch, now
// for the credential model itself: a bad App ID, a revoked/uninstalled
// GitHub App installation, a malformed private key, or a plain typo in a
// tenant's githubCredentialRef, surfaced before it accumulates into a
// silent, live failure the next time that tenant's spoke is actually
// served. Only checks tenants that would actually be served today
// (status !== 'active' is a deliberate, separate suspension, not a
// misconfiguration - excluded here so a doctor run on a suspended tenant
// doesn't cry wolf about a credential nobody expects to work right now).
async function checkTenantCredentialResolves(tenant) {
  const label = `tenant '${tenant.tenantId}': githubCredentialRef resolves`;
  const ref = tenant.githubCredentialRef;
  if (!ref || typeof ref !== 'string') {
    return { label, ok: false, detail: 'no githubCredentialRef configured' };
  }
  const token = await resolveSecretRef(ref);
  if (token) return { label, ok: true, detail: `resolves (${ref})` };
  return { label, ok: false, detail: `does not resolve to a working credential (${ref}) - check for a revoked/uninstalled GitHub App installation, an unset env var, or a typo` };
}

// Core check, testable without any real network access. Returns a plain
// result object rather than exiting - only the CLI wrapper below does
// that, matching processRequest/buildFullReport/pruneAllSpokes's existing
// testable-core/thin-CLI-shell split.
//
// `octokit` here checks the HUB's own token (GLOBAL_GITHUB_TOKEN) directly -
// that's the whole point of checkGlobalGithubToken. `octokitFactory(token)`
// is used per-spoke instead, resolving each spoke's OWN tenant credential
// (decision #1) rather than reusing the hub's token for every spoke's
// checks - falls back to `octokit` itself when octokitFactory isn't
// supplied, so existing single-tenant callers/tests keep working unchanged.
export async function runDoctor(octokit, { fetchImpl = fetch, env = process.env, octokitFactory, spokesOverride, tenantsOverride } = {}) {
  const checks = [];
  checks.push(await checkGlobalGithubToken(octokit, env.GLOBAL_GITHUB_TOKEN));
  checks.push(await checkAiKey(fetchImpl, env.AI_BASE_URL, env.AI_API_KEY));

  const spokes = spokesOverride || loadSpokesRegistry();
  const tenants = tenantsOverride || loadTenantsRegistry();

  for (const tenant of tenants) {
    if (tenant && tenant.status && tenant.status !== 'active') continue;
    checks.push(await checkTenantCredentialResolves(tenant));
  }

  // Read-only diagnostic tool, not request-serving credential resolution -
  // best-effort-with-some-token is the right behavior here (matches
  // health-report.js/prune-logs.js/collect-issue-feedback.js's identical,
  // deliberate fallback), unlike the hard-skip rule in
  // api/autonomous_agent.js/api/recursive_learning.js.
  const resolveOctokitForSpoke = async (spoke) => {
    if (!octokitFactory) return octokit;
    const tenantId = resolveTenantIdForSpoke(spoke.owner, spoke.repo, spokes);
    const tenant = findTenant(tenantId, tenants);
    const resolved = tenant ? await resolveSecretRef(tenant.githubCredentialRef) : null;
    const token = resolved || env.GLOBAL_GITHUB_TOKEN;
    return octokitFactory(token);
  };

  for (const spoke of spokes) {
    const spokeOctokit = await resolveOctokitForSpoke(spoke);
    checks.push(await checkSpokeRepoReachable(spokeOctokit, spoke));
    checks.push(await checkSpokeHasCallHubWorkflow(spokeOctokit, spoke));
    checks.push(await checkSpokeHasHubUrlSecret(spokeOctokit, spoke));
  }

  return { checks, allOk: checks.every((c) => c.ok) };
}

export function renderReport(result) {
  const lines = ['Mothership pre-flight doctor check', ''];
  for (const c of result.checks) {
    lines.push(`${c.ok ? '✓' : '✗'} ${c.label}: ${c.detail}`);
  }
  lines.push('');
  lines.push(result.allOk ? 'All checks passed.' : 'One or more checks failed - see above.');
  return lines.join('\\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
  const octokitFactory = (token) => new Octokit({ auth: token });

  runDoctor(octokit, { fetchImpl: fetch, octokitFactory })
    .then((result) => {
      console.log(renderReport(result));
      if (!result.allOk) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}"""
        },

        # Operator-driven manual tenant provisioning - the escape hatch for
        # everything self-service onboarding can't cover.
        {
            "path": "scripts/provision-tenant.js",
            "content": """// Operator-driven manual tenant provisioning - the escape hatch for
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
//   node scripts/provision-tenant.js \\
//     --tenant-id acme --name "Acme Corp" --plan pro \\
//     --credential-ref ghapp:12345678 \\
//     [--quota 100] [--caller-key-ref env:ACME_CALLER_KEY] \\
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
import { loadTenantsRegistry, loadSpokesRegistry, loadPlansRegistry, findPlan } from '../lib/secrets.js';

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
const SPOKE_PATTERN = /^([A-Za-z0-9._-]+)\\/([A-Za-z0-9._-]+)$/;

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
export function validateTenantInput(input, { existingTenants = [], existingSpokes = [], plans = [] } = {}) {
  const errors = [];

  if (!input.tenantId || !TENANT_ID_PATTERN.test(input.tenantId)) {
    errors.push(`tenant-id must match ${TENANT_ID_PATTERN} (got '${input.tenantId}')`);
  } else if (existingTenants.some((t) => t && typeof t.tenantId === 'string' && t.tenantId.toLowerCase() === input.tenantId.toLowerCase())) {
    errors.push(`tenant-id '${input.tenantId}' already exists (case-insensitive match)`);
  }

  if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
    errors.push('name is required');
  } else if (/[\\n\\r`]/.test(input.name)) {
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

  // plan is validated against plans.json when it matches a known planId -
  // its reviewsPerMonth auto-fills --quota unless explicitly overridden.
  // An unrecognized plan name still isn't rejected outright - this CLI's
  // whole design is "the operator is the trusted human," and a genuine
  // custom/one-off deal is a real, supported use case - but with no known
  // plan to inherit a quota from, --quota becomes required, so a typo'd
  // plan name can't silently produce an unlimited-quota tenant nobody
  // intended.
  const planName = typeof input.plan === 'string' ? input.plan.trim() : '';
  const matchedPlan = planName ? findPlan(planName, plans) : null;

  const quotaExplicitlyProvided = input.quota !== undefined && input.quota !== null && input.quota !== '';
  let reviewsPerMonth = null;
  if (quotaExplicitlyProvided) {
    const n = Number(input.quota);
    if (!Number.isInteger(n) || n < 1) {
      errors.push(`quota must be a positive integer or omitted for unlimited (got '${input.quota}')`);
    } else {
      reviewsPerMonth = n;
    }
  } else if (matchedPlan) {
    reviewsPerMonth = matchedPlan.reviewsPerMonth ?? null;
  } else if (planName) {
    errors.push(`plan '${planName}' is not a known plan in plans.json - pass --quota explicitly for a custom/one-off plan`);
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
      plan: planName,
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
export function provisionTenant(input, { existingTenants = [], existingSpokes = [], plans = [] } = {}) {
  const validation = validateTenantInput(input, { existingTenants, existingSpokes, plans });
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
    const plans = loadPlansRegistry();
    const result = provisionTenant(input, { existingTenants, existingSpokes, plans });

    if (result.status === 'Invalid') {
      console.error('Validation failed:');
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exitCode = 1;
    } else if (result.status === 'DryRun') {
      console.log('Dry run - nothing written. Would create:');
      console.log(JSON.stringify(result.tenant, null, 2));
      if (result.spokesToAdd.length) console.log('And register spokes:', JSON.stringify(result.spokesToAdd, null, 2));
    } else {
      writeFileSync('tenants.json', JSON.stringify(result.tenantsJson, null, 2) + '\\n');
      writeFileSync('spokes.json', JSON.stringify(result.spokesJson, null, 2) + '\\n');
      console.log(`Provisioned tenant '${result.tenant.tenantId}'${result.spokesToAdd.length ? ` with ${result.spokesToAdd.length} spoke(s)` : ''}.`);
      console.log('tenants.json/spokes.json updated on disk - review and commit:');
      console.log('  git add tenants.json spokes.json');
      console.log(`  git commit -m "chore: provision tenant ${result.tenant.tenantId}"`);
      console.log('  git push');
    }
  }
}"""
        },

        # 4. AUTOMATION (GitHub Actions workflows - self-reflect, maintenance,
        # health reporting, recursive learning). Without these, api/*.js and
        # scripts/*.js above are never actually invoked on any schedule - a
        # freshly-scaffolded hub would otherwise deploy successfully to Vercel
        # and sit there completely inert.
        {
            "path": ".github/workflows/self-reflect.yml",
            "content": """name: Hub Self-Reflection
on:
  schedule:
    - cron: '0 0 * * 0'  # Weekly at midnight UTC
  workflow_dispatch:

jobs:
  self-check:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Hub for self-analysis
        env:
          # Note: GLOBAL_GITHUB_TOKEN is not needed here - the hub authenticates
          # to GitHub server-side using its own Vercel env var, not anything
          # the caller sends. Only HUB_VERCEL_URL is actually required.
          HUB_VERCEL_URL: ${{ secrets.HUB_VERCEL_URL }}
          # The hub's deployment currently sits behind Vercel Deployment
          # Protection - without this header every call gets a 403 before it
          # ever reaches the handler. Get a "Protection Bypass for
          # Automation" secret from the Vercel dashboard (Settings ->
          # Deployment Protection) and store it as VERCEL_BYPASS_TOKEN.
          VERCEL_BYPASS_TOKEN: ${{ secrets.VERCEL_BYPASS_TOKEN }}
        run: |
          curl -X POST "${HUB_VERCEL_URL}/api/autonomous_agent" \\
            -H "Content-Type: application/json" \\
            -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_TOKEN}" \\
            -d '{
              "owner": "${{ github.repository_owner }}",
              "repo": "${{ github.event.repository.name }}",
              "mode": "refactor"
            }'"""
        },
        {
            "path": ".github/workflows/prune-logs.yml",
            "content": """name: Prune Decision Logs

on:
  schedule:
    - cron: '0 0 * * 0'  # Weekly, Sunday at midnight UTC
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Report what would move without writing anything'
        type: boolean
        default: false

jobs:
  prune:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Prune old decision-log entries across all registered spokes
        env:
          # Mirrors the Vercel env var of the same name - an Actions runner
          # can't read Vercel's env, so this needs its own copy of the token
          # as a repo secret, with cross-repo write access to every spoke.
          GLOBAL_GITHUB_TOKEN: ${{ secrets.GLOBAL_GITHUB_TOKEN }}
          DRY_RUN: ${{ inputs.dry_run }}
        run: node scripts/prune-logs.js"""
        },
        {
            "path": ".github/workflows/health-report.yml",
            "content": """name: Health Report

on:
  schedule:
    - cron: '0 6 * * 1'  # Weekly, Monday at 6 AM UTC
  workflow_dispatch:

jobs:
  report:
    runs-on: ubuntu-latest
    # Only governs the auto-generated GITHUB_TOKEN (used below by checkout) -
    # the script's actual GitHub calls authenticate with the GLOBAL_GITHUB_TOKEN
    # secret instead, so this block doesn't grant those anything. Listed
    # explicitly (rather than left off) so a future repo-visibility change
    # doesn't silently drop checkout's read access - declaring any permissions
    # here sets every unlisted scope to 'none'.
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4

      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Build and publish the Mothership health report
        env:
          # Mirrors the Vercel env var of the same name - an Actions runner
          # can't read Vercel's env, so this needs its own copy as a repo
          # secret, with read access to every registered spoke plus write
          # access to this repo (to update the pinned report issue).
          GLOBAL_GITHUB_TOKEN: ${{ secrets.GLOBAL_GITHUB_TOKEN }}
        run: node scripts/health-report.js"""
        },
        {
            "path": ".github/workflows/collect-issue-feedback.yml",
            "content": """name: Collect Issue Feedback

on:
  schedule:
    - cron: '0 6 * * 6'  # Weekly, Saturday at 06:00 UTC - offset from prune-logs.yml/health-report.yml's Sunday/Monday cadence
  workflow_dispatch:

jobs:
  collect-feedback:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Record maintainer feedback (issue reactions) across all registered spokes
        env:
          # Mirrors the Vercel env var of the same name - an Actions runner
          # can't read Vercel's env, so this needs its own copy of the token
          # as a repo secret, with cross-repo write access to every spoke.
          GLOBAL_GITHUB_TOKEN: ${{ secrets.GLOBAL_GITHUB_TOKEN }}
        run: node scripts/collect-issue-feedback.js"""
        },

        {
            "path": ".github/workflows/doctor.yml",
            "content": """name: Doctor

# Deliberately workflow_dispatch-only, no schedule. This session's whole
# investigation into the hub's health started because scheduled workflows
# were failing silently with nobody watching - adding another scheduled job
# here would risk the exact same failure mode this tool exists to catch.
# Run this manually when setting up a new spoke, rotating a credential, or
# troubleshooting - not on a clock.
on:
  workflow_dispatch:

jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run pre-flight checks against the hub and every registered spoke
        env:
          # GLOBAL_GITHUB_TOKEN also needs read access to each spoke's
          # Actions secrets metadata (names only, never values) to check
          # VERCEL_URL/APPS_SCRIPT_URL is set - the same classic PAT with
          # full repo scope already documented in README already covers this.
          GLOBAL_GITHUB_TOKEN: ${{ secrets.GLOBAL_GITHUB_TOKEN }}
          # AI_API_KEY/AI_BASE_URL normally live only as Vercel env vars, not
          # Actions secrets (an Actions runner can't read Vercel's env either
          # way) - the AI_API_KEY check below reports "not configured" and
          # is skipped gracefully unless you also mirror these two as Actions
          # secrets on this repo, the same way GLOBAL_GITHUB_TOKEN already
          # has to be mirrored to reach an Actions runner at all.
          AI_API_KEY: ${{ secrets.AI_API_KEY }}
          AI_BASE_URL: ${{ secrets.AI_BASE_URL }}
        run: node scripts/doctor.js"""
        },

        {
            "path": ".github/workflows/recursive-learning.yml",
            "content": """name: Recursive Learning

on:
  schedule:
    - cron: '0 0 1 * *'  # Monthly, 1st of the month at midnight UTC
  workflow_dispatch:

jobs:
  aggregate:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Hub for cross-spoke aggregation
        env:
          HUB_VERCEL_URL: ${{ secrets.HUB_VERCEL_URL }}
          # See self-reflect.yml - required while the deployment has Vercel
          # Deployment Protection enabled.
          VERCEL_BYPASS_TOKEN: ${{ secrets.VERCEL_BYPASS_TOKEN }}
        run: |
          curl -X POST "${HUB_VERCEL_URL}/api/recursive_learning" \\
            -H "Content-Type: application/json" \\
            -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_TOKEN}" \\
            -d '{}'"""
        },

        # Operator-driven, workflow_dispatch-only tenant provisioning.
        {
            "path": ".github/workflows/provision-tenant.yml",
            "content": """name: Provision Tenant

# Deliberately workflow_dispatch-only, no schedule - same trust/exposure
# model as doctor.yml: an operator triggers this by hand when actually
# provisioning someone, never on a clock. Unlike doctor.js/prune-logs.js's
# workflows (which write via the GitHub Contents API directly),
# scripts/provision-tenant.js writes to the local checkout on disk - this
# job commits and pushes that change itself, since nothing else will.
on:
  workflow_dispatch:
    inputs:
      tenant_id:
        description: 'Tenant id (lowercase, alphanumeric + hyphens)'
        required: true
      name:
        description: 'Human-readable tenant name'
        required: true
      plan:
        description: 'Plan name (free-form - e.g. pro, enterprise)'
        required: true
      credential_ref:
        description: 'GitHub credential ref (env:VAR_NAME or ghapp:<installation_id>)'
        required: true
      quota:
        description: 'Reviews per month (blank = unlimited)'
        required: false
      status:
        description: 'Tenant status'
        required: false
        default: 'active'
        type: choice
        options:
          - active
          - suspended
      spokes:
        description: 'Space-separated owner/repo entries to register as this tenant''s initial spokes (optional)'
        required: false
      dry_run:
        description: 'Dry run - validate and print, write nothing'
        required: false
        type: boolean
        default: false

jobs:
  provision-tenant:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Provision tenant
        run: |
          ARGS=(--tenant-id "${{ inputs.tenant_id }}" --name "${{ inputs.name }}" --plan "${{ inputs.plan }}" --credential-ref "${{ inputs.credential_ref }}")
          if [ -n "${{ inputs.quota }}" ]; then ARGS+=(--quota "${{ inputs.quota }}"); fi
          if [ -n "${{ inputs.status }}" ]; then ARGS+=(--status "${{ inputs.status }}"); fi
          for spoke in ${{ inputs.spokes }}; do ARGS+=(--spoke "$spoke"); done
          if [ "${{ inputs.dry_run }}" = "true" ]; then ARGS+=(--dry-run); fi
          node scripts/provision-tenant.js "${ARGS[@]}"

      - name: Commit and push (skipped on dry run)
        if: inputs.dry_run != 'true'
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          if git diff --quiet -- tenants.json spokes.json; then
            echo "No changes to commit."
            exit 0
          fi
          git add tenants.json spokes.json
          git commit -m "chore: provision tenant ${{ inputs.tenant_id }} (operator-driven, via Actions)"
          git push"""
        },

        # 5. INFRASTRUCTURE
        {
            "path": "package.json",
            "content": "{\n  \"name\": \"ai-cto-hub\",\n  \"version\": \"1.0.0\",\n  \"type\": \"module\",\n  \"scripts\": {\n    \"test\": \"for f in scripts/dev-test-*.mjs; do node \\\"$f\\\" || exit 1; done\"\n  },\n  \"dependencies\": {\n    \"@octokit/auth-app\": \"^6.1.4\",\n    \"@octokit/rest\": \"^19.0.0\",\n    \"resend\": \"^4.8.0\",\n    \"stripe\": \"^17.7.0\"\n  }\n}",
        },
        {
            "path": ".gitignore",
            "content": "node_modules/\n.env\n.vercel\n__pycache__/\n*.pyc\n# clasp's own config - contains a scriptId tied to one person's Google\n# account, generated by `clasp create`/`clasp clone`. gas/.clasp.json.example\n# is the checked-in template; the real file is per-deployment, not shared code.\n.clasp.json\n.clasprc.json"
        }
    ]

    for f in hub_files:
        os.makedirs(os.path.dirname(f["path"]), exist_ok=True) if os.path.dirname(f["path"]) else None
        with open(f["path"], "w") as file:
            file.write(f["content"])
        print(f"Created: {f['path']}")

    print("\nInstalling Hub dependencies...")
    # No shell=True here: combined with a list, it runs the list's first
    # item as the shell command and every item after it as arguments to the
    # *shell* invocation itself, not to that command - so ["npm", "install"]
    # silently ran bare `npm` (no subcommand) and never installed anything.
    # A plain list without shell=True execs npm directly with both args.
    install = subprocess.run(["npm", "install"])
    if install.returncode != 0:
        print("Warning: 'npm install' failed - install dependencies manually before deploying.")

    print("\n" + "="*50)
    print("MOTHERSHIP INITIALIZED")
    print("="*50)
    print("1. Deploy this folder to Vercel.")
    print("2. Set your Environment Variables in Vercel:")
    print("   - AI_API_KEY, AI_MODEL, AI_BASE_URL")
    print("   - GLOBAL_GITHUB_TOKEN (Personal Access Token with Repo access)")
    print("   - DRY_RUN_MODE (optional, defaults to true - set to \"false\" only")
    print("     after watching dry-run output for a while; see README)")
    print("   - RATE_CAP_PER_REPO_PER_DAY (optional, defaults to 3)")
    print("3. You are now ready to onboard 'Spoke' projects.")
    print("="*50)

if __name__ == "__main__":
    setup_hub()