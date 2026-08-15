# AI CTO Hub - Mothership Repository

This repository serves as the central intelligence (the "Mothership") for a hub-and-spoke autonomous coding swarm system.

## Why This Exists

The value proposition is leverage: write engineering judgment down once (`universal_lessons.md`, `north_star_framework.md`) and have it re-applied continuously across every connected spoke, instead of re-reviewing each project by hand. Each spoke stays lean - it only needs a heartbeat mechanism - while all the standards live centrally, in the hub. The Recursive Learning Loop pushes this further: a pattern the AI notices recurring across more than one spoke gets proposed back into the shared standards as a PR, so a lesson learned fixing one project can make every other project a little better too - a human still reviews and merges that proposal, the aggregation itself is what's automatic.

That leverage is deliberately safety-railed, and the caveat is part of the value proposition, not an afterthought: an earlier, naive version of this same idea - no real code in the prompt, no validation of what came back - produced ~1,974 fabricated GitHub issues against `tso` over four months (see `DOCS_VS_CODEBASE.md`). Everything built since - dry-run-by-default, per-repo daily rate caps, decision logs, strict response validation - exists because trusting an AI reviewer to act autonomously has to be earned incrementally and provably, not assumed.

There are two different intended experiences here, close to opposite on purpose:

- **The operator running the swarm** should get glanceable confidence, not a reason to dig through logs: a scheduled heartbeat quietly reviews real commit diffs, a single pinned health-report issue updates in place instead of spamming, and the [Health Dashboard](#health-dashboard-dashboard) gives the same picture live in a browser - worst-status-first, so a real problem is never buried under quiet ones. That's the intended experience once a hub URL is actually live and every piece is wired to it - as of this writing it isn't yet (see `DOCS_VS_CODEBASE.md` #7), so today this describes designed, tested behavior rather than something an operator can currently check in on.
- **The people actually using the spoke products** (`tso`, `thinkos-server`, `tais`) should never know any of this exists. That's the literal goal in `north_star_framework.md`: *"Efficiency without Anxiety," "Invisible Complexity - the AI handles the mess, the user sees the magic," "Forgiving Design."* Mothership's job is to catch the silent bug and nudge the refactor before either ever becomes something a real user has to notice. Success looks like nothing changing for them at all - see [Values Alignment](#values-alignment) below for how this is meant to compound across the whole portfolio.

## Overview

The AI CTO Hub implements a centralized intelligence system that manages multiple project repositories ("spokes") through a hub-and-spoke model. The system enables:

- **Shared Standards**: A manual edit to this repo's global lessons/North Star files takes effect for every spoke on its next heartbeat. On top of that, a monthly job now looks for patterns across spokes and *proposes* updates to those files as a PR - a human still reviews and merges it, but the aggregation itself is automatic. See [Recursive Learning Loop](#recursive-learning-loop-apirecursive_learningjs).
- **Centralized Maintenance**: Single point of updates for AI models, prompts, and standards  
- **Lean Spokes**: Individual projects remain lightweight, only needing a heartbeat mechanism
- **Global Cost Management**: All AI API traffic flows through a single deployment - Vercel by default, or Google Apps Script (see [Alternative: Deploy Without Vercel](#alternative-deploy-without-vercel-google-apps-script)) if you'd rather not use Vercel at all
- **Structural Consistency**: Ensures coding standards and architectural decisions align across the portfolio

## Core Components

### Universal Lessons (`universal_lessons.md`)
Global engineering standards that apply to all projects:
- Security best practices (no hardcoded keys, use environment variables)
- Quality requirements (typed code, linting)
- Architectural preferences (flat logic, clear documentation)
- Documentation requirements (each spoke must maintain a NORTH_STAR.md)

### North Star Framework (`north_star_framework.md`)
Global value proposition that defines the emotional UX outcomes:
- **Efficiency without Anxiety**: UX should feel fast and calm
- **Invisible Complexity**: AI handles complexity; users experience simplicity  
- **Forgiving Design**: Always provide paths to undo or go back

### Autonomous Agent (`api/autonomous_agent.js`)
The Vercel serverless worker that:
1. Fetches global context (universal lessons + North Star + hub lessons) from the hub
2. Fetches local context (project lessons + North Star) from the spoke
3. Checks the spoke's `ai_decision_log.json` for a prior decision on this exact commit+mode - if one exists (and wasn't an AI-call failure), replays that outcome and stops here without spending an AI call
4. Fetches the spoke's latest commit diff - if there's no usable diff, it stops here and does nothing (no AI call, no issue)
5. Combines contexts, the diff, and the last few logged decisions into a prompt for the configured AI model
6. Requests a strict JSON response that must include a `has_findings` flag
7. Validates the response's shape before acting on it - a parse failure, a missing field, or `has_findings: false` all result in the run being skipped, not an issue being posted
8. If dry-run mode is on (the default), a well-formed finding is reported back but never filed as an issue
9. In live mode, a hard per-repo/per-day cap on issue creation applies before an issue is ever filed
10. Only when the response is well-formed, reports real findings, dry-run is off, AND the day's cap hasn't been reached does it post a GitHub issue with reasoning and a code patch
11. Every outcome (skip, dry-run finding, rate-capped, created) gets appended to the spoke's `ai_decision_log.json`, best-effort - a logging failure never fails the request itself

### On-Demand Live Review (`.claude/skills/mothership-live-review/`)

The Autonomous Agent above has never run for real end-to-end - it needs a deployed backend (Vercel or Apps Script, neither ever actually live) *and* a configured `AI_API_KEY`/`AI_BASE_URL` (never set). Both are long-standing, disclosed blockers with no code fix. This skill sidesteps both without touching either deployment path: instead of the handler calling out to an external AI API, the Claude session invoking the skill *is* the AI step, directly, reusing every other rail above (decision-log dedup, dry-run default, rate cap, decision logging) exactly as designed - same schema, same fetch order, same all-or-nothing local-context quirk (see below), just with the "call an external `/chat/completions` endpoint" step replaced by real reasoning performed in-session.

Deliberately **on-demand only, no schedule** - this project's worst incident (the ~1,974-issue hallucination spree) and its second-worst (`thinkos-server`/`tais` spamming 100+/135+ failed scheduled runs on an unset secret) were both consequences of *unattended, scheduled* automation; wiring this into a cron/Routine is a distinct, separate decision, not implied by building it. It also **never files a real issue on its own** - a finding is always reported as a dry-run "would create," and actually calling `issues.create` requires a separate, explicit go-ahead per finding.

Verified working end-to-end against real data: run once against `tso`'s real commit `d020c799` (the same fix that later independently caused `thinkos-server`/`tais` to fail 100+/135+ scheduled runs on an unset `VERCEL_URL`) - found the same root cause from the diff alone (no prior guard on the secret being set before `curl` uses it), reported the dry-run finding, and appended a real `dry_run_would_create` decision-log entry to `tso`'s `ai_decision_log.json` (commit `a29cc68`). Full procedure documented in the skill file linked above.

### Safety Rails

The handler that used to file ~1,974 fabricated issues over 4 months (see `DOCS_VS_CODEBASE.md`) now has two independent guards on top of the response-validation fix above, both controlled by Vercel env vars:

- **`DRY_RUN_MODE`** (defaults to `true`) - a well-formed, real finding is reported in the response as `{ status: 'DryRunFinding', wouldCreate: {...} }` instead of actually calling the GitHub API to create an issue. A misconfigured or missing env var fails safe (no issue gets filed), not open. Only set this to the literal string `"false"` after watching dry-run output for a while and being satisfied the findings look real.
- **`RATE_CAP_PER_REPO_PER_DAY`** (defaults to `3`) - once dry-run is off, this hard-caps how many issues the handler will file against a single repo per UTC day, counted by querying that repo's existing issues (no separate database - there's nowhere else for a stateless Vercel function to keep a count). Once the cap is hit for the day, further findings return `Skipped` with the reason stated, until the next UTC day.

Every issue the handler files is tagged with the `cto-hub-auto` label - this is what the rate cap counts against, and what later tooling (health reporting) filters on to distinguish hub-filed issues from anything a human filed manually.

### Multi-Tenancy (`tenants.json`)

The hub can serve more than one customer/organization ("tenant") without pooling their data or their GitHub credentials. This is architecture-and-data-model work, built to make real multi-tenancy possible without a rewrite later - it is **not** a finished product: there's no tenant self-service signup UI, no billing/payment processor, no real secrets store, and `setup_hub.py`/`dashboard/` still assume one hub, one operator. See `lessons.md`'s dated multi-tenancy entry for the full scope decision.

- **Per-tenant GitHub credential, not one shared master token.** `spokes.json` now carries a `tenantId` per entry (every spoke registered before this feature existed was migrated to `tenantId: "default"`, which still resolves to `GLOBAL_GITHUB_TOKEN` - zero behavior change for the pre-existing single-tenant setup). `tenants.json` (new, hub root) holds one entry per tenant: `{ tenantId, name, status, plan, quota: { reviewsPerMonth }, githubCredentialRef, callerKeyRef?, createdAt }`. `githubCredentialRef`/`callerKeyRef` use a `scheme:value` pointer format - `env:VAR_NAME` reads a real environment variable (or, on the Apps Script side, a Script Property), and `kv:path` is a **disclosed, deliberately-unbuilt placeholder** for a real dynamic secrets store (Vercel KV, a database, a secrets manager) that does not exist yet - it always resolves to `null` today. **Never commit a raw per-tenant credential into `tenants.json`** - that permanently leaks it into git history and defeats the entire point of this feature; only `env:`-backed refs are safe to use before a real secrets store is wired up.
- **Hub-provided AI capability, metered per tenant, not billed per tenant.** There's still one shared AI credential for the whole hub (no change to that part of the architecture) - tenants don't bring their own key. What's new is that every AI-backed review/proposal is attributed to the tenant that triggered it.
- **Usage-metering hooks, no payment processor.** Every real AI call and every issue filed appends an event (`{tenantId, timestamp, eventType: 'review_run'|'issue_created'|'ai_call', mode, owner, repo}`) to that tenant's own `usage/{tenantId}.json` in the hub repo - real counters, real read-modify-write-with-retry (same convention as `ai_decision_log.json`), but per-tenant JSON files via the GitHub API don't scale or query well for real billing aggregation. This is "hooks exist and are provably wired up," not a production metering pipeline - a real database/metering service is the eventual, separate upgrade.
- **Per-tenant monthly quota**, enforced before the AI call (not just before filing, like the rate cap above, since the AI call is the actual cost-incurring event). A tenant's `quota.reviewsPerMonth: null` (the `"default"` tenant's seeded value) means unlimited - never checked. Once a tenant is at or over their quota, further requests return `Skipped`/`quota_exceeded` until next calendar month.
- **Opt-in caller authentication.** A request body may include `callerKey`; it's only checked against the resolved tenant's `callerKeyRef` if that tenant has one configured. A tenant with no `callerKeyRef` (true for `"default"` today) accepts any/no key - today's exact zero-auth behavior is unchanged for the pre-existing setup. `setup_spoke.py`'s generated `call-hub.yml` includes an optional `TENANT_CALLER_KEY` secret it forwards as `callerKey`, unset by default.
- **The Recursive Learning Loop never pools two tenants' data by default.** It groups spokes by `tenantId` and runs one fully independent pass per tenant - a tenant's spokes' `lessons.md`/decision-log data never appears in another tenant's prompt (verified by a dedicated test asserting this directly). `universal_lessons.md`/`north_star_framework.md` stay hub-global (operator-authored, not tenant-derived); each PR it opens is explicitly labeled with which tenant's data prompted it, so the human merging it can judge whether generalizing a tenant-specific pattern into the shared standard is appropriate. **Repos can additionally opt in to a separate, shared cross-organization learning pool** - see [Recursive Learning Loop](#recursive-learning-loop-apirecursive_learningjs) below for how that stays opt-in and anonymized.
- **Every maintenance/reporting script** (`doctor.js`, `health-report.js`, `prune-logs.js`, `collect-issue-feedback.js`) resolves each spoke's own tenant credential when an `octokitFactory` is supplied, instead of always using the hub's own token - optional and backward-compatible; omitting it behaves exactly as before.

### Decision Logging (`ai_decision_log.json`)

Every decision the handler makes for a spoke - skip (no diff, no findings, invalid AI response), dry-run finding, rate-capped, or created - gets appended to that spoke's `ai_decision_log.json` as `{ timestamp, mode, commitSha, outcome, issueUrl, summary }`. This serves two purposes:

- **Avoids redundant AI calls**: if this exact commit was already decided in this mode, the handler replays the logged outcome instead of calling the AI model again. An outcome of `ai_error` (the AI call itself failed, e.g. returned no content) is the one exception - that's not a real decision, so it doesn't block a retry on the next run.
- **Gives the model memory**: the last 5 entries are fed back into the prompt as "PRIOR DECISIONS" context, so the model is less likely to re-report something it already looked at and dismissed.

Writes are best-effort (read-modify-write with retry on a stale `sha`, per repo, via the GitHub API) - a logging failure never fails the actual request, since the real decision has already been made by the time the log write happens. There is no separate database here; the log file itself is the durable state, same as everything else this handler persists.

### Maintainer Feedback (`scripts/collect-issue-feedback.js`)

Before this, the only way a spoke maintainer could tell the system "this finding was wrong" was closing the issue - nothing ever read that. GitHub already attaches a `reactions` summary (`{"+1", "-1", laugh, ...}`) to every issue `issues.listForRepo` returns, so a 👎 on a hub-filed issue is a free, already-available signal that was simply never collected. A weekly Actions script (`.github/workflows/collect-issue-feedback.yml`, plain GitHub token only, no AI):

1. Lists every `cto-hub-auto`-labeled issue per registered spoke, reading each one's reaction counts.
2. Matches issues back to the decision-log entry that created them (`issueUrl === issue.html_url`).
3. Attaches `feedback: { thumbsUp, thumbsDown, checkedAt }` to any matching entry with a real thumbs-down count - additive, optional, no existing reader breaks.

This feeds directly into the Recursive Learning Loop below, which weighs a feedback pattern that recurs across spokes as evidence a check should be adjusted or suppressed, not just repeated.

### Recursive Learning Loop (`api/recursive_learning.js`)

A separate Vercel endpoint, distinct from `autonomous_agent.js`, that runs monthly (`.github/workflows/recursive-learning.yml`) and looks for patterns that recur across *multiple* spokes rather than reviewing one commit in one repo:

1. Reads `spokes.json` (this repo's registry of connected spokes - `[{ "owner", "repo", "addedAt", "status" }, ...]`). If it's empty, the run is skipped.
2. Fetches each registered spoke's `lessons.md` and recent `ai_decision_log.json` entries (including any `feedback` the maintainer-feedback script above has attached), alongside this hub's own current `universal_lessons.md`/`north_star_framework.md`.
3. Asks the configured AI model to find a genuine cross-spoke pattern - not something specific to just one project - that the current global standards don't already cover, and to propose it as the full updated text of `universal_lessons.md` and/or `north_star_framework.md`. A recurring negative-feedback signal across spokes counts as real evidence here too, not just repeated findings.
4. Same validation discipline as `autonomous_agent.js`: a `has_proposal` flag, and no action taken unless the response is well-formed with real reasoning and at least one patch.
5. Same `DRY_RUN_MODE` rail: dry-run reports the proposal in the response without acting on it.
6. In live mode, it **never pushes directly to `main`** - it opens a new branch, commits the proposed file(s), and opens a PR against this repo with the AI's reasoning as the PR body. A human still has to review and merge it, same as any other PR.

Because this is a proposal mechanism (a PR someone reviews), not an unattended action, it's lower-stakes than issue creation - but it still shouldn't run live before Sprint 0's safety rails have been verified working, since it shares the same `DRY_RUN_MODE` switch and the same underlying AI call.

**Shared, opt-in, cross-organization learning pool.** The per-tenant pass above deliberately never mixes tenants - but that also means a pattern that only shows up across *different* customers' repos (not just across one customer's own multiple spokes) would never surface. A repo can opt into a second, additional pass by setting `"shareLearnings": true` on its `spokes.json` entry - **a per-repo choice, not a per-tenant one**, since whether a codebase's patterns are safe to pool into a wider corpus is a property of that codebase, not of who's paying for it. A repo that opts in still also runs in its own tenant's private pass above; this is purely additive.

- **Every opted-in repo across every tenant is pooled into one shared pass**, regardless of which tenant owns it - each one's `lessons.md`/decision-log data is still fetched using *its own* resolved tenant credential, exactly like the per-tenant pass, just inside one aggregating loop instead of one tenant-scoped loop.
- **Anonymized labels, not real names, inside the prompt.** Each opted-in repo appears to the AI as `Contributor 1`, `Contributor 2`, etc. - never its real owner/repo/tenant name - so nothing organization-identifying can get echoed back into the merged, hub-global `universal_lessons.md`/`north_star_framework.md` text. (There's no actual source code in this prompt to begin with - same as the per-tenant pass, it's built from `lessons.md` text and decision-log summaries only.)
- **A structural evidence bar, checked in code, never just trusted from the model's own claim.** The model must cite exactly which anonymized contributors its proposal is evidenced by (`supporting_contributors`); the code looks those labels up against the real spokes behind them and only accepts the proposal if it clears **2 distinct tenants, or 3 distinct repos within one tenant** if it hasn't crossed a tenant boundary. A response that says `has_proposal: true` but whose *cited* evidence doesn't actually meet that bar is rejected outright - the same "validate the claim, don't trust the free-text self-report" discipline already applied to `has_findings`/`has_proposal` everywhere else in this project, applied here specifically against the risk of the model hallucinating a "cross-organization pattern" that isn't real.
- **The human reviewer still sees real names.** The anonymization boundary is the model's own reasoning, not the PR: an accepted proposal's PR body is built from the code-side label mapping (never from model output) and names the real contributing repos/tenants, since the hub operator reviewing/merging it already has full visibility into `spokes.json`/`tenants.json` - hiding names from them wouldn't add privacy, only make the PR harder to sanity-check.
- Same rails as the per-tenant pass otherwise: `DRY_RUN_MODE` reports the proposal without acting, live mode opens a PR (title `Recursive Learning: proposed cross-organization pattern (shared pool)`) against the hub's own default branch, never a direct commit.

### Maintenance (`scripts/prune-logs.js`)

Runs weekly (`.github/workflows/prune-logs.yml`, Sunday) as a plain GitHub Actions script - no AI, no Vercel call. For every spoke in `spokes.json`, it partitions `ai_decision_log.json` entries older than `RETENTION_DAYS` (default 90) out into `ai_decision_log_archive.json`, then truncates the live log to what's left. The archive write always happens **before** the live-log truncation, so a failure between the two leaves an entry duplicated in both files rather than lost - safe to just re-run.

This is a plain Node script, not a Vercel endpoint, because it doesn't need the AI model or anything Vercel-specific - only a GitHub token with cross-repo write access. That means it needs its own copy of that token as a **GitHub Actions secret on this repo** (`GLOBAL_GITHUB_TOKEN`) - the Vercel env var of the same name isn't visible to an Actions runner. Supports `workflow_dispatch` with a `dry_run` input that reports what would move without writing anything.

### Health Reporting (`scripts/health-report.js`)

Runs weekly (`.github/workflows/health-report.yml`) as a plain GitHub Actions script - no AI, no Vercel call. Unlike the `health-report.yml` this repo used to have (deleted for being a non-functional copy-paste of `tso`'s own health tooling - referenced files and a Prisma setup that don't exist here), this one reports on the **hub/swarm's own health**, not any one spoke's codebase:

- For every spoke registered in `spokes.json` (if none are registered yet, the report says so and stops there), counts issues the hub has filed (`cto-hub-auto` label) in the last 7 days, and pulls that spoke's `ai_decision_log.json` entries from the same window.
- Computes a skip rate (real findings vs. everything skipped) and a per-outcome breakdown per spoke.
- Infers each spoke's live/dry-run status **from the observed decision-log outcomes**, since a GitHub Actions runner has no way to read the hub's Vercel environment variables directly - if the log shows a `created` entry this window, it reports "live"; if only `dry_run_would_create` entries, it reports "dry-run"; if nothing at all, it says so distinctly from "no findings" (that usually means the spoke's heartbeat isn't actually running).
- Publishes the report as a single **pinned issue on this repo**, tagged `mothership-health-report`, updated in place on every run rather than creating a new one each time - a deliberate callback to the disaster this whole system exists to avoid repeating.

Like `prune-logs.js`, this needs its own `GLOBAL_GITHUB_TOKEN` Actions secret (see setup below, step 7) - the Vercel env var of the same name isn't visible to an Actions runner.

### Health Dashboard (`dashboard/`)

A standalone, installable PWA - additive, not part of the request-handling path (a PWA can't receive GitHub Actions' POST mid-cron-job the way the two endpoints above do). Since Mothership and every spoke are public repos, `dashboard/app.js` reads `spokes.json` and each spoke's `ai_decision_log.json`/issue list straight from `api.github.com` client-side and renders the same metrics `health-report.js`'s `buildReportForSpoke` already computes - skip rate, per-outcome breakdown, inferred live/dry-run status - live in a browser instead of waiting for the weekly pinned issue.

No backend of its own: `manifest.json`/`sw.js` make it installable (add-to-home-screen). GitHub Pages (Settings → Pages, source set to the `dashboard/` folder or a `gh-pages` branch) is a convenient free option, but **the real requirement is much smaller than "use GitHub Pages" implies** - any plain static HTTP(S) server works, including one running entirely on your own machine (`cd dashboard && python3 -m http.server`, or equivalent). There's no build step and nothing server-side to run.

**What genuinely doesn't work: opening `dashboard/index.html` directly as a `file://` URL** (i.e. zero hosting at all, not even a local server) - confirmed by testing it in a real browser against the real GitHub API: `file://` pages send `Origin: null`, and `api.github.com` rejects that origin via CORS (`No 'Access-Control-Allow-Origin' header is present`), so no live data can ever load that way. This is GitHub's own API policy, not something fixable from this repo's side. The service worker also refuses to register under `file://` (browsers require a "secure context" - `https://` or `localhost` - which `file://` doesn't qualify as), so installability and offline app-shell caching are unavailable too. The bar to clear is genuinely low (any real HTTP origin), just not zero.

