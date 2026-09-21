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
// HOW IT LEARNS WHETHER A SECRET IS SET, WITHOUT EVER HOLDING ONE
//
// GitHub gives a repo no API for listing its own secrets: the REST endpoint
// needs a PAT, and GITHUB_TOKEN has no permission scope that covers it -
// there is no `secrets:` key in a workflow's permissions block.
//
// The obvious move is `toJSON(secrets)`, reduced to names with jq. That is
// what this did first, and CodeQL's js/excessive-secrets-exposure rule
// flagged it on the very PR that introduced it: every organization and
// repository secret VALUE is handed to the runner, to learn a list of
// names. The mitigations were real (names extracted before Node started,
// env: rather than run:, no set -x) but the exposure was real too, and a
// narrower design existed.
//
// So it never sees a value now. secrets-doctor.yml runs in two jobs:
//
//   plan   - no secrets context at all. Derives the referenced names from
//            the workflow files and emits them as a matrix.
//   probe  - one matrix leg per name, whose only secret-derived input is
//            `${{ secrets[matrix.secret] != '' }}` - a BOOLEAN. The
//            comparison happens inside the expression; what reaches the
//            runner is "true" or "false".
//
// No secret value enters any runner, for any secret, at any point. That is
// strictly better than the first design rather than a compromise with it,
// and it removed a disclosed limitation as a side effect: `!= ''` tests
// non-emptiness, where a name-list could only test presence.
//
// It also costs something honest: this can no longer report a CONFIGURED
// secret that no workflow references, which the first version did. Seeing
// what a rename left behind was worth having, and it required enumerating
// every secret, which is precisely the exposure. Informational nicety
// against a real exposure is not a close call.
//
// THE CONTROL LEG. A mechanism that silently evaluated to empty for every
// secret would report every one of them missing - loud, but wrong, and
// wrong in a way that looks like a real emergency. So the matrix always
// carries GITHUB_TOKEN, which Actions mints on every run and which must
// therefore always come back configured. If the control reports missing,
// the indexing itself is broken and this says so instead of accusing the
// repo of losing its credentials.
//
// A REAL, DISCLOSED LIMIT: this confirms a secret exists and is non-empty.
// It cannot confirm the VALUE is correct. It would have caught every
// incident above, and it would NOT catch a token that is set but expired.
// Mothership's hub doctor exercises a few credentials live for that reason;
// doing the same here would mean firing real side effects (a hub review, an
// email) just to validate a secret, which is worse than the gap it closes.
//
// Per-repo settings come from .github/floor.json under `doctor`, so this
// file stays byte-identical in every repo the floor is distributed to -
// see CICD_FLOOR.md's "why runtime config instead of templating" section.
//
// Dispatch-only, never scheduled. Every incident above was a scheduled job
// failing with nobody watching; another scheduled job is the last thing
// this should be. Run it when provisioning a repo, rotating a credential,
// or diagnosing a broken step.

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLOOR_CONFIG_PATH = join(ROOT, '.github', 'floor.json');

// GITHUB_TOKEN is minted per run by Actions itself and is always present,
// so a workflow referencing it can never be the failure this looks for.
const ALWAYS_PROVIDED = new Set(['GITHUB_TOKEN']);

// The control leg - see the file header. GITHUB_TOKEN is minted by Actions
// on every run, so a probe reporting it absent proves the mechanism broke,
// not that a credential went missing.
const CONTROL_SECRET = 'GITHUB_TOKEN';
export { CONTROL_SECRET };

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

// ---------------------------------------------------------------------------
// plan: what to probe, derived from the workflows
// ---------------------------------------------------------------------------

// The control leg is first so a broken mechanism surfaces before any real
// secret is judged by it.
export function buildProbePlan(workflowsDir, config = loadConfig()) {
  const referenced = collectReferencedSecrets(workflowsDir);
  const names = [...referenced.keys()].filter((n) => !ALWAYS_PROVIDED.has(n)).sort();
  return {
    // CONTROL_SECRET always rides along - see the file header on why a
    // mechanism that evaluates to empty for everything must be detectable.
    matrix: [CONTROL_SECRET, ...names],
    referenced,
    workflowFiles: listWorkflowFiles(workflowsDir),
    optionalNames: names.filter((n) => Object.prototype.hasOwnProperty.call(config.optionalSecrets, n))
  };
}

