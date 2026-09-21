// Local verification harness for lib/email.js's sendEmail - the single
// most important property being tested is "this never throws, and never
// fails whatever request/webhook it's attached to," matching the fail-soft
// convention already established for ai_decision_log.json/
// usage/{tenantId}.json writes.
//
// Usage: node scripts/dev-test-email.mjs

import { sendEmail } from './../lib/email.js';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

function makeFakeResendClient({ result, throwError } = {}) {
  const calls = [];
  return {
    calls,
    emails: {
      send: async (payload) => {
        calls.push(payload);
        if (throwError) throw throwError;
        return result;
      }
    }
  };
}

async function testMissingRecipientFieldsNeverCallsOut() {
  console.log('sendEmail rejects a call missing to/subject/html without ever touching the mail client');
  const resendClient = makeFakeResendClient({ result: { data: { id: 'x' }, error: null } });
  const result = await sendEmail({ to: '', subject: 'hi', html: '<p>hi</p>' }, { apiKey: 'key', fromEmail: 'from@x.com', resendClient });
  check('not sent', result.sent === false);
  check('the client was never called', resendClient.calls.length === 0);
}

async function testMissingConfigNeverCallsOutAndNeverThrows() {
  console.log('sendEmail with no RESEND_API_KEY/NOTIFICATION_FROM_EMAIL configured short-circuits to not-sent without ever calling the client');
  const resendClient = makeFakeResendClient({ result: { data: { id: 'x' }, error: null } });
  const noKey = await sendEmail({ to: 'a@x.com', subject: 'hi', html: '<p>hi</p>' }, { apiKey: undefined, fromEmail: 'from@x.com', resendClient });
  const noFrom = await sendEmail({ to: 'a@x.com', subject: 'hi', html: '<p>hi</p>' }, { apiKey: 'key', fromEmail: undefined, resendClient });
  check('missing apiKey -> not sent', noKey.sent === false && noKey.reason === 'not configured');
  check('missing fromEmail -> not sent', noFrom.sent === false && noFrom.reason === 'not configured');
  check('the client was never called in either case', resendClient.calls.length === 0);
}

async function testSuccessfulSendReportsSentTrue() {
  console.log('a successful Resend send reports sent: true, with the right from/to/subject/html passed through');
  const resendClient = makeFakeResendClient({ result: { data: { id: 'email_123' }, error: null } });
  const result = await sendEmail({ to: 'customer@example.com', subject: 'Your access was suspended', html: '<p>details</p>' }, { apiKey: 'key', fromEmail: 'support@mothership.example', resendClient });
  check('sent: true', result.sent === true);
  check('the payload was passed through correctly', resendClient.calls[0].from === 'support@mothership.example' && resendClient.calls[0].to === 'customer@example.com' && resendClient.calls[0].subject === 'Your access was suspended');
}

async function testResendApiErrorNeverThrowsJustReportsNotSent() {
  console.log('a Resend API-level error (the {data: null, error: {...}} shape the SDK itself returns, not a thrown exception) is reported as not-sent with a reason, never thrown');
  const resendClient = makeFakeResendClient({ result: { data: null, error: { message: 'invalid recipient domain' } } });
  const result = await sendEmail({ to: 'bad@nowhere', subject: 'hi', html: '<p>hi</p>' }, { apiKey: 'key', fromEmail: 'from@x.com', resendClient });
  check('sent: false', result.sent === false);
  check('the reason names the real error', result.reason === 'invalid recipient domain');
}

async function testThrownNetworkErrorIsCaughtNeverPropagates() {
  console.log('a genuinely thrown error (network failure) from the mail client is caught - sendEmail itself never throws');
  const resendClient = makeFakeResendClient({ throwError: new Error('ECONNRESET') });
  let threw = false;
  let result;
  try {
    result = await sendEmail({ to: 'a@x.com', subject: 'hi', html: '<p>hi</p>' }, { apiKey: 'key', fromEmail: 'from@x.com', resendClient });
  } catch (e) {
    threw = true;
  }
  check('sendEmail did not throw', threw === false);
  check('reported as not sent', result && result.sent === false && result.reason === 'ECONNRESET');
}

async function main() {
  await testMissingRecipientFieldsNeverCallsOut();
  await testMissingConfigNeverCallsOutAndNeverThrows();
  await testSuccessfulSendReportsSentTrue();
  await testResendApiErrorNeverThrowsJustReportsNotSent();
  await testThrownNetworkErrorIsCaughtNeverPropagates();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
