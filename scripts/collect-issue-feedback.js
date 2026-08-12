// Closes a real gap: today the only way a spoke maintainer can tell the
// system "this finding was wrong" is closing the issue - nothing reads
// that. GitHub's issue objects already carry a `reactions` summary
// (`{"+1", "-1", laugh, ...}`) on every issue `issues.listForRepo` returns -
// no extra API call needed - so a thumbs-down on a hub-filed issue is a
// free, already-available signal that's simply never been read. This
// script reads it and attaches it to the matching `ai_decision_log.json`
// entry, so `api/recursive_learning.js`/`gas/recursive_learning.js` can
// factor a spoke's negative feedback into what they propose.
//
// Runs as a plain GitHub Actions script (no AI, no Vercel call) - like
// prune-logs.js/health-report.js, it only needs a GitHub token, mirrored as
// the GLOBAL_GITHUB_TOKEN Actions secret on this repo.
//
// Usage: node scripts/collect-issue-feedback.js

import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = join(process.cwd(), 'spokes.json');
const DECISION_LOG_PATH = 'ai_decision_log.json';
const HUB_ISSUE_LABEL = 'cto-hub-auto';

function loadSpokesRegistry() {
  if (!existsSync(SPOKES_REGISTRY_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SPOKES_REGISTRY_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function readJsonArrayFile(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { entries: Array.isArray(parsed) ? parsed : [], sha: data.sha };
  } catch (e) {
    return { entries: [], sha: null };
  }
}

async function writeJsonArrayFile(octokit, owner, repo, path, entries, sha, message) {
  const content = Buffer.from(JSON.stringify(entries, null, 2)).toString('base64');
  const params = { owner, repo, path, message, content };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

async function fetchLabeledIssues(octokit, owner, repo) {
  const { data } = await octokit.issues.listForRepo({
    owner, repo, state: 'all', labels: HUB_ISSUE_LABEL, per_page: 100
  });
  return data;
}

function reactionCounts(issue) {
  const r = issue && issue.reactions;
  return { thumbsUp: (r && r['+1']) || 0, thumbsDown: (r && r['-1']) || 0 };
}

function feedbackChanged(existing, counts) {
  if (!existing) return true;
  return existing.thumbsDown !== counts.thumbsDown || existing.thumbsUp !== counts.thumbsUp;
}

// Collects feedback for one spoke. Only decisions with outcome 'created'
// ever have a non-null issueUrl (confirmed against makeLogEntry in both
// autonomous_agent.js files) - anything else is skipped, there's nothing to
// match a reaction to. Matches by exact issueUrl === issue.html_url string
// equality; both come from the same GitHub field, so this is reliable
// without needing to parse an issue number out of the URL.
//
// Same retry-on-conflict shape as prune-logs.js's pruneSpoke: re-read the
// live log fresh on every attempt, in case a concurrent heartbeat run
// appended a new decision in the same window. Only writes if something
// actually changed - a run with no new reactions writes nothing.
export async function collectFeedbackForSpoke(octokit, spoke, { now = Date.now(), maxAttempts = 3 } = {}) {
  const issues = await fetchLabeledIssues(octokit, spoke.owner, spoke.repo);
  const issuesByUrl = new Map(issues.map((issue) => [issue.html_url, issue]));

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { entries, sha } = await readJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH);

    const updated = entries.map((entry) => {
      if (!entry || !entry.issueUrl) return entry;
      const issue = issuesByUrl.get(entry.issueUrl);
      if (!issue) return entry;
      const counts = reactionCounts(issue);
      // Only a real negative signal is worth recording - a plain thumbs-up
      // with no thumbs-down isn't feedback the system needs to act on.
      if (counts.thumbsDown === 0) return entry;
      if (!feedbackChanged(entry.feedback, counts)) return entry;
      return { ...entry, feedback: { thumbsUp: counts.thumbsUp, thumbsDown: counts.thumbsDown, checkedAt: new Date(now).toISOString() } };
    });

    const changedCount = updated.filter((entry, i) => entry !== entries[i]).length;
    if (changedCount === 0) {
      return { owner: spoke.owner, repo: spoke.repo, updated: 0 };
    }

    try {
      await writeJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH, updated, sha, 'chore: record maintainer feedback on filed issues');
      return { owner: spoke.owner, repo: spoke.repo, updated: changedCount };
    } catch (e) {
      lastError = e;
      // Loop and retry with a fresh read on the next iteration.
    }
  }
  throw lastError;
}

export async function collectFeedbackForAllSpokes(octokit, options = {}) {
  const spokes = loadSpokesRegistry();
  const results = [];
  for (const spoke of spokes) {
    try {
      results.push(await collectFeedbackForSpoke(octokit, spoke, options));
    } catch (e) {
      results.push({ owner: spoke.owner, repo: spoke.repo, error: e.message });
    }
  }
  return results;
}

// CLI entry point - only runs when this file is executed directly, not
// when the test harness imports collectFeedbackForSpoke/collectFeedbackForAllSpokes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  collectFeedbackForAllSpokes(octokit)
    .then((results) => {
      console.log(JSON.stringify(results, null, 2));
      if (results.some((r) => r.error)) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
