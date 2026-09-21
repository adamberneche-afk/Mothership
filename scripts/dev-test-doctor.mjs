// Local verification harness for scripts/doctor.js.
//
// Same rationale as the other dev-test-*.mjs harnesses: no live GitHub or
// AI calls here, everything runs against hand-rolled fakes.
//
// Usage: node scripts/dev-test-doctor.mjs

import { runDoctor } from './doctor.js';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

// --- Fakes -------------------------------------------------------------------

// `rateLimitStatus`: 200 (valid token) or 401 (invalid/expired) - the exact
// class of failure this session's own GLOBAL_GITHUB_TOKEN incident was.
// `repos`: { "owner/repo": { reachable, hasCallHubWorkflow, secretNames } } -
// per-spoke fixtures; a repo not listed defaults to fully healthy.
function makeFakeOctokit({ rateLimitStatus = 200, repos = {} } = {}) {
  const calls = { request: [], reposGet: [], getContent: [] };
  function repoFixture(owner, repo) {
    return repos[`${owner}/${repo}`] || { reachable: true, hasCallHubWorkflow: true, secretNames: ['VERCEL_URL'] };
  }
  return {
    calls,
    request: async (route, params) => {
      calls.request.push({ route, params });
      if (route === 'GET /rate_limit') {
        if (rateLimitStatus === 200) return { data: {} };
        const err = new Error(`${rateLimitStatus} Bad credentials`);
        err.status = rateLimitStatus;
        throw err;
      }
      if (route === 'GET /repos/{owner}/{repo}/actions/secrets') {
        const fixture = repoFixture(params.owner, params.repo);
        return { data: { secrets: fixture.secretNames.map((name) => ({ name })) } };
      }
      throw new Error(`unexpected route in fake: ${route}`);
    },
    repos: {
      get: async ({ owner, repo }) => {
        calls.reposGet.push({ owner, repo });
        const fixture = repoFixture(owner, repo);
        if (!fixture.reachable) throw new Error('404 not found');
        return { data: {} };
      },
      getContent: async ({ owner, repo, path }) => {
        calls.getContent.push({ owner, repo, path });
        const fixture = repoFixture(owner, repo);
        if (!fixture.hasCallHubWorkflow) {
          const err = new Error('404 not found');
          err.status = 404;
          throw err;
        }
        return { data: {} };
      }
    }
  };
}

function makeFakeFetch(status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: status === 200, status };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// --- Tests -------------------------------------------------------------------

async function testAllHealthyPasses() {
  console.log('all-healthy: every check ok, function returns without throwing');
  const octokit = makeFakeOctokit({ rateLimitStatus: 200 });
  const fetchImpl = makeFakeFetch(200);
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, tenantsOverride: [] });
  check('allOk is true', result.allOk === true);
  check('every check reports ok', result.checks.every((c) => c.ok));
}

async function testInvalidGithubTokenFailsButOtherChecksStillRun() {
  console.log('a 401 on GLOBAL_GITHUB_TOKEN is caught with a clear detail, and other checks still run');
  const octokit = makeFakeOctokit({ rateLimitStatus: 401 });
  const fetchImpl = makeFakeFetch(200);
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, tenantsOverride: [] });
  check('allOk is false', result.allOk === false);
  const githubCheck = result.checks.find((c) => c.label === 'GLOBAL_GITHUB_TOKEN');
  check('GLOBAL_GITHUB_TOKEN check failed with a real detail', githubCheck.ok === false && /401/.test(githubCheck.detail));
  const aiCheck = result.checks.find((c) => c.label === 'AI_API_KEY');
  check('the AI_API_KEY check still ran and passed (one failure does not abort the rest)', aiCheck.ok === true);
}

