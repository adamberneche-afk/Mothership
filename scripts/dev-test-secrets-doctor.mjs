// Local verification harness for scripts/secrets-doctor.mjs (floor check 10
// - see CICD_FLOOR.md).
//
// This harness carries more weight than the other floor checks' do, and
// deliberately so. secrets-doctor.yml is workflow_dispatch-only, and a
// dispatch-only workflow cannot be dispatched until it exists on the
// default branch - so unlike checks 6-9 there is no way to watch this one
// go red on a planted violation in a pull request. The planted-violation
// proof has to happen by dispatch after merge. Until then these assertions
// are the evidence, which is why they cover every status the check can
// report and both false-positive classes found while writing it.
//
// Everything here is synthetic - scratch workflow directories via mkdtemp,
// injected name lists - except one non-vacuous pass over this repo's real
// workflows, asserting the scan actually found them and resolved real
// references.
//
// Usage: node scripts/dev-test-secrets-doctor.mjs

import {
  loadConfig,
  repoRootLooksValid,
  stripYamlComments,
  extractSecretReferences,
  listWorkflowFiles,
  collectReferencedSecrets,
  BLOCK_BEGIN,
  BLOCK_END,
  envVarNameFor,
  renderEnvBlock,
  parseWiredSecrets,
  expectedSecrets,
  diffWiring,
  syncWorkflow,
  judgeSecret,
  runSecretsDoctor,
  renderReport
} from './secrets-doctor.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT_WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

