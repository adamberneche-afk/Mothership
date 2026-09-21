# The CI/CD Floor

What every repo in this portfolio is expected to have, why, and how it gets
there. Mothership is the source of truth: the canonical copy of each floor
artifact is **this repo's own working copy of it**, and `setup_spoke.py`
distributes it outward.

Scope: `Mothership` (hub), `KOS`, `TSO`, `ThinkOS-Server`, `Argoloth`.
`Tais` is archived and deliberately out of scope.

## Why a written floor at all

These tools were built one repo at a time and hand-ported outward. That
worked, but it drifted: `coverage-gaps` now exists in two divergent
implementations, the watchdog has been copied five times, and four of the
ten checks below exist in some repos and not others with no record of
whether that was a decision or an oversight. A written floor turns each
port from a judgment call into a mechanical one, and makes "is this repo
compliant?" a question with an answer.

## The floor

A compliant repo has all ten. Anything absent is either scaffolded or
recorded below as a deliberate exemption with a reason.

| # | Check | What it gates |
|---|---|---|
| 1 | **CodeQL** | Every language actually present in the repo. Rust uses `build-mode: none` — `autobuild` is unsupported and fails hard (CodeQL 2.27.0). |
| 2 | **Dependabot** | Every package ecosystem in the repo, plus `github-actions` itself. |
| 3 | **watchdog** | `actionlint` over every workflow file, plus the last run conclusion of every `schedule`-triggered workflow. Weekly. |
| 4 | **Tests gated in CI** | A required check that runs the repo's real test suite on every PR. |
| 5 | **docs-check** | A PR adding a new capability file must touch that area's docs. |
| 6 | **doc-currency** | Docs may not cite functions, files or counts that no longer exist. |
| 7 | **doc-link-check** | No dead relative links between Markdown files. |
| 8 | **doc-placeholder-check** | No unedited template text (`[Your Company Name]`, lorem ipsum). A line carrying a `floor-allow-placeholder` marker is skipped — for docs that describe the check and therefore must contain its patterns. <!-- floor-allow-placeholder: this row documents the patterns --> |
| 9 | **coverage-gaps** | Every scheduled job's script has test coverage CI can actually reach. |
| 10 | **doctor** | Dispatch-only pre-flight that the secrets each workflow needs actually resolve. |

### Conventions that come with them

- **Pinned-issue alerting.** Anything that reports findings on a schedule
  updates one issue in place and reopens it if a human closed it. Never a
  new issue per run.
- **Graceful degradation, not perpetual red.** A workflow depending on
  infrastructure that may not be provisioned yet checks for it first and
  reports a clean skip. A permanently-red required check trains people to
  ignore red checks.
- **Untrusted input through `env:`, never `${{ }}` into `run:`.** Applies
  to `workflow_dispatch` inputs, `repository_dispatch` payloads, and
  anything from an issue or comment body.
- **Credential hard-skip, never silent fallback.** A configured credential
  that fails to resolve is a hard skip. Falling back to a broader,
  operator-owned credential is backwards: a revoked credential should lose
  access, not gain someone else's.

## Definition of done: prove it fails

**No floor check counts as installed until it has been shown to go red on a
deliberately planted violation, then green once removed.** Record the
planted case in the PR that installs it.

This is not ceremony. Every significant failure in this portfolio's history
was a green check that meant nothing:

- A bad `GLOBAL_GITHUB_TOKEN` let `health-report.yml` fail silently for five
  consecutive runs. Nobody noticed. The watchdog exists because of this.
- A spoke's `call-hub.yml` fired every ten minutes for ~4 months with no
  code context in the payload, producing ~1,974 fabricated issues, ~220 of
  them failing to even serialize (`[object Object]` bodies).
- A quoted glob in `npm test` silently matched zero test files on the pinned
  Node version. The suite "passed."
- A Workspace Flow logged "Run Completed" on a lookup that matched zero rows.
- Workflow files sat unparseable — no run, no red X, no signal — for five
  months in a sibling repo.

A check nobody has watched fail is indistinguishable from a check that
cannot fail.

## Distribution: the installer is the distributor

Decided over two alternatives (keep hand-porting; a shared reusable-workflow
repo). Rationale: this repo already solved this exact problem once, for
`setup_hub.py`, with machinery that is proven and trusted —
`scripts/sync-installer-copies.py` plus a CI gate that installs into a
scratch directory and diffs every generated file against the real one.
Reusing that beats introducing a second mechanism alongside it.

### How it works

1. **Mothership's own working files are canonical.** There is no separate
   template directory to drift from. `.github/workflows/watchdog.yml` as this
   repo runs it *is* the spec for every other repo's copy.
