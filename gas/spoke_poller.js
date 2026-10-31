// Pull model: the hub reviews its spokes on its own timer, instead of each
// spoke pushing a heartbeat to the hub.
//
// Why this exists. Every spoke's call-hub.yml needed two repo secrets
// (APPS_SCRIPT_URL, TENANT_CALLER_KEY) that had to match a Script Property
// here, so one shared key lived in four places that all had to be set and
// rotated together. They never were: KOS's heartbeat failed all 233 of its
// runs between 2026-09-19 and 2026-10-31 without succeeding once, and its
// watchdog reported that every week. The hub already reads each spoke's
// commits and diff with its own credential (processRequest() below), so the
// spokes never needed to call in at all. Pulling leaves one credential in
// one place and no per-spoke setup.
//
// How it works. A time-driven trigger calls pollSpokesDebug() (and, weekly,
// pollSpokesHunt()/pollSpokesRefactor() - the same three modes and the same
// schedule shape call-hub.yml used). pollSpokes_() walks spokes.json and,
// for each active spoke whose latest commit differs from the one it last
// finished, calls processRequest() exactly as doPost() does. Nothing about
// review logic is duplicated: dedup by (commitSha, mode), dry-run, quota,
// bot-commit skips and the ReviewQueue hand-off are all processRequest()'s.
//
// The watermark. SPOKE_POLL_LAST_<owner>/<repo>:<mode> holds the last
// commit this poller saw through to a settled result, so an unchanged
// spoke costs one listCommits call and nothing else. It advances only on a
// result that is settled for that commit: 'Queued', or 'Already decided'
// (which is also what a logged bot/empty-diff/quota skip returns on the next
// poll). Anything else - no queue sheet, an unresolvable credential, a
// thrown error - leaves the watermark alone, so the commit is retried on
// the next run instead of being silently passed over.
//
// Visibility. Every run records its per-spoke results in SPOKE_POLL_STATUS
// (read it with showSpokePollStatus() from the editor), so a poller that is
// running but doing nothing useful shows why, rather than looking idle.
//
// Known limit, same as the heartbeat it replaces: it reviews each spoke's
// latest commit, not every commit since the last poll.

const SPOKE_POLL_WATERMARK_PREFIX = 'SPOKE_POLL_LAST_';
const SPOKE_POLL_STATUS_KEY = 'SPOKE_POLL_STATUS';
const SPOKE_POLL_MODES = ['debug', 'hunt', 'refactor'];

function spokePollWatermarkKey_(owner, repo, mode) {
  return `${SPOKE_POLL_WATERMARK_PREFIX}${owner}/${repo}:${mode}`;
}

// A processRequest() result this commit doesn't need to be retried for.
function isSettledPollResult_(result) {
  const body = (result && result.body) || {};
  if (result && result.httpStatus === 200 && body.status === 'Queued') return true;
  return !!(result && result.httpStatus === 200 && body.status === 'Skipped' &&
    typeof body.reason === 'string' && body.reason.indexOf('Already decided') === 0);
}

// The testable core. `props` is a ScriptProperties-shaped store (watermarks
// and the status record); everything else is processRequest()'s own deps.
// Returns { mode, results: [{ owner, repo, outcome, detail }] }.
function pollSpokes_(mode, deps) {
  const {
    githubFactory, hubGithub, base64Decode, config = {}, props,
    spokesOverride, tenantsOverride, now,
    processRequestImpl = processRequest
  } = deps;
  if (SPOKE_POLL_MODES.indexOf(mode) === -1) throw new Error(`Unknown poll mode: ${mode}`);

  const hubOwner = config.hubOwner || DEFAULT_HUB_OWNER;
  const hubRepo = config.hubRepo || DEFAULT_HUB_REPO;
  // Read both registries once per run and hand them to every
  // processRequest() call, instead of refetching them per spoke.
  const spokes = spokesOverride || safeGetJsonArrayFromHub(hubGithub, base64Decode, hubOwner, hubRepo, SPOKES_REGISTRY_PATH);
  const tenants = tenantsOverride || safeGetJsonArrayFromHub(hubGithub, base64Decode, hubOwner, hubRepo, TENANTS_REGISTRY_PATH);

  const results = [];
  spokes.forEach((spoke) => {
    if (!spoke || !spoke.owner || !spoke.repo) return;
    const { owner, repo } = spoke;
    if (spoke.status && spoke.status !== 'active') {
      results.push({ owner, repo, outcome: 'inactive', detail: `spoke status '${spoke.status}'` });
      return;
    }
    try {
      const { github, tenant } = resolveTenantAndGithub_(owner, repo, {
        githubFactory, hubGithub, base64Decode, config, hubOwner, hubRepo,
        spokesOverride: spokes, tenantsOverride: tenants
      });
      const { data: commits } = github.repos.listCommits({ owner, repo, per_page: 1 });
      const latestSha = commits && commits.length ? commits[0].sha : null;
      if (!latestSha) {
        results.push({ owner, repo, outcome: 'no-commits', detail: '' });
        return;
      }
      const key = spokePollWatermarkKey_(owner, repo, mode);
      if (props.getProperty(key) === latestSha) {
        results.push({ owner, repo, outcome: 'unchanged', detail: latestSha.slice(0, 7) });
        return;
      }
      // The poller runs inside the hub, so it supplies the tenant's own key
      // rather than asking processRequest() to skip its caller check.
      const callerKey = tenant ? resolveSecretRef(tenant.callerKeyRef, config.scriptProperties) : null;
      const result = processRequestImpl({ owner, repo, mode, callerKey }, {
        ...deps, spokesOverride: spokes, tenantsOverride: tenants, now
      });
      const body = (result && result.body) || {};
      if (isSettledPollResult_(result)) {
        props.setProperty(key, latestSha);
        results.push({ owner, repo, outcome: 'settled', detail: `${latestSha.slice(0, 7)} ${body.status}` });
      } else {
        results.push({ owner, repo, outcome: 'retry', detail: `${result && result.httpStatus} ${body.status || ''} ${body.reason || body.error || ''}`.trim() });
      }
    } catch (e) {
      results.push({ owner, repo, outcome: 'error', detail: e.message });
    }
  });

  const record = { at: (now || new Date()).toISOString(), mode, results };
  props.setProperty(SPOKE_POLL_STATUS_KEY, JSON.stringify(record));
  return record;
}

