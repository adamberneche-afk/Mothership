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
      Output your response as JSON with "action_summary", "code_patch", and "value_impact".
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
            "content": "{\n  \"name\": \"ai-cto-hub\",\n  \"version\": \"1.0.0\",\n  \"dependencies\": {\n    \"@octokit/rest\": \"^19.0.0\"\n  }\n}"
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
    print("3. You are now ready to onboard 'Spoke' projects.")
    print("="*50)

if __name__ == "__main__":
    setup_hub()