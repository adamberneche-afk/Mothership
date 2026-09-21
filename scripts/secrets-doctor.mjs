// Floor check 10 (see CICD_FLOOR.md) - a dispatch-only pre-flight that
// every secret this repo's workflows actually reference is actually
// configured, so an unset credential is found on purpose rather than by a
// scheduled job failing quietly for months.
//
// This is the incident class, twice over. A spoke's call-hub.yml failed
// 100+ scheduled runs on a VERCEL_URL that was never set. TSO's "Pull
// Vercel Environment Information" step failed instantly on every run since
// at least Feb 2026, and the cause turned out to be a VERCEL_TOKEN that had
// never been created at all. Both were one API call away from being known.
//
// WHY THE SECRET LIST IS DERIVED, NOT WRITTEN DOWN
//
// Mothership's scripts/doctor.js and TSO's tools/doctor/check.js both name
// their secrets in source. That is the right shape for a hub, which checks
// OTHER repos, but for a repo checking itself it puts the same list in two
// or three places - the script, the doctor workflow's own env block, and
// the workflows that really use the secret - and nothing reconciles them.
//
// It has already drifted. TSO's doctor checks VERCEL_URL,
// VERCEL_BYPASS_TOKEN and CRON_SECRET. TSO's db-backup.yml also references
// BACKUP_DATABASE_URL and BACKUP_PASSPHRASE, and its doctor has never
// looked at either - so a database backup silently failing on an unset
// passphrase is invisible to the exact tool built to see it. A list a human
// has to remember to extend is the same shape as the bug.
//
// So this derives the expected set from the workflow files themselves, and
// compares it against the set actually available at runtime. Adding a
// workflow that needs a new secret makes this check notice on its own.
//
// HOW THE AVAILABLE SET GETS HERE, AND WHY THAT IS SAFE
//
// GitHub gives no API for a repo to list its own secrets: the REST
// endpoint needs a PAT, and GITHUB_TOKEN has no permission scope that
// covers it (there is no `secrets:` key in a workflow's permissions
// block). The only thing a workflow can see is the `secrets` context, and
// the only way to enumerate it is `toJSON(secrets)`, which carries VALUES.
//
// So secrets-doctor.yml reduces it to names before this script ever runs:
// one `jq -r 'keys[]'` over the JSON, passed in through `env:` rather than
// interpolated into `run:`, writing a names-only file. This script receives
// a list of NAMES. No secret value is ever in its process, which is why it
// can never print one - not as a precaution, but because it does not have
// them. That is the whole reason for the two-step shape; collapsing it into
// one step that hands the JSON to Node would work and would be worse.
//
// A REAL, DISCLOSED LIMIT: this confirms a secret with the right NAME
// exists. It cannot confirm the VALUE is correct, or even non-empty -
// GitHub exposes neither. It would have caught every incident above, and it
// would NOT catch a token that is set but expired. Mothership's hub doctor
// exercises a few credentials live for that reason; doing the same here
// would mean firing real side effects (a hub review, an email) just to
// validate a secret, which is worse than the gap it closes.
//
// Per-repo settings come from .github/floor.json under `doctor`, so this
// file stays byte-identical in every repo the floor is distributed to -
// see CICD_FLOOR.md's "why runtime config instead of templating" section.
//
// Dispatch-only, never scheduled. Every incident above was a scheduled job
// failing with nobody watching; another scheduled job is the last thing
// this should be. Run it when provisioning a repo, rotating a credential,
// or diagnosing a broken step.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLOOR_CONFIG_PATH = join(ROOT, '.github', 'floor.json');

// GITHUB_TOKEN is minted per run by Actions itself and is always present,
// so a workflow referencing it can never be the failure this looks for.
const ALWAYS_PROVIDED = new Set(['GITHUB_TOKEN']);

export function loadConfig(configPath = FLOOR_CONFIG_PATH) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')).doctor || {};
  } catch (e) {
    raw = {};
  }
  return {
    // A map of name -> why it may legitimately be unset. A map rather than
    // a list so an entry has to carry its reason, the same discipline
    // doc-currency's knownAbsentPaths uses: that is what makes an
    // exemption reviewable instead of a silent mute.
    optionalSecrets: raw.optionalSecrets || {}
  };
}

// See doc-currency.mjs's copy of this for the full reasoning: ROOT is right
// only at the canonical scripts/<name>.mjs, and wrong QUIETLY anywhere
// else, since a scan rooted in the wrong directory finds no workflows and
// reports nothing to fix.
export function repoRootLooksValid(root = ROOT) {
  return existsSync(join(root, '.github'));
}

// YAML comments are stripped before scanning, because a secret named in
// prose is not a reference. This is not hypothetical: KOS's gas-lint.yml
// explains itself with the phrase "a bare `secrets.X` reference inside an
// `if:` conditional", which a naive scan reports as a missing secret named
// X. A check that invents credentials nobody needs gets muted, and a muted
// check is the thing this floor exists to prevent.
//
// A `#` inside a quoted scalar is not a comment, so quotes are tracked.
export function stripYamlComments(content) {
  return content
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === '\\') i++;
          else if (c === quote) quote = null;
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (c === '#') {
          // A `#` only opens a comment at the start of a line or after
          // whitespace; `a#b` is an ordinary scalar.
          if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

// `secrets.NAME` and `secrets['NAME']`, with a left boundary so a longer
// identifier ending in "secrets" cannot match. Also not hypothetical:
// KOS's `needs.check-sandbox-secrets.outputs.configured` otherwise reports
// a missing secret literally named "outputs".
const DOT_REF_RE = /(^|[^A-Za-z0-9_-])secrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
const INDEX_REF_RE = /(^|[^A-Za-z0-9_-])secrets\[\s*['"]([^'"]+)['"]\s*\]/g;

export function extractSecretReferences(workflowContent) {
  const body = stripYamlComments(workflowContent);
  const names = [
    ...[...body.matchAll(DOT_REF_RE)].map((m) => m[2]),
    ...[...body.matchAll(INDEX_REF_RE)].map((m) => m[2])
  ];
  return [...new Set(names)];
}

export function listWorkflowFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

// Every secret any workflow references, with the workflows that reference
// it - so a finding names where to go rather than just what is missing.
export function collectReferencedSecrets(workflowsDir) {
  const byName = new Map();
  for (const file of listWorkflowFiles(workflowsDir)) {
    const content = readFileSync(join(workflowsDir, file), 'utf8');
    for (const name of extractSecretReferences(content)) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(file);
    }
  }
  return byName;
}

