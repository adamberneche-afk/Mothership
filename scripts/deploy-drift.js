// Real, Mothership-native deploy-drift check - reacts to gas/'s
// self-reported version marker (delivered as a `repository_dispatch`
// payload, .github/workflows/deploy-drift.yml) by comparing it against
// what git currently expects (scripts/deploy-drift-expected-marker.js),
// then opening, updating, or closing a single pinned tracking issue - same
// "update in place, reopen if a human closed it" pattern
// scripts/watchdog.js's publishWatchdogReport already uses. Ported from
// KOS's own tools/deploy-drift/check.js, simplified for a single GAS
// project (no per-project registry needed) and switched to this repo's
// own Octokit convention instead of raw fetch.
//
// The payload driving this is UNTRUSTED input the moment gas/'s
// GLOBAL_GITHUB_TOKEN could ever leak (Script Properties are plaintext to
// anyone with editor access to that project - the same exposure
// review_queue.js's own comments already discuss for other Script
// Properties) - `sha` is validated against a strict 40-hex-char pattern
// before it's used for anything, including being written into an issue
// body.
//
// Usage (as the deploy-drift.yml workflow step): node scripts/deploy-drift.js
// Reads DEPLOY_DRIFT_SHA / DEPLOY_DRIFT_REPORTED_AT from the environment.

import { Octokit } from '@octokit/rest';
import { expectedDeployMarker } from './deploy-drift-expected-marker.js';

const HUB_OWNER = process.env.HUB_GITHUB_OWNER || 'adamberneche-afk';
const HUB_REPO = process.env.HUB_GITHUB_REPO || 'Mothership';
const DRIFT_ISSUE_LABEL = 'mothership-deploy-drift';
const DRIFT_ISSUE_TITLE = 'Deploy drift: gas/ Apps Script backend';
const SHA_RE = /^[0-9a-f]{40}$/;

// Pure - no network, no git. Given a self-report and a way to look up what
// git expects, decides what happened. Split out from main() so this is
// testable with a fake expectedMarkerFn instead of the real git-backed one.
export function evaluateReport({ reportedSha, reportedAt }, expectedMarkerFn = expectedDeployMarker) {
  if (!reportedSha || !SHA_RE.test(reportedSha)) {
    return { status: 'invalid', reason: `reported sha "${reportedSha}" is not a 40-char hex commit SHA` };
  }

  const expected = expectedMarkerFn();
  if (!expected.sha) {
    return { status: 'invalid', reason: "git has no commit history for gas/'s tracked files" };
  }

  return expected.sha === reportedSha
    ? { status: 'match', expected, reportedSha, reportedAt }
    : { status: 'drift', expected, reportedSha, reportedAt };
}

export function buildDriftIssueBody({ expected, reportedSha, reportedAt }) {
  return [
    "**gas/** self-reported a version that doesn't match what git expects.",
    '',
    `- Git expects: \`${expected.sha}\` (${expected.subject}, ${expected.committedAt})`,
    `- Live deployment reported: \`${reportedSha}\` as of ${reportedAt}`,
    '',
    "This usually means either a `clasp push` didn't fully land, or the code was " +
      'pushed but never promoted to the live deployment (`clasp deploy -i <id> -V <n>` ' +
      '- see README.md\'s "Alternative: Deploy Without Vercel" section). Push and/or ' +
      "promote the deployment, then this closes itself on gas/'s next scheduled self-report.",
    '',
    `_Last checked: ${new Date().toISOString()}_`
  ].join('\n');
}

async function findExistingDriftIssue(octokit) {
  const { data } = await octokit.issues.listForRepo({
    owner: HUB_OWNER, repo: HUB_REPO, state: 'all', labels: DRIFT_ISSUE_LABEL, per_page: 10
  });
  return data.find((issue) => issue.title === DRIFT_ISSUE_TITLE) || null;
}

// Opens/updates the pinned issue on drift; closes it (with a resolution
// comment) if it's currently open and this report is clean. Never creates
// an issue for a clean report - gas/ having never drifted should never
// have a tracking issue at all.
export async function publishDriftStatus(octokit, result) {
  const existing = await findExistingDriftIssue(octokit);

  if (result.status === 'drift') {
    const body = buildDriftIssueBody(result);
    if (existing) {
      const wasClosed = existing.state === 'closed';
      const updateParams = { owner: HUB_OWNER, repo: HUB_REPO, issue_number: existing.number, body };
      if (wasClosed) updateParams.state = 'open';
      await octokit.issues.update(updateParams);
      return { action: wasClosed ? 'reopened' : 'updated', issueUrl: existing.html_url };
    }
    const created = await octokit.issues.create({
      owner: HUB_OWNER, repo: HUB_REPO, title: DRIFT_ISSUE_TITLE, body, labels: [DRIFT_ISSUE_LABEL]
    });
    return { action: 'created', issueUrl: created.data.html_url };
  }

  // Clean report - only act if there's an OPEN issue to close.
  if (existing && existing.state === 'open') {
    const commentBody = `Resolved: \`${result.expected.sha}\` reported as live as of ${result.reportedAt}.`;
    await octokit.issues.createComment({ owner: HUB_OWNER, repo: HUB_REPO, issue_number: existing.number, body: commentBody });
    await octokit.issues.update({ owner: HUB_OWNER, repo: HUB_REPO, issue_number: existing.number, state: 'closed' });
    return { action: 'closed', issueUrl: existing.html_url };
  }
  return { action: 'none', issueUrl: existing ? existing.html_url : null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = {
    reportedSha: process.env.DEPLOY_DRIFT_SHA || '',
    reportedAt: process.env.DEPLOY_DRIFT_REPORTED_AT || new Date().toISOString()
  };
  const result = evaluateReport(report);
  console.log(JSON.stringify(result, null, 2));

  if (result.status === 'invalid') {
    console.error(`Rejected report: ${result.reason}`);
    process.exitCode = 1;
  } else {
    const octokit = new Octokit({ auth: process.env.GLOBAL_GITHUB_TOKEN });
    publishDriftStatus(octokit, result)
      .then((publishResult) => {
        console.log(`Issue ${publishResult.action}${publishResult.issueUrl ? ': ' + publishResult.issueUrl : ''}`);
        process.exitCode = result.status === 'drift' ? 1 : 0;
      })
      .catch((err) => {
        console.error('deploy-drift check failed:', err);
        process.exitCode = 1;
      });
  }
}
