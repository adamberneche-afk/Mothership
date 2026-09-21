// Mints short-lived GitHub App installation access tokens - the backing
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
  const pem = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  const looksLikePem = /-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----/.test(pem);
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
}