// The names-only file secrets-doctor.yml writes. Absent means this script
// cannot answer its own question, which is a hard failure and never a pass:
// "no list provided" and "nothing missing" must not look alike.
export function readAvailableSecretNames(filePath) {
  if (!filePath) return null;
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function runSecretsDoctor({
  config = loadConfig(),
  root = ROOT,
  workflowsDir,
  availableSecretNames
} = {}) {
  const dir = workflowsDir || join(root, '.github', 'workflows');
  const workflowFiles = listWorkflowFiles(dir);
  const referenced = collectReferencedSecrets(dir);

  const problems = [];

  // Non-vacuity. A repo with no workflows, or workflows referencing no
  // secrets, is a legitimate state - but it is NOT the same as a clean
  // run, and reporting it as one is how a check stops meaning anything.
  if (workflowFiles.length === 0) {
    problems.push('No workflow files found. This check scanned nothing, which is not the same as finding nothing wrong.');
  }
  if (availableSecretNames === null || availableSecretNames === undefined) {
    problems.push(
      'No available-secret-name list was provided, so nothing could be compared. ' +
        "secrets-doctor.yml's first step writes it; run this through that workflow rather than directly."
    );
  }

  const available = new Set(availableSecretNames || []);
  const checks = [];

  for (const [name, files] of [...referenced.entries()].sort()) {
    if (ALWAYS_PROVIDED.has(name)) {
      checks.push({ name, status: 'built-in', files, detail: 'provided by Actions on every run' });
      continue;
    }
    const optionalReason = Object.prototype.hasOwnProperty.call(config.optionalSecrets, name)
      ? config.optionalSecrets[name]
      : null;
    if (available.has(name)) {
      checks.push({ name, status: 'present', files, detail: "configured (name only - this cannot verify the value)" });
    } else if (optionalReason) {
      checks.push({ name, status: 'optional-missing', files, detail: optionalReason });
    } else {
      checks.push({ name, status: 'missing', files, detail: 'referenced by a workflow but not configured on this repo' });
    }
  }

  // A configured secret nothing references. Not a failure - plenty of
  // reasons exist - but worth seeing: it is what a rename leaves behind,
  // and reading one name in a list is cheaper than finding the orphan
  // later.
  const referencedNames = new Set([...referenced.keys()]);
  const unreferenced = [...available].filter((n) => !referencedNames.has(n) && !ALWAYS_PROVIDED.has(n)).sort();

  const hasFindings = problems.length > 0 || checks.some((c) => c.status === 'missing');
  return { checks, unreferenced, problems, workflowCount: workflowFiles.length, hasFindings };
}

export function renderReport({ checks, unreferenced, problems, workflowCount, hasFindings }) {
  const lines = ['secrets-doctor - every secret this repo\'s workflows reference', ''];

  for (const p of problems) lines.push(`::error::${p}`);
  if (problems.length > 0) lines.push('');

  if (checks.length === 0) {
    lines.push('No workflow references any secret.');
  }
  for (const c of checks) {
    const where = c.files.join(', ');
    if (c.status === 'present') {
      lines.push(`  ok   ${c.name} - ${c.detail} [${where}]`);
    } else if (c.status === 'built-in') {
      lines.push(`  ok   ${c.name} - ${c.detail} [${where}]`);
    } else if (c.status === 'optional-missing') {
      lines.push(`  warn ${c.name} - not configured, declared optional: ${c.detail} [${where}]`);
    } else {
      lines.push(`::error::${c.name} is ${c.detail} - referenced by ${where}`);
    }
  }

  lines.push('');
  if (unreferenced.length > 0) {
    lines.push(`Configured but referenced by no workflow (not a failure - often what a rename leaves behind): ${unreferenced.join(', ')}`);
  }
  lines.push(`Scanned ${workflowCount} workflow file(s).`);
  lines.push('');
  lines.push(
    hasFindings
      ? 'One or more secrets a workflow needs are not configured, or this check could not do its job - see above. A secret that may legitimately be unset belongs in floor.json\'s doctor.optionalSecrets, with the reason.'
      : 'Every secret this repo\'s workflows reference is configured.'
  );
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!repoRootLooksValid()) {
    console.error(
      `::error::secrets-doctor: computed repo root ${ROOT} contains no .github/ directory, so this is ` +
        'probably not the repository root. This file belongs at <repo>/scripts/secrets-doctor.mjs - ' +
        'see CICD_FLOOR.md. Refusing to report a result for a tree that may not be the repo.'
    );
    process.exit(2);
  }
  const result = runSecretsDoctor({
    availableSecretNames: readAvailableSecretNames(process.env.AVAILABLE_SECRET_NAMES_FILE)
  });
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : renderReport(result));
  process.exitCode = result.hasFindings ? 1 : 0;
}
