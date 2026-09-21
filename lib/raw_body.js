// Shared raw-request-body reader for the two webhook endpoints that need
// the exact, unparsed request bytes - api/stripe_webhook.js and
// api/github_app_webhook.js. Both verify a signature computed over the raw
// body by their respective provider (Stripe, GitHub), and Vercel's default
// body-parsing would discard those exact bytes before either handler ever
// saw them - hence `export const config = { api: { bodyParser: false } }`
// in both files, and this manual stream-drain instead.
//
// Deduped out of what used to be two byte-identical copies of this same
// function (plus MAX_BODY_BYTES), same convention as lib/secrets.js's own
// dedup - see that file's header comment.
//
// The explicit byte cap is a concrete, cheap DoS mitigation: reject and
// stop reading past the cap before buffering further, rather than trusting
// a well-behaved Content-Length header from a request nothing has
// authenticated yet.

export const MAX_BODY_BYTES = 1_000_000;

export function readRawBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
