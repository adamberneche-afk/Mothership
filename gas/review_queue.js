// The async hand-off layer between this Apps Script backend and a
// human-built Google Workspace Studio Flow doing the actual AI inference
// via its own native "Ask Gemini" step - no AI_API_KEY, no AI_BASE_URL, no
// GCP project required. Ported from the exact pattern already proven in
// this account's KOS repo (cas-ccps's Flow 2 redesign,
// cas-ccps/scripts/37_FlowInputBuilder.js) for a Workspace org where GCP
// access is disabled at the admin level and a developer-facing Gemini API
// key can't be issued at all - the same restriction this deployment is
// built for.
//
// Why this exists instead of a direct UrlFetchApp call to an AI endpoint:
// Apps Script has no way to invoke Google Workspace's own native Gemini
// inference programmatically - that's gated behind Workspace's own UI
// products (the Docs/Sheets side panel, the Studio/Flow builder), not an
// API surface a script can call. The only way code and native inference
// can talk to each other is a shared piece of durable state a human-built
// Flow can also read and write - a Google Sheet, since that's the one data
// source every native Studio/Flow step can target directly (confirmed the
// hard way in cas-ccps: Studio's "Get sheet contents" step only accepts a
// fixed picker, never a variable, so the sheet has to be the one, stable
// spreadsheet this Script Property points at).
//
// The hand-off, one row at a time:
//   1. processRequest()/runRecursiveLearning() build a prompt exactly as
//      before (same context-gathering, same skip logic, same quota gate),
//      then enqueueReviewRow_()/enqueueLearningRow_() write one flat row
//      with ReadyStatus = "READY" instead of calling an AI endpoint
//      synchronously.
//   2. A human builds a Workspace Flow, once, in the Workspace UI (see
//      README.md's "Deploy Without Vercel" section for the exact steps) -
//      watching this sheet for ReadyStatus = "READY", extracting
//      PromptText, asking Gemini via Flow's own native step, and writing
//      the raw response into GeminiFullOutput + ReadyStatus = "EVALUATED".
//      Nothing in this repo can build that Flow - Studio/Flow has no
//      deploy API, the same constraint cas-ccps hit.
//   3. harvestReviewResults()/harvestLearningResults(), installed on a
//      time-based trigger (installReviewQueueTriggers()), pick up
//      EVALUATED rows and run the exact same validation/dry-run/rate-cap/
//      decision-log/issue-or-PR logic processRequest()/runRecursiveLearning()
//      always had - finalizeReviewResult_()/finalizeLearningResult_() in
//      their own files, just moved to run once a real answer exists,
//      instead of inline in the same HTTP request that queued it.
//
// A caller's HTTP response is now "Queued", not a real review outcome -
// the actual result (an issue filed, a decision logged, a PR opened)
// surfaces later, once harvested. call-hub.yml's own run just shows
// "queued", not "found 2 issues" - a real, disclosed trade-off of choosing
// native inference over a synchronous API call, not a bug in this design.
//
// Studio's own run log shows "Run Completed" in green even when a step
// matched zero rows or a lookup failed silently - confirmed the hard way
// building cas-ccps's Flow 2 (see that repo's meta/FLOW_INVENTORY.md).
// checkReviewQueueLiveness/checkLearningQueueLiveness below are this
// project's version of the same backstop cas-ccps's checkFlow2Liveness()
// provides: distinguishes "no Flow has ever answered" from "the Flow is
// slow" from "the Flow is erroring" - something a green Studio checkmark
// alone cannot.

const QUEUE_TAB_REVIEW = 'ReviewQueue';
const QUEUE_TAB_LEARNING = 'LearningQueue';

// ReviewQueue columns (0-based) - one row per (owner, repo, mode, commit).
const RQ = {
  TIMESTAMP: 0,
  OWNER: 1,
  REPO: 2,
  MODE: 3,
  COMMIT_SHA: 4,
  READY_STATUS: 5,        // READY -> EVALUATED -> HARVESTED
                           // (or ERROR_EMPTY_OUTPUT / ERROR_HARVEST_FAILED)
  PROMPT_TEXT: 6,          // written by processRequest(); Studio's Extract
                           // step reads this via @trigger.PromptText
  GEMINI_FULL_OUTPUT: 7    // written by the Studio Flow's own Ask Gemini step
};
const RQ_HEADERS = ['Timestamp', 'Owner', 'Repo', 'Mode', 'CommitSha', 'ReadyStatus', 'PromptText', 'GeminiFullOutput'];

