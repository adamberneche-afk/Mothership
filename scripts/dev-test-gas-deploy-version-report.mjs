// Local verification harness for gas/deploy_version_report.js and
// gas/github.js's createDispatchEvent - the self-report half of the
// deploy-drift mechanism (see scripts/deploy-drift.js's header comment for
// the reacting half, and README.md's "Testing the pipeline" / deploy-drift
// sections). Same vm-based harness real Apps Script uses to run these
// files (gas-test-harness.mjs).
//
// Usage: node scripts/dev-test-gas-deploy-version-report.mjs

import { loadGasGlobals } from './gas-test-harness.mjs';
import { makeFakeLogger } from './gas-sheet-fakes.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

// const declarations don't leak into loadGasGlobals' returned vm context
// (confirmed empirically while building review_queue.js's own tests -
// only `function` declarations do) - so DEPLOY_VERSION_SHA/
// DEFAULT_HUB_OWNER/DEFAULT_HUB_REPO are read directly out of the real
// source files here instead, the same way dev-test-gas-review-queue.mjs
// hardcodes column indices rather than destructuring them off the context.
const __dirname = dirname(fileURLToPath(import.meta.url));
const GAS_DIR = join(__dirname, '..', 'gas');
function extractConst(file, name) {
  const src = readFileSync(join(GAS_DIR, file), 'utf8');
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*'([^']*)'`));
  if (!m) throw new Error(`could not find const ${name} in ${file}`);
  return m[1];
}
const EXPECTED_MARKER_SHA = extractConst('deploy_version_marker.js', 'DEPLOY_VERSION_SHA');
const EXPECTED_HUB_OWNER = extractConst('constants.js', 'DEFAULT_HUB_OWNER');
const EXPECTED_HUB_REPO = extractConst('constants.js', 'DEFAULT_HUB_REPO');

function freshContext(seed = {}) {
  const Logger = seed.Logger || makeFakeLogger();
  return loadGasGlobals('constants.js', 'github.js', 'deploy_version_marker.js', 'deploy_version_report.js', { Logger, ...seed });
}

// --- gas/github.js: createDispatchEvent's raw request shape -----------------

