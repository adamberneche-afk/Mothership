// Self-reports gas/'s live deployed version to this hub repo, so drift
// between "what git expects" and "what's actually live" gets caught
// without a human remembering to check by hand. Ported from the exact
// pattern already proven in this account's KOS repo
// (tools/deploy-drift/README.md - Phase 3 of that repo's own
// process-hardening sprint), applied here to Mothership's own single GAS
// project.
//
// WHY THIS PUSHES INSTEAD OF BEING POLLED: even though this project
// deploys webapp.access: ANYONE (appsscript.json) - unlike most of KOS's
// nine-project fleet, an anonymous request DOES reach doGet()/doPost()
// here - pushing is still the better fit: it needs no new
// anonymous-reachable surface on the web app at all (no "what version are
// you" endpoint to defend), and it reuses the exact trigger-installer
// convention review_queue.js's harvest triggers already established in
// this file set. This project already runs as a fully trusted context for
// itself, so it can call OUT with the GLOBAL_GITHUB_TOKEN it already
// holds in Script Properties - no separate, narrowly-scoped token needed
// the way KOS's design calls for: that token already has full write
// access to this hub repo (issues, PRs, decision logs), so letting it
// also fire a repository_dispatch event doesn't expand what a leak of it
// could do at all.
//
// Installed on its own low-frequency trigger
// (installDeployVersionReportTrigger()) - independent of the review-queue
// harvest triggers' cadence or error handling, since a bug here should
// never affect anything else this project does.
//
// deps: { githubFactory, config } - same DI shape as review_queue.js's
// runHarvestReviewResults() etc, so this is testable the same way (a
// fake githubFactory, no real UrlFetchApp/PropertiesService needed).
function reportDeployVersion(deps) {
  const { githubFactory, config = {} } = deps;
  const hubOwner = config.hubOwner || DEFAULT_HUB_OWNER;
  const hubRepo = config.hubRepo || DEFAULT_HUB_REPO;
  const token = config.globalGithubToken;

  if (!token) {
    Logger.log('[DeployVersionReport] No GLOBAL_GITHUB_TOKEN configured - skipping (not an error; nothing to report with yet).');
    return { ok: false, reason: 'No GLOBAL_GITHUB_TOKEN configured' };
  }

  const github = githubFactory(token);
  try {
    github.repos.createDispatchEvent({
      owner: hubOwner,
      repo: hubRepo,
      event_type: 'gas-version-report',
      client_payload: { sha: DEPLOY_VERSION_SHA, reportedAt: new Date().toISOString() }
    });
    Logger.log('[DeployVersionReport] Reported ' + DEPLOY_VERSION_SHA + ' successfully.');
    return { ok: true, sha: DEPLOY_VERSION_SHA };
  } catch (err) {
    Logger.log('[DeployVersionReport] Failed to report: ' + err.message);
    return { ok: false, reason: err.message };
  }
}

// Real (zero-argument) entry point - same convention as review_queue.js's
// runHarvestReviewResults()/runReviewQueueCanaryNow() etc: builds real
// deps from loadConfig()/PropertiesService and delegates to the
// DI-testable core above. Installed by installDeployVersionReportTrigger()
// below, by handler name, not the DI-taking function itself. Also
// runnable directly from the Apps Script IDE's function picker (or
// `clasp run runReportDeployVersionNow`) to confirm it works without
// waiting for the trigger.
function runReportDeployVersionNow() {
  const config = loadConfig();
  config.scriptProperties = PropertiesService.getScriptProperties();
  const githubFactory = (token) => makeGithubClient(UrlFetchApp.fetch, token);
  const result = reportDeployVersion({ githubFactory, config });
  Logger.log('[DeployVersionReport] Result: ' + JSON.stringify(result));
  return result;
}

// One-time admin action - run once from the Apps Script IDE's function
// picker (select installDeployVersionReportTrigger, click Run), or via
// `clasp run installDeployVersionReportTrigger`. Same
// idempotent-by-handler-name convention as review_queue.js's
// installReviewQueueTriggers(): safe to re-run, never installs a
// duplicate. Once a day is plenty - this only needs to catch "the live
// deployment silently fell behind git," not report in near-real-time.
function installDeployVersionReportTrigger() {
  const existing = ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
  if (existing.indexOf('runReportDeployVersionNow') === -1) {
    ScriptApp.newTrigger('runReportDeployVersionNow').timeBased().everyDays(1).create();
    Logger.log('[DeployVersionReport] Installed runReportDeployVersionNow - once a day.');
  }
}