// LearningQueue columns (0-based) - one row per tenant pass, or the shared
// pool pass, per monthly runRecursiveLearning() invocation. Kind
// distinguishes them since they use different prompts/evidence rules (see
// recursive_learning.js) even though both harvest the same way.
const LQ = {
  TIMESTAMP: 0,
  KIND: 1,                 // 'tenant' | 'shared_pool'
  TENANT_ID: 2,             // real tenantId for 'tenant' rows; 'shared_pool' literal otherwise
  READY_STATUS: 3,
  PROMPT_TEXT: 4,
  GEMINI_FULL_OUTPUT: 5,
  CONTEXT_JSON: 6           // shared_pool rows only: JSON-stringified Contributor-N -> real
                             // {owner, repo, tenantId} label map, exactly as it was when the
                             // prompt was built. Load-bearing for the evidence-bar check and
                             // the PR body at harvest time, so it's persisted here rather than
                             // re-derived from spokes.json - which could have a different
                             // opt-in list by the time a Flow answers, silently changing what
                             // each "Contributor N" label means. Blank for 'tenant' rows.
};
const LQ_HEADERS = ['Timestamp', 'Kind', 'TenantId', 'ReadyStatus', 'PromptText', 'GeminiFullOutput', 'ContextJson'];

function ensureQueueTab_(ss, tabName, headers) {
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(headers);
  }
  return sheet;
}

// config.queueSheetId is the QUEUE_SHEET_ID Script Property - one
// spreadsheet, both tabs, same "one Central Ledger" shape cas-ccps already
// uses. Auto-creates it on first use (see ensureQueueSpreadsheetCreated_)
// when unset and a real Script Properties handle is available to persist
// the new ID into; returns null only when there's truly no way to proceed
// (no config.scriptProperties, or the create-lock couldn't be acquired), so
// a genuinely broken deployment still fails a specific, loggable way rather
// than an opaque SpreadsheetApp error.
function openQueueSpreadsheet_(config) {
  const id = config && config.queueSheetId;
  if (id) return SpreadsheetApp.openById(id);
  return ensureQueueSpreadsheetCreated_(config);
}

// Removes the one manual "create a blank Sheet, copy its ID into
// QUEUE_SHEET_ID" setup step - the only genuinely manual step left after
// this is building the two Workspace Flows, since Studio/Flow itself has
// no deploy API (see this file's header comment).
//
// Locked (LockService.getScriptLock()) and re-checks Script Properties
// under the lock before creating - two concurrent requests both hitting
// doPost() before QUEUE_SHEET_ID exists yet must not create two
// spreadsheets. A human's Flow only ever gets built against one of them;
// a second, orphaned spreadsheet nobody's Flow is watching would silently
// swallow every request routed to it - exactly the invisible-failure class
// this account's own watchdog/liveness-check philosophy exists to catch,
// not a risk worth taking to save one lock acquisition. If the lock can't
// be acquired, this run skips cleanly (returns null, same as "not
// configured") rather than risking a duplicate - the next run tries again.
function ensureQueueSpreadsheetCreated_(config) {
  if (!config || !config.scriptProperties) return null; // no way to persist a new ID - fail safe, same as before

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('[ReviewQueue] Could not acquire the create-lock for the queue spreadsheet - another request is likely creating it right now. Skipping this run; the next one will find it.');
    return null;
  }
  try {
    // Re-check under the lock - another request may have already created
    // and persisted it while this one was waiting on tryLock.
    const existingId = config.scriptProperties.getProperty('QUEUE_SHEET_ID');
    if (existingId) return SpreadsheetApp.openById(existingId);

    const ss = SpreadsheetApp.create('Mothership Review Queue');
    config.scriptProperties.setProperty('QUEUE_SHEET_ID', ss.getId());
    Logger.log('[ReviewQueue] Created the queue spreadsheet: ' + ss.getUrl() + ' - build the two Workspace Flows against it next (see README.md\'s "Native Workspace Inference" section), or find this link again on the settings page.');
    return ss;
  } finally {
    lock.releaseLock();
  }
}

