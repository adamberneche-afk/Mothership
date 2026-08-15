// Minimal liveness endpoint - confirms the deployment is up and responding
// to real HTTP requests, with zero external dependencies (no GitHub call,
// no AI call, no credentials needed at all, no side effects). This is
// what .github/workflows/deploy-vercel.yml's post-deploy smoke test
// (scripts/smoke-test.js) hits before considering a deploy successful -
// deliberately NOT smoke-testing api/autonomous_agent.js/
// api/recursive_learning.js directly, since those need real GitHub/AI
// credentials to do anything meaningful and could have side effects; a
// dedicated liveness endpoint is the standard, safe pattern instead.
//
// Includes the deployed commit SHA - Vercel sets VERCEL_GIT_COMMIT_SHA
// automatically on every deployment - so a smoke test (or a human) can
// confirm a deploy actually shipped the EXPECTED commit, not just that
// something is listening on the URL.

export function buildHealthResponse({ now = Date.now(), env = process.env } = {}) {
  return {
    status: 'ok',
    timestamp: new Date(now).toISOString(),
    commit: env.VERCEL_GIT_COMMIT_SHA || null
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  res.status(200).json(buildHealthResponse({}));
}