async function testInvalidAiKeyFails() {
  console.log('a 401 on the AI /models check is caught with a clear detail');
  const octokit = makeFakeOctokit({ rateLimitStatus: 200 });
  const fetchImpl = makeFakeFetch(401);
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-bad', AI_BASE_URL: 'https://ai.example.com' }, tenantsOverride: [] });
  const aiCheck = result.checks.find((c) => c.label === 'AI_API_KEY');
  check('AI_API_KEY check failed with a real detail', aiCheck.ok === false && /401/.test(aiCheck.detail));
}

async function testUnsetAiKeyReportsNotConfigured() {
  console.log('an unset AI_API_KEY reports "not configured" without any fetch call');
  const octokit = makeFakeOctokit({ rateLimitStatus: 200 });
  const fetchImpl = makeFakeFetch(200);
  const result = await runDoctor(octokit, { fetchImpl, env: {}, tenantsOverride: [] });
  const aiCheck = result.checks.find((c) => c.label === 'AI_API_KEY');
  check('reports not configured', aiCheck.ok === false && aiCheck.detail === 'not configured');
  check('no fetch call was made', fetchImpl.calls.length === 0);
}

async function testUnsetGithubTokenReportsNotConfiguredWithoutAnyRequestCall() {
  console.log('an unset GLOBAL_GITHUB_TOKEN reports "not configured" without calling the API - GET /rate_limit itself returns 200 even fully unauthenticated, so this can only be caught by checking the token directly rather than trusting that response code');
  const octokit = makeFakeOctokit({ rateLimitStatus: 200 });
  const fetchImpl = makeFakeFetch(200);
  const result = await runDoctor(octokit, { fetchImpl, env: {}, tenantsOverride: [] });
  const githubCheck = result.checks.find((c) => c.label === 'GLOBAL_GITHUB_TOKEN');
  check('reports not configured', githubCheck.ok === false && githubCheck.detail === 'not configured');
  check('no GET /rate_limit request was made', !octokit.calls.request.some((c) => c.route === 'GET /rate_limit'));
}

async function testSpokeMissingCallHubWorkflowIsFlagged() {
  console.log('a spoke missing call-hub.yml is flagged');
  const octokit = makeFakeOctokit({
    repos: { 'adamberneche-afk/tso': { reachable: true, hasCallHubWorkflow: false, secretNames: ['VERCEL_URL'] } }
  });
  const fetchImpl = makeFakeFetch(200);
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, tenantsOverride: [] });
  const workflowCheck = result.checks.find((c) => c.label.includes('tso') && c.label.includes('call-hub.yml'));
  check('a call-hub.yml check exists for tso and fails', !!workflowCheck && workflowCheck.ok === false);
  check('overall allOk is false', result.allOk === false);
}

async function testCallHubWorkflowCheckDistinguishesNotFoundFromOtherErrors() {
  console.log('a non-404 error checking call-hub.yml (e.g. rate-limited) is reported distinctly, not misreported as "not wired up"');
  const octokit = makeFakeOctokit({
    repos: { 'adamberneche-afk/tso': { reachable: true, hasCallHubWorkflow: true, secretNames: ['VERCEL_URL'] } }
  });
  const originalGetContent = octokit.repos.getContent;
  octokit.repos.getContent = async (params) => {
    if (params.owner === 'adamberneche-afk' && params.repo === 'tso') {
      const err = new Error('API rate limit exceeded');
      err.status = 403;
      throw err;
    }
    return originalGetContent(params);
  };
  const fetchImpl = makeFakeFetch(200);
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, tenantsOverride: [] });
  const workflowCheck = result.checks.find((c) => c.label.includes('tso') && c.label.includes('call-hub.yml'));
  check('reports the real error, not "not wired up"', workflowCheck.ok === false && /couldn't check/.test(workflowCheck.detail) && !/not wired up/.test(workflowCheck.detail));
}

