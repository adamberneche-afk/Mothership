// Local verification harness for gas/Code.js's doPost() - the routing and
// config-loading layer no other test covers. Since Code.js references
// Apps Script-only globals (UrlFetchApp, PropertiesService, ContentService,
// Utilities) that don't exist outside a real deployment, this seeds fakes
// for all four into the same vm sandbox the harness uses to load the real
// gas/*.js files, then drives doPost() exactly as the platform would.
//
// Usage: node scripts/dev-test-gas-code.mjs

import { loadGasGlobals } from './gas-test-harness.mjs';
import { makeFakeSpreadsheet, makeFakeSpreadsheetApp } from './gas-sheet-fakes.mjs';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}
function unb64(str) {
  return Buffer.from(str, 'base64').toString('utf8');
}

// A single fake UrlFetchApp.fetch answers both the GitHub-shaped calls
// `github.js` makes and the AI chat-completions call Code.js wires up as
// `aiFetch` - both go through the exact same primitive in real Apps
// Script, so faking them identically here is the faithful choice, not a
// shortcut.
function makeFakeUrlFetchApp({ aiJsonContent, githubResponses = {} } = {}) {
  const calls = [];
  return {
    calls,
    fetch: (url, options) => {
      calls.push({ url, options });
      if (url.includes('api.github.com')) {
        // Longest-match-wins: '/commits/abc123' must beat '/commits' when a
        // URL matches both, or the more specific mock never fires.
        const match = Object.keys(githubResponses)
          .filter((k) => url.includes(k))
          .sort((a, b) => b.length - a.length)[0];
        if (match) return githubResponses[match];
        return { getResponseCode: () => 404, getContentText: () => '{}' };
      }
      // AI call
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ choices: [{ message: { content: aiJsonContent } }] })
      };
    }
  };
}

function makeFakePropertiesService(props) {
  return {
    getScriptProperties: () => ({
      getProperty: (key) => (props[key] !== undefined ? props[key] : null)
    })
  };
}

function makeFakeContentService() {
  return {
    MimeType: { JSON: 'JSON' },
    createTextOutput(text) {
      const output = {
        _text: text,
        setMimeType(mt) {
          output._mimeType = mt;
          return output;
        }
      };
      return output;
    }
  };
}

function makeFakeUtilities() {
  return {
    Charset: { UTF_8: 'UTF-8' },
    base64Encode: (str) => b64(str),
    base64Decode: (b64str) => Buffer.from(b64str, 'base64'),
    newBlob: (bytes) => ({
      getDataAsString: () => Buffer.from(bytes).toString('utf8')
    })
  };
}

const NO_FINDING_JSON = JSON.stringify({
  has_findings: false,
  action_summary: '',
  code_patch: '',
  value_impact: { reasoning: '' }
});

function loadCodeWithFakes({ props = {}, aiJsonContent = NO_FINDING_JSON, githubResponses = {}, spreadsheetsById = {} } = {}) {
  const urlFetchApp = makeFakeUrlFetchApp({ aiJsonContent, githubResponses });
  const spreadsheetApp = makeFakeSpreadsheetApp(spreadsheetsById);
  const openByIdCalls = [];
  const trackedSpreadsheetApp = {
    ...spreadsheetApp,
    openById: (id) => { openByIdCalls.push(id); return spreadsheetApp.openById(id); }
  };
  const seed = {
    UrlFetchApp: urlFetchApp,
    PropertiesService: makeFakePropertiesService(props),
    ContentService: makeFakeContentService(),
    Utilities: makeFakeUtilities(),
    SpreadsheetApp: trackedSpreadsheetApp,
    Logger: { log: () => {} }
  };
  const context = loadGasGlobals('constants.js', 'github.js', 'review_queue.js', 'autonomous_agent.js', 'recursive_learning.js', 'Code.js', seed);
  return { context, urlFetchApp, openByIdCalls };
}

// A 404 for any GitHub content/commit lookup, and the AI returning
// "no findings" - the shortest path through processRequest that still
// exercises doPost's full routing and response-shaping.
const NOT_FOUND = { getResponseCode: () => 404, getContentText: () => '{}' };

