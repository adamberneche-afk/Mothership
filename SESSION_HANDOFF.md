# Session Handoff — 2026-09-06

*Last updated 2026-09-21 (CI/CD floor session). The dated update notes below are cumulative — read them in order; the original 09-06 body is kept as the record of what prompted all of it, not as current status.*

Written for whoever (human or a fresh Claude Code session) picks this up next. Read the "Start here" section first — everything else is context for *why*, not things to do before that.

> **Update (2026-09-14):** A later session re-verified this handoff's entire open-items list, plus every finding in KOS Audit Docket II, against then-current code across every repo in the account, then ran a scoped one-item sprint against Mothership specifically. **Items 5 and 8 below have since closed** — marked inline. Item 5 closed incidentally, as a side effect of an unrelated lock-hardening commit in kos-personal. Item 8 closed in two steps: Argoloth's half closed incidentally too (found mid-feature-work), but **Mothership's own copy was fixed deliberately, as its own scoped sprint** — the account's first case of an item actually getting pulled off this list on purpose rather than by accident. Every other item, including item 1, was re-confirmed exactly as open as described below. Full detail: [The Pivot Ledger](https://claude.ai/code/artifact/324d94db-64b1-4e3d-904f-16de245a2f79)'s "Auditing the audit" section — leaving this table's original claims uncorrected here would repeat the exact mistake that section exists to catch.

> **Update (2026-09-20):** Two further sessions landed real work. **Items 3, 6 (half), and 7 have since closed**, and item 1 closed on 2026-09-18 — all marked inline below. New in this round: the KOS inference service was stood up on real infrastructure for the first time, which found five defects no test suite had caught; Mothership's own `doPost()` auth gap was found and fixed; and the dependabot backlog was cleared. **Three new items (11-13) are appended to the table** — 11 and 12 are things only the repo owner can do; 13 was found and closed the same day. The "Start here" section has been rewritten: leader-hub's `doPost()` is fixed, so it is no longer the top item.

> **Update (2026-09-21):** A session working through KOS's Open Items list (Flow 2 prompt-injection fix, SCR confirm/override, the inference service's Drive scope, leader-hub's Sales Log escaping — all merged: KOS PRs #23-25, #27) also got a real answer on "Start here" item 3 below, straight from the repo owner: **keep Vercel as an open deployment option, but do not deploy into it until there's a concrete reason to expand the account's surface area.** PR #33 stays open, unmerged — it's the record of that option, not a queued task. See item 3's own entry for what this does and doesn't resolve.

> **Update (2026-09-21, later session):** The CI/CD floor was specified, completed on the hub, and distributed. It is now **ten checks**, written down in [`CICD_FLOOR.md`](CICD_FLOOR.md); Mothership has all ten and every one has been proven by watching it go red. Checks 6–9 went to Argoloth; check 10 went to Argoloth, KOS and TSO. **Open item 9 has therefore moved, not closed** — and Tais is out of scope for good (archived). The consequential part is not the checks, though: **check 10's first real run proved that "Start here" item 1's last bullet was never done.** `APPS_SCRIPT_URL` and `TENANT_CALLER_KEY` are unset in all three repos, and the spoke heartbeats built on them have failed **33 consecutive runs with zero successes**. That had been sitting in this file as a one-line to-do since 2026-09-06. See "What the 2026-09-21 floor session did" below.

---

## Start here: manual steps only the repo owner can do

Nothing below is a technical blocker — all of it is code that is merged and waiting on a credential or a console click.

**1. Mothership's live Apps Script hub is running code that predates its own auth fix.** PR #43 added a caller-key gate; the deployed script has not been updated. Until these are done, the live `/exec` URL is still the unauthenticated one described in the 2026-09-18 Pivot Ledger entry:
   - Set Script Property `DEFAULT_TENANT_CALLER_KEY` on the hub's Apps Script project.
   - `clasp push`, then `clasp deploy -i <existing deployment id> -V <n>` — reusing the deployment id is what preserves the `/exec` URL and its access setting. A bare `clasp deploy` creates a *new* deployment defaulting to "Only myself".
   - Add repo secrets `APPS_SCRIPT_URL` and `TENANT_CALLER_KEY` to Mothership, KOS, and Argoloth.
   - The generated key was handed over in chat on 2026-09-19. It is deliberately not written down in any repo.

> ⚠️ **This bullet is now measured, not assumed (2026-09-21).** `secrets-doctor` (floor check 10) was dispatched against all four repos and reports both secrets **unset in Mothership, KOS and Argoloth** — the exact three named above. The cost is not hypothetical:
>
> | workflow | repo | runs | successes |
> |---|---|---|---|
> | `call-hub.yml` | Argoloth | 16 (since 2026-09-19) | **0** |
> | `call-hub.yml` | KOS | 17 (since 2026-09-19) | **0** |
> | `self-reflect.yml` | Mothership | green to 2026-09-13 | failing since 2026-09-20 |
>
> Every spoke run dies on `curl: (3) URL rejected: No host part in the URL` — `APPS_SCRIPT_URL` expands to nothing, so the heartbeat curls a bare `?endpoint=autonomous_agent`. Both spokes' heartbeats have **never once worked**. `recursive-learning.yml` is monthly (`0 0 1 * *`), last succeeded 2026-09-01, and will fail on its next run for the same reason. This is the single highest-value item in this file: it is two console clicks per repo, and until it is done, the live hub this account spent three sessions standing up has no spoke actually reaching it.

**2. The KOS inference service on Render needs one env var before it will boot.** Everything else is set.
   - Render dashboard -> `kos-inference-service` -> Environment -> **Add from Database** -> `kos-inference-db` -> **Internal Database URL**. Set Health Check Path to `/health` while there.
   - Then it boots but is not yet functional: it still needs `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`/`_SECRET`/`_REDIRECT_URI` (-> `https://kos-inference-service.onrender.com/auth/callback`), and the Stripe keys if billing is wanted.
   - `TOKEN_ENCRYPTION_KEY` is already set in Render. **Back it up** — lose it and every stored OAuth token becomes undecryptable.
   - Caveat worth a decision: free Render web services spin down after ~15 min without HTTP traffic. The job worker runs in-process, so on the free plan it stops whenever the service sleeps. Continuous operation means the Starter plan, not a code change.

**3. ✅ Decided (2026-09-21): Vercel stays optional, not deployed.** The repo owner's answer, direct: keep Vercel available as a deployment target in principle, but don't actually deploy into it until there's a concrete reason to expand the account's surface area. Nothing to action right now — this is a "don't" decision, not a "do" one.
   - **What this resolves:** PR #33 ("Real deployment pipeline," its Phase 3 — Vercel CD) is not getting merged or acted on. It stays open on GitHub as the record of this option, in case a future need for Vercel ever materializes — not because it's mergeable as-is or queued as a task. It is still 17+ commits behind `main` and conflicting; nobody should try to land it without re-scoping it against whatever `main` looks like at that point.
   - **What this does NOT resolve:** whether PR #33's other four phases (health endpoints, smoke-test/failure-alerting infra, its independently-useful Apps Script CD half — Phase 4, and the installer/CI resync in Phase 5) are still worth extracting on their own, now that `main` already has its own heartbeat-failure-alerting fixes (PR #45) and a live Apps Script hub. That's a separate, still-open question nobody has asked yet — don't assume it's covered by this decision.

---

## What this session did, in order

1. **Closed out the CI/CD floor on Argoloth, Mothership, and TSO** to match the floor KOS already had: committed regression tests wired into CI, a repo-specific static check, Dependabot, CodeQL, a scheduled-job watchdog, and a docs-check gate. Full detail and per-repo status: **[The Pivot Ledger](https://claude.ai/code/artifact/324d94db-64b1-4e3d-904f-16de245a2f79)**'s status table.
   - Argoloth needed a from-scratch GAS-mock test harness (none existed) — now 105 committed tests.
   - TSO had a genuinely broken floor: 4 workflow files were silently invalid YAML (a real incident, not hypothetical) and its one test file had never actually run (truncated mid-statement, plus a missing `require`). All fixed and verified green.
   - Mothership picked up its own missing Dependabot/CodeQL, plus a real docs-drift fix: the dashboard's "Hub Health" panel was undercounting its own scheduled workflows by 3 (one pre-existing gap, two from this session's own additions).
2. **Ran the `mothership-live-review` skill against KOS's two newest commits** at the time (the docs-check-gate + watchdog feature, and its README follow-up) — found nothing wrong in what wasn't truncated away by `MAX_DIFF_CHARS`, but did find and fix a real backported bug: KOS's own copy of the watchdog silently reported "every file clean" if `actionlint` couldn't even be spawned, instead of surfacing the tool failure. Fixed there; still not backported to Argoloth's or Mothership's copies at the time — **update, 2026-09-14: both are now fixed too, see Open Items item 8**.
3. **Discovered KOS's local clone was ~100 commits behind `origin/main`** — silently missing an entire leader-hub server migration, a new autonomous "Drive Steward" system, and a full "Flow doctrine" rollout, discovered only when a routine push was rejected as non-fast-forward. Merged cleanly, no conflicts, no lost work.
4. **Given that scale of surprise change, ran a full re-audit** (4 parallel research passes) against KOS's original audit findings plus everything genuinely new. Published as **[KOS Audit Docket II](https://claude.ai/code/artifact/a34064f3-f903-4c6d-9834-e845057c9053)**. Headline results:
   - kos-personal: 1 of 5 original findings genuinely fixed (webhook auth), 4 untouched, 2 new concurrency bugs.
   - cas-ccps: both original HIGH findings still open; new Flow-2 work turned a previously-inert prompt-injection weakness into a live path to forged official student competency records (ranked recommendation #2, still open).
   - leader-hub: the original 7 XSS sites are genuinely fixed and survived a later refactor — but the server migration since then opened the critical `doPost()` gap above.
   - New subsystems (Drive Steward, Flow doctrine, doc-currency tool, gas-lint) are well-built, with one good ironic bug: the tool built to catch stale docs has its own directory-exclusion bug (still open, low priority — see Open Items).
5. **Found and fixed 2 more small doc-drift items** the audit had flagged but not yet corrected: `cas-ccps/README.md`'s stale "prompt-injection denylist" claim (no such thing exists in code — now matches the already-correct `SYSTEM_ARCHITECTURE.html`), and `leader-hub/README.md`'s newest verification entry claiming gas-lint ran "clean" with no caveat (a live run is `0 errors, 5 warnings`, all pre-existing and harmless — now stated accurately).
6. **Updated [The Pivot Ledger](https://claude.ai/code/artifact/324d94db-64b1-4e3d-904f-16de245a2f79)** with 5 new cross-repo lessons pulled from steps 2–5 above (re-verification methodology, "shipping a capability and re-examining its blast radius must be the same commit," local-clone staleness, confirming scope before an ambiguous big ask, and the doc-currency tool's own bug).

---

## What the 2026-09-18 → 09-20 sessions did

Grouped by what it changes for whoever reads this next.

**Mothership's own `doPost()` had the same gap leader-hub's did, and it went live.** The multi-tenant caller-key mechanism was opt-in and the seeded `"default"` tenant had no key — fine while nothing was deployed, not fine once the Apps Script hub went live with access set to Anyone. Any unauthenticated caller could POST an arbitrary owner/repo and make the hub fetch that repo's diff with `GLOBAL_GITHUB_TOKEN`, private repos included. Fixed in [PR #43](https://github.com/adamberneche-afk/Mothership/pull/43) — and unlike leader-hub's, **the owner's decision was taken on the record before any code was written**, which is what item 1's own flag had asked for. Deployment of that fix is open item 11.

**The KOS inference service ran on real infrastructure for the first time, and that found things tests could not.** Five defects, in the order they surfaced:
  1. `getNextQueuedJob`'s `RETURNING` clause ended with a scalar subquery returning sixteen columns. Postgres rejects it at *parse* time, so it threw on every call — the worker never processed a single job. The fake-pool suite stayed green because it matches queries by substring and returns canned rows; **it structurally cannot know whether the SQL it matched is valid**. Fix `76c1cf5`, plus `test/db-sql.test.js` which runs every query against a real Postgres (skips when `DATABASE_URL` is unset; CI runs a `postgres:16` service).
  2. `schema.sql` was idempotent everywhere except `CREATE TRIGGER`, which has no `IF NOT EXISTS`. First boot would migrate; every redeploy would die before `npm start`. Fix `2a4a53b`.
  3. `.env.example` did not exist, though the deployment doc opens with `cp .env.example .env`. Written, all 25 variables.
  4. `.env` was not gitignored — combined with (3), the next `git add -A` commits the Google client secret, Anthropic and Stripe keys, `DATABASE_URL` and `TOKEN_ENCRYPTION_KEY`. Fix `991d781`.
  5. A missing `DATABASE_URL` failed silently: `pg` reads an undefined connection string as "use libpq defaults" and dials localhost, and `migrate.js` logged only `err.message` — which is empty on the AggregateError Node 26 throws. The operator's entire diagnostic was `[migrate] Failed:`. Fix `dc528c2`.

**Every hub heartbeat was reporting success even when the hub refused it.** `self-reflect.yml`, `recursive-learning.yml` and both spokes' `call-hub.yml` used a bare `curl -X POST`, which exits 0 on any HTTP status. PR #43's new 403 — the one condition these workflows exist to surface — showed green. Reproduced against a local 403 server: bare curl exits 0, `curl --fail-with-body` exits 22. Fixed in all four, plus the three `gas/*.example.yml` templates. `recursive-learning.yml` was also still pointing at the retired Vercel URL and is now on Apps Script. On the Mothership branch, not yet merged.

**The dependabot backlog cleared.** PRs #36-39 were all failing on the same thing, and it was never the dependency — see open item 13. All four are merged; `main` is green.

---

## What the 2026-09-21 floor session did

**The CI/CD floor is now a written spec with ten checks, not an oral tradition.** [`CICD_FLOOR.md`](CICD_FLOOR.md) names all ten, the "prove it fails" rule, the constraints a distributed artifact has to satisfy, and the exemptions. Checks 1–5 already existed across the portfolio; this session built 6–10 on the hub and distributed what applied.

| # | check | Mothership | Argoloth | KOS | TSO | ThinkOS-Server |
|---|---|---|---|---|---|---|
| 1–5 | CodeQL, Dependabot, watchdog, tests-in-CI, docs-check | ✅ | ⛔ CodeQL (private, no GHAS) | ✅ | ⚠️ docs-check | partial |
| 6 | doc-currency | ✅ | ✅ | pre-existing own | pre-existing own | ❌ |
| 7 | doc-link-check | ✅ | ✅ | ✅ | ✅ | non-canonical |
| 8 | doc-placeholder-check | ✅ | ✅ | ✅ | ✅ | non-canonical |
| 9 | coverage-gaps | ✅ | ✅ | pre-existing own | ✅ | ❌ |
| 10 | secrets-doctor | ✅ | ✅ | ✅ | ✅ | PR #6, draft |

Merged: Mothership #48–#52, Argoloth #13–#14, KOS #30, TSO #2054.

**Two design decisions worth not re-litigating.** Per-repo variation lives in a committed `.github/floor.json` read at *runtime*, never in generated-code templating — templating would break the `ast.literal_eval` round-trip invariant `sync-installer-copies.py` depends on (open item 13). And every distributed script is `.mjs`, not `.js`, so it loads in a CommonJS repo like Argoloth regardless of the host `package.json`'s `type`. Every distributed file is byte-identical across repos, verified by `diff` after every edit.

**Every check was proven by watching it go red on a planted violation** — except check 10's `probe` half, which is `workflow_dispatch`-only and so cannot be dispatched until it exists on the default branch. That proof was completed after merge and is recorded in `CICD_FLOOR.md` and on each of the four PRs.

**What the checks found on their first real runs.** This is the part worth reading; the checks themselves are plumbing.

1. **The hub secrets were never set** — see the flagged block under "Start here" item 1. 33 failed spoke runs, zero successes.
2. **Mothership's `watchdog.yml` is itself failing silently.** Its last two scheduled runs (2026-09-08, 2026-09-15) died on a GitHub API call authenticated with `GLOBAL_GITHUB_TOKEN`, with no open watchdog issue to show for it. `secrets-doctor` reports that token as *configured* — so it is present but not valid. The tool built because a bad token let `health-report.yml` fail silently is now failing silently on a bad token. That is open item 14.
3. **TSO has never had a successful database backup.** `db-backup.yml` has run exactly once (2026-09-21) and failed; `BACKUP_DATABASE_URL` and `BACKUP_PASSPHRASE` are unset. Both were invisible to TSO's own `tools/doctor`, which checks three secrets while its workflows reference five — the exact drift that motivated deriving the list from the workflow files instead of hand-writing it.
4. **TSO's `call-hub.yml` has stopped firing without failing.** `state: active`, definition unchanged since 2026-03-23, 2,157 runs, and **its last run was 2026-08-05** — six weeks dormant, no error, no signal. Nothing in the floor catches a schedule that simply stops. That is open item 15, and it is a genuine hole in check 3.
5. **Argoloth's `DEPLOY_GUIDE.md` documented a deleted workflow**, and its `CLAUDE.md` claimed 139 tests across 7 files when the real numbers were 147 across 8. Both caught by check 6 on its first run; both fixed in Argoloth #13.

**Three bugs the floor found in itself before anything else did**, recorded because the pattern matters more than the fixes: `doc-currency`'s directory walk skipped every dotfile, so it falsely reported a real `gas/.clasp.json.example` missing; `coverage-gaps` counted an import that appeared only as a *string fixture* inside a test as real coverage, which meant it could certify its own blind spot (fixed with a code-position scanner that skips comments and consumes strings whole); and `secrets-doctor`'s expected set was self-fulfilling until its own workflow was excluded from the reference scan, because that workflow's generated block necessarily names every secret it checks. The first was caught by a real false positive, the second by reading its own output, the third by a failing test.

**Three CodeQL findings on `secrets-doctor`, and one of my own replies to them was wrong.** The first design passed `toJSON(secrets)`; the second indexed `secrets[matrix.secret]`. I initially defended the second on the grounds that no secret value reached any runner — **that was false**, and worth recording as the lesson: a *dynamic* index is unresolvable before dispatch, so the Actions service ships the job *every* secret, even though the step's environment shows only one. Only a static `${{ secrets.NAME != '' }}` is resolved up front. The shipped design is static references in a generated block, with a `--check` drift gate so the block cannot fall behind the workflows in either direction.

---

## Open items, roughly in priority order

| # | Item | Where | Status |
|---|---|---|---|
| 1 | Auth check on leader-hub's `doPost()` | KOS | ✅ **Resolved (2026-09-18)** — real `Session.getActiveUser()` checks now gate every owner-only action and a same-domain check gates Org Sync, covered by `tests/leaderhub/webapp-auth.test.js`. **Flagged, not clean**: shipped by a Claude session with no human commit or review in between, which is exactly what the original flag asked for. Worth the owner's own eyes retroactively. |
| 2 | Anchor/escape the prompt delimiter feeding forged SCR evidence | KOS, cas-ccps | Open, HIGH — Audit Docket II rec #2 |
| 3 | Validate the intake email before it grants Drive access | KOS, cas-ccps | ✅ **Resolved (2026-09-19)** — `_studentIdPattern_()` now gates the submitted account before `shareToStudentDrive_()` calls `addEditor()`/`addViewer()`. 5 regression tests; commit `86a55b9`. |
| 4 | Wire a real SCR confirm/override caller (or rescope the status table + disable the dead Weekly Parent Report section) | KOS, cas-ccps | Open |
| 5 | Add `LockService` to `harvestStudioReturns()` and `_markAuditRetryPriority_()` | KOS, kos-personal | ✅ **Resolved (2026-09-14)** — both closed as a side effect of an unrelated lock-hardening commit (`7921cde`) wrapping `processInferenceQueue()`'s whole body in `LockService.getScriptLock()`; `harvestStudioReturns()` now takes the lock directly, and `_markAuditRetryPriority_()`'s one call site sits inside that same lock. Not a targeted fix for this item, but the race it named is genuinely closed. |
| 6 | Encrypt OAuth refresh tokens at rest, narrow Drive scope to `drive.file` | KOS, kos-personal | 🟡 **Half resolved (2026-09-19)** — tokens are now AES-256-GCM encrypted at rest (`src/token-crypto.js`, commit `c53ed41`), fail-closed on a missing key, with legacy plaintext rows still readable so deploy day locks nobody out. 17 tests. **The `drive` → `drive.file` scope narrowing is still open** and still needs a deliberate pass against a live deployed script. |
| 7 | Fix `tools/doc-currency/check.js:100`'s exclusion-path bug (root-only match, not any-depth) | KOS | ✅ **Resolved (2026-09-19)** — `isExcludedDir()` extracted and fixed to match any path segment. 5 regression tests including the nested `node_modules` case and an `archived_old`-vs-`archived` false-positive guard. Commit `34657fa`. |
| 8 | Backport the actionlint-ENOENT watchdog fix | Argoloth, Mothership | ✅ **Resolved (2026-09-14)** — Argoloth's copy fixed incidentally during unrelated feature work (commit `35beb6e`); Mothership's copy fixed deliberately in a scoped one-item sprint (commit `751f8e0`), with a new regression test covering the spawn-failure path. All four repos with this watchdog (KOS, Mothership, Argoloth, TSO) are now consistent. |
| 9 | Bring the remaining repos up to the CI/CD floor | ThinkOS-Server | 🟡 **Moved and narrowed (2026-09-21)** — **Tais is out of scope permanently: it is archived.** The floor is now a written ten-check spec (`CICD_FLOOR.md`) and Mothership, Argoloth, KOS and TSO are at or near it. ThinkOS-Server is the only repo left: its check 10 sits in **PR #6, deliberately parked as a draft** at the owner's request, and checks 3, 4, 6 and 9 are unstarted. Its `doc-link-check`/`doc-placeholder-check` exist but are not the canonical copies. |
| 10 | School Store Sales Log's unescaped `innerHTML` sink | KOS, leader-hub | Open, low severity (single-owner data only) — re-confirmed open 2026-09-14 |
| 11 | Deploy the merged Mothership auth fix to the live Apps Script hub | Mothership | **Owner-only** — see "Start here" step 1. The fix is merged; the running deployment is not. |
| 12 | Finish standing up the KOS inference service on Render | KOS | **Owner-only for the credentials** — see "Start here" step 2. `DATABASE_URL` is one dashboard click; the API keys are yours to supply. |
| 13 | Make `setup_hub.py`'s embedded file copies regenerable | Mothership | ✅ **Resolved (2026-09-20)** — `scripts/sync-installer-copies.py` regenerates them; `--check` reports drift, a bare run repairs it. ci.yml now takes its file list from `--list` (the two lists drifting apart was its own latent bug) and names the fix command in its error. The escaping is never trusted: every literal is parsed back with `ast.literal_eval` and compared to its source bytes before being written, so the script can refuse but cannot silently corrupt the installer. Covered by `scripts/dev-test-sync-installer-copies.mjs`, which was itself sabotaged to confirm it fails against the corruption it guards. Commit `56132ab`. |
| 14 | `GLOBAL_GITHUB_TOKEN` looks configured but invalid — the watchdog is failing silently on it | Mothership | **Owner-only.** `watchdog.yml`'s last two scheduled runs (2026-09-08, 2026-09-15) failed on a GitHub API call using it, with no watchdog issue opened. `secrets-doctor` confirms the secret is *set and non-empty*, so this is an expired or under-scoped value, not a missing one — the one failure mode check 10 explicitly cannot see. Rotate it. |
| 15 | A scheduled workflow that stops firing produces no signal at all | TSO (found), all repos (class) | Open — TSO's `call-hub.yml` is `state: active`, unchanged since 2026-03-23, 2,157 runs, **last run 2026-08-05**. Six weeks dormant, silently. Check 3 (watchdog) asks whether the *last run* succeeded, which a workflow with no recent runs passes vacuously. Needs a staleness dimension: a `schedule:` workflow whose last run is older than its own cron interval is a finding. |
| 16 | Remove TSO's superseded `tools/doctor/` | TSO | Open, low risk — floor check 10 now covers a strict superset (5 secrets vs 3, derived rather than hand-listed). Deliberately left in place during TSO #2054 so the two could be compared on real output; that comparison is done and check 10 won. **7 files reference `tools/doctor`**, so removal needs a `doc-currency` re-run in the same PR. |
| 17 | Generalize the distributor so the floor stops being hand-copied | Mothership | Open — every floor script is byte-identical across repos today, but only because each copy was `diff`ed by hand. `scripts/sync-installer-copies.py` already solves this shape for `setup_hub.py`; generalizing it plus a `floor-drift` check would make divergence a red build instead of a thing someone notices. This is what keeps the floor a floor. |

Items 2, 4, 6 and 10 are unchanged in substance from what Audit Docket II already recommends in more detail — that document is the source of truth for exact file:line citations, not this summary. Items 11–14 are **owner-only**: every one is a credential or a console click, not code. Items 15–17 came out of the 2026-09-21 floor work and are the only items on this list that are straightforwardly mine to pick up next.

---

## Repo state as of this handoff

**Updated 2026-09-21.** Everything this session touched is merged; one docs commit is pushed and unmerged.

| Repo | `main` | Open work from this session |
|---|---|---|
| Mothership | `1876b85` (#52 merged) | `claude/mothership-handoff-review-5k8plk` is **1 commit ahead, pushed, no PR opened** — `CICD_FLOOR.md`'s dispatch proof plus this handoff update. Open a PR or cherry-pick it; do not let it rot on the branch. |
| Argoloth | `114e2c7` (#14 merged) | none |
| KOS | `2fbc5a4` (#30 merged) | none |
| TSO | `75498c9` (#2054 merged) | none |
| ThinkOS-Server | — | **PR #6 open as a draft, parked at the owner's request.** Revive when asked; see open item 9. |
| Tais | — | **Archived. Out of scope permanently** — do not re-add it to any floor status table. |

Only Mothership is cloned locally in this session (`/home/user/Mothership`). The other four were worked entirely through the GitHub API, so there is no stale local clone to distrust for them — but the lesson below still applies the moment one is cloned.

**Lesson learned the hard way this session: don't trust a local clone's HEAD without checking.** `git fetch origin main && git log HEAD..origin/main` before assuming a clone reflects reality, especially for any repo more than one session or tool touches — KOS's clone silently missed ~100 real commits with no symptom until a push got rejected.

---

## Artifacts (all owned by the account, private until shared)

| Artifact | URL | What it is |
|---|---|---|
| The Pivot Ledger | https://claude.ai/code/artifact/324d94db-64b1-4e3d-904f-16de245a2f79 | Rolling cross-repo lesson/pivot tracker + CI/CD floor status table for all 9 repos. Updated in place — read this first for "what's the standing account-wide status." |
| KOS Audit Docket (I) | https://claude.ai/code/artifact/2f2ef98c-26d9-4249-ab28-ca9daddad2bb | Original security/quality audit of KOS's three systems, filed against an early snapshot. Historical record — superseded in currency by Docket II, not deleted. |
| KOS Audit Docket II | https://claude.ai/code/artifact/a34064f3-f903-4c6d-9834-e845057c9053 | Re-verification of every Docket I finding against current code, plus new subsystems. Source of truth for KOS's current security/quality state. |
| The Argoloth Ledger | https://claude.ai/code/artifact/0428c8c8-4da5-418e-a740-df09f1dc8690 | Argoloth-specific audit findings. |
| The Spoke Ledger | https://claude.ai/code/artifact/a581f69b-a093-43e7-ab5f-414479154eac | Cross-spoke (TSO/ThinkOS-Server/Tais) onboarding history and findings. |

---

## Conventions this session established or relied on — worth preserving

- **Run the repo's real checks before pushing, never push speculatively** — the repo's own tests plus `actionlint` (or equivalent). This has held across every repo.
- **Mothership now uses PRs; KOS and Argoloth still push direct to `main`.** PRs #43 and #44 both went through review and CI on Mothership, which is the right shape for a repo whose `ci.yml` has a drift guard. Update this line if that changes.
- **Reproduce a breakage before believing a green run.** Twice this round a "passing" check proved nothing: an edit meant to break a query silently failed to apply, and `actionlint` without `shellcheck` on PATH cannot reproduce the SC2086 findings CI reports. Confirm the deliberate breakage actually applied, then trust the fix.
- **`mothership-live-review` skill** for on-demand debug/hunt/refactor reviews against a spoke's latest commit(s), sidestepping the AI-backend endpoint (undeployed at the time this line was written; **update 2026-09-18: Mothership's own Apps Script backend is now live**, though no real spoke points at it yet and this skill's own value as an on-demand, no-Flow-needed path is unchanged). Dedup is by `(commitSha, mode)` in that spoke's own `ai_decision_log.json` — check it before re-reviewing a commit.
- **The Pivot Ledger is the durable index** — when in doubt about "has this already been looked at / fixed," check it before re-deriving from scratch.
- **A docket/audit is a dated filing, not a rolling document** — when a repo has moved substantially since its last audit, file a new, cross-referenced docket rather than editing the old one in place. The Pivot Ledger *is* the rolling document; audit dockets are snapshots.
- **Ground every finding in code you actually read**, never a commit message's own claim about itself — this is what caught both the ENOENT watchdog bug and the two doc-drift items fixed this session.