function makeWorkflows(files) {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-doctor-test-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function testConfig(overrides = {}) {
  return { optionalSecrets: {}, ...overrides };
}

// --- the root guard ----------------------------------------------------

function testRepoRootGuard() {
  console.log('\nrepoRootLooksValid - refuses to answer for a tree that is not a repo');
  check("this repo's real root passes", repoRootLooksValid() === true);
  const notARepo = mkdtempSync(join(tmpdir(), 'secrets-doctor-not-a-repo-'));
  check('a directory with no .github/ fails', repoRootLooksValid(notARepo) === false);
  mkdirSync(join(notARepo, '.github'));
  check('the same directory passes once .github/ exists', repoRootLooksValid(notARepo) === true);
  rmSync(notARepo, { recursive: true, force: true });
}

// --- loadConfig --------------------------------------------------------

function testLoadConfig() {
  console.log('\nloadConfig');
  const missing = loadConfig(join(tmpdir(), 'secrets-doctor-no-such-floor.json'));
  check('a missing floor.json degrades to no optional secrets', Object.keys(missing.optionalSecrets).length === 0);

  const dir = makeWorkflows({ 'floor.json': '{ not json' });
  let threw = false;
  try {
    loadConfig(join(dir, 'floor.json'));
  } catch (e) {
    threw = true;
  }
  check('malformed JSON does not throw', !threw);
  rmSync(dir, { recursive: true, force: true });

  const ok = makeWorkflows({ 'floor.json': JSON.stringify({ doctor: { optionalSecrets: { A: 'a reason' } } }) });
  check('reads the doctor block', loadConfig(join(ok, 'floor.json')).optionalSecrets.A === 'a reason');
  rmSync(ok, { recursive: true, force: true });
}

// --- stripYamlComments -------------------------------------------------

function testStripYamlComments() {
  console.log('\nstripYamlComments');
  check('a whole-line comment is removed', stripYamlComments('# secrets.GONE').trim() === '');
  check('a trailing comment is removed', stripYamlComments('key: value # secrets.GONE').includes('key: value'));
  check('and its content is gone', !stripYamlComments('key: value # secrets.GONE').includes('GONE'));
  check(
    'a # inside a quoted scalar is NOT a comment',
    stripYamlComments('key: "a # b secrets.KEPT"').includes('secrets.KEPT')
  );
  check(
    'a # with no leading whitespace is an ordinary scalar character',
    stripYamlComments('key: a#b').includes('a#b')
  );
  check('the line count is preserved', stripYamlComments('a\n# c\nb').split('\n').length === 3);
}

// --- extractSecretReferences -------------------------------------------

function testExtractSecretReferences() {
  console.log('\nextractSecretReferences');
  check('a dotted reference', extractSecretReferences('${{ secrets.MY_TOKEN }}').includes('MY_TOKEN'));
  check('a bracket reference', extractSecretReferences("${{ secrets['MY_TOKEN'] }}").includes('MY_TOKEN'));
  check('a reference in an if: without ${{ }}', extractSecretReferences("if: secrets.MY_TOKEN != ''").includes('MY_TOKEN'));
  check('deduplicates across the file', extractSecretReferences('${{ secrets.A }} ${{ secrets.A }}').length === 1);
  check('finds several', extractSecretReferences('${{ secrets.A }}\n${{ secrets.B }}').length === 2);
}

// These two are the false-positive classes found by running the extractor
// against all five repos before it was finished. Both came from KOS, and
// both would have had this check inventing credentials nobody needs - a
// check that cries wolf gets muted, and a muted check is what this floor
// exists to prevent.
function testExtractorFalsePositives() {
  console.log('\nextractSecretReferences - the two real false positives, pinned');
  check(
    'a secret named in a YAML comment is NOT a reference (KOS gas-lint.yml says "a bare `secrets.X` reference")',
    extractSecretReferences('  # GitHub Actions does not allow a bare `secrets.X` reference here\n').length === 0
  );
  check(
    'a longer identifier ending in "secrets" does not match (KOS: needs.check-sandbox-secrets.outputs.configured)',
    extractSecretReferences('if: needs.check-sandbox-secrets.outputs.configured == \'true\'').length === 0
  );
  check(
    'and a real reference on a line that also mentions one in prose still resolves',
    extractSecretReferences('${{ secrets.REAL }} # unlike secrets.FAKE').join() === 'REAL'
  );
  check(
    'an underscore-prefixed name still matches - the boundary rule must not be too greedy',
    extractSecretReferences('${{ secrets._PRIVATE }}').includes('_PRIVATE')
  );
}

// --- collection over a directory ---------------------------------------

function testCollectReferencedSecrets() {
  console.log('\ncollectReferencedSecrets');
  const dir = makeWorkflows({
    'a.yml': '${{ secrets.SHARED }}\n${{ secrets.ONLY_A }}',
    'b.yaml': '${{ secrets.SHARED }}',
    'notes.txt': '${{ secrets.IGNORED }}'
  });
  const map = collectReferencedSecrets(dir);
  check('collects across .yml and .yaml', map.has('SHARED') && map.has('ONLY_A'));
  check('a non-workflow file in the directory is ignored', !map.has('IGNORED'));
  check('a shared secret names every workflow that references it', map.get('SHARED').sort().join() === 'a.yml,b.yaml');
  check('listWorkflowFiles returns only workflow files', listWorkflowFiles(dir).length === 2);
  check('a missing directory returns nothing rather than throwing', listWorkflowFiles(join(dir, 'nope')).length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// --- the generated env block ------------------------------------------

function testRenderEnvBlock() {
  console.log('\nrenderEnvBlock - static references only');
  const block = renderEnvBlock(['TOKEN_A', 'TOKEN_B']);
  check('carries the begin marker', block.includes(BLOCK_BEGIN));
  check('carries the end marker', block.includes(BLOCK_END));
  check('one env var per secret', block.includes('CONFIGURED_TOKEN_A:') && block.includes('CONFIGURED_TOKEN_B:'));
  check(
    'each reference is STATIC - the whole point, since a dynamic index makes Actions ship every secret',
    block.includes("secrets.TOKEN_A != ''") && block.includes("secrets.TOKEN_B != ''")
  );
  check('no dynamic index appears anywhere', !/secrets\[/.test(block));
  check('the comparison is inside the expression, so only a boolean lands in env', !/\$\{\{\s*secrets\.[A-Z_]+\s*\}\}/.test(block));
  check('an empty list still produces a valid block', renderEnvBlock([]).includes('No workflow in this repo references a secret'));
}

function testParseWiredSecrets() {
  console.log('\nparseWiredSecrets - reads back what the workflow actually wires');
  const wf = `jobs:\n  x:\n    steps:\n      - env:\n${renderEnvBlock(['A', 'B'])}\n        run: node x\n`;
  check('round-trips the generated block', parseWiredSecrets(wf).sort().join() === 'A,B');
  check('a workflow with no block yields null, not an empty list', parseWiredSecrets('jobs:\n  x:\n') === null);
  check(
    'a CONFIGURED_ var OUTSIDE the block is not counted - only the generated region is authoritative',
    parseWiredSecrets(`CONFIGURED_OUTSIDE: x\n${renderEnvBlock(['A'])}`).join() === 'A'
  );
}

function testDiffWiring() {
  console.log('\ndiffWiring');
  check('in sync', diffWiring(['A', 'B'], ['B', 'A']).inSync === true);
  const missing = diffWiring(['A', 'B'], ['A']);
  check('a newly referenced secret shows as missing', missing.missing.join() === 'B');
  check('and is not in sync', missing.inSync === false);
  const stale = diffWiring(['A'], ['A', 'OLD']);
  check('a no-longer-referenced secret shows as stale', stale.stale.join() === 'OLD');
  check('and is not in sync', stale.inSync === false);
  check('a null wiring (no block at all) is never in sync', diffWiring([], null).inSync === false);
}

function testSyncWorkflow() {
  console.log('\nsyncWorkflow - regenerates the block in place');
  const before = `prefix\n${renderEnvBlock(['OLD'])}\nsuffix\n`;
  const after = syncWorkflow(before, ['NEW_A', 'NEW_B']);
  check('the old entry is gone', !after.includes('CONFIGURED_OLD'));
  check('the new entries are present', after.includes('CONFIGURED_NEW_A') && after.includes('CONFIGURED_NEW_B'));
  check('surrounding content is untouched', after.startsWith('prefix\n') && after.endsWith('suffix\n'));
  check('and it round-trips through the parser', parseWiredSecrets(after).sort().join() === 'NEW_A,NEW_B');
  check('syncing twice is idempotent', syncWorkflow(after, ['NEW_A', 'NEW_B']) === after);

  let threw = false;
  try {
    syncWorkflow('no markers here', ['A']);
  } catch (e) {
    threw = true;
  }
  check('a workflow with no markers throws rather than silently writing nothing', threw);
}

// --- judgeSecret -------------------------------------------------------

function testJudgeSecret() {
  console.log('\njudgeSecret - one secret, one verdict');
  const config = testConfig({ optionalSecrets: { MAYBE: 'only once staging exists' } });
  check('true -> present', judgeSecret('A', 'true', config).status === 'present');
  check('and discloses the value is unchecked', judgeSecret('A', 'true', config).detail.includes('the value itself is not checked'));
  check('false, not declared optional -> missing', judgeSecret('A', 'false', config).status === 'missing');
  check('false, declared optional -> optional-missing', judgeSecret('MAYBE', 'false', config).status === 'optional-missing');
  check('the declared reason is carried through', judgeSecret('MAYBE', 'false', config).detail.includes('only once staging exists'));
  check('the verdict carries no value field', !('value' in judgeSecret('A', 'true', config)));
}

// An unreadable input must never read as "configured" - that is the one
// wrong answer that would turn this check into a rubber stamp.
function testUnreadableInputFailsClosed() {
  console.log('\njudgeSecret - an unreadable input fails closed');
  for (const raw of [undefined, '', 'TRUE', 'True', 'yes', '1', 'null', 'false ']) {
    const r = judgeSecret('A', raw, testConfig());
    check(`${envVarNameFor('A')}=${JSON.stringify(raw)} -> broken`, r.status === 'broken');
  }
  check(
    'and an optionalSecrets entry cannot silence a broken probe',
    judgeSecret('A', 'garbage', testConfig({ optionalSecrets: { A: 'try to mute it' } })).status === 'broken'
  );
}

// --- runSecretsDoctor, end to end -------------------------------------

function scratchRepo(workflows, wiredSecrets) {
  const dir = makeWorkflows({
    ...workflows,
    'secrets-doctor.yml': `jobs:\n  d:\n    steps:\n      - env:\n${renderEnvBlock(wiredSecrets)}\n        run: node x\n`
  });
  return dir;
}

function testEndToEndGreen() {
  console.log('\nrunSecretsDoctor - everything referenced, wired and configured');
  const dir = scratchRepo({ 'a.yml': "${{ secrets.TOKEN_A }}" }, ['TOKEN_A']);
  const r = runSecretsDoctor({
    config: testConfig(),
    workflowsDir: dir,
    workflowFile: join(dir, 'secrets-doctor.yml'),
    env: { CONFIGURED_TOKEN_A: 'true' }
  });
  check('no findings', r.hasFindings === false);
  check('no problems', r.problems.length === 0);
  check('the secret is reported present', r.checks[0].status === 'present');
  rmSync(dir, { recursive: true, force: true });
}

function testEndToEndMissingSecret() {
  console.log('\nrunSecretsDoctor - a wired secret that is not configured goes red');
  const dir = scratchRepo({ 'a.yml': "${{ secrets.TOKEN_A }}" }, ['TOKEN_A']);
  const r = runSecretsDoctor({
    config: testConfig(),
    workflowsDir: dir,
    workflowFile: join(dir, 'secrets-doctor.yml'),
    env: { CONFIGURED_TOKEN_A: 'false' }
  });
  check('hasFindings', r.hasFindings === true);
  check('reported missing', r.checks[0].status === 'missing');
  check('the report emits ::error::', renderReport(r).includes('::error::TOKEN_A'));
  rmSync(dir, { recursive: true, force: true });
}

// The failure mode the generate-then-verify shape exists to remove: a
// workflow starts needing a secret and the doctor never learns about it.
// TSO's hand-written doctor is in exactly this state for two secrets.
function testUnwiredSecretIsNotSilentlySkipped() {
  console.log('\nrunSecretsDoctor - a referenced-but-unwired secret is a finding, not a silent skip');
  const dir = scratchRepo({ 'a.yml': "${{ secrets.WIRED }}\n${{ secrets.FORGOTTEN }}" }, ['WIRED']);
  const r = runSecretsDoctor({
    config: testConfig(),
    workflowsDir: dir,
    workflowFile: join(dir, 'secrets-doctor.yml'),
    env: { CONFIGURED_WIRED: 'true' }
  });
  check('hasFindings even though every WIRED secret is configured', r.hasFindings === true);
  check('the unwired one is named', r.problems.some((p) => p.includes('FORGOTTEN')));
  check('and it says it was NOT checked', r.problems.some((p) => p.includes('NOT checked')));
  check('and points at --sync', r.problems.some((p) => p.includes('--sync')));
  check('the wired one still reports present', r.checks.find((c) => c.name === 'WIRED').status === 'present');
  rmSync(dir, { recursive: true, force: true });
}

function testStaleWiringIsAFinding() {
  console.log('\nrunSecretsDoctor - a wired secret no workflow references any more is a finding');
  const dir = scratchRepo({ 'a.yml': "${{ secrets.STILL_USED }}" }, ['STILL_USED', 'REMOVED_LAST_MONTH']);
  const r = runSecretsDoctor({
    config: testConfig(),
    workflowsDir: dir,
    workflowFile: join(dir, 'secrets-doctor.yml'),
    env: { CONFIGURED_STILL_USED: 'true', CONFIGURED_REMOVED_LAST_MONTH: 'false' }
  });
  check('hasFindings', r.hasFindings === true);
  check('the stale entry is named', r.problems.some((p) => p.includes('REMOVED_LAST_MONTH')));
  check(
    'and it is NOT also reported as a missing secret - that would be two findings for one cause',
    !r.checks.some((c) => c.name === 'REMOVED_LAST_MONTH')
  );
  rmSync(dir, { recursive: true, force: true });
}

function testVacuousRunsAreFailures() {
  console.log('\nrunSecretsDoctor - a run that checked nothing is a failure, not a pass');
  const noBlock = makeWorkflows({ 'a.yml': "${{ secrets.TOKEN }}", 'secrets-doctor.yml': 'jobs:\n  d:\n' });
  const r1 = runSecretsDoctor({
    config: testConfig(),
    workflowsDir: noBlock,
    workflowFile: join(noBlock, 'secrets-doctor.yml'),
    env: {}
  });
  check('no generated block -> hasFindings', r1.hasFindings === true);
  check('and it says there is nothing to read verdicts from', r1.problems.some((p) => p.includes('no generated env block')));
  rmSync(noBlock, { recursive: true, force: true });

  const none = scratchRepo({}, []);
  // Only secrets-doctor.yml itself exists, so there IS a workflow file -
  // the interesting empty case is no files at all.
  rmSync(none, { recursive: true, force: true });

  const empty = makeWorkflows({});
  const r2 = runSecretsDoctor({
    config: testConfig(),
    workflowsDir: empty,
    workflowFile: join(empty, 'nope.yml'),
    env: {}
  });
  check('no workflow files -> hasFindings', r2.hasFindings === true);
  check('and it says the scan covered nothing', r2.problems.some((p) => p.includes('scanned nothing')));
  rmSync(empty, { recursive: true, force: true });
}

// --- the one test against the real repo --------------------------------

function testThisRepoPlansNonVacuously() {
  console.log("\nthis repo's own workflows - the plan is non-vacuous");
  // Only the PLAN half is assertable here. Whether this repo's secrets are
  // actually set is a question only a dispatch can answer, and asserting it
  // in the suite would make `npm test` depend on repo settings no test can
  // control - which is also why check 10's planted-violation proof is a
  // post-merge dispatch rather than something this file can stand in for.
  const config = loadConfig();
  const expected = expectedSecrets(ROOT_WORKFLOWS, config);
  check(`derived real secrets from this repo's workflows (${expected.length})`, expected.length > 5);
  check(
    'GLOBAL_GITHUB_TOKEN is among them - the credential whose silent invalidity started all this',
    expected.includes('GLOBAL_GITHUB_TOKEN')
  );
  check(
    'every optionalSecrets entry in floor.json is actually referenced by some workflow',
    Object.keys(config.optionalSecrets).every((n) => expected.includes(n))
  );
  check('no phantom secret named X or outputs (the KOS false positives)', !expected.includes('X') && !expected.includes('outputs'));

  // THE DRIFT GATE. This is the assertion that makes the generated list
  // trustworthy: it fails the suite, on every pull request, the moment a
  // workflow starts referencing a secret secrets-doctor.yml does not wire.
  // Without it the generated block is just a hand-written list with extra
  // steps, which is the state TSO's doctor is in.
  const selfPath = join(ROOT_WORKFLOWS, 'secrets-doctor.yml');
  const wiring = diffWiring(expected, parseWiredSecrets(readFileSync(selfPath, 'utf8')));
  if (!wiring.inSync) {
    console.error(`  missing from secrets-doctor.yml: ${wiring.missing.join(', ') || '(none)'}`);
    console.error(`  stale in secrets-doctor.yml:    ${wiring.stale.join(', ') || '(none)'}`);
    console.error('  fix with: node scripts/secrets-doctor.mjs --sync');
  }
  check("secrets-doctor.yml wires exactly what this repo's workflows reference", wiring.inSync);

  // And the file must contain no dynamic index, which is what CodeQL
  // flagged twice - a regression here is a security regression.
  const selfSource = readFileSync(selfPath, 'utf8');
  check('secrets-doctor.yml uses no dynamic secrets index', !/secrets\[/.test(selfSource));
  check('and does not pass the whole secrets context', !/toJSON\(\s*secrets\s*\)/.test(selfSource));
}

// --- main ---------------------------------------------------------------

function main() {
  console.log('secrets-doctor (floor check 10) - local verification\n');

  testRepoRootGuard();
  testLoadConfig();
  testStripYamlComments();
  testExtractSecretReferences();
  testExtractorFalsePositives();
  testCollectReferencedSecrets();
  testRenderEnvBlock();
  testParseWiredSecrets();
  testDiffWiring();
  testSyncWorkflow();
  testJudgeSecret();
  testUnreadableInputFailsClosed();
  testEndToEndGreen();
  testEndToEndMissingSecret();
  testUnwiredSecretIsNotSilentlySkipped();
  testStaleWiringIsAFinding();
  testVacuousRunsAreFailures();
  testThisRepoPlansNonVacuously();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
