// Tests scripts/sync-installer-copies.py — the regenerator for
// setup_hub.py's embedded copies of this repo's real files.
//
// WHY THIS FILE EXISTS
// --------------------
// ci.yml diffs fourteen tracked files against copies setup_hub.py carries
// inline. That guard is good and has caught real drift. What it lacked was
// a way to satisfy it: fixing a violation meant hand-editing a string
// literal inside a 2400-line Python file. Dependabot can't do that, so
// every dependency PR touching one of the fourteen was unmergeable —
// four sat red simultaneously before the sync script existed.
//
// The script that fixes this is itself the dangerous part. The embedded
// literals are non-raw triple-quoted Python strings, so a backslash in a
// source file means something different once it's inside one.
// api/autonomous_agent.js contains thirteen `\n` sequences written as two
// characters in JavaScript; embed those naively and Python turns each into
// a real newline, and the installer writes a file that differs from the
// original in a way no one reads a diff closely enough to catch. That is a
// silent corruption of the bootstrap path for every future fresh install.
//
// So the thing worth pinning here is not "the script runs." It's that a
// regenerated copy reproduces its source byte for byte, including the
// hazards — and that the script refuses rather than guesses when it can't.
//
// These tests operate on a throwaway copy of the repo (git archive of
// HEAD), never the working tree.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCRIPT = 'scripts/sync-installer-copies.py';

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'ok' : 'NOT OK'} - ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`      ${detail}`);
  }
}
function section(name) {
  console.log(name);
}