// Same dependency wiring as doPost() (Code.js), for a call with no request.
function buildHubDeps_() {
  const config = loadConfig();
  const props = PropertiesService.getScriptProperties();
  config.scriptProperties = props;
  return {
    githubFactory: (token) => makeGithubClient(UrlFetchApp.fetch, token),
    hubGithub: makeGithubClient(UrlFetchApp.fetch, config.globalGithubToken),
    base64Encode, base64Decode, config, props
  };
}

// Trigger handlers: a time-driven trigger calls a function with no
// arguments, so each mode gets its own. The script lock keeps a slow run
// from overlapping the next one.
function runSpokePoll_(mode) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log(`[SpokePoller] ${mode}: another poll is still running; skipped.`);
    return null;
  }
  try {
    const record = pollSpokes_(mode, buildHubDeps_());
    record.results.forEach((r) => Logger.log(`[SpokePoller] ${mode} ${r.owner}/${r.repo}: ${r.outcome} ${r.detail}`));
    return record;
  } finally {
    lock.releaseLock();
  }
}

function pollSpokesDebug() { return runSpokePoll_('debug'); }
function pollSpokesHunt() { return runSpokePoll_('hunt'); }
function pollSpokesRefactor() { return runSpokePoll_('refactor'); }

// What the last run did, per spoke - run from the editor's function picker.
function showSpokePollStatus() {
  const raw = PropertiesService.getScriptProperties().getProperty(SPOKE_POLL_STATUS_KEY);
  Logger.log(raw ? raw : '[SpokePoller] No poll has run yet. Run installSpokePollerTriggers(), then pollSpokesDebug() once by hand.');
  return raw ? JSON.parse(raw) : null;
}

// Run once from the editor (or `clasp run installSpokePollerTriggers`).
// Idempotent by handler name, like installReviewQueueTriggers(). The
// cadence mirrors call-hub.yml's modes: debug often, hunt Wednesday noon,
// refactor Sunday midnight (script time zone). Every 6 hours, not every 30
// minutes: an unchanged spoke is one cheap call, but nothing is gained by
// checking a repo that commits a few times a day more often than that.
function installSpokePollerTriggers() {
  const existing = ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
  const installed = [];
  if (existing.indexOf('pollSpokesDebug') === -1) {
    ScriptApp.newTrigger('pollSpokesDebug').timeBased().everyHours(6).create();
    installed.push('pollSpokesDebug (every 6 hours)');
  }
  if (existing.indexOf('pollSpokesHunt') === -1) {
    ScriptApp.newTrigger('pollSpokesHunt').timeBased().onWeekDay(ScriptApp.WeekDay.WEDNESDAY).atHour(12).create();
    installed.push('pollSpokesHunt (Wednesdays, 12:00)');
  }
  if (existing.indexOf('pollSpokesRefactor') === -1) {
    ScriptApp.newTrigger('pollSpokesRefactor').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(0).create();
    installed.push('pollSpokesRefactor (Sundays, 00:00)');
  }
  Logger.log(installed.length ? `[SpokePoller] Installed: ${installed.join(', ')}.` : '[SpokePoller] All three triggers already installed.');
  return installed;
}