**Known, disclosed limitation:** unauthenticated GitHub API calls are capped at 60 requests/hour per IP. Fine for a single-operator dashboard opened a few times a day; would need a caching proxy (the `gas/` deployment above could serve this read-only, authenticated, with a much higher cap) if usage ever grows past that.

**Offline behavior:** two separate caches exist for two separate purposes. A short-lived (45s) `sessionStorage` cache exists purely to avoid burning the request budget above on a reopened tab or an accidental double-refresh - it forgets everything when the browser session ends. A second, durable `localStorage` cache (no expiry) exists specifically so a genuinely offline load - no network at all, possibly a brand-new tab days after the page was last online - still shows real "last known status as of 3 days ago" data per spoke instead of a bare error, labeled "offline - last seen ..." and rendered in a neutral color (never the status's original color, since a days-old "live" shouldn't read as "currently fine" at a glance). If a spoke has never successfully loaded on this device at all, there's nothing to fall back to and the plain failure message still shows.

**Resilience:** every GitHub API call has a 15-second timeout - a hung request (flaky network, captive portal) surfaces as a distinct "timed out" status instead of leaving the page stuck with the Refresh button disabled forever. A malformed `spokes.json` entry (a stray `null`, an object missing `owner`/`repo`) is filtered out rather than crashing the page, and each spoke's data loads and fails independently - one spoke's problem never blocks another spoke's row from appearing, and rows stream in as each resolves rather than all waiting on the slowest.