// enqueueReviewRow_ - dedup on Owner+Repo+Mode+CommitSha among rows not yet
// HARVESTED, the same key shape the decision-log dedup this replaces the
// synchronous half of already used. A retried/duplicate call-hub.yml POST
// for the same commit+mode must never queue a second row while the first
// is still waiting on a Flow answer.
function enqueueReviewRow_(sheet, { owner, repo, mode, commitSha, promptText }) {
  const data = sheet.getDataRange().getValues();
  const key = `${owner}|${repo}|${mode}|${commitSha}`;
  // Starts at row 0, not 1 - deliberately does not assume a header row is
  // present (a caller-supplied `reviewQueueSheet` override, e.g. in tests,
  // may not have one; ensureQueueTab_'s own header row never coincidentally
  // matches a real owner/repo/mode/commitSha key, so scanning it too is
  // harmless on the real, header-carrying path).
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][RQ.READY_STATUS]).trim() === 'HARVESTED') continue;
    const rowKey = `${data[i][RQ.OWNER]}|${data[i][RQ.REPO]}|${data[i][RQ.MODE]}|${data[i][RQ.COMMIT_SHA]}`;
    if (rowKey === key) return { alreadyQueued: true };
  }
  sheet.appendRow([new Date(), owner, repo, mode, commitSha, 'READY', promptText, '']);
  return { alreadyQueued: false };
}

// No dedup here, unlike enqueueReviewRow_ - runRecursiveLearning() only
// ever enqueues once per tenant/pool per invocation (it's the caller's own
// loop, not a retried external POST), so a duplicate-suppression key would
// just be dead code guarding against a case that can't happen this way.
function enqueueLearningRow_(sheet, { kind, tenantId, promptText, contextJson }) {
  sheet.appendRow([new Date(), kind, tenantId, 'READY', promptText, '', contextJson || '']);
}

// harvestReviewResults - the DI-testable core. Real Apps Script triggers
// call zero-argument functions, so this is wrapped by runHarvestReviewResults()
// below (Code.js's own doPost/deps-construction convention) for the actual
// installed trigger handler.
function harvestReviewResults(deps) {
  const ss = openQueueSpreadsheet_(deps.config);
  if (!ss) {
    Logger.log('[ReviewQueue] QUEUE_SHEET_ID not configured - nothing to harvest.');
    return { harvested: 0 };
  }
  const sheet = ensureQueueTab_(ss, QUEUE_TAB_REVIEW, RQ_HEADERS);
  const data = sheet.getDataRange().getValues();
  let harvested = 0;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][RQ.READY_STATUS]).trim() !== 'EVALUATED') continue;
    const rowNum = i + 1;
    const row = data[i];
    const rawContent = String(row[RQ.GEMINI_FULL_OUTPUT] || '');

    if (!rawContent.trim()) {
      Logger.log('[ReviewQueue] Row ' + rowNum + ' marked EVALUATED with no output - leaving for manual review.');
      sheet.getRange(rowNum, RQ.READY_STATUS + 1).setValue('ERROR_EMPTY_OUTPUT');
      continue;
    }

    try {
      finalizeReviewResult_({
        owner: row[RQ.OWNER], repo: row[RQ.REPO], mode: row[RQ.MODE], commitSha: row[RQ.COMMIT_SHA],
        rawContent
      }, deps);
      sheet.getRange(rowNum, RQ.READY_STATUS + 1).setValue('HARVESTED');
      harvested++;
    } catch (err) {
      Logger.log('[ReviewQueue] Harvest failed for row ' + rowNum + ': ' + err.message);
      sheet.getRange(rowNum, RQ.READY_STATUS + 1).setValue('ERROR_HARVEST_FAILED');
    }
  }

  if (harvested > 0) SpreadsheetApp.flush();
  return { harvested };
}

function harvestLearningResults(deps) {
  const ss = openQueueSpreadsheet_(deps.config);
  if (!ss) {
    Logger.log('[LearningQueue] QUEUE_SHEET_ID not configured - nothing to harvest.');
    return { harvested: 0 };
  }
  const sheet = ensureQueueTab_(ss, QUEUE_TAB_LEARNING, LQ_HEADERS);
  const data = sheet.getDataRange().getValues();
  let harvested = 0;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][LQ.READY_STATUS]).trim() !== 'EVALUATED') continue;
    const rowNum = i + 1;
    const row = data[i];
    const rawContent = String(row[LQ.GEMINI_FULL_OUTPUT] || '');

    if (!rawContent.trim()) {
      Logger.log('[LearningQueue] Row ' + rowNum + ' marked EVALUATED with no output - leaving for manual review.');
      sheet.getRange(rowNum, LQ.READY_STATUS + 1).setValue('ERROR_EMPTY_OUTPUT');
      continue;
    }

    try {
      finalizeLearningResult_({
        kind: row[LQ.KIND], tenantId: row[LQ.TENANT_ID], rawContent,
        contextJson: row[LQ.CONTEXT_JSON] || ''
      }, deps);
      sheet.getRange(rowNum, LQ.READY_STATUS + 1).setValue('HARVESTED');
      harvested++;
    } catch (err) {
      Logger.log('[LearningQueue] Harvest failed for row ' + rowNum + ': ' + err.message);
      sheet.getRange(rowNum, LQ.READY_STATUS + 1).setValue('ERROR_HARVEST_FAILED');
    }
  }

  if (harvested > 0) SpreadsheetApp.flush();
  return { harvested };
}

