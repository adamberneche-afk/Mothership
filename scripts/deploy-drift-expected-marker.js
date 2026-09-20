// deploy-drift-expected-marker - "what should gas/'s self-reported deploy
// version marker say right now, according to git?" Ported from KOS's own
// tools/deploy-drift/expected-marker.js, simplified for Mothership's
// single GAS project (KOS's version is keyed by project name across nine
// projects; this hub only ever has one - gas/).
//
// Pure - no network, no credential, nothing but this repo's own commit
// history via `git log`. Run from the repo root, same convention as
// scripts/watchdog.js's own WORKFLOWS_DIR use of process.cwd().
//
// "The marker" is the full 40-char SHA of the most recent commit that
// touched any of GAS_PROJECT_FILES - deliberately the full SHA, never an
// abbreviated one: git's abbreviation length isn't fixed (it grows as a
// repo needs more characters to stay unique), so two correct computations
// of "the same commit" could print different-length short SHAs depending
// on when/where they run. A short form is fine for a human-readable
// message, never for the actual equality check (see deploy-drift.js).
//
// Usage: node scripts/deploy-drift-expected-marker.js -> JSON on stdout
// Exit code 1 on a git error or if gas/ has no commit history at all.

import { execFileSync } from 'child_process';

// Every file clasp actually pushes as gas/'s live Apps Script project -
// explicit, not a glob over gas/*, so a new non-deployed file dropped into
// gas/ (a doc, a workflow template like *.apps-script.example.yml, the
// .clasp.json.example scaffold) never silently counts toward "what commit
// does git expect" for the deployed code. Excludes
// gas/deploy_version_marker.js itself - see that file's own header
// comment for why (a commit can't embed its own SHA).
export const GAS_PROJECT_FILES = [
  'gas/Code.js',
  'gas/appsscript.json',
  'gas/autonomous_agent.js',
  'gas/constants.js',
  'gas/deploy_version_report.js',
  'gas/github.js',
  'gas/recursive_learning.js',
  'gas/review_queue.js',
  'gas/settings.js'
];

// files/cwd are injectable so tests can point this at a scratch git repo
// instead of mutating (or depending on the exact state of) this session's
// real one - same DI convention as execFn/octokitFactory elsewhere in this
// project.
export function expectedDeployMarker({ files = GAS_PROJECT_FILES, cwd = process.cwd() } = {}) {
  const existing = files.filter((f) => {
    try {
      // stdio: 'ignore' - a missing file/no HEAD yet is an EXPECTED,
      // silently-handled case (a not-yet-committed marker file, a
      // brand-new scratch repo in tests), not something worth printing
      // git's own "fatal: ... does not exist" noise for on every check.
      execFileSync('git', ['cat-file', '-e', `HEAD:${f}`], { cwd, stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  });
  if (!existing.length) {
    return { sha: null, committedAt: null, subject: null, files };
  }

  const out = execFileSync(
    'git',
    ['log', '-1', '--format=%H%x1f%cI%x1f%s', '--', ...existing],
    { cwd, encoding: 'utf8' }
  ).trim();

  if (!out) {
    // Tracked, but never committed on this branch's reachable history -
    // shouldn't happen for real project files, but fail informatively
    // rather than silently returning a made-up marker.
    return { sha: null, committedAt: null, subject: null, files: existing };
  }

  const [sha, committedAt, subject] = out.split('\x1f');
  return { sha, committedAt, subject, files: existing };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = expectedDeployMarker();
    console.log(JSON.stringify(result, null, 2));
    if (!result.sha) process.exitCode = 1;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
