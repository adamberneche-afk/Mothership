// Real implementation of the "Maintenance Scripts" capability README always
// claimed. The previous version of this file was a no-op stub
// ("Pruner initialized. Ready for Sunday maintenance.") that nothing ever
// invoked and that didn't touch a single decision log.
//
// Runs as a plain GitHub Actions script (no AI, no Vercel call) - it only
// needs a GitHub token with cross-repo write access, mirrored here as the
// GLOBAL_GITHUB_TOKEN Actions secret on this repo (the Vercel env var of
// the same name doesn't reach an Actions runner).
//
// Usage: node scripts/prune-logs.js
//   Env: RETENTION_DAYS (default 90), DRY_RUN=true to report without writing

import { Octokit } from '@octokit/rest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SPOKES_REGISTRY_PATH = join(process.cwd(), 'spokes.json');
const DECISION_LOG_PATH = 'ai_decision_log.json';
const ARCHIVE_LOG_PATH = 'ai_decision_log_archive.json';
const DEFAULT_RETENTION_DAYS = 90;

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

// Entries without a parseable timestamp are treated as "recent" (kept) -
// safer to keep something we can't date than to silently archive it.
function partitionByAge(entries, retentionDays, now) {
  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const recent = [];
  const old = [];
  for (const entry of entries) {
    const t = entry && entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
    if (!Number.isNaN(t) && t < cutoffMs) old.push(entry);
    else recent.push(entry);
  }
  return { recent, old };
}

// Prunes one spoke's decision log. Archive-then-truncate: the archive write
// happens first, so a failure between the two writes leaves an entry
// duplicated in both files (safe, idempotent on the next run) rather than
// lost.
//
// Retries the whole read-partition-write cycle a few times on failure - most
// likely a stale-sha conflict from a heartbeat run (autonomous_agent.js)
// appending a new decision entry in the same window this pruner is reading
// and writing. Re-reading from scratch each attempt picks up that new entry
// instead of clobbering it.
export async function pruneSpoke(octokit, spoke, { retentionDays = DEFAULT_RETENTION_DAYS, dryRun = false, now = Date.now(), maxAttempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { entries: liveEntries, sha: liveSha } = await readJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH);
    const { recent, old } = partitionByAge(liveEntries, retentionDays, now);

    if (old.length === 0) {
      return { owner: spoke.owner, repo: spoke.repo, moved: 0, skipped: true };
    }

    if (dryRun) {
      return { owner: spoke.owner, repo: spoke.repo, moved: old.length, dryRun: true };
    }

    try {
      const { entries: archiveEntries, sha: archiveSha } = await readJsonArrayFile(octokit, spoke.owner, spoke.repo, ARCHIVE_LOG_PATH);
      const updatedArchive = [...archiveEntries, ...old];
      await writeJsonArrayFile(octokit, spoke.owner, spoke.repo, ARCHIVE_LOG_PATH, updatedArchive, archiveSha, 'chore: archive old decision-log entries');
      await writeJsonArrayFile(octokit, spoke.owner, spoke.repo, DECISION_LOG_PATH, recent, liveSha, 'chore: prune archived entries from decision log');
      return { owner: spoke.owner, repo: spoke.repo, moved: old.length, dryRun: false };
    } catch (e) {
      lastError = e;
      // Loop and retry with a fresh read on the next iteration.
    }
  }
  throw lastError;
}

export async function pruneAllSpokes(octokit, options = {}) {
  const spokes = loadSpokesRegistry();
  const results = [];
  for (const spoke of spokes) {
    try {
      results.push(await pruneSpoke(octokit, spoke, options));
    } catch (e) {
      results.push({ owner: spoke.owner, repo: spoke.repo, error: e.message });
    }
  }
  return results;
}

// CLI entry point - only runs when this file is executed directly, not
// when the test harness imports pruneSpoke/pruneAllSpokes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const retentionDays = Number(process.env.RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  const dryRun = process.env.DRY_RUN === 'true';
  const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });

  pruneAllSpokes(octokit, { retentionDays, dryRun })
    .then((results) => {
      console.log(JSON.stringify(results, null, 2));
      if (results.some((r) => r.error)) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
