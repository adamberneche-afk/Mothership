# AI CTO Hub - Mothership Repository

This repository serves as the central intelligence (the "Mothership") for a hub-and-spoke autonomous coding swarm system.

## Overview

The AI CTO Hub implements a centralized intelligence system that manages multiple project repositories ("spokes") through a hub-and-spoke model. The system enables:

- **Recursive Learning**: Improves across projects by sharing lessons and patterns
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
1. Fetches global context (universal lessons + North Star) from the hub
2. Fetches local context (project lessons + North Star + decision log) from the spoke
3. Combines contexts to create a comprehensive prompt for Nemotron-3
4. Requests JSON-formatted responses with value impact analysis
5. Posts proposals as GitHub issues with clear reasoning and code patches

### Maintenance Scripts
- `scripts/prune-logs.js`: Archives old decision logs to prevent context bloat

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
- Verify that the hub receives the request and creates a GitHub issue in the spoke repo

## How It Works

### The Heartbeat Mechanism
Each spoke repository contains a GitHub Action (`.github/workflows/call-hub.yml`) that:
- Triggers every 30 minutes (`cron: '*/30 * * * *'`) for debugging/hunting
- Triggers every Sunday at midnight (`cron: '0 0 * * 0'`) for refactoring
- Sends a POST request to the hub's Vercel endpoint with:
  - Repository owner and name
  - Mode (`debug`, `hunt`, or `refactor`)

### Agent Decision Flow
When the hub receives a request:
1. Loads global context from its own files
2. Fetches local context from the target spoke repository via GitHub API
3. Constructs a prompt combining:
   - Role specification (Senior AI CTO in specific mode)
   - Global standards and North Star
   - Local project context and lessons
   - Recent decision history (for peer review between agents)
4. Calls Nemotron-3 with strict JSON response requirements
5. Logs the decision to the spoke's `ai_decision_log.json`
6. Posts the proposal as a GitHub issue with clear value impact analysis

### Recursive Learning Loop
1. Agents in individual spokes make decisions and log them
2. Periodically, the hub aggregates insights from all spokes
3. Global lessons and North Star guidance are updated based on cross-project patterns
4. New spokes automatically inherit this collective wisdom
5. Existing spokes benefit from updated global context on each heartbeat

## Values Alignment

This system is designed to continuously improve toward producing:
- **Accurate Code**: Through proactive debugging, hunting for silent errors, and value-aligned decision making
- **Efficient Code**: Through weekly refactoring that eliminates Frankenstein code and reduces complexity
- **User Value**: Through North Star alignment that prioritizes emotional UX outcomes over technical perfection
- **White Glove Service**: Through forgiving design principles and invisible complexity that delights users

Each project in the portfolio benefits from the collective intelligence of the swarm while maintaining its unique characteristics through local North Star and lessons files.