function py(cwd, args, { allowFail = false } = {}) {
  try {
    return {
      status: 0,
      out: execFileSync('python3', [SCRIPT, ...args], { cwd, encoding: 'utf8' }),
    };
  } catch (err) {
    if (!allowFail) throw err;
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// Runs setup_hub.py into a scratch dir and returns what it generated for
// `path` — i.e. exactly what a fresh install would receive.
function installerOutput(cwd, path) {
  const scratch = mkdtempSync(join(tmpdir(), 'hub-scratch-'));
  try {
    execFileSync('python3', [join(cwd, 'setup_hub.py')], {
      cwd: scratch,
      stdio: 'ignore',
    });
    return readFileSync(join(scratch, path), 'utf8');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A pristine copy of HEAD, plus the working tree's own script/installer so
// uncommitted changes to either are what gets tested.
function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-test-'));
  const tar = execFileSync('git', ['archive', 'HEAD'], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'buffer',
  });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  cpSync(join(repoRoot, SCRIPT), join(dir, SCRIPT));
  cpSync(join(repoRoot, 'setup_hub.py'), join(dir, 'setup_hub.py'));
  return dir;
}

const trackedPaths = py(repoRoot, ['--list']).out.trim().split('\n');

// ── The escaping guarantee ───────────────────────────────────────

section('sync-installer-copies.py --self-test covers the escaping hazards');
{
  const res = py(repoRoot, ['--self-test'], { allowFail: true });
  check('self-test exits 0', res.status === 0, res.out);
  check('it reports every case passing', /\b(\d+)\/\1 self-test cases passed/.test(res.out), res.out);
}

section('the tracked-path list is the one ci.yml consumes');
{
  const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  check('ci.yml gets its list from --list, not a pasted copy',
    ci.includes('sync-installer-copies.py --list'));
  check('ci.yml names the fix command in its error',
    ci.includes('Fix it with: python3 scripts/sync-installer-copies.py'));
  check('fourteen paths are tracked', trackedPaths.length === 14,
    `got ${trackedPaths.length}`);
}

section('the committed tree is already in sync');
{
  const res = py(repoRoot, ['--check'], { allowFail: true });
  check('--check exits 0 on a clean tree', res.status === 0, res.out);
}

// ── Detecting and repairing real drift ───────────────────────────

section('drift in a file full of backslash escapes is detected and repaired exactly');
{
  const dir = freshRepo();
  try {
    const target = 'api/autonomous_agent.js';
    const original = readFileSync(join(dir, target), 'utf8');

    // The hazard, verbatim: a two-character backslash-n, the thing a naive
    // triple-quoted embedding silently turns into a real newline.
    const probe = String.raw`// DRIFT PROBE: two-char escape '\n' plus a real "quote" and a \\ pair`;
    const mutated = `${probe}\n${original}`;
    writeFileSync(join(dir, target), mutated);

    // Never interpret a green run against a breakage that didn't apply.
    check('the deliberate drift actually landed in the file',
      readFileSync(join(dir, target), 'utf8') !== original);

    const before = py(dir, ['--check'], { allowFail: true });
    check('--check detects the drift (exit 1)', before.status === 1, before.out);
    check('--check names the drifted file', before.out.includes(target), before.out);
    check('--check changed nothing', readFileSync(join(dir, target), 'utf8') === mutated);

    const sync = py(dir, [], { allowFail: true });
    check('sync exits 0', sync.status === 0, sync.out);

    const after = py(dir, ['--check'], { allowFail: true });
    check('--check is clean afterwards', after.status === 0, after.out);

    const generated = installerOutput(dir, target);
    check('the installer now generates the mutated file byte for byte',
      generated.replace(/\n+$/, '') === mutated.replace(/\n+$/, ''));
    check('the two-character backslash-n survived as two characters',
      generated.includes(String.raw`'\n'`),
      'it was converted to a real newline — the exact silent corruption this guards');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('every hazard at once round-trips through a real sync');
{
  const dir = freshRepo();
  try {
    const target = 'scripts/prune-logs.js';
    const nasty = [
      '// torture',
      String.raw`const a = 'tab\there newline\nthere';`,
      String.raw`const b = "C:\\Users\\x";`,
      'const c = `triple """ quote inside`;',
      'const d = "unicode: caf\u00e9 \u2014 \u{1F600}";',
      String.raw`const e = /a\\b[\n]/g;`,
      'const f = "ends with a quote"',
    ].join('\n');
    const mutated = `${nasty}\n${readFileSync(join(dir, target), 'utf8')}`;
    writeFileSync(join(dir, target), mutated);

    const sync = py(dir, [], { allowFail: true });
    check('sync exits 0 on adversarial content', sync.status === 0, sync.out);

    const generated = installerOutput(dir, target);
    check('regenerated byte for byte',
      generated.replace(/\n+$/, '') === mutated.replace(/\n+$/, ''));
    check('the embedded triple-quote did not terminate the literal early',
      generated.includes('triple """ quote inside'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── What it must NOT touch ───────────────────────────────────────

section('fresh-install seed files are deliberately left alone');
{
  // setup_hub.py seeds spokes.json/tenants.json/the two doctrine docs with
  // fresh-install defaults, NOT this repo's accumulated state. Syncing them
  // would ship this hub's live spoke registry to every new install.
  const seeds = ['spokes.json', 'tenants.json', 'universal_lessons.md', 'north_star_framework.md'];
  for (const seed of seeds) {
    check(`${seed} is not in the tracked list`, !trackedPaths.includes(seed));
  }

  const dir = freshRepo();
  try {
    const seeded = installerOutput(dir, 'spokes.json');
    const real = readFileSync(join(dir, 'spokes.json'), 'utf8');
    check('the installer seeds an empty spokes.json, not this repo\'s live one',
      seeded.trim() === '[]' && real.trim() !== '[]',
      `installer wrote ${seeded.trim().slice(0, 40)}`);

    py(dir, [], { allowFail: true });
    check('running sync leaves that seed untouched',
      installerOutput(dir, 'spokes.json').trim() === '[]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('a path with no embedded copy is refused, not silently skipped');
{
  const dir = freshRepo();
  try {
    const script = join(dir, SCRIPT);
    const src = readFileSync(script, 'utf8');
    writeFileSync(script, src.replace('    "package.json",', '    "README.md",\n    "package.json",'));
    const res = py(dir, ['--check'], { allowFail: true });
    check('it exits non-zero', res.status !== 0, res.out);
    check('it says which path has no embedded copy', res.out.includes('README.md'), res.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
