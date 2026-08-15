// Post-deploy smoke test - confirms a freshly-deployed hub endpoint is
// actually alive and responding before a CD pipeline (deploy-vercel.yml/
// deploy-apps-script.yml) considers the deploy successful. Hits the
// dedicated /health (Vercel) or ?endpoint=health (Apps Script) liveness
// route - see api/health.js/gas/Code.js's renderHealthResponse for what
// it's checking - never the AI-calling endpoints, which need real
// credentials to do anything meaningful and could have side effects.
//
// Retries a few times with a short delay before giving up, rather than
// failing on the first non-2xx/mismatch: a brief propagation lag right
// after a deploy completes (edge-cache warmup, DNS, an Apps Script
// deployment version taking a moment to become the active one) is normal,
// expected behavior, not a real problem - treating a single transient
// blip as a hard CI failure would create exactly the kind of noisy
// false-failure this project has been careful to avoid elsewhere (see
// doctor.js's deliberately narrow, honestly-scoped checks).
//
// Usage: node scripts/smoke-test.js <url> [expectedCommit]
//   node scripts/smoke-test.js https://mothership.example.com/api/health abc1234
//   node scripts/smoke-test.js "https://script.google.com/macros/s/.../exec?endpoint=health"

const TIMEOUT_MS = 15000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 3000;

// Single attempt - no retry logic here, so tests can assert exact
// pass/fail behavior for one call without needing to reason about timing.
export async function checkHealth(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, expectedCommit, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal, headers });
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, reason: 'response was not valid JSON' };
  }

  if (body.status !== 'ok') {
    return { ok: false, reason: `unexpected response body: ${JSON.stringify(body)}` };
  }

  // Apps Script's health response has no `commit` field at all (a real,
  // disclosed platform difference - see gas/Code.js's renderHealthResponse
  // comment) - only compared when both an expectation and a real value
  // exist to compare against.
  if (expectedCommit && body.commit && body.commit !== expectedCommit) {
    return { ok: false, reason: `deployed commit ${body.commit} does not match expected ${expectedCommit}` };
  }

  return { ok: true, body };
}

// Retries checkHealth up to maxAttempts times, returning as soon as one
// attempt succeeds - the actual entry point the CLI/CD pipeline uses.
export async function checkHealthWithRetry(url, {
  fetchImpl = fetch,
  timeoutMs = TIMEOUT_MS,
  expectedCommit,
  headers,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  delayMs = DEFAULT_RETRY_DELAY_MS,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  let lastResult;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await checkHealth(url, { fetchImpl, timeoutMs, expectedCommit, headers });
    if (lastResult.ok) return lastResult;
    if (attempt < maxAttempts - 1) await sleepImpl(delayMs);
  }
  return lastResult;
}

// --- CLI-only from here down ------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, expectedCommit] = process.argv.slice(2);
  if (!url) {
    console.error('Usage: node scripts/smoke-test.js <url> [expectedCommit]');
    process.exitCode = 1;
  } else {
    // Generic (not Vercel-specific) escape hatch for a platform that needs
    // one extra header to reach its own health route - e.g. Vercel
    // Deployment Protection's bypass header, set by deploy-vercel.yml via
    // SMOKE_TEST_HEADER_NAME/VALUE. Both must be non-empty, or no header is
    // sent at all - matches every other caller of VERCEL_BYPASS_TOKEN in
    // this repo, where an unset value means "no protection, nothing to add."
    const headers = (process.env.SMOKE_TEST_HEADER_NAME && process.env.SMOKE_TEST_HEADER_VALUE)
      ? { [process.env.SMOKE_TEST_HEADER_NAME]: process.env.SMOKE_TEST_HEADER_VALUE }
      : undefined;
    checkHealthWithRetry(url, { expectedCommit, headers })
      .then((result) => {
        if (result.ok) {
          console.log(`OK - ${url} is healthy: ${JSON.stringify(result.body)}`);
        } else {
          console.error(`FAIL - ${url} did not become healthy: ${result.reason}`);
          process.exitCode = 1;
        }
      })
      .catch((err) => {
        console.error(err);
        process.exitCode = 1;
      });
  }
}
