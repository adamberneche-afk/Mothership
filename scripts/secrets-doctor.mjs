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
// HOW IT LEARNS WHETHER A SECRET IS SET, AND WHY THE LIST IS GENERATED
//
// GitHub gives a repo no API for listing its own secrets: the REST endpoint
// needs a PAT, and GITHUB_TOKEN has no permission scope that covers it -
// there is no `secrets:` key in a workflow's permissions block. The only
// thing a workflow can consult is the `secrets` context.
//
// Two designs were tried and rejected by CodeQL's
// js/excessive-secrets-exposure rule, both correctly:
//
//   1. Pass the whole context as JSON and reduce it to names with jq. This
//      obviously hands every value to the runner.
//   2. A matrix over the derived names, with `secrets[<dynamic index>]`
//      collapsed to a boolean inside the expression. This looked airtight
//      and was not: with a DYNAMIC index, the Actions service cannot know
//      at dispatch time which secret a job will read, so it must ship the
//      job every secret it might need. The boolean is all that reaches the
//      step's environment, but the values are in the job payload. The
//      exposure was in a place I had not looked.
//
// A STATIC reference - `${{ secrets.NAME != '' }}` - is resolvable before
// dispatch, so the job receives that secret and no other. It is what
// Mothership's own doctor.yml has always used, and what CodeQL has never
// flagged there. So the workflow names its secrets statically after all.
//
// WHICH LOOKS LIKE THE HAND-MAINTAINED LIST THIS SET OUT TO AVOID, AND IS
// NOT, because nothing human maintains it:
//
//   --sync   rewrites the env block in secrets-doctor.yml from the names
//            the workflow files actually reference.
//   --check  verifies that block still matches, and FAILS if it does not.
//            It runs on every pull request via this repo's test suite, not
//            on dispatch, so adding a workflow that needs a new secret
//            turns a PR red until the block is regenerated.
//
// That is the same generate-then-verify shape scripts/sync-installer-copies.py
// already uses for setup_hub.py's embedded files, and it answers the real
// objection to TSO's version. The problem there was never that the list
// lived in a file; it was that a human had to remember to extend it, and
// nobody did - TSO's doctor still checks three secrets while its workflows
// reference six. A generated list with a drift gate cannot fall behind
// quietly.
//
// It also moves half the check earlier. "Is the list current?" is a
// question about files, answerable on every PR. "Are the secrets actually
// set?" needs the secrets context, so it stays on dispatch. Splitting them
// means the half that can be caught before merge is.
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

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
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

// This check's own workflow is excluded from the reference scan. Its
// generated block necessarily names every secret it checks, so counting
// those as uses would make the expected set self-fulfilling: a secret would
// stay "referenced" forever once wired, even after the workflow that
// actually needed it was deleted, and stale entries could never be
// detected. Found by a test asserting exactly that, which failed.
export const SELF_WORKFLOW = 'secrets-doctor.yml';

export function listWorkflowFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

// Every secret any workflow references, with the workflows that reference
// it - so a finding names where to go rather than just what is missing.
export function collectReferencedSecrets(workflowsDir, { excludeSelf = true } = {}) {
  const byName = new Map();
  for (const file of listWorkflowFiles(workflowsDir)) {
    if (excludeSelf && file === SELF_WORKFLOW) continue;
    const content = readFileSync(join(workflowsDir, file), 'utf8');
    for (const name of extractSecretReferences(content)) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(file);
    }
  }
  return byName;
}

// ---------------------------------------------------------------------------
// The generated env block
// ---------------------------------------------------------------------------

// Each referenced secret becomes one static reference. The comparison
// happens inside the expression, so the step's environment carries a
// boolean rather than a credential - and because the reference is static,
// the job is shipped only the secrets it names.
export const BLOCK_BEGIN = '          # >>> generated by scripts/secrets-doctor.mjs --sync - do not edit by hand';
export const BLOCK_END = '          # <<< end generated block';

export function envVarNameFor(secretName) {
  return `CONFIGURED_${secretName}`;
}

export function renderEnvBlock(secretNames) {
  const lines = [BLOCK_BEGIN];
  if (secretNames.length === 0) {
    lines.push('          # No workflow in this repo references a secret.');
  }
  for (const name of secretNames) {
    lines.push(`          ${envVarNameFor(name)}: \${{ secrets.${name} != '' }}`);
  }
  lines.push(BLOCK_END);
  return lines.join('\n');
}

