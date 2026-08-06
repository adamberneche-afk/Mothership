import os
import subprocess

def setup_hub():
    print("Initializing the AI Mothership (Hub)...")

    # Define the core files for the Hub
    hub_files = [
        # 1. THE UNIVERSAL CONTEXT
        {
            "path": "universal_lessons.md",
            "content": "# Universal Engineering Standards\n\n- **Security**: Never commit API keys; use environment variables.\n- **Quality**: All code must be typed (TypeScript) or linted.\n- **Architecture**: Prefer flat logic over deep nesting.\n- **Documentation**: Every Spoke must maintain a NORTH_STAR.md."
        },
        {
            "path": "north_star_framework.md",
            "content": "# Global North Star Framework\n\n## Core Values\n- **Efficiency without Anxiety**: UX should feel fast and calm.\n- **Invisible Complexity**: The AI handles the mess; the user sees the magic.\n- **Forgiving Design**: Always provide a path to undo or go back."
        },

        # 2. THE CENTRAL INTELLIGENCE (Vercel Worker)
        {
            "path": "api/autonomous_agent.js",
            "content": """import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Caps how much diff text gets forwarded to the LLM per run - keeps prompt
// size and API cost bounded.
const MAX_DIFF_CHARS = 12000;

// Every issue this handler files is tagged with this label. GitHub creates
// the label automatically on first use. It's how the rate cap below counts
// "issues the hub created" without confusing them with anything a human
// filed manually, and it's what the health-report/decision-log tooling
// filters on too.
const HUB_ISSUE_LABEL = 'cto-hub-auto';

// Counts issues carrying HUB_ISSUE_LABEL that were created since UTC
// midnight today, for the rate cap below. Derived on-demand from GitHub's
// primary issue list (not the Search API, which lags real-time) - there is
// no database in this stack, so "how many have we filed today" has to be
// computed from GitHub itself every time, not tracked in memory (a Vercel
// function's memory doesn't survive between invocations anyway).
async function countHubIssuesCreatedTodayUTC(octokit, owner, repo) {
  const { data } = await octokit.issues.listForRepo({
    owner, repo, state: 'all', labels: HUB_ISSUE_LABEL,
    sort: 'created', direction: 'desc', per_page: 100
  });
  const startOfDayUTC = new Date();
  startOfDayUTC.setUTCHours(0, 0, 0, 0);
  let count = 0;
  for (const issue of data) {
    // Sorted newest-first, so the moment we hit one from before today we
    // can stop - everything after it is even older.
    if (new Date(issue.created_at) < startOfDayUTC) break;
    count++;
  }
  return count;
}

// The actual decision logic, factored out of the Vercel handler so it can
// be driven by a local test harness (scripts/dev-test-handler.mjs) with a
// fake octokit/fetch instead of hitting GitHub and the AI API for real.
// `dryRunOverride` lets tests force a specific dry-run state instead of
// reading the DRY_RUN_MODE env var.
export async function processRequest(reqBody, { octokit, fetchImpl = fetch, dryRunOverride } = {}) {
  const { owner, repo, mode } = reqBody || {};

  if (!owner || !repo || !mode) {
    return { httpStatus: 400, body: { error: 'owner, repo, and mode are required' } };
  }

  // SAFETY RAIL 1: dry-run mode. Defaults to true so a missing/misconfigured
  // env var never files a real issue by accident - DRY_RUN_MODE has to be
  // explicitly set to the string "false" in Vercel to go live. Every
  // response from this point on carries `dryRun` so callers (and the
  // decision log / health report built on top of this) can always tell
  // which mode produced it.
  const dryRun = dryRunOverride !== undefined
    ? dryRunOverride
    : process.env.DRY_RUN_MODE !== 'false';

  // Fetch Global Context from Hub
  const universalLessonsPath = join(process.cwd(), 'universal_lessons.md');
  const globalNorthStarPath = join(process.cwd(), 'north_star_framework.md');
  const hubLessonsPath = join(process.cwd(), 'hub_lessons.md');

  const universalLessons = existsSync(universalLessonsPath)
    ? readFileSync(universalLessonsPath, 'utf8')
    : "";
  const globalNorthStar = existsSync(globalNorthStarPath)
    ? readFileSync(globalNorthStarPath, 'utf8')
    : "";
  const hubLessons = existsSync(hubLessonsPath)
    ? readFileSync(hubLessonsPath, 'utf8')
    : "";

  // Fetch Local Context from the Spoke repo
  let localContext = "No local context found.";
  try {
    const { data: lsData } = await octokit.repos.getContent({ owner, repo, path: 'lessons.md' });
    const { data: nsData } = await octokit.repos.getContent({ owner, repo, path: 'NORTH_STAR.md' });
    localContext = `
      LOCAL LESSONS: ${Buffer.from(lsData.content, 'base64').toString()}
      LOCAL NORTH STAR: ${Buffer.from(nsData.content, 'base64').toString()}
    `;
  } catch (e) {
    localContext = "No local context found.";
  }

  // Fetch REAL CODE context: the diff of the spoke's latest commit.
  //
  // Every "audit" used to run with zero actual code in the prompt - only
  // lessons.md/NORTH_STAR.md, which are notes files, not source. That
  // guaranteed the LLM would hallucinate a plausible-looking bug + patch
  // every single run, since it had nothing real to look at. If there's no
  // usable diff (empty commit, binary-only changes, repo unreachable, huge
  // commit GitHub won't return patches for), we skip the AI call and the
  // issue entirely instead of asking it to invent something out of nothing.
  let codeDiff = null;
  try {
    const { data: commits } = await octokit.repos.listCommits({ owner, repo, per_page: 1 });
    if (commits.length > 0) {
      const { data: commitDetail } = await octokit.repos.getCommit({ owner, repo, ref: commits[0].sha });
      const patches = (commitDetail.files || [])
        .filter(f => typeof f.patch === 'string' && f.patch.length > 0)
        .map(f => `--- ${f.filename} (${f.status}) ---\\n${f.patch}`)
        .join('\\n\\n');
      if (patches.length > 0) {
        codeDiff = patches.length > MAX_DIFF_CHARS
          ? patches.slice(0, MAX_DIFF_CHARS) + `\\n\\n[... diff truncated at ${MAX_DIFF_CHARS} chars ...]`
          : patches;
      }
    }
  } catch (e) {
    codeDiff = null;
  }

  if (!codeDiff) {
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'No usable code diff found for the latest commit', dryRun } };
  }

  let taskInstruction;
  if (mode === 'debug') {
    taskInstruction = 'Review the RECENT CODE CHANGES below for bugs, unsafe patterns, and code quality issues actually present in this diff. Only report something you can point to directly in the diff text.';
  } else if (mode === 'hunt') {
    taskInstruction = "Review the RECENT CODE CHANGES below for silent logic errors - places where the code runs without crashing but produces a wrong result. You cannot execute code or run tests; base findings only on what's visible in the diff text.";
  } else if (mode === 'refactor') {
    taskInstruction = 'Review the RECENT CODE CHANGES below for opportunities to simplify complex logic, remove redundancy, or improve maintainability. Only report something you can point to directly in the diff text.';
  } else {
    return { httpStatus: 400, body: { error: `Unknown mode: ${mode}`, dryRun } };
  }

  const prompt = `
    ROLE: Senior AI CTO. MODE: ${mode.toUpperCase()}.
    GLOBAL STANDARDS: ${universalLessons}
    GLOBAL NORTH STAR: ${globalNorthStar}
    HUB LESSONS: ${hubLessons}
    LOCAL CONTEXT: ${localContext}

    RECENT CODE CHANGES (diff of the latest commit):
    ${codeDiff}

    TASK: ${taskInstruction}
    If you find nothing worth reporting, set "has_findings" to false and
    leave "code_patch" and "value_impact.reasoning" as empty strings - do
    not invent an issue just to have something to say.
    Respond with ONLY valid JSON, exactly this shape:
    {
      "has_findings": boolean,
      "action_summary": string,
      "code_patch": string,
      "value_impact": { "reasoning": string }
    }
  `;

  const aiResponse = await fetchImpl(`${process.env.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    })
  });

  const aiData = await aiResponse.json();
  const rawContent = aiData?.choices?.[0]?.message?.content;

  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'AI returned no content', dryRun } };
  }

  // Parse and STRICTLY VALIDATE the AI's response before acting on it.
  //
  // A JSON.parse failure does not fabricate a synthetic result and file an
  // issue anyway, and a successful parse is checked field-by-field (non-empty
  // strings for action_summary/code_patch/value_impact.reasoning) before use.
  // Unmet validation returns a 200 "Skipped" response instead of posting.
  let result;
  try {
    result = JSON.parse(rawContent);
  } catch (parseError) {
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: 'AI did not return valid JSON', raw: rawContent.slice(0, 500), dryRun }
    };
  }

  if (result.has_findings !== true) {
    return { httpStatus: 200, body: { status: 'Skipped', reason: 'AI reported no findings', dryRun } };
  }

  const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
  const isValidShape =
    isNonEmptyString(result.action_summary) &&
    isNonEmptyString(result.code_patch) &&
    result.value_impact &&
    typeof result.value_impact === 'object' &&
    isNonEmptyString(result.value_impact.reasoning);

  if (!isValidShape) {
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: 'AI response did not match the required shape', raw: rawContent.slice(0, 500), dryRun }
    };
  }

  const issueTitle = `CTO HUB: ${mode.toUpperCase()} Action`;
  const issueBody = `### Value Impact\\n${result.value_impact.reasoning}\\n\\n### Patch\\n\\`\\`\\`\\n${result.code_patch}\\n\\`\\`\\``;

  // SAFETY RAIL 1 (continued): a real, validated finding - but dry-run mode
  // means we report what we *would* have filed instead of actually filing it.
  if (dryRun) {
    return {
      httpStatus: 200,
      body: { status: 'DryRunFinding', dryRun: true, wouldCreate: { title: issueTitle, body: issueBody } }
    };
  }

  // SAFETY RAIL 2: a hard cap on how many issues this handler will file
  // against one repo per day, live mode only. This is what stands between
  // a misbehaving prompt/model and a repeat of the ~1,974-issue incident -
  // even if validation above somehow passes bad data every run, this bounds
  // the damage to a handful of issues instead of one every 30 minutes for
  // months.
  const cap = Number(process.env.RATE_CAP_PER_REPO_PER_DAY || 3);
  const countToday = await countHubIssuesCreatedTodayUTC(octokit, owner, repo);
  if (countToday >= cap) {
    return {
      httpStatus: 200,
      body: { status: 'Skipped', reason: `Rate cap reached (${countToday}/${cap} issues filed today)`, dryRun }
    };
  }

  const created = await octokit.issues.create({
    owner, repo,
    title: issueTitle,
    body: issueBody,
    labels: [HUB_ISSUE_LABEL]
  });

  return { httpStatus: 200, body: { status: "Success", dryRun, issueUrl: created.data.html_url } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  try {
    const { httpStatus, body } = await processRequest(req.body, { octokit, fetchImpl: fetch });
    return res.status(httpStatus).json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}"""
        },

        # 3. MEMORY MANAGEMENT
        {
            "path": "scripts/prune-logs.js",
            "content": "const fs = require('fs');\n// Logic to archive old decision logs from Spokes (executed via GitHub Actions)\nconsole.log(\"Pruner initialized. Ready for Sunday maintenance.\");"
        },

        # 4. INFRASTRUCTURE
        {
            "path": "package.json",
            "content": "{\n  \"name\": \"ai-cto-hub\",\n  \"version\": \"1.0.0\",\n  \"type\": \"module\",\n  \"dependencies\": {\n    \"@octokit/rest\": \"^19.0.0\"\n  }\n}"
        },
        {
            "path": ".gitignore",
            "content": "node_modules/\n.env\n"
        }
    ]

    for f in hub_files:
        os.makedirs(os.path.dirname(f["path"]), exist_ok=True) if os.path.dirname(f["path"]) else None
        with open(f["path"], "w") as file:
            file.write(f["content"])
        print(f"Created: {f['path']}")

    print("\nInstalling Hub dependencies...")
    subprocess.run(["npm", "install"], shell=True)

    print("\n" + "="*50)
    print("MOTHERSHIP INITIALIZED")
    print("="*50)
    print("1. Deploy this folder to Vercel.")
    print("2. Set your Environment Variables in Vercel:")
    print("   - AI_API_KEY, AI_MODEL, AI_BASE_URL")
    print("   - GLOBAL_GITHUB_TOKEN (Personal Access Token with Repo access)")
    print("   - DRY_RUN_MODE (optional, defaults to true - set to \"false\" only")
    print("     after watching dry-run output for a while; see README)")
    print("   - RATE_CAP_PER_REPO_PER_DAY (optional, defaults to 3)")
    print("3. You are now ready to onboard 'Spoke' projects.")
    print("="*50)

if __name__ == "__main__":
    setup_hub()