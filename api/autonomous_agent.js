import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
  const { owner, repo, mode } = req.body;

  try {
    // Fetch Global Context from Hub
    const universalLessons = fs.readFileSync(path.join(process.cwd(), 'universal_lessons.md'), 'utf8');
    const globalNorthStar = fs.readFileSync(path.join(process.cwd(), 'north_star_framework.md'), 'utf8');

    // Fetch Local Context from the Spoke repo
    let localContext = "";
    try {
      const { data: lsData } = await octokit.repos.getContent({ owner, repo, path: 'lessons.md' });
      const { data: nsData } = await octokit.repos.getContent({ owner, repo, path: 'NORTH_STAR.md' });
      localContext = `
        LOCAL LESSONS: ${Buffer.from(lsData.content, 'base64').toString()}
        LOCAL NORTH STAR: ${Buffer.from(nsData.content, 'base64').toString()}
      `;
    } catch (e) { localContext = "No local context found."; }

    const prompt = `
      ROLE: Senior AI CTO. MODE: ${mode}.
      GLOBAL STANDARDS: ${universalLessons}
      GLOBAL NORTH STAR: ${globalNorthStar}
      LOCAL CONTEXT: ${localContext}

      TASK: Perform a ${mode} audit of the latest code. 
      Ensure any proposed changes strengthen the North Star values.
      Output your response as JSON with "action_summary", "code_patch", and "value_impact`.
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
    const result = JSON.parse(aiData.choices[0].message.content);

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