// Entry point for self-service onboarding - a plain GET redirect into
// GitHub's own hosted App-install picker, carrying a freshly signed state
// token (see lib/onboarding_token.js) so api/github_app_callback.js can
// later verify this specific install flow wasn't forged.
//
// No tenant, spoke, or any other record is created here - this endpoint's
// only side effect is a redirect. Provisioning only ever happens in
// api/stripe_webhook.js, after BOTH the App install (re-verified against
// GitHub, not just trusted from the query string) and a real payment are
// confirmed - see api/github_app_callback.js's header comment for the
// full sequencing rationale.

import { randomUUID } from 'crypto';
import { signOnboardingToken } from '../lib/onboarding_token.js';

export function buildInstallRedirect({ now = Date.now(), generateId = randomUUID, env = process.env } = {}) {
  const appSlug = env.GITHUB_APP_SLUG;
  if (!appSlug) {
    return { httpStatus: 500, body: { error: 'GITHUB_APP_SLUG is not configured' } };
  }
  const onboardingId = generateId();
  const state = signOnboardingToken({ onboardingId }, { now });
  const redirectUrl = `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
  return { httpStatus: 302, redirectUrl };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const result = buildInstallRedirect({});
  if (result.httpStatus === 302) {
    res.writeHead(302, { Location: result.redirectUrl });
    res.end();
    return;
  }
  res.status(result.httpStatus).json(result.body);
}