const LIVENESS_ZERO_REPORT = { ready: 0, answered: 0, everAnswered: false, oldestReadyMins: 0, stuckAtReady: 0 };

// FIX (found by reviewing KOS's own cas-ccps Flow-doctrine tooling, not a
// live incident here yet): a Flow's "update row" step can write
// GeminiFullOutput and forget to also set ReadyStatus = "EVALUATED" in
// that same step - harvestReviewResults()/harvestLearningResults() only
// ever scan for ReadyStatus === "EVALUATED" (see their own loops above),
// so a row with real output sitting right there, still at "READY", is
// never picked up - forever. This function used to count any row with
// non-empty output as simply "answered," which would have reported that
// exact failure mode as healthy - the identical bug KOS's own
// checkFlow2Binding() found and fixed for cas-ccps's Flow 2. Reported
// here as its own `stuckAtReady` count, and logged with the same
// actionable guidance that fix's own comment gives, rather than folded
// silently into `answered`.
function checkQueueLiveness_(sheet, statusColIdx, outputColIdx, timestampColIdx) {
  const data = sheet.getDataRange().getValues();
  const report = { ready: 0, answered: 0, everAnswered: false, oldestReadyMins: 0, stuckAtReady: 0 };
  const nowMs = Date.now();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const hasOutput = String(row[outputColIdx] || '').trim() !== '';
    const status = String(row[statusColIdx] || '').trim();

    if (hasOutput && status === 'READY') {
      report.stuckAtReady++;
      continue;
    }
    if (hasOutput) { report.answered++; report.everAnswered = true; continue; }
    if (status !== 'READY') continue;
    report.ready++;
    const ageMins = Math.round((nowMs - new Date(row[timestampColIdx]).getTime()) / 60000);
    if (ageMins > report.oldestReadyMins) report.oldestReadyMins = ageMins;
  }

  if (report.stuckAtReady > 0) {
    Logger.log('[ReviewQueue] ' + report.stuckAtReady + ' row(s) have a real answer in the output ' +
      'column but ReadyStatus never advanced past READY - harvest will never pick these up. The ' +
      'Flow\'s "update spreadsheet row" step needs to write the output column AND set ReadyStatus ' +
      'to the literal "EVALUATED", both in the same step. Change nothing else about the row.');
  }

  return report;
}

function checkReviewQueueLiveness(config) {
  const ss = openQueueSpreadsheet_(config);
  if (!ss) return { ...LIVENESS_ZERO_REPORT };
  const sheet = ensureQueueTab_(ss, QUEUE_TAB_REVIEW, RQ_HEADERS);
  return checkQueueLiveness_(sheet, RQ.READY_STATUS, RQ.GEMINI_FULL_OUTPUT, RQ.TIMESTAMP);
}

function checkLearningQueueLiveness(config) {
  const ss = openQueueSpreadsheet_(config);
  if (!ss) return { ...LIVENESS_ZERO_REPORT };
  const sheet = ensureQueueTab_(ss, QUEUE_TAB_LEARNING, LQ_HEADERS);
  return checkQueueLiveness_(sheet, LQ.READY_STATUS, LQ.GEMINI_FULL_OUTPUT, LQ.TIMESTAMP);
}