**Staying current without asking:** the page refetches automatically when you switch back to its tab, or when the browser reports connectivity restored after being offline - both deliberately budget-respecting (only fetches what's actually gone stale per spoke, reusing the same cache above) rather than a blind polling interval that would need re-tuning every time a spoke is added. `document.title` picks up a `⚠` marker when any spoke has a genuine problem (never for the disclosed rate-limited state) so a backgrounded or pinned tab is still useful at a glance, and both the "Updated ..." timestamp and a rate-limited spoke's "retry in ..." countdown tick down live instead of freezing between loads. Press `r`, or click Refresh, to force an immediate check regardless of cache freshness.

**Hub Health:** a second panel, above the per-spoke one, answering a different question - not "are the spokes okay," but "is the swarm's own machinery actually running." Reads this repo's own Actions run history for its four scheduled workflows (`self-reflect`, `health-report`, `recursive-learning`, `prune-logs` - `ci.yml` is left out on purpose, it's a PR/push code-quality gate, not a scheduled operational signal) via the same unauthenticated `api.github.com` access as everything else here, with the same caching/offline-fallback treatment. Statuses: `healthy` (last run succeeded), `failing` (completed with any other outcome), `never run`, `in progress`, plus the same `rate-limited`/`couldn't load`/`timed out` states the spoke panel already has - worst-first, same as the spoke table.

