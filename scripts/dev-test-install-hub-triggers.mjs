// Local verification harness for the deploy-time trigger install: the hub
// side (installHubTriggers() in gas/settings.js, routed by doPost) and the
// caller (scripts/install-hub-triggers.mjs).
//
// Usage: node scripts/dev-test-install-hub-triggers.mjs

import { loadGasGlobals } from './gas-test-harness.mjs';
import { makeFakeLogger } from './gas-sheet-fakes.mjs';
import { installHubTriggers as callHub } from './install-hub-triggers.mjs';

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

function fakeScriptApp(existing = []) {
  const handlers = existing.slice();
  const builder = (fn) => {
    const b = {
      timeBased: () => b, everyMinutes: () => b, everyHours: () => b, everyDays: () => b,
      onWeekDay: () => b, atHour: () => b,
      create: () => { handlers.push(fn); return {}; }
    };
    return b;
  };
  return {
    _handlers: handlers,
    WeekDay: { WEDNESDAY: 'WED', SUNDAY: 'SUN' },
    newTrigger: builder,
    getProjectTriggers: () => handlers.map((fn) => ({ getHandlerFunction: () => fn }))
  };
}

function hubContext({ adminToken = 'tok-1', existing = [] } = {}) {
  const props = adminToken ? { ADMIN_SETTINGS_TOKEN: adminToken } : {};
  const ScriptApp = fakeScriptApp(existing);
  const ctx = loadGasGlobals('constants.js', 'github.js', 'review_queue.js', 'autonomous_agent.js',
    'deploy_version_report.js', 'spoke_poller.js', 'settings.js', {
      ScriptApp,
      Logger: makeFakeLogger(),
      PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props[k] !== undefined ? props[k] : null) }) }
    });
  return { ctx, ScriptApp };
}

const ALL_HANDLERS = ['runHarvestReviewResults', 'runHarvestLearningResults', 'runReportDeployVersionNow',
  'pollSpokesDebug', 'pollSpokesHunt', 'pollSpokesRefactor'];

function testInstallsEveryHubTriggerOnce() {
  console.log('installHubTriggers installs all six hub triggers, then nothing on a second call');
  const { ctx, ScriptApp } = hubContext();
  const first = ctx.installHubTriggers('tok-1');
  check('six installed', first.installed.length === 6);
  check('every expected handler present', ALL_HANDLERS.every((h) => first.present.includes(h)));
  const second = ctx.installHubTriggers('tok-1');
  check('second call installs none', second.installed.length === 0);
  check('no duplicates', ScriptApp._handlers.length === 6);
}

function testReportsOnlyWhatItAdded() {
  console.log('a hub that already has some triggers reports only the new ones');
  const { ctx } = hubContext({ existing: ['runHarvestReviewResults', 'runHarvestLearningResults'] });
  const r = ctx.installHubTriggers('tok-1');
  check('four installed', r.installed.length === 4 && !r.installed.includes('runHarvestReviewResults'));
}

function testRejectsWrongOrMissingToken() {
  console.log('a wrong token, or no ADMIN_SETTINGS_TOKEN set at all, installs nothing');
  const { ctx, ScriptApp } = hubContext();
  let threw = false;
  try { ctx.installHubTriggers('wrong'); } catch (e) { threw = e.message === 'Unauthorized'; }
  check('wrong token throws Unauthorized', threw);
  check('nothing installed', ScriptApp._handlers.length === 0);
  const unset = hubContext({ adminToken: null });
  let threw2 = false;
  try { unset.ctx.installHubTriggers(undefined); } catch (e) { threw2 = e.message === 'Unauthorized'; }
  check('unset token rejects even an undefined token', threw2);
}