2. **`setup_spoke.py` embeds and writes them**, the same way `setup_hub.py`
   already embeds its own generated files as Python string literals.
3. **`scripts/sync-installer-copies.py` covers both installers.** It is
   currently hardcoded to `INSTALLER = "setup_hub.py"`; it generalizes to a
   list. Every embedded literal keeps its `ast.literal_eval` round-trip
   verification — a literal that doesn't reproduce its source bytes exactly
   is never spliced.
4. **Per-repo variation is runtime config, never generated-code templating.**
   See below. This is the load-bearing design choice.
5. **Each spoke verifies its own floor.** Mothership's CI cannot see a
   spoke's files, so each spoke carries a `floor-drift` check comparing its
   floor artifacts against canonical — structurally the same
   self-report-then-compare shape as `deploy-drift`, which already works in
   three repos.

### Why runtime config instead of templating

The floor is not byte-identical by nature: `docs-check` watches different
directories per repo, and CodeQL's language matrix differs. The obvious move
is to template the YAML with substitution tokens at generation time. Don't.

Templating breaks the invariant the whole mechanism rests on. Today the
embedded copy must equal the source file *exactly*, which is what
`ast.literal_eval` verification proves. Under templating the generated file
is *supposed* to differ from the canonical one, so that check can no longer
tell an intended substitution from a corrupted literal.

Instead: every distributed file stays **byte-identical in every repo**, and
the variation moves into a committed `.github/floor.json` that the workflows
and scripts read at runtime. The round-trip invariant survives untouched, and
a repo can change its watched directories without regenerating anything.

This also matches existing convention — `spokes.json`, `tenants.json` and
`plans.json` are all committed JSON config read at runtime.

### `.github/floor.json`

```json
{
  "floorVersion": "1",
  "codeqlLanguages": ["actions", "javascript-typescript"],
  "testCommand": "npm test",
  "docsCheck": {
    "watchedPaths": ["api/", "gas/", "dashboard/", ".github/workflows/"],
    "requiredDocs": ["README.md"]
  },
  "scheduledScriptDir": "scripts/"
}
```

**Known cost.** A `strategy.matrix` needs its values at workflow-parse time,
so it cannot read a file directly. CodeQL therefore gains a small preceding
job that reads `floor.json` and emits the matrix as an output, consumed via
`strategy.matrix: ${{ fromJSON(needs.setup.outputs.matrix) }}`. One extra job
per CodeQL run is the price of keeping the YAML identical everywhere.

## Current compliance

Verified 2026-09-21 by direct inspection, not by reading docs.

| | Mothership | KOS | Argoloth | TSO | ThinkOS |
|---|---|---|---|---|---|
| 1 CodeQL | ✅ | ✅ | ❌ | ✅ | ✅ |
| 2 Dependabot | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3 watchdog | ✅ | ✅ | ✅ | ✅ | ❌ |
| 4 tests in CI | ✅ | ✅ | ✅ | ✅ | ❌ |
| 5 docs-check | ✅ | ✅ | ✅ | ❌ | ❌ |
| 6 doc-currency | ❌ | ✅ | ❌ | ✅ | ❌ |
| 7 doc-link-check | ❌ | ❌ | ❌ | ✅ | ✅ |
| 8 doc-placeholder-check | ❌ | ❌ | ❌ | ✅ | ✅ |
| 9 coverage-gaps | ❌ | ✅ | ❌ | ✅ | ❌ |
| 10 doctor | ✅ | ❌ | ❌ | ✅ | ❌ |

**The hub is not compliant, and that now blocks everything.** Mothership is
missing checks 6–9. A distributor can only distribute what it has, so
bringing this repo to full compliance is the first implementation step, not
a parity cleanup to be done later.

Where a check's mature implementation lives elsewhere, it is adopted here
rather than rewritten: `doc-currency` from KOS (it checks doc *truth*, not
just that a doc was touched), and `coverage-gaps` from TSO (its
require-graph resolution supersedes KOS's VM-instrumented original).

## Latent gap this surfaced

`setup_spoke.py` is tracked by nothing. `sync-installer-copies.py` covers
only `setup_hub.py`, so the `call-hub.yml` that `setup_spoke.py` embeds has
had no drift protection since it was written and may already disagree with
what this repo considers current. Generalizing the sync tool closes this as
a side effect of step 3 above — but it is a real, pre-existing hole, not
newly introduced by the floor work.

## Exemptions

None recorded yet. An exemption names the repo, the check, and the reason;
"not done yet" is not an exemption.
