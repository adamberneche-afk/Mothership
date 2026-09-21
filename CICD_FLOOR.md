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
recorded below as a deliberate exemption with a reason. In the matrix, ❌
means missing and ⛔ means exempt with a recorded reason — the difference
between work outstanding and a decision already made.

| # | Check | What it gates |
|---|---|---|
| 1 | **CodeQL** | Every language actually present in the repo. Rust uses `build-mode: none` — `autobuild` is unsupported and fails hard (CodeQL 2.27.0). |
| 2 | **Dependabot** | Every package ecosystem in the repo, plus `github-actions` itself. |
| 3 | **watchdog** | `actionlint` over every workflow file, plus the last run conclusion of every `schedule`-triggered workflow. Weekly. |
| 4 | **Tests gated in CI** | A required check that runs the repo's real test suite on every PR. |
| 5 | **docs-check** | A PR adding a new capability file must touch that area's docs. |
| 6 | **doc-currency** | Docs may not cite a file or a function that no longer exists in the repo. A line carrying a `doc-currency:ignore` marker is skipped, and a path that is legitimately never present here (a spoke's file, a gitignored one) is declared in `floor.json`'s `knownAbsentPaths` — a map, so each entry carries its written reason. |
| 7 | **doc-link-check** | No dead relative links between Markdown files. |
| 8 | **doc-placeholder-check** | No unedited template text (`[Your Company Name]`, lorem ipsum). A line carrying a `floor-allow-placeholder` marker is skipped — for docs that describe the check and therefore must contain its patterns. <!-- floor-allow-placeholder: this row documents the patterns --> |
| 9 | **coverage-gaps** | Every scheduled job's script has test coverage CI can actually reach. Distinguishes "no test exists" from "a real test exists that `npm test` never runs" — the second is the one that reads green. A scheduled workflow invoking no local script is named in the report rather than silently dropped. |
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

### Constraints a distributed artifact must satisfy

Both were discovered by attempting the first shipment (Argoloth), not by
design, and both are load-bearing rather than stylistic.

1. **A script artifact is `.mjs`, never `.js`.** Mothership is
   `"type": "module"`, so `.js` is already ESM here — but the same bytes
   have to load in a repo that is not. Argoloth has a CommonJS root
   `package.json` and CommonJS tests, where a `.js` file carrying `import`
   fails to parse at all. `.mjs` is ESM regardless of the host
   `package.json`, so one set of bytes runs in both kinds of repo.
2. **A script artifact lives at `scripts/<name>.mjs`, and says so out
   loud.** It computes the repo root as one level up, which is correct only
   at that path — and wrong *quietly*, because a walk rooted in the wrong
   directory finds nothing and prints "clean". Argoloth keeps its own
   tooling at `tools/<name>/check.js`, one level deeper, where the root
   would have resolved to `tools/`. Each script therefore asserts `.github/`
   exists under its computed root and exits 2 if not, turning a vacuous
   green into a loud refusal. The fixed path is also what lets `floor-drift`
   know where to look.

Harnesses are **not** floor artifacts and are not byte-identical: each repo
tests in its own idiom (Mothership's `scripts/dev-test-*.mjs`, Argoloth's
`tests/*.test.js` under `node --test`). The floor is the ten checks, not a
test style.

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

Abridged — this repo's real `.github/floor.json` is the authority, and it
grows a key each time a check is adopted. The shape:

```json
{
  "floorVersion": "1",
  "codeqlLanguages": ["actions", "javascript-typescript"],
  "testCommand": "npm test",
  "docsCheck": {
    "watchedPaths": ["api/", "gas/", "dashboard/", ".github/workflows/"],
    "requiredDocs": ["README.md"]
  },
  "docExcludePaths": ["node_modules"],
  "docCurrency": { "excludeDirs": [], "exemptDocs": [], "codeExtensions": [], "knownAbsentPaths": {} },
  "coverageGaps": { "testFilePatterns": [], "testCommandGlobs": [], "exemptScripts": {} },
  "placeholderPatterns": []
}
```

Every key is read defensively — a missing one degrades to a documented
default rather than hard-failing the check. That matters because a spoke's
copy of `floor.json` will routinely predate a key the hub has just added,
and the distributed workflow has to keep working in the interval.

**Known cost.** A `strategy.matrix` needs its values at workflow-parse time,
so it cannot read a file directly. CodeQL therefore gains a small preceding
job that reads `floor.json` and emits the matrix as an output, consumed via
`strategy.matrix: ${{ fromJSON(needs.setup.outputs.matrix) }}`. One extra job
per CodeQL run is the price of keeping the YAML identical everywhere.

## Current compliance

Verified 2026-09-21 by direct inspection, not by reading docs. Mothership's
rows 6–9 were flipped by the work in this branch and each was proven per the
DoD above; the other four repos' columns are unchanged since that audit.

| | Mothership | KOS | Argoloth | TSO | ThinkOS |
|---|---|---|---|---|---|
| 1 CodeQL | ✅ | ✅ | ⛔ | ✅ | ✅ |
| 2 Dependabot | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3 watchdog | ✅ | ✅ | ✅ | ✅ | ❌ |
| 4 tests in CI | ✅ | ✅ | ✅ | ✅ | ❌ |
| 5 docs-check | ✅ | ✅ | ✅ | ❌ | ❌ |
| 6 doc-currency | ✅ | ✅ | ❌ | ✅ | ❌ |
| 7 doc-link-check | ✅ | ❌ | ❌ | ✅ | ✅ |
| 8 doc-placeholder-check | ✅ | ❌ | ❌ | ✅ | ✅ |
| 9 coverage-gaps | ✅ | ✅ | ❌ | ✅ | ❌ |
| 10 doctor | ✅ | ❌ | ❌ | ✅ | ❌ |

**The hub was not compliant, and that blocked everything.** A distributor
can only distribute what it has, so bringing this repo to full compliance was
the first implementation step, not a parity cleanup to be done later. **The
hub is now compliant on all ten.** The next step is the distributor itself.

Where a check's mature implementation lives elsewhere, it is adopted here
rather than rewritten. Which copy to adopt was decided by reading both, not
by reputation:

- **`doc-currency` from TSO**, not KOS. KOS's is much the more capable of the
  two — 14 checks against TSO's 2, plus a whole exclusions taxonomy — but it
  `require`s `../gas-lint/check.js`, a KOS-only Apps Script static analyzer, <!-- doc-currency:ignore: KOS's file, named here for contrast - deliberately not this repo's -->
  for its comment and string stripping. Adopting it wholesale would mean
  dragging gas-lint into every repo the floor reaches. TSO's is a
  dependency-free slice of the same original and imports nothing but node
  builtins, which is the property that matters for a file that has to run
  unchanged in five repos. Porting the two checks it kept
  (`cited-file-missing`, `cited-function-missing`) is a deliberate floor,
  not a shortfall: a repo wanting KOS's other twelve can still have them.
- **`coverage-gaps` from TSO**, whose module-graph resolution supersedes
  KOS's VM-instrumented original. KOS's answers "was this Apps Script
  trigger handler's body ever entered", using V8 coverage instrumentation
  over files loaded into a `vm` sandbox — a real trick, needed because Apps
  Script has no module system and every file in a project shares one global
  scope. Neither TSO nor this repo has that problem, so the same question is
  answerable by resolving the module graph directly. Two changes were forced
  by this repo: it resolves ESM `import` as well as CJS `require` (Mothership
  is `"type": "module"`, so a require-only scanner would resolve zero edges
  and report every scheduled script as uncovered), and the `npm test`
  reachability globs are **declared** in `floor.json` and verified against
  `package.json` rather than parsed out of the test command. TSO parses its
  own `node --test <globs>`; that parse is specific to one command shape,
  this repo's test script is a shell for-loop, and a distributed copy would
  meet a third shape in the next repo. A declared glob that no longer
  appears in `package.json`'s test script is a hard failure, because every
  reachability verdict is meaningless while those two disagree.

## Latent gap this surfaced

`setup_spoke.py` is tracked by nothing. `sync-installer-copies.py` covers
only `setup_hub.py`, so the `call-hub.yml` that `setup_spoke.py` embeds has
had no drift protection since it was written and may already disagree with
what this repo considers current. Generalizing the sync tool closes this as
a side effect of step 3 above — but it is a real, pre-existing hole, not
newly introduced by the floor work.

## Exemptions

An exemption names the repo, the check, and the reason; "not done yet" is not
an exemption.

### Argoloth — check 1 (CodeQL)

**Exempt. Structurally cannot run, verified independently of the claim.**

CodeQL was added to Argoloth and then deliberately removed in `8215271`,
because code scanning is a repo-Settings gate, not a workflow setting:
Argoloth is a **private** repo (confirmed via the API, `"private": true`),
and this account's plan does not carry GitHub Advanced Security for private
repos — Settings → Code security shows Dependency graph and Dependabot and
no Code scanning section at all. There is no toggle to flip. The check had
failed every run since it was added, always on the same
"Code scanning is not enabled for this repository" wall.

Removing it was right, and it is the floor's own
**"graceful degradation, not perpetual red"** convention applied correctly:
a check that can structurally never pass was sitting red forever and
masking the two that matter (`test`, `check`) under it. The audit table
below recorded Argoloth's ❌ without a reason, which is precisely the
"decision or oversight?" ambiguity this document exists to end. It was a
decision.

**Restore condition:** making the repo public, or the account's plan gaining
GHAS for private repos. The original file is in history — restoring it is a
one-file `git checkout`, not a rebuild.

Mothership by contrast is a public repo, which is why the identical check
runs there for free. Nothing about this exemption generalizes to the other
four repos; each private repo has to be checked on its own facts.
