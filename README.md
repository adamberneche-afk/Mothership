# AI CTO Hub - Mothership Repository

This repository serves as the central intelligence (the "Mothership") for a hub-and-spoke autonomous coding swarm system.

## Overview

The AI CTO Hub implements a centralized intelligence system that manages multiple project repositories ("spokes") through a hub-and-spoke model. The system enables:

- **Shared Standards**: A manual edit to this repo's global lessons/North Star files takes effect for every spoke on its next heartbeat. On top of that, a monthly job now looks for patterns across spokes and *proposes* updates to those files as a PR - a human still reviews and merges it, but the aggregation itself is automatic. See [Recursive Learning Loop](#recursive-learning-loop-apirecursive_learningjs).
- **Centralized Maintenance**: Single point of updates for AI models, prompts, and standards  
- **Lean Spokes**: Individual projects remain lightweight, only needing a heartbeat mechanism
- **Global Cost Management**: All AI API traffic flows through a single Vercel deployment
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

### Safety Rails

The handler that used to file ~1,974 fabricated issues over 4 months (see `DOCS_VS_CODEBASE.md`) now has two independent guards on top of the response-validation fix above, both controlled by Vercel env vars:

- **`DRY_RUN_MODE`** (defaults to `true`) - a well-formed, real finding is reported in the response as `{ status: 'DryRunFinding', wouldCreate: {...} }` instead of actually calling the GitHub API to create an issue. A misconfigured or missing env var fails safe (no issue gets filed), not open. Only set this to the literal string `"false"` after watching dry-run output for a while and being satisfied the findings look real.
- **`RATE_CAP_PER_REPO_PER_DAY`** (defaults to `3`) - once dry-run is off, this hard-caps how many issues the handler will file against a single repo per UTC day, counted by querying that repo's existing issues (no separate database - there's nowhere else for a stateless Vercel function to keep a count). Once the cap is hit for the day, further findings return `Skipped` with the reason stated, until the next UTC day.

Every issue the handler files is tagged with the `cto-hub-auto` label - this is what the rate cap counts against, and what later tooling (health reporting) filters on to distinguish hub-filed issues from anything a human filed manually.

### Decision Logging (`ai_decision_log.json`)

Every decision the handler makes for a spoke - skip (no diff, no findings, invalid AI response), dry-run finding, rate-capped, or created - gets appended to that spoke's `ai_decision_log.json` as `{ timestamp, mode, commitSha, outcome, issueUrl, summary }`. This serves two purposes:

- **Avoids redundant AI calls**: if this exact commit was already decided in this mode, the handler replays the logged outcome instead of calling the AI model again. An outcome of `ai_error` (the AI call itself failed, e.g. returned no content) is the one exception - that's not a real decision, so it doesn't block a retry on the next run.
- **Gives the model memory**: the last 5 entries are fed back into the prompt as "PRIOR DECISIONS" context, so the model is less likely to re-report something it already looked at and dismissed.

Writes are best-effort (read-modify-write with retry on a stale `sha`, per repo, via the GitHub API) - a logging failure never fails the actual request, since the real decision has already been made by the time the log write happens. There is no separate database here; the log file itself is the durable state, same as everything else this handler persists.

### Recursive Learning Loop (`api/recursive_learning.js`)

A separate Vercel endpoint, distinct from `autonomous_agent.js`, that runs monthly (`.github/workflows/recursive-learning.yml`) and looks for patterns that recur across *multiple* spokes rather than reviewing one commit in one repo:

1. Reads `spokes.json` (this repo's registry of connected spokes - `[{ "owner", "repo", "addedAt", "status" }, ...]`). If it's empty, the run is skipped.
2. Fetches each registered spoke's `lessons.md` and recent `ai_decision_log.json` entries, alongside this hub's own current `universal_lessons.md`/`north_star_framework.md`.
3. Asks the configured AI model to find a genuine cross-spoke pattern - not something specific to just one project - that the current global standards don't already cover, and to propose it as the full updated text of `universal_lessons.md` and/or `north_star_framework.md`.
4. Same validation discipline as `autonomous_agent.js`: a `has_proposal` flag, and no action taken unless the response is well-formed with real reasoning and at least one patch.
5. Same `DRY_RUN_MODE` rail: dry-run reports the proposal in the response without acting on it.
6. In live mode, it **never pushes directly to `main`** - it opens a new branch, commits the proposed file(s), and opens a PR against this repo with the AI's reasoning as the PR body. A human still has to review and merge it, same as any other PR.

Because this is a proposal mechanism (a PR someone reviews), not an unattended action, it's lower-stakes than issue creation - but it still shouldn't run live before Sprint 0's safety rails have been verified working, since it shares the same `DRY_RUN_MODE` switch and the same underlying AI call.

### Maintenance (`scripts/prune-logs.js`)

Runs weekly (`.github/workflows/prune-logs.yml`, Sunday) as a plain GitHub Actions script - no AI, no Vercel call. For every spoke in `spokes.json`, it partitions `ai_decision_log.json` entries older than `RETENTION_DAYS` (default 90) out into `ai_decision_log_archive.json`, then truncates the live log to what's left. The archive write always happens **before** the live-log truncation, so a failure between the two leaves an entry duplicated in both files rather than lost - safe to just re-run.

This is a plain Node script, not a Vercel endpoint, because it doesn't need the AI model or anything Vercel-specific - only a GitHub token with cross-repo write access. That means it needs its own copy of that token as a **GitHub Actions secret on this repo** (`GLOBAL_GITHUB_TOKEN`) - the Vercel env var of the same name isn't visible to an Actions runner. Supports `workflow_dispatch` with a `dry_run` input that reports what would move without writing anything.

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

3. Add the spoke to this hub's own `spokes.json` (`{ "owner", "repo", "addedAt", "status" }`) so the [Recursive Learning Loop](#recursive-learning-loop-apirecursive_learningjs) includes it in its monthly cross-spoke pattern search. This step is only needed for that monthly job - the regular per-commit heartbeat (steps 1-2 above) works without it.

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

This repo's root `spokes.json` lists the spokes this hub knows about (`{ owner, repo, addedAt, status }`), used by cross-spoke tooling that needs to iterate every connected project rather than operate on just one. As of this writing: `tso`, `thinkos-server`, and `tais` - all three now have the standard spoke contract (`NORTH_STAR.md`, `lessons.md`, `ai_decision_log.json`, `.github/workflows/call-hub.yml`) and are registered here. Being registered doesn't change how the per-commit heartbeat works (that only needs the spoke's own `VERCEL_URL` secret) - it's specifically for tooling that operates across the whole portfolio at once.

## Values Alignment

This system is designed to continuously improve toward producing:
- **Accurate Code**: Through proactive debugging, hunting for silent errors, and value-aligned decision making
- **Efficient Code**: Through weekly refactoring that eliminates Frankenstein code and reduces complexity
- **User Value**: Through North Star alignment that prioritizes emotional UX outcomes over technical perfection
- **White Glove Service**: Through forgiving design principles and invisible complexity that delights users

Each project in the portfolio benefits from the collective intelligence of the swarm while maintaining its unique characteristics through local North Star and lessons files.
