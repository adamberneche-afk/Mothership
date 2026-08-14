---
name: mothership-live-review
description: On-demand replacement for the AI-backend call in api/autonomous_agent.js's processRequest - the invoking Claude session performs the debug/hunt/refactor review itself instead of calling an external, undeployed AI API. Use when asked to run a real Mothership review against a registered spoke, or to "close the loop" / make the autonomous review functional without a live Vercel/Apps Script deployment.
---

# Mothership live review (on-demand, no external AI backend needed)

## Why this exists

`api/autonomous_agent.js`'s `processRequest` is fully built and tested (dry-run
default, decision-log dedup, rate cap, response validation) but has never once
run for real end-to-end - it needs a deployed backend (Vercel or Apps Script,
neither ever actually deployed) *and* a working `AI_API_KEY`/`AI_BASE_URL`
(never configured). Both are long-standing, disclosed blockers, not something
a repo change fixes.

This skill sidesteps both by having the invoking Claude session *be* the AI
step, directly, right now - reusing every other rail `processRequest` already
has (decision-log dedup, dry-run default, rate cap, decision logging) exactly
as designed, with real GitHub reads/writes via whatever GitHub access this
session already has (MCP tools, `gh`, or a real token - whichever actually
works in the calling environment).

**Deliberately on-demand only, no schedule.** This project's own worst
incident (~1,974 fabricated issues) and its second-worst (thinkos-server/tais
spamming 100+/135+ failed scheduled runs on an unset secret) were both
consequences of *unattended, scheduled* automation. Don't wire this into a
cron/Routine without that being its own explicit decision later - see
`lessons.md`'s dated entry on this pivot for the reasoning.

**Never files a real GitHub issue on its own.** This procedure always
computes and reports what `processRequest` would do in dry-run mode. Actually
calling `issues.create` for a specific finding requires a separate, explicit
go-ahead from whoever invoked this skill for *that* finding - treat it the
same as any other outward-facing, semi-reversible action.

## Inputs

- `owner`, `repo` - must be a spoke registered in this repo's `spokes.json`
  (or explicitly confirmed with the user if not - registration is what makes
  a spoke visible to the Recursive Learning Loop and health reporting, not a
  hard requirement for a one-off review, but worth flagging if missing).
- `mode` - one of `debug`, `hunt`, `refactor`. Reject anything else, matching
  `MODE_INSTRUCTIONS` in `api/autonomous_agent.js`.
- `commit` (optional) - a specific commit sha to review. Defaults to the
  spoke's actual latest commit on its default branch, matching what the real
  deployed handler would operate on. Pass this explicitly when demonstrating
  or re-running against a specific past commit rather than "whatever's
  latest right now."

## Procedure (mirrors `processRequest` exactly - same schema, same rails)

1. **Validate `mode`** against the real `MODE_INSTRUCTIONS` map in
   `api/autonomous_agent.js` (debug/hunt/refactor) - use its exact task text,
   don't paraphrase it.

2. **Resolve the target commit.** Latest commit on the spoke's default
   branch, unless `commit` was passed explicitly.

3. **Decision-log dedup check first**, before doing anything else. Fetch the
   spoke's `ai_decision_log.json`. If a non-`ai_error` entry already exists
   for this exact `commitSha` + `mode`, **stop** and report that prior
   decision instead of re-reviewing - this is the real dedup rail, not
   optional.

4. **Fetch the real diff.** Prefer `https://github.com/{owner}/{repo}/commit/{sha}.diff`
   (GitHub's public, unauthenticated diff endpoint) over a commit-info API
   call if the latter doesn't surface per-file `patch` text (confirmed true
   for at least one MCP tool surface this project has used). Truncate at
   12,000 chars, matching `MAX_DIFF_CHARS` in the real code, with the same
   `[... diff truncated at 12000 chars ...]` marker appended. If there's no
   usable diff (empty commit, binary-only, unreachable), **log a
   `no_diff_skip` decision and stop** - never invent something to review.

