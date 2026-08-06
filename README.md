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
3. Fetches the spoke's latest commit diff - if there's no usable diff, it stops here and does nothing (no AI call, no issue)
4. Combines contexts and the diff into a prompt for the configured AI model
5. Requests a strict JSON response that must include a `has_findings` flag
6. Validates the response's shape before acting on it - a parse failure, a missing field, or `has_findings: false` all result in the run being skipped, not an issue being posted
7. Only when the response is well-formed AND reports real findings does it post a GitHub issue with reasoning and a code patch

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
This repository's own `.github/workflows/self-reflect.yml` pings the hub's `/api/autonomous_agent` endpoint against itself (`mode: refactor`) weekly. It needs one repository secret that isn't part of the Vercel setup above - without it, the workflow runs but the request has nowhere to go:

| Secret | Value |
|--------|-------|
| `HUB_VERCEL_URL` | This hub's deployed Vercel URL (same value as `VERCEL_URL` on spokes) |

Set this under this repository's own Settings → Secrets and variables → Actions. (The hub authenticates to GitHub server-side using its own `GLOBAL_GITHUB_TOKEN` Vercel env var - the workflow doesn't need to send a token itself.)

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
3. Fetches the diff of the spoke's latest commit. If there's no usable diff, the request stops here with a "Skipped" response - no AI call, no issue.
4. Constructs a prompt combining the role/mode, global standards, local context, and the actual diff
5. Calls the configured AI model with strict JSON response requirements, including a `has_findings` flag
6. Validates the response: invalid JSON, `has_findings: false`, or a response missing required fields all result in a "Skipped" response
7. Only a valid response with real findings gets posted as a GitHub issue with value impact analysis and a code patch

`ai_decision_log.json` is part of the spoke setup contract (`setup_spoke.py` creates it) but nothing currently reads or writes it - it's reserved for a future decision-history feature, not an active part of the flow today.

### Sharing Lessons Across Spokes
There's currently no automated process that aggregates insights across spokes or updates `universal_lessons.md`/`north_star_framework.md` based on cross-project patterns - that's a manual step (edit the files in this repo directly) rather than something the hub does on its own. What *is* automatic: every spoke's heartbeat picks up whatever the hub's global files currently say, so an edit here takes effect for every spoke on its next run.

## Values Alignment

This system is designed to continuously improve toward producing:
- **Accurate Code**: Through proactive debugging, hunting for silent errors, and value-aligned decision making
- **Efficient Code**: Through weekly refactoring that eliminates Frankenstein code and reduces complexity
- **User Value**: Through North Star alignment that prioritizes emotional UX outcomes over technical perfection
- **White Glove Service**: Through forgiving design principles and invisible complexity that delights users

Each project in the portfolio benefits from the collective intelligence of the swarm while maintaining its unique characteristics through local North Star and lessons files.