async function testSpokeMissingHubUrlSecretIsFlagged() {
  console.log('a spoke with neither VERCEL_URL nor APPS_SCRIPT_URL in its secrets is flagged');
  const octokit = makeFakeOctokit({
    repos: { 'adamberneche-afk/tso': { reachable: true, hasCallHubWorkflow: true, secretNames: [] } }
  });
  const fetchImpl = makeFakeFetch(200);
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, tenantsOverride: [] });
  const secretCheck = result.checks.find((c) => c.label.includes('tso') && c.label.includes('secret'));
  check('a secret-presence check exists for tso and fails', !!secretCheck && secretCheck.ok === false);
  check('overall allOk is false', result.allOk === false);
}

async function testSpokeWithApsScriptUrlInsteadOfVercelUrlPasses() {
  console.log('a spoke with APPS_SCRIPT_URL (instead of VERCEL_URL) still passes the secret-presence check');
  const octokit = makeFakeOctokit({
    repos: { 'adamberneche-afk/tso': { reachable: true, hasCallHubWorkflow: true, secretNames: ['APPS_SCRIPT_URL'] } }
  });
  const fetchImpl = makeFakeFetch(200);
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, tenantsOverride: [] });
  const secretCheck = result.checks.find((c) => c.label.includes('tso') && c.label.includes('secret'));
  check('the secret-presence check passes', !!secretCheck && secretCheck.ok === true);
}

async function testEachSpokeIsCheckedWithItsOwnTenantCredentialNotTheHubToken() {
  console.log("Multi-tenancy: with octokitFactory supplied, each spoke's checks use ITS tenant's own resolved credential, not the hub token");
  process.env.ACME_TEST_TOKEN = 'acme-secret-token';
  const acmeOctokit = makeFakeOctokit({ repos: { 'acme-org/acme-repo': { reachable: true, hasCallHubWorkflow: true, secretNames: ['VERCEL_URL'] } } });
  const hubOctokit = makeFakeOctokit({ rateLimitStatus: 200 });
  const tokensRequested = [];
  const octokitFactory = (token) => { tokensRequested.push(token); return token === 'acme-secret-token' ? acmeOctokit : hubOctokit; };
  const fetchImpl = makeFakeFetch(200);
  const spokesOverride = [{ tenantId: 'acme', owner: 'acme-org', repo: 'acme-repo', addedAt: '2026-08-13T00:00:00Z', status: 'active' }];
  const tenantsOverride = [{ tenantId: 'acme', name: 'Acme', status: 'active', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:ACME_TEST_TOKEN', createdAt: '2026-08-13T00:00:00Z' }];
  const result = await runDoctor(hubOctokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'hub-token', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, octokitFactory, spokesOverride, tenantsOverride });
  check("acme's own token was resolved and used, not the hub token", tokensRequested.includes('acme-secret-token'));
  check("acme's spoke checks actually ran against acme's own fake octokit", acmeOctokit.calls.reposGet.length === 1);
  check('the hub octokit was never asked to check the acme spoke directly', hubOctokit.calls.reposGet.length === 0);
  check('acme spoke checks pass (using its own healthy fixture)', result.checks.filter(c => c.label.includes('acme-org/acme-repo')).every(c => c.ok));
  delete process.env.ACME_TEST_TOKEN;
}

async function testNoOctokitFactoryFallsBackToTheSingleOctokitUnchanged() {
  console.log('Multi-tenancy: omitting octokitFactory entirely (no tenant awareness needed) behaves exactly like before - single octokit for everything');
  const octokit = makeFakeOctokit({ repos: { 'adamberneche-afk/tso': { reachable: true, hasCallHubWorkflow: true, secretNames: ['VERCEL_URL'] } } });
  const fetchImpl = makeFakeFetch(200);
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, tenantsOverride: [] });
  check('still runs and passes using the one octokit for every spoke', result.allOk === true);
}