function testDefaultsToAutonomousAgentWhenNoEndpointGiven() {
  console.log("doPost defaults to autonomous_agent when no ?endpoint= is given (matches Vercel's original default route)");
  const { context } = loadCodeWithFakes({
    props: { DRY_RUN_MODE: 'true' },
    githubResponses: { '/commits': NOT_FOUND, '/contents/': NOT_FOUND }
  });
  const e = { parameter: {}, postData: { contents: JSON.stringify({ owner: 'o', repo: 'r', mode: 'debug' }) } };
  const output = context.doPost(e);
  const body = JSON.parse(output._text);
  check('routed to autonomous_agent (a diff-shaped Skipped response, not a spokes.json one)', body.reason === 'No usable code diff found for the latest commit');
  check('mime type is set to JSON', output._mimeType === 'JSON');
}

function testExplicitEndpointRoutesToRecursiveLearning() {
  console.log('doPost routes to recursive_learning when ?endpoint=recursive_learning is given');
  const { context } = loadCodeWithFakes({
    props: { DRY_RUN_MODE: 'true' },
    githubResponses: { 'spokes.json': { getResponseCode: () => 200, getContentText: () => JSON.stringify({ content: b64('[]') }) } }
  });
  const e = { parameter: { endpoint: 'recursive_learning' }, postData: { contents: '{}' } };
  const output = context.doPost(e);
  const body = JSON.parse(output._text);
  check('routed to runRecursiveLearning (its distinct "no spokes" message)', /no spokes/i.test(body.reason || ''));
}

function testResponseBodyCarriesHttpStatusSinceApsScriptCannotSetARealOne() {
  console.log("doPost surfaces the intended httpStatus inside the JSON body, since Apps Script Web Apps can't set a real HTTP status code");
  const { context } = loadCodeWithFakes({ props: {} });
  const e = { parameter: {}, postData: { contents: JSON.stringify({}) } }; // missing owner/repo/mode -> 400
  const output = context.doPost(e);
  const body = JSON.parse(output._text);
  check('_httpStatus reflects the 400 that a real Vercel response would have set', body._httpStatus === 400);
  check('the original error message is preserved', body.error === 'owner, repo, and mode are required');
}

function testMissingPostDataDoesNotThrow() {
  console.log('doPost tolerates a request with no postData at all instead of throwing');
  const { context } = loadCodeWithFakes({ props: {} });
  const e = { parameter: {} }; // no postData
  const output = context.doPost(e);
  const body = JSON.parse(output._text);
  check('still returns a well-formed error response, not an exception', body.error === 'owner, repo, and mode are required');
}

function testConfigIsReadFromScriptPropertiesNotHardcoded() {
  console.log('QUEUE_SHEET_ID actually comes from PropertiesService, not a hardcoded default baked into Code.js - and doPost queues into it, no more inline AI call');
  const reviewQueue = makeFakeSpreadsheet();
  const { context, openByIdCalls } = loadCodeWithFakes({
    props: { DRY_RUN_MODE: 'true', QUEUE_SHEET_ID: 'my-real-sheet-id' },
    spreadsheetsById: { 'my-real-sheet-id': reviewQueue },
    githubResponses: { '/commits': { getResponseCode: () => 200, getContentText: () => JSON.stringify([{ sha: 'abc123' }]) },
                        '/commits/abc123': { getResponseCode: () => 200, getContentText: () => JSON.stringify({ files: [{ filename: 'x', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }] }) },
                        '/contents/': NOT_FOUND }
  });
  const e = { parameter: {}, postData: { contents: JSON.stringify({ owner: 'o', repo: 'r', mode: 'debug' }) } };
  const output = context.doPost(e);
  const body = JSON.parse(output._text);
  check('SpreadsheetApp.openById was called with the QUEUE_SHEET_ID read from Script Properties', openByIdCalls.includes('my-real-sheet-id'));
  check('doPost responds Queued, not an inline AI answer', body.status === 'Queued');
  check('a real row landed in the ReviewQueue tab of that spreadsheet', reviewQueue.getSheetByName('ReviewQueue')?._rows?.length === 2); // header + 1 row
}

function main() {
  testDefaultsToAutonomousAgentWhenNoEndpointGiven();
  testExplicitEndpointRoutesToRecursiveLearning();
  testResponseBodyCarriesHttpStatusSinceApsScriptCannotSetARealOne();
  testMissingPostDataDoesNotThrow();
  testConfigIsReadFromScriptPropertiesNotHardcoded();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
