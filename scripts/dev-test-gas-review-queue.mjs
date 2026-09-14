// Local verification harness for gas/review_queue.js - the async hand-off
// layer between this Apps Script backend and a human-built Google
// Workspace Studio Flow's native inference step. Covers what
// dev-test-gas-handler.mjs/dev-test-gas-recursive-learning.mjs don't:
// ensureQueueTab_'s tab-creation behavior, harvestReviewResults'/
// harvestLearningResults' row-scanning and error-status handling, the
// liveness checks, and installReviewQueueTriggers' idempotency. Same
// vm-based harness real Apps Script uses to run these files.
//
// Usage: node scripts/dev-test-gas-review-queue.mjs

import { loadGasGlobals } from './gas-test-harness.mjs';
import { makeFakeSheet, makeFakeSpreadsheet, makeFakeSpreadsheetApp, makeFakeLogger } from './gas-sheet-fakes.mjs';

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

function b64(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function unb64(str) { return Buffer.from(str, 'base64').toString('utf8'); }
const BASE_DEPS = { base64Encode: b64, base64Decode: unb64 };

// finalizeReviewResult_/finalizeLearningResult_ need real github/decision-
// log plumbing - autonomous_agent.js and recursive_learning.js are loaded
// alongside review_queue.js so harvest can actually call them, same as a
// real deployment's one shared script scope.
function freshContext() {
  const Logger = makeFakeLogger();
  return loadGasGlobals('constants.js', 'github.js', 'review_queue.js', 'autonomous_agent.js', 'recursive_learning.js', { Logger });
}

// --- ensureQueueTab_ / openQueueSpreadsheet_ (via the harvest functions) ---

function testHarvestReturnsZeroWhenQueueSheetIdUnconfigured() {
  console.log('harvestReviewResults/harvestLearningResults: no QUEUE_SHEET_ID configured is a clean {harvested: 0}, not a crash');
  const ctx = freshContext();
  const r1 = ctx.harvestReviewResults({ ...BASE_DEPS, config: {} });
  const r2 = ctx.harvestLearningResults({ ...BASE_DEPS, config: {} });
  check('harvestReviewResults returns harvested: 0', r1.harvested === 0);
  check('harvestLearningResults returns harvested: 0', r2.harvested === 0);
}

function testHarvestCreatesTheTabOnFirstRunIfMissing() {
  console.log('harvestReviewResults creates the ReviewQueue tab (with headers) on a brand-new spreadsheet');
  const ctx = freshContext();
  const spreadsheet = makeFakeSpreadsheet();
  ctx.SpreadsheetApp = makeFakeSpreadsheetApp({ 'sheet-1': spreadsheet });
  const result = ctx.harvestReviewResults({ ...BASE_DEPS, config: { queueSheetId: 'sheet-1' } });
  check('nothing to harvest on a freshly created tab', result.harvested === 0);
  check('the ReviewQueue tab now exists', !!spreadsheet.getSheetByName('ReviewQueue'));
  check('the tab got a real header row', spreadsheet.getSheetByName('ReviewQueue')._rows[0][0] === 'Timestamp');
}

// --- harvestReviewResults: row scanning + status transitions ---------------

function testHarvestReviewSkipsRowsNotYetEvaluated() {
  console.log('harvestReviewResults only acts on EVALUATED rows, leaves READY/HARVESTED rows untouched');
  const ctx = freshContext();
  const rqSheet = makeFakeSheet([
    ['Timestamp', 'Owner', 'Repo', 'Mode', 'CommitSha', 'ReadyStatus', 'PromptText', 'GeminiFullOutput'],
    [new Date(), 'o', 'r', 'debug', 'sha1', 'READY', 'prompt', ''],
    [new Date(), 'o', 'r', 'debug', 'sha2', 'HARVESTED', 'prompt', 'old output']
  ]);
  const spreadsheet = makeFakeSpreadsheet({ ReviewQueue: rqSheet });
  ctx.SpreadsheetApp = makeFakeSpreadsheetApp({ 'sheet-1': spreadsheet });
  const github = makeFakeGithubForFinalize();
  const result = ctx.harvestReviewResults({ ...BASE_DEPS, githubFactory: () => github, hubGithub: github, config: { queueSheetId: 'sheet-1' } });
  check('nothing was harvested', result.harvested === 0);
  check('READY row untouched', rqSheet._rows[1][5] === 'READY');
  check('HARVESTED row untouched', rqSheet._rows[2][5] === 'HARVESTED');
}

function testHarvestReviewMarksEmptyOutputAsError() {
  console.log('harvestReviewResults marks an EVALUATED row with a blank GeminiFullOutput as ERROR_EMPTY_OUTPUT, not a crash');
  const ctx = freshContext();
  const rqSheet = makeFakeSheet([
    ['Timestamp', 'Owner', 'Repo', 'Mode', 'CommitSha', 'ReadyStatus', 'PromptText', 'GeminiFullOutput'],
    [new Date(), 'o', 'r', 'debug', 'sha1', 'EVALUATED', 'prompt', '   ']
  ]);
  const spreadsheet = makeFakeSpreadsheet({ ReviewQueue: rqSheet });
  ctx.SpreadsheetApp = makeFakeSpreadsheetApp({ 'sheet-1': spreadsheet });
  const result = ctx.harvestReviewResults({ ...BASE_DEPS, config: { queueSheetId: 'sheet-1' } });
  check('nothing counted as harvested', result.harvested === 0);
  check('row marked ERROR_EMPTY_OUTPUT', rqSheet._rows[1][5] === 'ERROR_EMPTY_OUTPUT');
}

function testHarvestReviewCallsFinalizeAndMarksHarvested() {
  console.log('harvestReviewResults calls finalizeReviewResult_ for a real EVALUATED row and marks it HARVESTED on success');
  const ctx = freshContext();
  const noFindingJson = JSON.stringify({ has_findings: false, action_summary: '', code_patch: '', value_impact: { reasoning: '' } });
  const rqSheet = makeFakeSheet([
    ['Timestamp', 'Owner', 'Repo', 'Mode', 'CommitSha', 'ReadyStatus', 'PromptText', 'GeminiFullOutput'],
    [new Date(), 'o', 'r', 'debug', 'sha1', 'EVALUATED', 'prompt', noFindingJson]
  ]);
  const spreadsheet = makeFakeSpreadsheet({ ReviewQueue: rqSheet });
  ctx.SpreadsheetApp = makeFakeSpreadsheetApp({ 'sheet-1': spreadsheet });
  const github = makeFakeGithubForFinalize();
  const result = ctx.harvestReviewResults({ ...BASE_DEPS, githubFactory: () => github, hubGithub: github, config: { queueSheetId: 'sheet-1', dryRunMode: 'true' } });
  check('one row harvested', result.harvested === 1);
  check('row marked HARVESTED', rqSheet._rows[1][5] === 'HARVESTED');
  // hubGithub and githubFactory both resolve to this same fake here, so
  // this also picks up finalizeReviewResult_'s usage-log write alongside
  // the decision-log one - assert the decision-log write specifically
  // happened, not a raw call count.
  check('a decision-log entry was actually written', github.calls.createOrUpdateFileContents.some((p) => p.path === 'ai_decision_log.json'));
}

function testHarvestReviewMarksThrownErrorsDistinctly() {
  console.log('harvestReviewResults marks a row ERROR_HARVEST_FAILED (not HARVESTED) if finalizeReviewResult_ throws, and keeps going');
  const ctx = freshContext();
  const rqSheet = makeFakeSheet([
    ['Timestamp', 'Owner', 'Repo', 'Mode', 'CommitSha', 'ReadyStatus', 'PromptText', 'GeminiFullOutput'],
    [new Date(), 'o', 'r', 'debug', 'sha1', 'EVALUATED', 'prompt', 'not valid json'],
  ]);
  const spreadsheet = makeFakeSpreadsheet({ ReviewQueue: rqSheet });
  ctx.SpreadsheetApp = makeFakeSpreadsheetApp({ 'sheet-1': spreadsheet });
  // A github client whose getContent always throws mid-decision-log-write
  // would be a real thrown error, but invalid JSON itself is handled
  // cleanly by finalizeReviewResult_ (returns Skipped, not a throw) - so to
  // actually exercise the ERROR_HARVEST_FAILED path, force githubFactory
  // itself to throw (a plausible real failure: a revoked credential).
  const throwingFactory = () => { throw new Error('credential revoked'); };
  const result = ctx.harvestReviewResults({ ...BASE_DEPS, githubFactory: throwingFactory, hubGithub: {}, config: { queueSheetId: 'sheet-1' } });
  check('nothing counted as harvested', result.harvested === 0);
  check('row marked ERROR_HARVEST_FAILED', rqSheet._rows[1][5] === 'ERROR_HARVEST_FAILED');
}

function makeFakeGithubForFinalize() {
  const calls = { createOrUpdateFileContents: [], issuesCreate: [], getContent: [] };
  return {
    calls,
    repos: {
      getContent: ({ path }) => { calls.getContent.push(path); throw new Error('404 not found'); },
      createOrUpdateFileContents: (p) => { calls.createOrUpdateFileContents.push(p); return { data: {} }; }
    },
    issues: {
      listForRepo: () => ({ data: [] }),
      create: (p) => { calls.issuesCreate.push(p); return { data: { html_url: 'https://github.com/fake/fake/issues/1' } }; }
    }
  };
}

// --- checkReviewQueueLiveness / checkLearningQueueLiveness ------------------

function testLivenessDistinguishesNeverAnsweredFromSlowFromAnswered() {
  console.log('checkReviewQueueLiveness distinguishes "never answered" from "slow" from "has answered before" - same backstop as cas-ccps\'s checkFlow2Liveness');
  const ctx = freshContext();

  // Case 1: rows READY, none ever answered.
  const oldTimestamp = new Date(Date.now() - 45 * 60 * 1000); // 45 min ago
  const neverAnsweredSheet = makeFakeSheet([
    ['Timestamp', 'Owner', 'Repo', 'Mode', 'CommitSha', 'ReadyStatus', 'PromptText', 'GeminiFullOutput'],
    [oldTimestamp, 'o', 'r', 'debug', 'sha1', 'READY', 'prompt', '']
  ]);
  let spreadsheet = makeFakeSpreadsheet({ ReviewQueue: neverAnsweredSheet });
  ctx.SpreadsheetApp = makeFakeSpreadsheetApp({ 'sheet-1': spreadsheet });
  let report = ctx.checkReviewQueueLiveness({ queueSheetId: 'sheet-1' });
  check('1 ready, 0 answered, everAnswered false', report.ready === 1 && report.answered === 0 && report.everAnswered === false);
  check('oldestReadyMins reflects the real age (~45 min)', report.oldestReadyMins >= 44 && report.oldestReadyMins <= 46);

  // Case 2: one row has answered before - everAnswered flips true even
  // with a separate row still waiting.
  const mixedSheet = makeFakeSheet([
    ['Timestamp', 'Owner', 'Repo', 'Mode', 'CommitSha', 'ReadyStatus', 'PromptText', 'GeminiFullOutput'],
    [new Date(), 'o', 'r', 'debug', 'sha1', 'HARVESTED', 'prompt', 'some real answer'],
    [new Date(), 'o', 'r', 'debug', 'sha2', 'READY', 'prompt', '']
  ]);
  spreadsheet = makeFakeSpreadsheet({ ReviewQueue: mixedSheet });
  ctx.SpreadsheetApp = makeFakeSpreadsheetApp({ 'sheet-2': spreadsheet });
  report = ctx.checkReviewQueueLiveness({ queueSheetId: 'sheet-2' });
  check('1 ready, 1 answered, everAnswered true', report.ready === 1 && report.answered === 1 && report.everAnswered === true);
}

function testLearningQueueLivenessSameShape() {
  console.log('checkLearningQueueLiveness reports the same three-state shape for LearningQueue rows');
  const ctx = freshContext();
  const sheet = makeFakeSheet([
    ['Timestamp', 'Kind', 'TenantId', 'ReadyStatus', 'PromptText', 'GeminiFullOutput', 'ContextJson'],
    [new Date(), 'tenant', 'acme', 'READY', 'prompt', '', '']
  ]);
  const spreadsheet = makeFakeSpreadsheet({ LearningQueue: sheet });
  ctx.SpreadsheetApp = makeFakeSpreadsheetApp({ 'sheet-1': spreadsheet });
  const report = ctx.checkLearningQueueLiveness({ queueSheetId: 'sheet-1' });
  check('1 ready, 0 answered, everAnswered false', report.ready === 1 && report.answered === 0 && report.everAnswered === false);
}

function testLivenessFailsSafeWithNoQueueSheetConfigured() {
  console.log('Both liveness checks report a clean all-zero report, not a crash, when QUEUE_SHEET_ID is unconfigured');
  const ctx = freshContext();
  const report = ctx.checkReviewQueueLiveness({});
  check('all-zero, not a throw', report.ready === 0 && report.answered === 0 && report.everAnswered === false);
}

// --- installReviewQueueTriggers: idempotent by handler name -----------------

function makeFakeScriptApp(existingHandlerNames = []) {
  const created = [];
  const triggers = existingHandlerNames.map((name) => ({ getHandlerFunction: () => name }));
  return {
    getProjectTriggers: () => triggers,
    newTrigger: (handlerName) => {
      const builder = {
        timeBased: () => builder,
        everyMinutes: (n) => {
          created.push({ handlerName, everyMinutes: n });
          return { create: () => {} };
        }
      };
      return builder;
    },
    _created: created
  };
}

function testInstallTriggersCreatesBothOnAFreshProject() {
  console.log('installReviewQueueTriggers creates both harvest triggers when neither exists yet');
  const ctx = freshContext();
  ctx.ScriptApp = makeFakeScriptApp([]);
  ctx.installReviewQueueTriggers();
  const names = ctx.ScriptApp._created.map((c) => c.handlerName);
  check('runHarvestReviewResults was installed', names.includes('runHarvestReviewResults'));
  check('runHarvestLearningResults was installed', names.includes('runHarvestLearningResults'));
  check('review trigger runs every 5 minutes', ctx.ScriptApp._created.find((c) => c.handlerName === 'runHarvestReviewResults')?.everyMinutes === 5);
  check('learning trigger runs every 30 minutes', ctx.ScriptApp._created.find((c) => c.handlerName === 'runHarvestLearningResults')?.everyMinutes === 30);
}

function testInstallTriggersIsIdempotent() {
  console.log('installReviewQueueTriggers never installs a duplicate when both already exist');
  const ctx = freshContext();
  ctx.ScriptApp = makeFakeScriptApp(['runHarvestReviewResults', 'runHarvestLearningResults']);
  ctx.installReviewQueueTriggers();
  check('nothing new was created', ctx.ScriptApp._created.length === 0);
}

function testInstallTriggersOnlyCreatesTheMissingOne() {
  console.log('installReviewQueueTriggers only creates the one that\'s actually missing, not both');
  const ctx = freshContext();
  ctx.ScriptApp = makeFakeScriptApp(['runHarvestReviewResults']);
  ctx.installReviewQueueTriggers();
  const names = ctx.ScriptApp._created.map((c) => c.handlerName);
  check('only the missing learning trigger was created', names.length === 1 && names[0] === 'runHarvestLearningResults');
}

function main() {
  testHarvestReturnsZeroWhenQueueSheetIdUnconfigured();
  testHarvestCreatesTheTabOnFirstRunIfMissing();
  testHarvestReviewSkipsRowsNotYetEvaluated();
  testHarvestReviewMarksEmptyOutputAsError();
  testHarvestReviewCallsFinalizeAndMarksHarvested();
  testHarvestReviewMarksThrownErrorsDistinctly();
  testLivenessDistinguishesNeverAnsweredFromSlowFromAnswered();
  testLearningQueueLivenessSameShape();
  testLivenessFailsSafeWithNoQueueSheetConfigured();
  testInstallTriggersCreatesBothOnAFreshProject();
  testInstallTriggersIsIdempotent();
  testInstallTriggersOnlyCreatesTheMissingOne();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
