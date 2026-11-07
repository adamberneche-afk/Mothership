// Shared constants across gas/*.js files. Apps Script gives every file in
// a project one global scope - no import/export, no per-file isolation
// (see github.js's header comment) - so a name declared with `const` in
// two files is a real SyntaxError the moment both load together, not a
// namespace clash a bundler would quietly resolve. Caught exactly this way
// by scripts/dev-test-gas-code.mjs, which loads every gas/*.js file into
// one vm context the same way a real deployment shares one script scope.
// This file exists so these are declared exactly once, loaded before
// anything that references them.
const DEFAULT_HUB_OWNER = 'adamberneche-afk';
const DEFAULT_HUB_REPO = 'Mothership';

// Multi-tenancy registries (hub-root files, fetched via hubGithub - see
// autonomous_agent.js/recursive_learning.js's own header comments), and the
// tenantId every not-yet-migrated spoke falls back to. Needed by both
// autonomous_agent.js and recursive_learning.js, hence living here instead
// of in either.
const SPOKES_REGISTRY_PATH = 'spokes.json';
const TENANTS_REGISTRY_PATH = 'tenants.json';
const DEFAULT_TENANT_ID = 'default';

// Constant-time comparison for a caller-supplied secret (a tenant caller
// key, ADMIN_SETTINGS_TOKEN) against the real one. A plain `!==` returns at
// the first differing character, which leaks how much of a guess was right;
// this loop always walks the whole expected value and folds every
// difference, including a length mismatch, into one flag. Its running time
// depends only on the expected value's length, never on the guess. Anything
// that isn't a non-empty string on either side is a mismatch. Same contract
// as lib/secrets.js's secretsEqual (Node uses crypto.timingSafeEqual).
function secretsEqual_(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  if (!supplied || !expected) return false;
  let diff = supplied.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= (i < supplied.length ? supplied.charCodeAt(i) : 0) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// Names the setting an operator has to fill in for a callerKeyRef, for a
// refusal message: "env:DEFAULT_TENANT_CALLER_KEY" -> that Script Property.
// Names only, never values.
function describeSecretRef_(ref) {
  if (!ref || typeof ref !== 'string') return 'a callerKeyRef in tenants.json';
  if (ref.startsWith('env:')) return `the ${ref.slice(4)} Script Property`;
  return `the secret behind callerKeyRef "${ref}"`;
}