// The secrets the workflow is currently wired to check, read back out of
// its own generated block - so drift is detected against the file that
// actually runs, not against an assumption about it.
export function parseWiredSecrets(workflowContent) {
  const begin = workflowContent.indexOf(BLOCK_BEGIN);
  const end = workflowContent.indexOf(BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  const body = workflowContent.slice(begin + BLOCK_BEGIN.length, end);
  return [...body.matchAll(/^\s*CONFIGURED_([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
}

export function expectedSecrets(workflowsDir, config = loadConfig()) {
  void config;
  const referenced = collectReferencedSecrets(workflowsDir);
  return [...referenced.keys()].filter((n) => !ALWAYS_PROVIDED.has(n)).sort();
}

export function diffWiring(expected, wired) {
  const e = new Set(expected);
  const w = new Set(wired || []);
  return {
    missing: expected.filter((n) => !w.has(n)),
    stale: [...w].filter((n) => !e.has(n)).sort(),
    inSync: wired !== null && expected.length === w.size && expected.every((n) => w.has(n))
  };
}

export function syncWorkflow(workflowContent, expected) {
  const begin = workflowContent.indexOf(BLOCK_BEGIN);
  const end = workflowContent.indexOf(BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      'secrets-doctor.yml has no generated block to replace. It must contain the BEGIN and END marker ' +
        'comments exactly as scripts/secrets-doctor.mjs emits them.'
    );
  }
  return workflowContent.slice(0, begin) + renderEnvBlock(expected) + workflowContent.slice(end + BLOCK_END.length);
}

// ---------------------------------------------------------------------------
// The dispatch-time verdicts
// ---------------------------------------------------------------------------

// `env` is the process environment the workflow built: one CONFIGURED_<NAME>
// per wired secret, each already reduced to "true"/"false" by the
// expression. Anything else means the wiring is wrong, and an unreadable
// input is reported rather than guessed at - reading it as "configured"
// is the one wrong answer that would make this a rubber stamp.
export function judgeSecret(name, raw, config) {
  if (raw !== 'true' && raw !== 'false') {
    // THE VALUE IS DELIBERATELY NOT ECHOED, and this is not caution for its
    // own sake. This branch fires only when the variable is NOT a boolean,
    // and the most plausible way that happens is a mis-wiring that drops
    // the `!= ''` - `CONFIGURED_X: ${{ secrets.X }}` - which puts the
    // actual credential in it. So the one case where the value is worth
    // printing for debugging is the case where it might be a secret.
    // Reporting its shape is enough to fix the wiring.
    //
    // CodeQL's js/clear-text-logging rule flagged the version that did echo
    // it, correctly, and this reasoning is why that was a real finding
    // rather than a taint-tracking false positive.
    const shape = raw === undefined ? 'unset' : raw === '' ? 'empty' : 'present but not a recognized boolean';
    return {
      name,
      status: 'broken',
      detail:
        `expected ${envVarNameFor(name)} to be exactly "true" or "false"; it was ${shape}. ` +
        'The value is not echoed - a variable that is not a boolean here may be a credential, which is ' +
        'exactly what a mis-wired generated block would put in it. Re-run `node scripts/secrets-doctor.mjs --sync`. ' +
        'Treating an unreadable probe as a failure rather than as "configured".'
    };
  }
  if (raw === 'true') {
    return { name, status: 'present', detail: 'configured and non-empty (the value itself is not checked)' };
  }
  const reason = Object.prototype.hasOwnProperty.call(config.optionalSecrets, name) ? config.optionalSecrets[name] : null;
  return reason
    ? { name, status: 'optional-missing', detail: `not configured, declared optional: ${reason}` }
    : { name, status: 'missing', detail: 'referenced by a workflow but not configured on this repo' };
}

export function runSecretsDoctor({ config = loadConfig(), root = ROOT, workflowsDir, workflowFile, env = process.env } = {}) {
  const dir = workflowsDir || join(root, '.github', 'workflows');
  const selfPath = workflowFile || join(dir, 'secrets-doctor.yml');
  const workflowFiles = listWorkflowFiles(dir);
  const referenced = collectReferencedSecrets(dir);
  const expected = expectedSecrets(dir, config);

  let wired = null;
  try {
    wired = parseWiredSecrets(readFileSync(selfPath, 'utf8'));
  } catch (e) {
    wired = null;
  }
  const wiring = diffWiring(expected, wired);

  const problems = [];
  if (workflowFiles.length === 0) {
    problems.push('No workflow files found. This check scanned nothing, which is not the same as finding nothing wrong.');
  }
  if (wired === null) {
    problems.push(
      'secrets-doctor.yml has no generated env block, so there is nothing to read verdicts from. ' +
        'Run `node scripts/secrets-doctor.mjs --sync`.'
    );
  }
  for (const name of wiring.missing) {
    problems.push(
      `${name} is referenced by ${(referenced.get(name) || []).join(', ')} but is not wired into ` +
        'secrets-doctor.yml, so it was NOT checked. Run `node scripts/secrets-doctor.mjs --sync`.'
    );
  }
  for (const name of wiring.stale) {
    problems.push(
      `${name} is wired into secrets-doctor.yml but no workflow references it any more. ` +
        'Run `node scripts/secrets-doctor.mjs --sync`.'
    );
  }

  const checks = (wired || []).filter((n) => !wiring.stale.includes(n)).map((n) => judgeSecret(n, env[envVarNameFor(n)], config));

  const hasFindings = problems.length > 0 || checks.some((c) => c.status === 'missing' || c.status === 'broken');
  return { checks, problems, wiring, referenced, workflowCount: workflowFiles.length, hasFindings };
}

export function renderReport({ checks, problems, workflowCount, hasFindings }) {
  const lines = ["secrets-doctor - every secret this repo's workflows reference", ''];
  for (const p of problems) lines.push(`::error::${p}`);
  if (problems.length > 0) lines.push('');

  if (checks.length === 0) lines.push('No secret is wired for checking.');
  for (const c of checks) {
    if (c.status === 'present') lines.push(`  ok   ${c.name} - ${c.detail}`);
    else if (c.status === 'optional-missing') lines.push(`  warn ${c.name} - ${c.detail}`);
    else lines.push(`::error::${c.name} - ${c.detail}`);
  }

  lines.push('');
  lines.push(`Scanned ${workflowCount} workflow file(s); checked ${checks.length} secret(s).`);
  lines.push('');
  lines.push(
    hasFindings
      ? "One or more secrets a workflow needs are not configured, or this check could not do its job - see above. A secret that may legitimately be unset belongs in .github/floor.json's doctor.optionalSecrets, with the reason."
      : "Every secret this repo's workflows reference is configured and non-empty."
  );
  return lines.join('\n');
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
  const selfPath = join(workflowsDir, 'secrets-doctor.yml');
  const expected = expectedSecrets(workflowsDir);

  if (process.argv.includes('--sync')) {
    const before = readFileSync(selfPath, 'utf8');
    const after = syncWorkflow(before, expected);
    if (after === before) {
      console.log(`secrets-doctor.yml already wires all ${expected.length} referenced secret(s).`);
    } else {
      writeFileSync(selfPath, after);
      console.log(`Rewrote secrets-doctor.yml's generated block with ${expected.length} referenced secret(s).`);
    }
  } else if (process.argv.includes('--check')) {
    const wiring = diffWiring(expected, parseWiredSecrets(readFileSync(selfPath, 'utf8')));
    if (wiring.inSync) {
      console.log(`secrets-doctor.yml wires exactly the ${expected.length} secret(s) this repo's workflows reference.`);
      process.exitCode = 0;
    } else {
      for (const n of wiring.missing) console.error(`::error::${n} is referenced by a workflow but not wired into secrets-doctor.yml.`);
      for (const n of wiring.stale) console.error(`::error::${n} is wired into secrets-doctor.yml but referenced by no workflow.`);
      console.error('Fix with: node scripts/secrets-doctor.mjs --sync');
      process.exitCode = 1;
    }
  } else {
    const result = runSecretsDoctor();
    console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : renderReport(result));
    process.exitCode = result.hasFindings ? 1 : 0;
  }
}
