import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Caps how much diff text gets forwarded to the LLM per run - keeps prompt
// size and API cost bounded.
const MAX_DIFF_CHARS = 12000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
  const { owner, repo, mode } = req.body || {};

  if (!owner || !repo || !mode) {
    return res.status(400).json({ error: 'owner, repo, and mode are required' });
  }

  try {
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
    // This is the piece that was missing entirely before. Every prior "audit"
    // ran with zero actual code in the prompt - only lessons.md/NORTH_STAR.md,
    // which are notes files, not source. That guaranteed the LLM would
    // hallucinate a plausible-looking bug + patch every single run, since it
    // had nothing real to look at. If there's no usable diff (empty commit,
    // binary-only changes, repo unreachable, huge commit GitHub won't return
    // patches for), we skip the AI call and the issue entirely instead of
    // asking it to invent something out of nothing.
    let codeDiff = null;
    try {
      const { data: commits } = await octokit.repos.listCommits({ owner, repo, per_page: 1 });
      if (commits.length > 0) {
        const { data: commitDetail } = await octokit.repos.getCommit({ owner, repo, ref: commits[0].sha });
        const patches = (commitDetail.files || [])
          .filter(f => typeof f.patch === 'string' && f.patch.length > 0)
          .map(f => `--- ${f.filename} (${f.status}) ---\n${f.patch}`)
          .join('\n\n');
        if (patches.length > 0) {
          codeDiff = patches.length > MAX_DIFF_CHARS
            ? patches.slice(0, MAX_DIFF_CHARS) + `\n\n[... diff truncated at ${MAX_DIFF_CHARS} chars ...]`
            : patches;
        }
      }
    } catch (e) {
      codeDiff = null;
    }

    if (!codeDiff) {
      return res.status(200).json({ status: 'Skipped', reason: 'No usable code diff found for the latest commit' });
    }

    let taskInstruction;
    if (mode === 'debug') {
      taskInstruction = 'Review the RECENT CODE CHANGES below for bugs, unsafe patterns, and code quality issues actually present in this diff. Only report something you can point to directly in the diff text.';
    } else if (mode === 'hunt') {
      taskInstruction = "Review the RECENT CODE CHANGES below for silent logic errors - places where the code runs without crashing but produces a wrong result. You cannot execute code or run tests; base findings only on what's visible in the diff text.";
    } else if (mode === 'refactor') {
      taskInstruction = 'Review the RECENT CODE CHANGES below for opportunities to simplify complex logic, remove redundancy, or improve maintainability. Only report something you can point to directly in the diff text.';
    } else {
      return res.status(400).json({ error: `Unknown mode: ${mode}` });
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

    const aiResponse = await fetch(`${process.env.AI_BASE_URL}/chat/completions`, {
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
      return res.status(200).json({ status: 'Skipped', reason: 'AI returned no content' });
    }

    // Parse and STRICTLY VALIDATE the AI's response before acting on it.
    //
    // Previously: a JSON.parse failure fabricated a synthetic result from
    // substring heuristics and posted an issue anyway, and even a successful
    // parse was trusted blindly - a missing or wrong-typed field (code_patch
    // as an object, value_impact.reasoning undefined) got string-interpolated
    // straight into the issue body as literal "undefined" / "[object Object]".
    // Neither path creates an issue now unless the response is well-formed
    // JSON with real, non-empty findings.
    let result;
    try {
      result = JSON.parse(rawContent);
    } catch (parseError) {
      return res.status(200).json({
        status: 'Skipped',
        reason: 'AI did not return valid JSON',
        raw: rawContent.slice(0, 500)
      });
    }

    if (result.has_findings !== true) {
      return res.status(200).json({ status: 'Skipped', reason: 'AI reported no findings' });
    }

    const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
    const isValidShape =
      isNonEmptyString(result.action_summary) &&
      isNonEmptyString(result.code_patch) &&
      result.value_impact &&
      typeof result.value_impact === 'object' &&
      isNonEmptyString(result.value_impact.reasoning);

    if (!isValidShape) {
      return res.status(200).json({
        status: 'Skipped',
        reason: 'AI response did not match the required shape',
        raw: rawContent.slice(0, 500)
      });
    }

    await octokit.issues.create({
      owner, repo,
      title: `CTO HUB: ${mode.toUpperCase()} Action`,
      body: `### Value Impact\n${result.value_impact.reasoning}\n\n### Patch\n\`\`\`\n${result.code_patch}\n\`\`\``
    });

    return res.status(200).json({ status: "Success" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