// checkQueueBinding_ - compares a tab's actual header row (row 1) against
// the one canonical column map this file's own RQ_HEADERS/LQ_HEADERS
// declare. Same purpose as KOS's own column-map-agreement check in
// tools/gas-lint/check.js, simpler here since Mothership only has one
// canonical map per tab (RQ/LQ above), not several files each independently
// declaring an overlapping one - there's nothing to cross-reference against,
// only the live sheet to check against this file's own source of truth.
// Catches a human accidentally reordering, renaming, or deleting a header
// cell while building a Flow's Extract/Update-row step against this sheet
// by hand - a Flow step bound to the wrong column silently reads or writes
// the wrong data, no error, no red Studio run.
function checkQueueBinding_(sheet, expectedHeaders) {
  const data = sheet.getDataRange().getValues();
  const actual = (data[0] || []).map((v) => String(v || '').trim());

  const missing = [];
  const mismatched = [];
  for (let i = 0; i < expectedHeaders.length; i++) {
    const got = actual[i] || '';
    if (!got) missing.push(expectedHeaders[i]);
    else if (got !== expectedHeaders[i]) mismatched.push({ index: i, expected: expectedHeaders[i], got });
  }
  const extra = actual.slice(expectedHeaders.length).filter((v) => v !== '');

  return { ok: missing.length === 0 && mismatched.length === 0 && extra.length === 0, missing, mismatched, extra };
}

function checkReviewQueueBinding(config) {
  const ss = openQueueSpreadsheet_(config);
  if (!ss) return { ok: false, missing: RQ_HEADERS.slice(), mismatched: [], extra: [], reason: 'No queue spreadsheet configured' };
  const sheet = ensureQueueTab_(ss, QUEUE_TAB_REVIEW, RQ_HEADERS);
  return checkQueueBinding_(sheet, RQ_HEADERS);
}

function checkLearningQueueBinding(config) {
  const ss = openQueueSpreadsheet_(config);
  if (!ss) return { ok: false, missing: LQ_HEADERS.slice(), mismatched: [], extra: [], reason: 'No queue spreadsheet configured' };
  const sheet = ensureQueueTab_(ss, QUEUE_TAB_LEARNING, LQ_HEADERS);
  return checkQueueBinding_(sheet, LQ_HEADERS);
}

// FIXTURE_MARKER - the stable Owner/Repo (review) or TenantId (learning)
// value a fixture row uses so a human building a Flow has a known, stable
// value to search for in their test run, and so this code can check
// idempotently whether one is already installed.
const FIXTURE_MARKER = '_fixture';

// installReviewQueueFixture/installLearningQueueFixture - installable
// known-good test data, so a human building a Flow against this sheet has
// something to point its first test run at without waiting for real
// call-hub.yml traffic or a monthly recursive-learning run. Idempotent:
// checks for an existing fixture row first, never appends a second one.
//
// The review fixture's safety doesn't depend on how it's answered: Owner/
// Repo = "_fixture"/"_fixture" isn't a real GitHub repo, so even a
// has_findings: true answer on a live (non-dry-run) deployment fails at
// github.issues.create with a 404 - not wrapped in its own try/catch inside
// finalizeReviewResult_, but harvestReviewResults()'s own per-row try/catch
// (see above) still catches it, marks the row ERROR_HARVEST_FAILED, and
// nothing else happens: no crash, no real issue, just a row a human needs
// to glance at. Accepted as-is rather than adding a second guard layer -
// testing a Flow against a live deployment without ever trying dry-run
// first is already the unusual, higher-risk path.
function installReviewQueueFixture(config) {
  const ss = openQueueSpreadsheet_(config);
  if (!ss) return { ok: false, reason: 'No queue spreadsheet available' };
  const sheet = ensureQueueTab_(ss, QUEUE_TAB_REVIEW, RQ_HEADERS);

  const data = sheet.getDataRange().getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][RQ.OWNER] === FIXTURE_MARKER && data[i][RQ.REPO] === FIXTURE_MARKER) {
      return { ok: true, alreadyInstalled: true };
    }
  }

  const promptText = 'This is a fixture row installed by installReviewQueueFixture(), not a real review request. ' +
    'Point a Flow you are building/testing at this row: it has a stable Owner/Repo ("_fixture"/"_fixture") to find, ' +
    'and answering it is safe to experiment with - this deployment can never file a real issue against an owner/repo ' +
    'that does not exist on GitHub (see installReviewQueueFixture\'s own comment in review_queue.js). Write your test ' +
    'answer as JSON into GeminiFullOutput, e.g. {"has_findings": false}, and set ReadyStatus to EVALUATED.';
  enqueueReviewRow_(sheet, { owner: FIXTURE_MARKER, repo: FIXTURE_MARKER, mode: 'fixture', commitSha: FIXTURE_MARKER, promptText });
  return { ok: true, alreadyInstalled: false };
}

