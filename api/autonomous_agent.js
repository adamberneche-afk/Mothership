import { Octokit } from '@octokit/rest';
import { execSync } from 'child_process';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
  const { owner, repo, mode } = req.body;

  try {
     // Fetch Global Context from Hub
     const universalLessonsPath = path.join(process.cwd(), 'universal_lessons.md');
     const globalNorthStarPath = path.join(process.cwd(), 'north_star_framework.md');
     const hubLessonsPath = path.join(process.cwd(), 'hub_lessons.md');
     
     const universalLessons = fs.existsSync(universalLessonsPath) 
         ? fs.readFileSync(universalLessonsPath, 'utf8') 
         : "";
     const globalNorthStar = fs.existsSync(globalNorthStarPath) 
         ? fs.readFileSync(globalNorthStarPath, 'utf8') 
         : "";
     const hubLessons = fs.existsSync(hubLessonsPath) 
         ? fs.readFileSync(hubLessonsPath, 'utf8') 
         : "";

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

    let prompt = "";
    
    if (mode === 'debug') {
       prompt = `
         ROLE: Senior AI CTO. MODE: DEBUG.
         GLOBAL STANDARDS: ${universalLessons}
         GLOBAL NORTH STAR: ${globalNorthStar}
         HUB LESSONS: ${hubLessons}
         LOCAL CONTEXT: ${localContext}

         TASK: Perform a debug audit of the latest code. 
         Identify code quality issues, unsafe patterns, and potential bugs.
         Be specific about what you found and where.
         Output your response as JSON with "action_summary", "code_patch", and "value_impact".
       `;
    } 
    
    else if (mode === 'hunt') {
       prompt = `
         ROLE: Senior AI CTO. MODE: SILENT ERROR HUNTER.
         GLOBAL STANDARDS: ${universalLessons}
         GLOBAL NORTH STAR: ${globalNorthStar}
         HUB LESSONS: ${hubLessons}
         LOCAL CONTEXT: ${localContext}

         TASK: Run property-based tests to find silent logic errors.
         Report any test failures as potential silent errors in the codebase.
         Be specific about what tests failed and what they indicate.
         Output your response as JSON with "action_summary", "code_patch", and "value_impact".
       `;
    }
    
    else if (mode === 'refactor') {
       prompt = `
         ROLE: Senior AI CTO. MODE: REFACTOR.
         GLOBAL STANDARDS: ${universalLessons}
         GLOBAL NORTH STAR: ${globalNorthStar}
         HUB LESSONS: ${hubLessons}
         LOCAL CONTEXT: ${localContext}

         TASK: Perform a refactor audit of the latest code. 
         Identify opportunities to simplify complex logic, eliminate redundant code, and improve maintainability.
         Be specific about what you found and where.
         Output your response as JSON with "action_summary", "code_patch", and "value_impact".
       `;
    }

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
    
    // Try to parse the AI's response as JSON
    let result;
    try {
      result = JSON.parse(aiData.choices[0].message.content);
    } catch (parseError) {
      // If parsing fails, try to extract meaningful information and create a structured response
      const content = aiData.choices[0].message.content;
      
      // Extract action summary (first sentence or first 100 chars)
      const actionSummary = content.split('.')[0] + '.' || content.substring(0, 100) + '...';
      
      // Look for code-like content in the response
      let codePatch = "// AI suggestions:\n// ";
      codePatch += content.substring(0, 200).replace(/\n/g, '\n// ');
      
      // Determine what the AI was trying to tell us
      let benefitStrengthened = "Processing";
      let frictionCreated = "See analysis";
      let reasoning = "The AI provided analysis but not in the expected JSON format.";
      
      // Try to extract value impact information from the response
      if (content.toLowerCase().includes('efficiency') || content.toLowerCase().includes('performance')) {
        benefitStrengthened = "Efficiency without Anxiety";
      }
      if (content.toLowerCase().includes('complex') || content.toLowerCase().includes('simplify')) {
        frictionCreated = "Potential complexity reduction";
      }
      if (content.toLowerCase().includes('safe') || content.toLowerCase().includes('secure') || 
          content.toLowerCase().includes('error') || content.toLowerCase().includes('exception')) {
        benefitStrengthened = "Forgiving Design";
      }
      
      reasoning = `AI Analysis: ${content.substring(0, 300)}...`;
      
      result = {
        action_summary: actionSummary.trim(),
        code_patch: codePatch,
        value_impact: {
          benefit_strengthened: benefitStrengthened,
          friction_created: frictionCreated,
          reasoning: reasoning
        }
      };
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
