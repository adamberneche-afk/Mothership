// Apps Script Web App entry point. Deploy this project ("Deploy" > "New
// deployment" > type "Web app", "Execute as: Me", "Who has access: Anyone")
// to get a stable HTTPS URL that GitHub Actions can POST to - with no
// deployment-protection wall to fight, unlike the Vercel deployment this
// replaces.
//
// Apps Script Web Apps expose exactly one URL, not one route per file the
// way Vercel's api/*.js did - callers pick an endpoint via a query
// parameter (?endpoint=autonomous_agent or ?endpoint=recursive_learning),
// appended to the deployed URL. See README.md's "Apps Script Deployment"
// section for the exact URLs each workflow should be pointed at.
//
// Real limitation worth knowing: Apps Script Web Apps always answer with
// HTTP 200 for a request the script actually handles (a script exception
// that escapes doPost is the one way to get anything else, and that's a
// Google-rendered error page, not JSON) - there's no way to set an
// arbitrary status code the way Vercel's res.status(x) could. The intended
// `httpStatus` (400 for bad input, 200 for everything else) is preserved
// inside the JSON body as `_httpStatus` instead, since nothing that calls
// this endpoint today branches on the transport-level status code anyway.
// GET requests: only ?endpoint=settings does anything real (see
// gas/settings.js) - a small, token-gated page for viewing/updating this
// deployment's config without reopening the Apps Script IDE every time.
// Anything else just says what this URL is, since there was no doGet at all
// before this - GET requests used to fall through to Apps Script's own
// default error page, which said nothing useful either.
function doGet(e) {
  const endpoint = (e && e.parameter && e.parameter.endpoint) || '';
  if (endpoint === 'settings') {
    return renderSettingsPage((e && e.parameter && e.parameter.token) || '');
  }
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><body><p>Mothership hub webhook endpoint. POST requests only.</p></body></html>'
  );
}

function doPost(e) {
  const endpoint = (e && e.parameter && e.parameter.endpoint) || 'autonomous_agent';

  let reqBody = {};
  try {
    if (e && e.postData && e.postData.contents) {
      reqBody = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    reqBody = {};
  }

  const config = loadConfig();
  // githubFactory defers client construction until processRequest/
  // runRecursiveLearning know which tenant's credential to use (decision
  // #1 in lessons.md's multi-tenancy entry) - hubGithub stays the one,
  // hub-repo-scoped client (still GLOBAL_GITHUB_TOKEN under the hood) used
  // only for this hub's own registry/usage-log reads/writes, never for a
  // tenant's spoke operations. config.scriptProperties lets
  // resolveSecretRef's env: scheme read other Script Properties by name.
  const githubFactory = (token) => makeGithubClient(UrlFetchApp.fetch, token);
  const hubGithub = makeGithubClient(UrlFetchApp.fetch, config.globalGithubToken);
  const aiFetch = (url, options) => UrlFetchApp.fetch(url, options);
  config.scriptProperties = PropertiesService.getScriptProperties();

  let result;
  try {
    if (endpoint === 'recursive_learning') {
      result = runRecursiveLearning(reqBody, { githubFactory, hubGithub, aiFetch, base64Encode, base64Decode, config });
    } else {
      result = processRequest(reqBody, { githubFactory, hubGithub, aiFetch, base64Encode, base64Decode, config });
    }
  } catch (err) {
    result = { httpStatus: 500, body: { error: err.message } };
  }

  const responseBody = Object.assign({}, result.body, { _httpStatus: result.httpStatus });
  return ContentService
    .createTextOutput(JSON.stringify(responseBody))
    .setMimeType(ContentService.MimeType.JSON);
}

// Config lives in Script Properties (Project Settings > Script Properties,
// or `clasp` / the Apps Script API) - the equivalent of Vercel's
// per-project environment variables. Same six keys, same defaults-that-
// fail-safe behavior (a missing DRY_RUN_MODE still means dry-run, handled
// inside processRequest/runRecursiveLearning exactly as before).
function loadConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    aiApiKey: props.getProperty('AI_API_KEY'),
    aiModel: props.getProperty('AI_MODEL'),
    aiBaseUrl: props.getProperty('AI_BASE_URL'),
    globalGithubToken: props.getProperty('GLOBAL_GITHUB_TOKEN'),
    dryRunMode: props.getProperty('DRY_RUN_MODE'),
    rateCapPerRepoPerDay: props.getProperty('RATE_CAP_PER_REPO_PER_DAY'),
    hubOwner: props.getProperty('HUB_GITHUB_OWNER'),
    hubRepo: props.getProperty('HUB_GITHUB_REPO')
  };
}

// Utilities.base64Encode/base64Decode wrapped to a plain (string) => string
// signature, matching what autonomous_agent.js/recursive_learning.js
// inject and call - and matching Buffer's behavior in the original Vercel
// code closely enough that porting the call sites was a rename, not a
// rewrite.
function base64Encode(str) {
  return Utilities.base64Encode(str, Utilities.Charset.UTF_8);
}

function base64Decode(b64) {
  return Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString('UTF-8');
}
