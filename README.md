# AI CTO Hub - Mothership Repository

This repository serves as the central intelligence (the "Mothership") for a hub-and-spoke autonomous coding swarm system.

## Overview

The AI CTO Hub implements a centralized intelligence system that manages multiple project repositories ("spokes") through a hub-and-spoke model. The system enables:

- **Shared Standards**: A manual edit to this repo's global lessons/North Star files takes effect for every spoke on its next heartbeat - there's no automatic cross-spoke learning loop today, just a single shared source of truth
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
   - Add `VERCEL_URL`: Your deployed Vercel application URL (e.g., `https://your-hub-name.vercel.app`)

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

## How It Works

### The Heartbeat Mechanism
Each spoke repository contains a GitHub Action (`.github/workflows/call-hub.yml`) that:
- Triggers every 30 minutes (`cron: '*/30 * * * *'`) with `mode: debug`
- Triggers every Sunday at midnight (`cron: '0 0 * * 0'`) with `mode: refactor`
- Sends a POST request to the hub's Vercel endpoint with the repository owner, name, and mode

Note: `api/autonomous_agent.js` also supports `mode: hunt`, but the generated spoke workflow (`setup_spoke.py`) never actually sends it - both the scheduled runs and a manual `workflow_dispatch` of that workflow only ever produce `debug` or `refactor` (the mode is computed from `github.event.schedule`, which `workflow_dispatch` doesn't set either). The only way to use `hunt` today is a direct POST to the hub's `/api/autonomous_agent` endpoint with `"mode": "hunt"` in the body, outside of GitHub Actions.

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
There's currently no automated process that aggregates insights across spokes or updates `universal_lessons.md`/`north_star_framework.md` based on cross-project patterns - that's a manual step (edit the files in this repo directly) rather than something the hub does on its own. What *is* automatic: every spoke's heartbeat picks up whatever the hub's global files currently say, so an edit here takes effect for every spoke on its next run.

## Values Alignment

This system is designed to continuously improve toward producing:
- **Accurate Code**: Through proactive debugging, hunting for silent errors, and value-aligned decision making
- **Efficient Code**: Through weekly refactoring that eliminates Frankenstein code and reduces complexity
- **User Value**: Through North Star alignment that prioritizes emotional UX outcomes over technical perfection
- **White Glove Service**: Through forgiving design principles and invisible complexity that delights users

Each project in the portfolio benefits from the collective intelligence of the swarm while maintaining its unique characteristics through local North Star and lessons files.