export function renderPlan({ matrix, referenced, workflowFiles, optionalNames }) {
  const lines = ["secrets-doctor - plan (no secret value is read in this job)", ''];
  if (workflowFiles.length === 0) {
    lines.push('::error::No workflow files found. This check scanned nothing, which is not the same as finding nothing wrong.');
  }
  if (matrix.length === 1) {
    lines.push('No workflow references any secret. Only the control leg will run.');
  }
  for (const name of matrix) {
    if (name === CONTROL_SECRET) {
      lines.push(`  ctl  ${CONTROL_SECRET} - control leg: Actions mints this every run, so it must come back configured`);
      continue;
    }
    const where = (referenced.get(name) || []).join(', ');
    const optional = optionalNames.includes(name) ? ' (declared optional)' : '';
    lines.push(`  ->   ${name}${optional} - referenced by ${where}`);
  }
  lines.push('');
  lines.push(`Scanned ${workflowFiles.length} workflow file(s); ${matrix.length - 1} secret(s) to probe.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// probe: the verdict for one secret
// ---------------------------------------------------------------------------

// `configured` is the boolean the workflow computed inside the expression -
// the only secret-derived value that ever reaches a runner. Anything other
// than a clean "true"/"false" means the workflow did not wire this leg
// correctly, and that is reported rather than guessed at: an unparseable
// input must never read as "configured".
export function probeSecret({ name, configuredRaw, config = loadConfig(), workflowsDir }) {
  if (!name) {
    return { name: null, status: 'broken', detail: 'no secret name was passed to this probe - secrets-doctor.yml must set SECRET_NAME' };
  }
  if (configuredRaw !== 'true' && configuredRaw !== 'false') {
    return {
      name,
      status: 'broken',
      detail: `expected SECRET_CONFIGURED to be "true" or "false", got ${JSON.stringify(configuredRaw ?? null)}. ` +
        'Treating an unreadable probe as a failure rather than as "configured".'
    };
  }
  const configured = configuredRaw === 'true';

  if (name === CONTROL_SECRET) {
    return configured
      ? { name, status: 'control-ok', detail: 'control leg passed - secret indexing works on this runner' }
      : {
          name,
          status: 'broken',
          detail:
            'CONTROL LEG FAILED. Actions mints this secret on every run, so it cannot genuinely be absent. ' +
            'The `secrets[matrix.secret]` indexing is not working, which means every other leg in this run is ' +
            'reporting "missing" for a mechanical reason and not a real one. Fix the workflow, not the secrets.'
        };
  }

  const files = workflowsDir ? (collectReferencedSecrets(workflowsDir).get(name) || []) : [];
  const where = files.length > 0 ? ` - referenced by ${files.join(', ')}` : '';

  if (configured) {
    return { name, status: 'present', detail: `configured and non-empty (the value itself is not checked)${where}` };
  }
  const reason = Object.prototype.hasOwnProperty.call(config.optionalSecrets, name) ? config.optionalSecrets[name] : null;
  if (reason) {
    return { name, status: 'optional-missing', detail: `not configured, declared optional: ${reason}${where}` };
  }
  return { name, status: 'missing', detail: `referenced by a workflow but not configured on this repo${where}` };
}

export function renderProbe(result) {
  const lines = [];
  if (result.status === 'present' || result.status === 'control-ok') {
    lines.push(`  ok   ${result.name} - ${result.detail}`);
  } else if (result.status === 'optional-missing') {
    lines.push(`  warn ${result.name} - ${result.detail}`);
  } else {
    lines.push(`::error::${result.name || '(no name)'} - ${result.detail}`);
    if (result.status === 'missing') {
      lines.push(
        "If this secret may legitimately be unset, declare it in .github/floor.json's doctor.optionalSecrets with the reason."
      );
    }
  }
  return lines.join('\n');
}

export function probeFailed(result) {
  return result.status === 'missing' || result.status === 'broken';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!repoRootLooksValid()) {
    console.error(
      `::error::secrets-doctor: computed repo root ${ROOT} contains no .github/ directory, so this is ` +
        'probably not the repository root. This file belongs at <repo>/scripts/secrets-doctor.mjs - ' +
        'see CICD_FLOOR.md. Refusing to report a result for a tree that may not be the repo.'
    );
    process.exit(2);
  }

  const workflowsDir = join(ROOT, '.github', 'workflows');
  const mode = process.argv.includes('--probe') ? 'probe' : 'plan';

  if (mode === 'plan') {
    const plan = buildProbePlan(workflowsDir);
    console.log(renderPlan(plan));
    // Consumed by the probe job's strategy.matrix. A matrix needs its
    // values at workflow-parse time and so cannot read a file, which is the
    // same constraint CICD_FLOOR.md records for CodeQL's language matrix.
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `secrets=${JSON.stringify(plan.matrix)}\n`);
    }
    process.exitCode = plan.workflowFiles.length === 0 ? 1 : 0;
  } else {
    const result = probeSecret({
      name: process.env.SECRET_NAME,
      configuredRaw: process.env.SECRET_CONFIGURED,
      workflowsDir
    });
    console.log(renderProbe(result));
    process.exitCode = probeFailed(result) ? 1 : 0;
  }
}