// Unlike the review fixture, the learning fixture is NOT inherently
// side-effect-free if answered has_proposal: true on a live deployment:
// finalizeTenantLearning_ always opens its PR against THIS hub repo itself
// (HUB_OWNER/HUB_REPO), using TenantId only as a label - "_fixture" isn't
// a nonexistent target the way "_fixture"/"_fixture" is for the review
// fixture, so that answer would create a real (reviewable, not
// auto-merged, but real) branch and PR here. Prefer has_proposal: false
// unless deliberately exercising that path - said explicitly in the row's
// own PromptText below so a human building a Flow test run sees it.
function installLearningQueueFixture(config) {
  const ss = openQueueSpreadsheet_(config);
  if (!ss) return { ok: false, reason: 'No queue spreadsheet available' };
  const sheet = ensureQueueTab_(ss, QUEUE_TAB_LEARNING, LQ_HEADERS);

  const data = sheet.getDataRange().getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][LQ.TENANT_ID] === FIXTURE_MARKER) {
      return { ok: true, alreadyInstalled: true };
    }
  }

  const promptText = 'This is a fixture row installed by installLearningQueueFixture(), not a real learning pass. ' +
    'Point a Flow you are building/testing at this row: it has a stable TenantId ("_fixture") to find. Unlike the ' +
    'ReviewQueue fixture, answering this one has_proposal: true on a LIVE deployment opens a real PR against this ' +
    'hub repo (reviewable, not auto-merged, but real) - prefer testing with {"has_proposal": false} unless you ' +
    'specifically intend to exercise the PR-opening path. Write your test answer as JSON into GeminiFullOutput and ' +
    'set ReadyStatus to EVALUATED.';
  enqueueLearningRow_(sheet, { kind: 'tenant', tenantId: FIXTURE_MARKER, promptText, contextJson: '' });
  return { ok: true, alreadyInstalled: false };
}

// runReviewQueueCanary/runLearningQueueCanary - proves the queue -> harvest
// -> finalize wiring works end to end WITHOUT a live Flow, the same purpose
// cas-ccps's own canary role serves in KOS's Flow Doctrine (see this file's
// header comment). Writes a synthetic row, then simulates the one step only
// a human-built Flow normally performs (writing GeminiFullOutput +
// ReadyStatus = EVALUATED), then runs the exact real harvest/finalize code
// against it - so a canary run genuinely exercises the same code path a
// real Flow answer would, not a separate, unverified stand-in for it.
//
// Safe-target resolution: the review canary targets THIS hub's own repo
// (hubOwner/hubRepo) with a synthetic commitSha ("CANARY-<timestamp>-
// <random>"), never a real commit sha - a real one could collide with the
// decision-log dedup key finalizeReviewResult_'s own logOutcome() uses
// (commitSha + mode), silently poisoning it for a real future review of
// that same commit. The learning canary similarly uses a synthetic
// tenantId ("canary") together with a unique stamp embedded in its own
// PromptText, since enqueueLearningRow_ has no natural key to search the
// row back out by afterward the way enqueueReviewRow_'s owner/repo/mode/
// commitSha does.
//
// Both canaries always answer with the SAFEST possible response
// (has_findings: false / has_proposal: false), regardless of this
// deployment's real DRY_RUN_MODE - an operator may deliberately run a
// canary against an already-live deployment specifically to verify it, and
// the canary itself must never be the thing that files a real issue or
// opens a real PR. That answer shape stops finalizeReviewResult_/
// finalizeTenantLearning_ at their own first "nothing to do" check, before
// either ever reaches a dry-run branch or a write beyond a decision-log/
// usage-log line (review) or nothing at all (learning - see
// finalizeTenantLearning_'s own early return above; it writes nothing until
// past the has_proposal check).
function runReviewQueueCanary(deps) {
  const config = deps.config || {};
  const hubOwner = config.hubOwner || DEFAULT_HUB_OWNER;
  const hubRepo = config.hubRepo || DEFAULT_HUB_REPO;

  const ss = openQueueSpreadsheet_(config);
  if (!ss) return { ok: false, reason: 'No queue spreadsheet available (QUEUE_SHEET_ID unset and no scriptProperties to auto-create one into)' };
  const sheet = ensureQueueTab_(ss, QUEUE_TAB_REVIEW, RQ_HEADERS);

  const commitSha = 'CANARY-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const promptText = '[Canary probe] This row exists only to prove the ReviewQueue -> harvest -> decision-log ' +
    'pipeline is wired end to end. It is written and answered entirely by runReviewQueueCanary() itself, never a ' +
    'real Flow - safe to ignore in a Flow you are building against this sheet.';
  enqueueReviewRow_(sheet, { owner: hubOwner, repo: hubRepo, mode: 'canary', commitSha, promptText });

  const data = sheet.getDataRange().getValues();
  let rowNum = -1;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i][RQ.COMMIT_SHA] === commitSha) { rowNum = i + 1; break; }
  }
  if (rowNum === -1) return { ok: false, reason: 'Row vanished immediately after being enqueued - something else is writing to this sheet concurrently' };

  // Simulate the one step only a human-built Flow normally performs.
  const safeAnswer = JSON.stringify({ has_findings: false });
  sheet.getRange(rowNum, RQ.GEMINI_FULL_OUTPUT + 1).setValue(safeAnswer);
  sheet.getRange(rowNum, RQ.READY_STATUS + 1).setValue('EVALUATED');

  try {
    finalizeReviewResult_({ owner: hubOwner, repo: hubRepo, mode: 'canary', commitSha, rawContent: safeAnswer }, deps);
    sheet.getRange(rowNum, RQ.READY_STATUS + 1).setValue('HARVESTED');
    return { ok: true, commitSha, message: 'Canary row enqueued, answered, and harvested end to end - the decision log should show one no_findings entry for mode=canary.' };
  } catch (err) {
    sheet.getRange(rowNum, RQ.READY_STATUS + 1).setValue('ERROR_HARVEST_FAILED');
    return { ok: false, reason: 'Harvest step threw: ' + err.message };
  }
}