async function testTenantCredentialLivenessCheckPassesForAResolvableCredential() {
  console.log("credential-liveness: an active tenant whose githubCredentialRef resolves gets an ok check");
  process.env.ACME_LIVENESS_TOKEN = 'acme-live-token';
  const octokit = makeFakeOctokit({});
  const fetchImpl = makeFakeFetch(200);
  const tenantsOverride = [{ tenantId: 'acme', name: 'Acme', status: 'active', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:ACME_LIVENESS_TOKEN', createdAt: '2026-08-13T00:00:00Z' }];
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, spokesOverride: [], tenantsOverride });
  const tenantCheck = result.checks.find((c) => c.label.includes("tenant 'acme'"));
  check('a credential-liveness check exists for tenant acme and passes', !!tenantCheck && tenantCheck.ok === true);
  delete process.env.ACME_LIVENESS_TOKEN;
}

async function testTenantCredentialLivenessCheckFailsForAnUnresolvableCredential() {
  console.log("credential-liveness: an active tenant whose githubCredentialRef does NOT resolve (revoked/unset/typo) is flagged, and fails the whole doctor run");
  const octokit = makeFakeOctokit({});
  const fetchImpl = makeFakeFetch(200);
  const tenantsOverride = [{ tenantId: 'broken-tenant', name: 'Broken', status: 'active', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:SOME_TOTALLY_UNSET_VAR_XYZ', createdAt: '2026-08-13T00:00:00Z' }];
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, spokesOverride: [], tenantsOverride });
  const tenantCheck = result.checks.find((c) => c.label.includes("tenant 'broken-tenant'"));
  check('the credential-liveness check exists for the broken tenant and fails', !!tenantCheck && tenantCheck.ok === false);
  check('the detail names the actual ref, not just a generic message', tenantCheck.detail.includes('env:SOME_TOTALLY_UNSET_VAR_XYZ'));
  check('overall allOk is false because of this', result.allOk === false);
}

async function testSuspendedTenantsAreSkippedNotFlagged() {
  console.log("credential-liveness: a tenant with status !== 'active' is never checked at all - a broken credential nobody expects to work right now shouldn't fail the doctor run");
  const octokit = makeFakeOctokit({});
  const fetchImpl = makeFakeFetch(200);
  const tenantsOverride = [{ tenantId: 'suspended-tenant', name: 'Suspended', status: 'suspended', plan: 'pro', quota: { reviewsPerMonth: null }, githubCredentialRef: 'env:SOME_TOTALLY_UNSET_VAR_ABC', createdAt: '2026-08-13T00:00:00Z' }];
  const result = await runDoctor(octokit, { fetchImpl, env: { GLOBAL_GITHUB_TOKEN: 'ghp_good', AI_API_KEY: 'sk-good', AI_BASE_URL: 'https://ai.example.com' }, spokesOverride: [], tenantsOverride });
  const tenantCheck = result.checks.find((c) => c.label.includes("tenant 'suspended-tenant'"));
  check('no credential-liveness check was created for a suspended tenant', !tenantCheck);
  check('overall allOk stays true - a suspended tenant\'s broken credential is expected, not a failure', result.allOk === true);
}

async function main() {
  await testAllHealthyPasses();
  await testInvalidGithubTokenFailsButOtherChecksStillRun();
  await testInvalidAiKeyFails();
  await testUnsetAiKeyReportsNotConfigured();
  await testUnsetGithubTokenReportsNotConfiguredWithoutAnyRequestCall();
  await testSpokeMissingCallHubWorkflowIsFlagged();
  await testCallHubWorkflowCheckDistinguishesNotFoundFromOtherErrors();
  await testSpokeMissingHubUrlSecretIsFlagged();
  await testSpokeWithApsScriptUrlInsteadOfVercelUrlPasses();
  await testEachSpokeIsCheckedWithItsOwnTenantCredentialNotTheHubToken();
  await testNoOctokitFactoryFallsBackToTheSingleOctokitUnchanged();
  await testTenantCredentialLivenessCheckPassesForAResolvableCredential();
  await testTenantCredentialLivenessCheckFailsForAnUnresolvableCredential();
  await testSuspendedTenantsAreSkippedNotFlagged();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