5. **Fetch local spoke context** - `lessons.md` and `NORTH_STAR.md` from the
   spoke's root, in the same all-or-nothing shape the real code uses: if
   *either* fetch fails, the whole `localContext` becomes
   `"No local context found."`, even if the other one succeeded. This is a
   real, confirmed-live quirk (e.g. a spoke whose `NORTH_STAR.md` has moved
   off-root loses its otherwise-valid `lessons.md` too) - replicate it
   faithfully rather than silently being smarter than the deployed code;
   note it as a finding if it fires, don't patch around it mid-review.

6. **Fetch hub-level context** - `universal_lessons.md`, `north_star_framework.md`,
   `hub_lessons.md` from this repo's own working tree (real files, not a
   fetch - matches how the real code reads them off local disk).

7. **Fetch prior-decisions context** - the last 5 entries from the same
   decision log fetched in step 3, formatted exactly like
   `priorDecisionsContext` in the real code (`- [timestamp] mode=X outcome=Y: summary`).

8. **Build the review** - assemble the identical prompt structure
   `processRequest` builds (ROLE/MODE/GLOBAL STANDARDS/GLOBAL NORTH
   STAR/HUB LESSONS/LOCAL CONTEXT/PRIOR DECISIONS/RECENT CODE CHANGES/TASK),
   then genuinely reason over it as the invoking Claude session - this is
   the one step that's not a mechanical fetch. Ground every claim in the
   actual diff text (same "Ground Every Claim in Real Code" rule already in
   `universal_lessons.md`'s Engineering Compass) - if nothing real stands
   out, that's a valid, expected outcome, not a failure to try harder.
   Produce a verdict in exactly this shape:
   ```json
   { "has_findings": boolean, "action_summary": string, "code_patch": string, "value_impact": { "reasoning": string } }
   ```

9. **Validate the verdict** the same way the real code does: non-empty
   strings required for `action_summary`, `code_patch`, and
   `value_impact.reasoning` when `has_findings` is true. If `has_findings`
   is `false`, **log a `no_findings` decision and stop.**

10. **Dry-run report (the default and normal outcome of this skill).** For a
    real finding, log a `dry_run_would_create` decision-log entry (same
    `{timestamp, mode, commitSha, outcome, issueUrl: null, summary}` shape,
    `summary` = `action_summary` truncated to 200 chars) and report to
    whoever invoked this skill exactly what *would* be filed: title
    `CTO HUB: ${mode.toUpperCase()} Action`, body
    `### Value Impact\n${reasoning}\n\n### Patch\n\`\`\`\n${code_patch}\n\`\`\``.
    **Stop here unless explicitly told to actually file it.**

11. **Going live for a specific finding (only on separate, explicit
    confirmation).** Count today's UTC `cto-hub-auto`-labeled issues on the
    spoke (same query the real rate cap uses); if at or above
    `RATE_CAP_PER_REPO_PER_DAY` (default 3), report the cap was hit and log
    a `rate_capped` decision instead of filing. Otherwise file the issue
    (label `cto-hub-auto`, exact title/body from step 10) and log a
    `created` decision entry with the real `issueUrl`.

## Explicitly out of scope for this skill

- No scheduled trigger - on-demand only, per the decision this skill exists
  to implement. Revisit as its own explicit choice if ever wanted.
- Doesn't touch `api/autonomous_agent.js`, `gas/autonomous_agent.js`, or
  `api/recursive_learning.js`/`gas/recursive_learning.js` - those stay in the
  repo as documented, still-buildable alternatives for a fully autonomous,
  provider-swappable, cron-triggered deployment for whoever eventually does
  get Vercel/Apps Script live with a real AI key. This skill is a different,
  additional path to a working state today, not a replacement for that code.
- Doesn't extend this same on-demand pattern to `recursive_learning.js`'s
  cross-spoke pattern-finding - a real, reasonable future extension, flagged
  here rather than bundled in.