function runLearningQueueCanary(deps) {
  const config = deps.config || {};
  const ss = openQueueSpreadsheet_(config);
  if (!ss) return { ok: false, reason: 'No queue spreadsheet available (QUEUE_SHEET_ID unset and no scriptProperties to auto-create one into)' };
  const sheet = ensureQueueTab_(ss, QUEUE_TAB_LEARNING, LQ_HEADERS);

  const stamp = 'CANARY-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const promptText = '[Canary probe ' + stamp + '] This row exists only to prove the LearningQueue -> harvest ' +
    'pipeline is wired end to end. It is written and answered entirely by runLearningQueueCanary() itself, never a ' +
    'real Flow - safe to ignore in a Flow you are building against this sheet.';
  enqueueLearningRow_(sheet, { kind: 'tenant', tenantId: 'canary', promptText, contextJson: '' });

  // No natural dedup key to search the row back out by (unlike the review
  // queue's owner/repo/mode/commitSha) - the stamp embedded in PromptText
  // above is this canary's own unique marker instead.
  const data = sheet.getDataRange().getValues();
  let rowNum = -1;
  for (let i = data.length - 1; i >= 0; i--) {
    if (String(data[i][LQ.PROMPT_TEXT]).indexOf(stamp) !== -1) { rowNum = i + 1; break; }
  }
  if (rowNum === -1) return { ok: false, reason: 'Row vanished immediately after being enqueued - something else is writing to this sheet concurrently' };

  const safeAnswer = JSON.stringify({ has_proposal: false });
  sheet.getRange(rowNum, LQ.GEMINI_FULL_OUTPUT + 1).setValue(safeAnswer);
  sheet.getRange(rowNum, LQ.READY_STATUS + 1).setValue('EVALUATED');

  try {
    finalizeLearningResult_({ kind: 'tenant', tenantId: 'canary', rawContent: safeAnswer, contextJson: '' }, deps);
    sheet.getRange(rowNum, LQ.READY_STATUS + 1).setValue('HARVESTED');
    return { ok: true, stamp, message: 'Canary row enqueued, answered, and harvested end to end - finalizeTenantLearning_ should have returned "no cross-spoke pattern" with zero writes.' };
  } catch (err) {
    sheet.getRange(rowNum, LQ.READY_STATUS + 1).setValue('ERROR_HARVEST_FAILED');
    return { ok: false, reason: 'Harvest step threw: ' + err.message };
  }
}

// --- Real (zero-argument) trigger entry points --------------------------
// ScriptApp calls an installed time-trigger's handler with no custom
// arguments - these build real deps the same way Code.js's doPost() does
// and delegate to the DI-testable core functions above. Installed by
// installReviewQueueTriggers() below, by handler NAME (these two), not the
// DI-taking functions themselves.

function runHarvestReviewResults() {
  const config = loadConfig();
  config.scriptProperties = PropertiesService.getScriptProperties();
  const githubFactory = (token) => makeGithubClient(UrlFetchApp.fetch, token);
  const hubGithub = makeGithubClient(UrlFetchApp.fetch, config.globalGithubToken);
  harvestReviewResults({ githubFactory, hubGithub, base64Encode, base64Decode, config });
}