### Failure Alerting (`.github/actions/notify-on-failure/`)

The class of gap `doctor.js` and the dashboard's Hub Health panel both exist to close - a scheduled workflow failing silently with nobody watching (`health-report.yml`'s 401 sat undetected for 5 straight runs; `recursive-learning.yml` never ran once) - is still only caught by someone actually opening the Actions tab or the dashboard. A shared composite action (referenced by path, not published separately) posts a Slack-compatible webhook message the moment a job it's wired into actually fails, as that job's last step with `if: failure()`: `self-reflect.yml`, `recursive-learning.yml`, `prune-logs.yml`, `collect-issue-feedback.yml`, and `health-report.yml` all call it today.

Opt-in and silent by design: an unset `ALERT_WEBHOOK_URL` repository secret is a no-op (the step logs that alerting isn't configured and exits 0) - it never turns a missing secret into a second failure on top of whatever actually went wrong. Set `ALERT_WEBHOOK_URL` under this repository's own Settings → Secrets and variables → Actions to a Slack incoming webhook URL to enable it (a Discord webhook also works if you append `/slack` to its URL - Discord's own compatibility mode for this exact payload shape). The notification itself failing to send (e.g. a bad/expired webhook URL) only logs a warning - it never masks or replaces the real job failure that triggered it.

`scripts/health-report.js`'s CLI wrapper additionally treats a genuine per-spoke read failure (a real GitHub API error, not just a quiet "no findings this window") as a job failure via its exit code, specifically so this alerting actually fires for that class of problem instead of silently succeeding with a partial report.

### Pre-Flight Doctor Check (`scripts/doctor.js`)

Checks exactly the class of bug found live in this repo's own history: a `GLOBAL_GITHUB_TOKEN` that's invalid or expired (`health-report.yml`'s 401, undetected through 5 straight runs before anyone noticed), and a spoke whose `call-hub.yml` has no hub-URL secret set at all (`thinkos-server`/`tais` failing 100+ scheduled runs on an unset `VERCEL_URL`) - both checkable in under a second per repo.

Validates: `GLOBAL_GITHUB_TOKEN` against `GET /rate_limit`, `AI_API_KEY`/`AI_BASE_URL` against `GET /models` (same low-cost validation as the Apps Script settings page above), and per registered spoke - the repo is reachable, `call-hub.yml` exists, and at least one of `VERCEL_URL`/`APPS_SCRIPT_URL` appears in that repo's Actions secret names.

**Known, disclosed limitation:** GitHub never exposes a secret's *value* via any API, only its name and timestamps - the secret check above can only confirm something with the right name exists. It would have caught a fully-unset `VERCEL_URL`, but not one set to an empty string or a wrong value. That's a narrower net than "the exact incident," stated as such rather than papered over.

**Deliberately `workflow_dispatch`-only, no schedule** - this project's own investigation into its health started because scheduled workflows were failing silently with nobody watching; adding another scheduled job here would risk the identical failure mode this tool exists to catch. Run it manually when setting up a new spoke, rotating a credential, or troubleshooting.

### Continuous Deployment (`.github/workflows/deploy-vercel.yml`)

Before this workflow, nothing in this repo ever auto-deployed anywhere - `api/` only ran if a human clicked "Deploy" in the Vercel dashboard. A push to `main` now deploys to production automatically; a pull request targeting `main` deploys a preview instead - which **is** this project's staging environment for the Vercel backend (a real, isolated deployment scoped to that PR, replaced on every push, rather than a separate long-lived environment to provision and keep in sync). Both paths run the same steps: `vercel pull` → `vercel build` → `vercel deploy --prebuilt`, then a smoke test (`scripts/smoke-test.js`) against a dedicated, credential-free `/api/health` route (`api/health.js` - deliberately never one of the AI-calling endpoints, which need real credentials and could have side effects) - checking both a healthy response and that the deployed response's `commit` field (Vercel auto-populates `VERCEL_GIT_COMMIT_SHA`) matches the commit that was actually pushed, so a stale/failed deploy can't silently pass as successful. A preview deploy's URL is posted back as a PR comment.

Needs three new repository secrets beyond the ones in step 2 below - see [Setup Instructions](#setup-instructions) step 8.

**Not live-verified end-to-end:** no Vercel account/token is reachable from this environment, so the `vercel` CLI sequence above has never actually run for real here. It follows Vercel's own documented CI recipe, but is flagged honestly as "should work per the documented interface," not "confirmed working" - the same disclosure standard applied to every other integration this project can't reach directly (e.g. the Stripe webhook's own smoke-test flag in `api/stripe_webhook.js`).

**Known, disclosed limitation:** a pull request from a fork doesn't receive repository secrets (a GitHub security restriction, not a bug here), so preview deploys only work for PRs from branches within this same repository - fine for this project's current single-operator model.

**Failure alerting is wired in for the production path only** - a failing preview deploy is already visible to whoever opened the PR, directly as a failing check; the silent-failure risk `ALERT_WEBHOOK_URL` (see [Failure Alerting](#failure-alerting-githubactionsnotify-on-failure) above) exists to close is specifically the unattended, post-merge production path.

## Setup Instructions

### 1. Deploy to Vercel
- Push this repository to GitHub
- Import the project into Vercel
- Vercel will automatically detect and deploy the `api/` folder as a serverless function

### 2. Configure Environment Variables in Vercel
Go to Vercel Project Settings → Environment Variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `AI_API_KEY` | Your NVIDIA NIM or API lab key | Authentication for AI model access |
| `AI_MODEL` | e.g., `nvidia/nemotron-3-nano-30b-a3b-bf16` | The AI model to use |
| `AI_BASE_URL` | e.g., `https://integrate.api.nvidia.com/v1` | API endpoint for the model provider |
| `GLOBAL_GITHUB_TOKEN` | GitHub Personal Access Token with `repo` scope | Enables the hub to access all spoke repositories |
| `DRY_RUN_MODE` | `true` (default) or `false` | Optional. While `true`, well-formed findings are reported but never filed as issues. See [Safety Rails](#safety-rails). |
| `RATE_CAP_PER_REPO_PER_DAY` | e.g., `3` (default) | Optional. Hard cap on issues filed per repo per UTC day once dry-run is off. |

### 3. Configure Spoke Repositories
For each project you want to manage:

1. Run the `setup_spoke.py` script (or manually create):
   - `NORTH_STAR.md` - Project-specific value proposition
   - `lessons.md` - Local lessons learned
   - `ai_decision_log.json` - Initialize as empty array `[]`
   - `.github/workflows/call-hub.yml` - GitHub Actions heartbeat

2. In GitHub Repository Settings → Secrets and variables → Actions:
   - Add `VERCEL_URL`: Your deployed Vercel application URL (`setup_spoke.py` prints the exact value to use as its last step)
   - Add `VERCEL_BYPASS_TOKEN`: only needed if the hub's Vercel deployment has Deployment Protection enabled (see [Enable Hub Self-Analysis](#5-optional-enable-hub-self-analysis) below for where this comes from)
   - Add `TENANT_CALLER_KEY`: only needed if the hub registers this spoke under a tenant that has a `callerKeyRef` configured (see [Multi-Tenancy](#multi-tenancy-tenantsjson)) - leave unset for a single-tenant/default setup.

3. Add the spoke to this hub's own `spokes.json` (`{ "owner", "repo", "tenantId", "addedAt", "status" }` - `tenantId` defaults to `"default"` if omitted) so the [Recursive Learning Loop](#recursive-learning-loop-apirecursive_learningjs) includes it in its monthly cross-spoke pattern search. This step is only needed for that monthly job - the regular per-commit heartbeat (steps 1-2 above) works without it. If you're onboarding this spoke under a real, distinct tenant, also add (or update) the matching entry in `tenants.json` - see [Multi-Tenancy](#multi-tenancy-tenantsjson).

### 4. Test the Connection
- Commit and push changes to a spoke repository
- Manually trigger the "Ping CTO Hub" workflow from the Actions tab
- Verify that the hub receives the request and creates a GitHub issue in the spoke repo (or returns a "Skipped" status if there's nothing to report - that's expected, not a failure)

### 5. (Optional) Enable Hub Self-Analysis
This repository's own `.github/workflows/self-reflect.yml` pings the hub's `/api/autonomous_agent` endpoint against itself (`mode: refactor`) weekly. It needs two repository secrets that aren't part of the Vercel setup above - without them, the workflow runs but the request either has nowhere to go or gets rejected before it reaches the handler:

| Secret | Value |
|--------|-------|
| `HUB_VERCEL_URL` | This hub's deployed Vercel URL (same value as `VERCEL_URL` on spokes) |
| `VERCEL_BYPASS_TOKEN` | A "Protection Bypass for Automation" secret from the Vercel dashboard (Project Settings → Deployment Protection) - required if the deployment has Vercel Deployment Protection enabled, which returns a 403 to any caller that doesn't send it |

Set these under this repository's own Settings → Secrets and variables → Actions. (The hub authenticates to GitHub server-side using its own `GLOBAL_GITHUB_TOKEN` Vercel env var - the workflow doesn't need to send a GitHub token itself.)

### 6. Enable Maintenance (Log Pruning)

Unlike self-analysis and recursive learning, `.github/workflows/prune-logs.yml` doesn't call the Vercel deployment at all - it's a plain Actions script that talks to GitHub directly. It needs its own repository secret:

| Secret | Value |
|--------|-------|
| `GLOBAL_GITHUB_TOKEN` | The same GitHub Personal Access Token used as the Vercel env var of the same name - an Actions runner can't read Vercel's environment, so it needs its own copy here |

Set this under this repository's own Settings → Secrets and variables → Actions.

### 7. Enable Health Reporting

Unlike self-analysis, `.github/workflows/health-report.yml` doesn't call the Vercel deployment at all either - it's a plain Actions script that talks to GitHub directly, and needs the exact same `GLOBAL_GITHUB_TOKEN` secret as step 6 above. If you've already set that up for log pruning, health reporting works with no further setup.

### 8. Enable Continuous Deployment (Vercel)

`.github/workflows/deploy-vercel.yml` (see [Continuous Deployment](#continuous-deployment-githubworkflowsdeploy-vercelyml) above) needs three repository secrets beyond step 2's Vercel env vars - these authenticate the Vercel CLI itself, not the running application:

| Secret | Value |
|--------|-------|
| `VERCEL_TOKEN` | A personal access token from Vercel's Account Settings → Tokens |
| `VERCEL_ORG_ID` | Found in the linked project's `.vercel/project.json` after running `vercel link` locally once, or in Vercel Project Settings → General |
| `VERCEL_PROJECT_ID` | Same source as `VERCEL_ORG_ID` |

`VERCEL_BYPASS_TOKEN` (step 5 above) is reused automatically by the smoke-test step if the deployment has Deployment Protection enabled - no separate secret needed for that. Once these three are set, a push to `main` deploys to production and a pull request targeting `main` gets its own preview deploy - no further action needed.

### Alternative: Deploy Without Vercel (Google Apps Script)

Everything in steps 1-2 above (the two AI-calling endpoints and their config) can run on Google Apps Script instead of Vercel, using the `gas/` directory instead of `api/`. The two most common reasons to prefer this: you don't have (or don't want) a Vercel account, or your Vercel deployment sits behind Deployment Protection and you can't get a bypass token - Apps Script Web Apps have no equivalent forced auth wall, so there's nothing to bypass.

`gas/` is a faithful, independently-tested port of `api/autonomous_agent.js` and `api/recursive_learning.js` - same validation, same dry-run/rate-cap rails, same decision-log dedup - adapted for three real platform differences (documented in `gas/autonomous_agent.js`'s header comment): no `@octokit/rest` (a hand-rolled `github.js` REST client replaces it), no Node `fetch`/Promises (Apps Script's `UrlFetchApp` is synchronous, so this code is too), and no local filesystem (the hub's own `universal_lessons.md`/`north_star_framework.md`/`hub_lessons.md` are fetched from this repo via the GitHub API instead of read off disk). Apps Script also has no `import`/`export` - every file in a project shares one global scope - so these files are plain global functions, not ES modules; `gas/constants.js` exists specifically so shared identifiers are declared exactly once instead of colliding.

**Setup:**

1. Install [`clasp`](https://github.com/google/clasp), Google's official CLI for Apps Script, and run `clasp login` (opens a browser to authorize your Google account).
2. From this repo: `cd gas && clasp create --title "Mothership Hub" --type webapp --rootDir .` - this creates a new Apps Script project under your account and writes a real `gas/.clasp.json` (gitignored - it's a scriptId tied to your account, not shared code; `gas/.clasp.json.example` is the checked-in template).
3. `clasp push` to upload `gas/*.js` and `gas/appsscript.json`.
4. In the Apps Script IDE (`clasp open`) → Project Settings → Script Properties, set `ADMIN_SETTINGS_TOKEN` (a long random string, not a memorable password) plus the same six config values as step 2's Vercel env vars: `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`, `GLOBAL_GITHUB_TOKEN`, `DRY_RUN_MODE`, `RATE_CAP_PER_REPO_PER_DAY`. Same names, same defaults-fail-safe behavior.
5. Deploy → New deployment → type **Web app** → Execute as **Me** → Who has access **Anyone** → Deploy. Copy the resulting Web App URL.
6. On each spoke (instead of step 3's `VERCEL_URL`/`VERCEL_BYPASS_TOKEN`): set an `APPS_SCRIPT_URL` secret to that URL, and drop `VERCEL_BYPASS_TOKEN` entirely - nothing replaces it, because nothing needs to. Apps Script Web Apps expose one URL for both endpoints, not one route per file the way Vercel's `api/*.js` did - append `?endpoint=autonomous_agent` or `?endpoint=recursive_learning` to the deployed URL to pick one (omitting it defaults to `autonomous_agent`, matching Vercel's original default route). Ready-to-copy versions of `call-hub.yml`/`self-reflect.yml`/`recursive-learning.yml` targeting `APPS_SCRIPT_URL` this way live in `gas/*.apps-script.example.yml` - deliberately kept outside `.github/workflows/` so GitHub never tries to run them; copy the one you need over its Vercel-targeting counterpart once you have a real URL from step 5.

**Rotating config later without reopening the Apps Script IDE:** once step 4's `ADMIN_SETTINGS_TOKEN` is set, visit `<your Web App URL>?endpoint=settings&token=<that value>` for a small settings page (`gas/settings.js`) that reads/writes the same six config values plus `HUB_GITHUB_OWNER`/`HUB_GITHUB_REPO`. This doesn't remove step 4 - `ADMIN_SETTINGS_TOKEN` itself still has to be bootstrapped via Script Properties first, and it's the one value this page will never show or let you change, so a leaked page token can't mint its own replacement. Secret fields (`AI_API_KEY`, `GLOBAL_GITHUB_TOKEN`) render masked and start blank - leaving one blank and saving keeps its current value, it never gets cleared. A wrong or missing token gets a generic response either way, so probing the URL doesn't confirm the page even exists.

**Live diagnostics, not just a form:** the page also validates `GLOBAL_GITHUB_TOKEN` and `AI_API_KEY` against the real APIs the moment it loads (a real, cheap call - `GET /rate_limit` for GitHub, `GET /models` for the AI provider) and shows a green "✓ valid" or red "✗ <reason>" next to each field. This exists because a bad `GLOBAL_GITHUB_TOKEN` sat undetected through 5 straight failed `health-report.yml` runs before anyone noticed - opening this page now catches that the moment you open it, instead of after N silent failures.

**Verified locally, not yet live:** `scripts/dev-test-gas-*.mjs` cover the ported decision logic, the GitHub REST mapping, `Code.js`'s request routing, and the settings page's token gate/masking/allowlist behavior against hand-rolled fakes - the same testing discipline as everything else in this repo, and they already caught one real defect (`autonomous_agent.js`/`recursive_learning.js` both declaring the same constant, a silent `SyntaxError` the moment both files shared one real Apps Script project's scope) before any real deployment existed. What hasn't happened yet is an actual `clasp push` + live dispatch against a real Apps Script project - do that and confirm `dryRun: true` responses before pointing any spoke's schedule at it.

**Continuous deployment (optional):** `.github/workflows/deploy-apps-script.yml` mirrors `deploy-vercel.yml` above for this backend - a push to `main` updates a production deployment, a pull request targeting `main` updates a separate, persistent staging deployment, both smoke-tested against `?endpoint=health` before being considered successful. Unlike Vercel, Apps Script has no concept of "redeploy the same URL automatically" - `clasp deploy -i <deploymentId>` updates a *specific, already-existing* deployment's code in place, which is what keeps its Web App URL stable across every CD run. That means two deployments need to exist up front (repeat step 5 above twice - once for production, once for staging - and note each one's deployment ID, visible in the Apps Script IDE's Deploy → Manage deployments screen, or via `clasp deployments`), plus these secrets on this repository:

| Secret | Value |
|--------|-------|
| `CLASPRC_JSON` | Base64-encoded contents of `clasp login`'s own credential file (run `clasp login` once locally, then `base64 -i ~/.clasprc.json` or `base64 -i ~/.config/clasp/.clasprc.json` depending on your clasp version - see the workflow file's header comment for why it's written to both paths) |
| `GAS_SCRIPT_ID` | The same scriptId as `gas/.clasp.json` (step 2 above) |
| `GAS_PROD_DEPLOYMENT_ID` | The production deployment's ID from step 5 |
| `GAS_STAGING_DEPLOYMENT_ID` | A second, separate deployment's ID (create it the same way as step 5, once, by hand) |
| `GAS_WEB_APP_URL` | The production deployment's Web App URL |
| `GAS_STAGING_WEB_APP_URL` | The staging deployment's Web App URL |

**Not live-verified end-to-end** - no Google account/clasp credential is reachable from this environment, same disclosure as `deploy-vercel.yml`. A pull_request from a fork doesn't receive repository secrets either, so staging deploys only work for PRs from branches within this same repository.

**Not removed:** `api/*.js` and the Vercel path stay in this repo untouched. Dropping Vercel entirely - deleting `api/`, `setup_hub.py`'s Vercel-flavored generation, the Vercel-specific docs above - is a deliberate follow-up once the Apps Script path has actually been verified live, not bundled into adding it.

## How It Works

### The Heartbeat Mechanism
Each spoke repository contains a GitHub Action (`.github/workflows/call-hub.yml`, generated by `setup_spoke.py`) that:
- Triggers every 30 minutes (`cron: '*/30 * * * *'`) with `mode: debug`
- Triggers every Sunday at midnight (`cron: '0 0 * * 0'`) with `mode: refactor`
- Triggers every Wednesday at noon (`cron: '0 12 * * 3'`) with `mode: hunt`
- Sends a POST request to the hub's Vercel endpoint (read from the `VERCEL_URL` secret) with the repository owner, name, and mode

A `Determine Mode` step computes the mode from `github.event.schedule` via a shell `case` statement (a step output, not an inline workflow expression - inline expressions for anything beyond a trivial check are exactly the kind of thing that breaks in confusing ways under GitHub Actions' expression syntax). A manual `workflow_dispatch` run (where `github.event.schedule` is unset) falls through the `case`'s default branch to `debug`.

### Agent Decision Flow
When the hub receives a request:
1. Loads global context from its own files (universal lessons, North Star, hub lessons)
2. Fetches local context (`lessons.md`, `NORTH_STAR.md`) from the target spoke repository via GitHub API
3. Determines the spoke's latest commit sha, then checks `ai_decision_log.json` for a prior decision on this exact commit+mode - if found (and it wasn't a failed AI call), replays that outcome and stops here, skipping both the diff fetch and the AI call
4. Fetches the diff of the spoke's latest commit. If there's no usable diff, the request stops here with a "Skipped" response - no AI call, no issue - and logs `no_diff_skip`.
5. Constructs a prompt combining the role/mode, global standards, local context, the last few logged decisions, and the actual diff
6. Calls the configured AI model with strict JSON response requirements, including a `has_findings` flag
7. Validates the response: invalid JSON, `has_findings: false`, or a response missing required fields all result in a "Skipped" response, logged as `invalid_ai_response` or `no_findings`
8. If `DRY_RUN_MODE` is on, a valid response with real findings is reported back as `DryRunFinding`, logged as `dry_run_would_create`, and stops here - no issue is filed
9. Otherwise, checks the per-repo/per-day rate cap (`RATE_CAP_PER_REPO_PER_DAY`) - if today's count for this repo is already at the cap, the request stops here with a "Skipped" response, logged as `rate_capped`
10. Only a valid response with real findings, with dry-run off and under the day's cap, gets posted as a GitHub issue (tagged `cto-hub-auto`) with value impact analysis and a code patch, logged as `created` with the issue's URL

### Sharing Lessons Across Spokes
Every spoke's heartbeat picks up whatever `universal_lessons.md`/`north_star_framework.md` currently say, so a manual edit to those files here takes effect for every spoke on its next run - that part has always been true.

On top of that, `api/recursive_learning.js` runs monthly and looks across every spoke registered in `spokes.json` for a genuine cross-project pattern the current global standards don't cover, proposing an update as a PR against this repo (see [Recursive Learning Loop](#recursive-learning-loop-apirecursive_learningjs)). It never merges anything itself - a human still decides whether the proposal is right and merges the PR (or doesn't). "Automatic" here means the aggregation and drafting, not the decision to actually change the global standards.

### Registered Spokes (`spokes.json`)

This repo's root `spokes.json` lists the spokes this hub knows about (`{ owner, repo, tenantId, addedAt, status, shareLearnings? }`), used by cross-spoke tooling that needs to iterate every connected project rather than operate on just one. As of this writing: `tso`, `thinkos-server`, and `tais` - all three now have the standard spoke contract (`NORTH_STAR.md`, `lessons.md`, `ai_decision_log.json`, `.github/workflows/call-hub.yml`) and are registered here, all under `tenantId: "default"` (see [Multi-Tenancy](#multi-tenancy-tenantsjson)); none has opted into the shared learning pool (`shareLearnings`) yet. Being registered doesn't change how the per-commit heartbeat works (that only needs the spoke's own `VERCEL_URL` secret) - it's specifically for tooling that operates across the whole portfolio at once.

## Testing & CI

Every piece of decision logic in `api/` and `scripts/` is dependency-injected (an optional `{ octokit, fetchImpl, dryRunOverride }` for the two AI-calling endpoints; similarly for the plain scripts) specifically so it can be driven by a local mock harness instead of hitting GitHub or the AI API for real:

- `scripts/dev-test-handler.mjs`, `dev-test-recursive-learning.mjs`, `dev-test-prune-logs.mjs`, `dev-test-health-report.mjs` - one per capability, run with `node scripts/dev-test-*.mjs` or all at once via `npm test`.
- `.github/workflows/ci.yml` runs that full suite, a `python3 -m py_compile` check on both installer scripts, and a scratch-directory diff proving `setup_hub.py`'s generated output still matches this repo's real files - on every pull request, every push to `main`, and on demand. No secrets required: every harness runs against a fully mocked GitHub/AI client, so it's safe even on a PR opened from a fork.
- A separate `docs-check` job in the same workflow fails a pull request that adds a new file under `api/`, `gas/`, `dashboard/`, or `.github/workflows/` without also touching `README.md` in the same diff - the automated version of the "is this documented?" check that found the gaps this section itself is an answer to. A `[skip-docs-check]` marker in the PR title or body is the escape hatch for genuine non-capability additions.

Before this existed, verification was a manual sweep run by hand after every change - several real defects were found sitting in code that already had a passing test, which is exactly the gap automatic enforcement closes: a test only guards the future if something re-runs it on every subsequent change, not just the one where it was written.

## Values Alignment

This system is designed to continuously improve toward producing:
- **Accurate Code**: Through proactive debugging, hunting for silent errors, and value-aligned decision making
- **Efficient Code**: Through weekly refactoring that eliminates Frankenstein code and reduces complexity
- **User Value**: Through North Star alignment that prioritizes emotional UX outcomes over technical perfection
- **White Glove Service**: Through forgiving design principles and invisible complexity that delights users

Each project in the portfolio benefits from the collective intelligence of the swarm while maintaining its unique characteristics through local North Star and lessons files.
