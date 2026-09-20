# Session Handoff — 2026-09-06

Written for whoever (human or a fresh Claude Code session) picks this up next. Read the "Start here" section first — everything else is context for *why*, not things to do before that.

> **Update (2026-09-14):** A later session re-verified this handoff's entire open-items list, plus every finding in KOS Audit Docket II, against then-current code across every repo in the account, then ran a scoped one-item sprint against Mothership specifically. **Items 5 and 8 below have since closed** — marked inline. Item 5 closed incidentally, as a side effect of an unrelated lock-hardening commit in kos-personal. Item 8 closed in two steps: Argoloth's half closed incidentally too (found mid-feature-work), but **Mothership's own copy was fixed deliberately, as its own scoped sprint** — the account's first case of an item actually getting pulled off this list on purpose rather than by accident. Every other item, including item 1, was re-confirmed exactly as open as described below. Full detail: [The Pivot Ledger](https://claude.ai/code/artifact/324d94db-64b1-4e3d-904f-16de245a2f79)'s "Auditing the audit" section — leaving this table's original claims uncorrected here would repeat the exact mistake that section exists to catch.

> **Update (2026-09-20):** Two further sessions landed real work. **Items 3, 6 (half), and 7 have since closed**, and item 1 closed on 2026-09-18 — all marked inline below. New in this round: the KOS inference service was stood up on real infrastructure for the first time, which found five defects no test suite had caught; Mothership's own `doPost()` auth gap was found and fixed; and the dependabot backlog was cleared. **Three new items (11-13) are appended to the table** — 11 and 12 are things only the repo owner can do; 13 was found and closed the same day. The "Start here" section has been rewritten: leader-hub's `doPost()` is fixed, so it is no longer the top item.


---

## Start here: manual steps only the repo owner can do

Nothing below is a technical blocker — all of it is code that is merged and waiting on a credential or a console click.

**1. Mothership's live Apps Script hub is running code that predates its own auth fix.** PR #43 added a caller-key gate; the deployed script has not been updated. Until these are done, the live `/exec` URL is still the unauthenticated one described in the 2026-09-18 Pivot Ledger entry:
   - Set Script Property `DEFAULT_TENANT_CALLER_KEY` on the hub's Apps Script project.
   - `clasp push`, then `clasp deploy -i <existing deployment id> -V <n>` — reusing the deployment id is what preserves the `/exec` URL and its access setting. A bare `clasp deploy` creates a *new* deployment defaulting to "Only myself".
   - Add repo secrets `APPS_SCRIPT_URL` and `TENANT_CALLER_KEY` to Mothership, KOS, and Argoloth.
   - The generated key was handed over in chat on 2026-09-19. It is deliberately not written down in any repo.

**2. The KOS inference service on Render needs one env var before it will boot.** Everything else is set.
   - Render dashboard -> `kos-inference-service` -> Environment -> **Add from Database** -> `kos-inference-db` -> **Internal Database URL**. Set Health Check Path to `/health` while there.
   - Then it boots but is not yet functional: it still needs `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`/`_SECRET`/`_REDIRECT_URI` (-> `https://kos-inference-service.onrender.com/auth/callback`), and the Stripe keys if billing is wanted.
   - `TOKEN_ENCRYPTION_KEY` is already set in Render. **Back it up** — lose it and every stored OAuth token becomes undecryptable.
   - Caveat worth a decision: free Render web services spin down after ~15 min without HTTP traffic. The job worker runs in-process, so on the free plan it stops whenever the service sleeps. Continuous operation means the Starter plan, not a code change.

**3. One open decision: is Vercel still a deployment target?** PR #33 ("Real deployment pipeline") builds Vercel CD, but `main` has since moved the hub to Apps Script. It is 17 commits behind with five conflicting files, and the `self-reflect.yml` conflict is Vercel-vs-Apps-Script, not whitespace. Nobody should resolve that without an answer. Its Apps Script CD half (Phase 4) looks independently useful.

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
| 9 | Bring ThinkOS-Server and Tais up to the same CI/CD floor as the other 4 repos | ThinkOS-Server, Tais | Not started — re-confirmed via a live `git ls-remote` (not a stale clone) on 2026-09-14 — see Pivot Ledger status table |
| 10 | School Store Sales Log's unescaped `innerHTML` sink | KOS, leader-hub | Open, low severity (single-owner data only) — re-confirmed open 2026-09-14 |
| 11 | Deploy the merged Mothership auth fix to the live Apps Script hub | Mothership | **Owner-only** — see "Start here" step 1. The fix is merged; the running deployment is not. |
| 12 | Finish standing up the KOS inference service on Render | KOS | **Owner-only for the credentials** — see "Start here" step 2. `DATABASE_URL` is one dashboard click; the API keys are yours to supply. |
| 13 | Make `setup_hub.py`'s embedded file copies regenerable | Mothership | ✅ **Resolved (2026-09-20)** — `scripts/sync-installer-copies.py` regenerates them; `--check` reports drift, a bare run repairs it. ci.yml now takes its file list from `--list` (the two lists drifting apart was its own latent bug) and names the fix command in its error. The escaping is never trusted: every literal is parsed back with `ast.literal_eval` and compared to its source bytes before being written, so the script can refuse but cannot silently corrupt the installer. Covered by `scripts/dev-test-sync-installer-copies.mjs`, which was itself sabotaged to confirm it fails against the corruption it guards. Commit `56132ab`. |

Items 2–4, 6, 7, and 10 are unchanged in substance from what Audit Docket II already recommends in more detail — that document is the source of truth for exact file:line citations, not this summary. Items 5 and 8 are the first two items on this list to actually close since it was written; see the 2026-09-14 update note at the top of this file for how each one closed.

---

## Repo state as of this handoff

All local clones are clean and pushed, `main` branch, no uncommitted changes:

| Repo | Local path | HEAD | Sync |
|---|---|---|---|
| Mothership | `/home/user/Mothership` | `82e40c6` on `claude/mothership-docs-review-bpi391` | 9 ahead of `origin/main` (`c5f5413`), 0 behind — **pushed, no PR opened yet** |
| KOS | `/home/user/kos` | `21d42a3` | matches `origin/main` |
| Argoloth | `/home/user/argoloth` | `65d96e7` | matches `origin/main` |
| TSO | *not cloned in this session* | — | Left alone deliberately — a concurrent Claude session was working TSO/Render at the time |

All three present clones are clean, nothing uncommitted, everything pushed.

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