// doPost routing: Code.js must answer 200 with the result for the right
// token and 401 for a wrong one.
function testDoPostRoutesAndMapsUnauthorized() {
  console.log('doPost(?endpoint=install-triggers) answers 200 with the result, or 401 for a wrong token');
  const props = { ADMIN_SETTINGS_TOKEN: 'tok-1' };
  const ScriptApp = fakeScriptApp();
  const ctx = loadGasGlobals('constants.js', 'github.js', 'review_queue.js', 'autonomous_agent.js', 'recursive_learning.js',
    'deploy_version_marker.js', 'deploy_version_report.js', 'spoke_poller.js', 'settings.js', 'Code.js', {
      ScriptApp,
      Logger: makeFakeLogger(),
      UrlFetchApp: { fetch: () => ({ getResponseCode: () => 404, getContentText: () => '{}' }) },
      PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props[k] !== undefined ? props[k] : null) }) },
      ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ _text: t, setMimeType() { return this; } }) },
      Utilities: { base64Encode: (s) => Buffer.from(s).toString('base64'), base64Decode: (s) => [...Buffer.from(s, 'base64')], Charset: { UTF_8: 'UTF-8' }, newBlob: (b) => ({ getDataAsString: () => Buffer.from(b).toString('utf8') }) }
    });
  const ok = JSON.parse(ctx.doPost({ parameter: { endpoint: 'install-triggers' }, postData: { contents: JSON.stringify({ adminToken: 'tok-1' }) } })._text);
  check('_httpStatus 200', ok._httpStatus === 200);
  check('reports six installed', ok.installed.length === 6);
  const bad = JSON.parse(ctx.doPost({ parameter: { endpoint: 'install-triggers' }, postData: { contents: JSON.stringify({ adminToken: 'nope' }) } })._text);
  check('_httpStatus 401', bad._httpStatus === 401 && bad.error === 'Unauthorized');
  check('the 401 lists no triggers', bad.installed === undefined);
}

// The caller script, against fake hub answers.
function fakeFetch(answer, seen) {
  return async (url, opts) => {
    seen.push({ url, opts });
    return { status: 200, text: async () => (typeof answer === 'string' ? answer : JSON.stringify(answer)) };
  };
}

async function testCallerSuccess() {
  console.log('the caller POSTs the token in the body, never the URL, and returns what the hub reports');
  const seen = [];
  const r = await callHub('https://script.google.com/macros/s/X/exec?endpoint=health', 'tok-1',
    { fetchImpl: fakeFetch({ _httpStatus: 200, installed: ['pollSpokesDebug'], present: ['pollSpokesDebug'] }, seen) });
  check('targets the install endpoint on the bare /exec URL', seen[0].url === 'https://script.google.com/macros/s/X/exec?endpoint=install-triggers');
  check('POST', seen[0].opts.method === 'POST');
  check('token in the body', JSON.parse(seen[0].opts.body).adminToken === 'tok-1');
  check('token not in the URL', !seen[0].url.includes('tok-1'));
  check('returns installed', r.installed[0] === 'pollSpokesDebug');
}

async function testCallerFailures() {
  console.log('the caller fails loudly on a refusal, a non-JSON answer, or a missing token');
  const refuse = await callHub('https://h/exec', 'bad', { fetchImpl: fakeFetch({ _httpStatus: 401, error: 'Unauthorized' }, []) }).catch((e) => e.message);
  check('401 becomes an error naming it', /refused: 401 Unauthorized/.test(refuse));
  const html = await callHub('https://h/exec', 'tok', { fetchImpl: fakeFetch('<html>sign in</html>', []) }).catch((e) => e.message);
  check('an HTML page (an old deployment, or a sign-in wall) is an error', /did not answer with JSON/.test(html));
  const noTok = await callHub('https://h/exec', '', { fetchImpl: fakeFetch({}, []) }).catch((e) => e.message);
  check('a missing token stops before any request', /ADMIN_SETTINGS_TOKEN is not set/.test(noTok));
}

testInstallsEveryHubTriggerOnce();
testReportsOnlyWhatItAdded();
testRejectsWrongOrMissingToken();
testDoPostRoutesAndMapsUnauthorized();
await testCallerSuccess();
await testCallerFailures();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