function makeFakeHttpFetch(responseCode, responseBody = '') {
  const calls = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, options });
    return {
      getResponseCode: () => responseCode,
      getContentText: () => responseBody
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function testCreateDispatchEventPostsTheRightShape() {
  console.log('makeGithubClient(...).repos.createDispatchEvent posts to /dispatches with the right event_type/payload, and a bare 204 is a normal success (not a thrown error)');
  const ctx = loadGasGlobals('github.js');
  const httpFetch = makeFakeHttpFetch(204, '');
  const github = ctx.makeGithubClient(httpFetch, 'tok');

  const result = github.repos.createDispatchEvent({
    owner: 'o', repo: 'r', event_type: 'gas-version-report', client_payload: { sha: 'abc', reportedAt: '2026-01-01T00:00:00.000Z' }
  });

  check('one HTTP call made', httpFetch.calls.length === 1);
  check('posted to the right dispatches URL', httpFetch.calls[0].url === 'https://api.github.com/repos/o/r/dispatches');
  check('used POST', httpFetch.calls[0].options.method === 'post');
  const body = JSON.parse(httpFetch.calls[0].options.payload);
  check('event_type carried through', body.event_type === 'gas-version-report');
  check('client_payload carried through', body.client_payload.sha === 'abc' && body.client_payload.reportedAt === '2026-01-01T00:00:00.000Z');
  check('a 204-with-no-body response is treated as success, not a throw', result.status === 204 && result.data === null);
}

function testCreateDispatchEventThrowsOnANon2xxResponse() {
  console.log('createDispatchEvent throws on a non-2xx response, same as every other github.js method');
  const ctx = loadGasGlobals('github.js');
  const httpFetch = makeFakeHttpFetch(404, '{"message":"Not Found"}');
  const github = ctx.makeGithubClient(httpFetch, 'tok');

  let threw = false;
  try {
    github.repos.createDispatchEvent({ owner: 'o', repo: 'r', event_type: 'x', client_payload: {} });
  } catch (e) {
    threw = true;
    check('the error carries the real status', e.status === 404);
  }
  check('threw on 404', threw);
}

// --- reportDeployVersion (the DI-testable core) ------------------------------

function makeFakeGithubForReport(shouldThrow = false) {
  const calls = { createDispatchEvent: [] };
  return {
    calls,
    repos: {
      createDispatchEvent: (params) => {
        calls.createDispatchEvent.push(params);
        if (shouldThrow) throw new Error('simulated network failure');
        return { data: null, status: 204 };
      }
    }
  };
}

function testReportDeployVersionFailsSafeWithNoTokenConfigured() {
  console.log('reportDeployVersion is a clean, explained no-op (not a crash) when GLOBAL_GITHUB_TOKEN is unconfigured');
  const ctx = freshContext();
  const result = ctx.reportDeployVersion({ githubFactory: () => { throw new Error('should never be called'); }, config: {} });
  check('reports ok: false with a reason', result.ok === false && typeof result.reason === 'string');
}

function testReportDeployVersionSendsTheMarkerShaToTheHubRepoByDefault() {
  console.log('reportDeployVersion reports DEPLOY_VERSION_SHA against the default hub owner/repo when config.hubOwner/hubRepo are unset');
  const ctx = freshContext();
  const github = makeFakeGithubForReport();
  const result = ctx.reportDeployVersion({ githubFactory: () => github, config: { globalGithubToken: 'tok' } });

  check('reports ok: true', result.ok === true);
  check('reports the marker constant, not something else', result.sha === EXPECTED_MARKER_SHA);
  check('exactly one dispatch event fired', github.calls.createDispatchEvent.length === 1);
  const sent = github.calls.createDispatchEvent[0];
  check('targets the default hub owner/repo', sent.owner === EXPECTED_HUB_OWNER && sent.repo === EXPECTED_HUB_REPO);
  check('event_type is gas-version-report', sent.event_type === 'gas-version-report');
  check('client_payload carries the marker sha', sent.client_payload.sha === EXPECTED_MARKER_SHA);
  check('client_payload carries a reportedAt timestamp', typeof sent.client_payload.reportedAt === 'string' && sent.client_payload.reportedAt.length > 0);
}

function testReportDeployVersionRespectsAConfiguredHubOwnerRepo() {
  console.log('reportDeployVersion targets config.hubOwner/hubRepo when set, not just the DEFAULT_ constants');
  const ctx = freshContext();
  const github = makeFakeGithubForReport();
  ctx.reportDeployVersion({ githubFactory: () => github, config: { globalGithubToken: 'tok', hubOwner: 'someone-else', hubRepo: 'their-fork' } });

  const sent = github.calls.createDispatchEvent[0];
  check('targets the configured owner', sent.owner === 'someone-else');
  check('targets the configured repo', sent.repo === 'their-fork');
}

function testReportDeployVersionCatchesAThrownErrorInsteadOfCrashing() {
  console.log('reportDeployVersion reports ok: false (not a thrown exception) when the GitHub call itself fails');
  const ctx = freshContext();
  const github = makeFakeGithubForReport(true);
  const result = ctx.reportDeployVersion({ githubFactory: () => github, config: { globalGithubToken: 'tok' } });
  check('reports ok: false with the real error message', result.ok === false && result.reason.includes('simulated network failure'));
}

// --- installDeployVersionReportTrigger: idempotent by handler name ----------

function makeFakeScriptApp(existingHandlerNames = []) {
  const created = [];
  const triggers = existingHandlerNames.map((name) => ({ getHandlerFunction: () => name }));
  return {
    getProjectTriggers: () => triggers,
    newTrigger: (handlerName) => {
      const builder = {
        timeBased: () => builder,
        everyDays: (n) => {
          created.push({ handlerName, everyDays: n });
          return { create: () => {} };
        }
      };
      return builder;
    },
    _created: created
  };
}

function testInstallTriggerCreatesItOnAFreshProject() {
  console.log('installDeployVersionReportTrigger installs runReportDeployVersionNow, once a day, when no trigger exists yet');
  const ctx = freshContext();
  ctx.ScriptApp = makeFakeScriptApp([]);
  ctx.installDeployVersionReportTrigger();
  check('one trigger created', ctx.ScriptApp._created.length === 1);
  check('for the right handler', ctx.ScriptApp._created[0].handlerName === 'runReportDeployVersionNow');
  check('once a day', ctx.ScriptApp._created[0].everyDays === 1);
}

function testInstallTriggerIsIdempotent() {
  console.log('installDeployVersionReportTrigger never installs a duplicate when one already exists');
  const ctx = freshContext();
  ctx.ScriptApp = makeFakeScriptApp(['runReportDeployVersionNow']);
  ctx.installDeployVersionReportTrigger();
  check('nothing new was created', ctx.ScriptApp._created.length === 0);
}

function main() {
  testCreateDispatchEventPostsTheRightShape();
  testCreateDispatchEventThrowsOnANon2xxResponse();
  testReportDeployVersionFailsSafeWithNoTokenConfigured();
  testReportDeployVersionSendsTheMarkerShaToTheHubRepoByDefault();
  testReportDeployVersionRespectsAConfiguredHubOwnerRepo();
  testReportDeployVersionCatchesAThrownErrorInsteadOfCrashing();
  testInstallTriggerCreatesItOnAFreshProject();
  testInstallTriggerIsIdempotent();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
