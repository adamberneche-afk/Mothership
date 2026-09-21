// Pre-flight health check for the hub + every registered spoke - checks
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
    if (hasOne) return { label, ok: true, detail: 'present (name only - value can\'t be verified)' };
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
  return lines.join('\n');
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
}