function runHarvestLearningResults() {
  const config = loadConfig();
  config.scriptProperties = PropertiesService.getScriptProperties();
  const githubFactory = (token) => makeGithubClient(UrlFetchApp.fetch, token);
  const hubGithub = makeGithubClient(UrlFetchApp.fetch, config.globalGithubToken);
  harvestLearningResults({ githubFactory, hubGithub, base64Encode, base64Decode, config });
}

// Manual admin actions - run once from the Apps Script IDE's function
// picker (select one of these, click Run, check the Executions log for the
// returned result) whenever you want to check this deployment's wiring
// without waiting on a real Flow or real traffic. Never installed on a
// trigger - these are on-demand checks, not part of the running pipeline.
function runReviewQueueCanaryNow() {
  const config = loadConfig();
  config.scriptProperties = PropertiesService.getScriptProperties();
  const githubFactory = (token) => makeGithubClient(UrlFetchApp.fetch, token);
  const hubGithub = makeGithubClient(UrlFetchApp.fetch, config.globalGithubToken);
  const result = runReviewQueueCanary({ githubFactory, hubGithub, base64Encode, base64Decode, config });
  Logger.log('[ReviewQueue] Canary result: ' + JSON.stringify(result));
  return result;
}

function runLearningQueueCanaryNow() {
  const config = loadConfig();
  config.scriptProperties = PropertiesService.getScriptProperties();
  const githubFactory = (token) => makeGithubClient(UrlFetchApp.fetch, token);
  const hubGithub = makeGithubClient(UrlFetchApp.fetch, config.globalGithubToken);
  const result = runLearningQueueCanary({ githubFactory, hubGithub, base64Encode, base64Decode, config });
  Logger.log('[LearningQueue] Canary result: ' + JSON.stringify(result));
  return result;
}

function runReviewQueueBindingCheckNow() {
  const config = loadConfig();
  config.scriptProperties = PropertiesService.getScriptProperties();
  const result = checkReviewQueueBinding(config);
  Logger.log('[ReviewQueue] Binding check: ' + JSON.stringify(result));
  return result;
}

function runLearningQueueBindingCheckNow() {
  const config = loadConfig();
  config.scriptProperties = PropertiesService.getScriptProperties();
  const result = checkLearningQueueBinding(config);
  Logger.log('[LearningQueue] Binding check: ' + JSON.stringify(result));
  return result;
}

function installReviewQueueFixtureNow() {
  const config = loadConfig();
  config.scriptProperties = PropertiesService.getScriptProperties();
  const result = installReviewQueueFixture(config);
  Logger.log('[ReviewQueue] Fixture install: ' + JSON.stringify(result));
  return result;
}

function installLearningQueueFixtureNow() {
  const config = loadConfig();
  config.scriptProperties = PropertiesService.getScriptProperties();
  const result = installLearningQueueFixture(config);
  Logger.log('[LearningQueue] Fixture install: ' + JSON.stringify(result));
  return result;
}

// One-time admin action - run once from the Apps Script IDE's function
// picker (select installReviewQueueTriggers, click Run), or via
// `clasp run installReviewQueueTriggers` - see README.md. Same
// idempotent-by-handler-name convention as cas-ccps's
// installFlowInputTriggers(): safe to re-run, never installs a duplicate.
// ScriptApp's time-based trigger API only accepts
// everyMinutes(1|5|10|15|30) - confirmed the hard way there too
// (everyMinutes(2) throws "The value you passed to everyMinutes was
// invalid" on a real account).
function installReviewQueueTriggers() {
  const existing = ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
  if (existing.indexOf('runHarvestReviewResults') === -1) {
    ScriptApp.newTrigger('runHarvestReviewResults').timeBased().everyMinutes(5).create();
    Logger.log('[ReviewQueue] Installed runHarvestReviewResults - every 5 minutes.');
  }
  if (existing.indexOf('runHarvestLearningResults') === -1) {
    // recursive_learning runs monthly - no need for the review queue's
    // faster cadence, but still fast enough that a same-day answer from
    // the Flow doesn't sit for weeks before being harvested.
    ScriptApp.newTrigger('runHarvestLearningResults').timeBased().everyMinutes(30).create();
    Logger.log('[ReviewQueue] Installed runHarvestLearningResults - every 30 minutes.');
  }
}
