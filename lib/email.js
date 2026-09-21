// Transactional email, used for two things: notifying a customer when
// api/github_app_webhook.js suspends their tenant (they'd otherwise only
// discover it when Mothership silently stops working), and delivering a
// fresh Customer Portal link on request (see api/request_portal_link.js).
//
// resend (official npm package, simple HTTP API, generous free tier) is
// the one deliberate new dependency for this - flagged as swappable if the
// operator already has a preferred provider, since the actual integration
// surface is one API call (`resend.emails.send`).
//
// Fail-soft by design, matching this project's existing "decision-log
// writes are best-effort" convention (ai_decision_log.json,
// usage/{tenantId}.json): a failed or misconfigured send is logged and
// swallowed here - it must NEVER fail the webhook/request it's attached
// to. A suspended tenant not getting an email is a real, but lesser, gap
// than a webhook 500ing because a third-party mail API had a bad day.

import { Resend } from 'resend';

// Returns { sent: true } on success, or { sent: false, reason } on any
// failure - missing config, a Resend API error, a network error - never
// throws.
export async function sendEmail({ to, subject, html }, {
  apiKey = process.env.RESEND_API_KEY,
  fromEmail = process.env.NOTIFICATION_FROM_EMAIL,
  resendClient
} = {}) {
  if (!to || !subject || !html) {
    return { sent: false, reason: 'to/subject/html are all required' };
  }
  if (!apiKey || !fromEmail) {
    console.warn(`lib/email.js: RESEND_API_KEY/NOTIFICATION_FROM_EMAIL not configured - email to ${to} ("${subject}") was not sent`);
    return { sent: false, reason: 'not configured' };
  }
  const client = resendClient || new Resend(apiKey);
  try {
    const result = await client.emails.send({ from: fromEmail, to, subject, html });
    if (result && result.error) {
      console.warn(`lib/email.js: Resend rejected the send to ${to}: ${result.error.message || result.error}`);
      return { sent: false, reason: result.error.message || String(result.error) };
    }
    return { sent: true };
  } catch (e) {
    console.warn(`lib/email.js: failed to send email to ${to}: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}
