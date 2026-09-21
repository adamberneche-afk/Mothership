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
  CONTROL_SECRET,
  buildProbePlan,
  renderPlan,
  probeSecret,
  renderProbe,
  probeFailed
} from './secrets-doctor.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
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

// --- buildProbePlan ----------------------------------------------------

function testBuildProbePlan() {
  console.log('\nbuildProbePlan - what to probe, derived from the workflows');
  const dir = makeWorkflows({
    'a.yml': '${{ secrets.TOKEN_B }}\n${{ secrets.TOKEN_A }}',
    'b.yml': '${{ secrets.GITHUB_TOKEN }}'
  });
  const plan = buildProbePlan(dir, testConfig());
  check('the control leg comes first', plan.matrix[0] === CONTROL_SECRET);
  check('referenced secrets follow, sorted', plan.matrix.slice(1).join() === 'TOKEN_A,TOKEN_B');
  check(
    'GITHUB_TOKEN appears once - as the control, not also as a referenced secret',
    plan.matrix.filter((n) => n === CONTROL_SECRET).length === 1
  );
  check('the plan carries which workflow needs each', plan.referenced.get('TOKEN_A').join() === 'a.yml');
  check('and how many workflows it scanned', plan.workflowFiles.length === 2);

  const optional = buildProbePlan(dir, testConfig({ optionalSecrets: { TOKEN_A: 'why' } }));
  check('optional names are identified for the plan output', optional.optionalNames.join() === 'TOKEN_A');
  rmSync(dir, { recursive: true, force: true });
}

function testPlanIsNeverEmptyAndNeverSilent() {
  console.log('\nbuildProbePlan - a repo with nothing to probe still runs the control');
  const empty = makeWorkflows({ 'a.yml': 'name: X\non: push\n' });
  const plan = buildProbePlan(empty, testConfig());
  check('the matrix is never empty, so the probe job is never skipped', plan.matrix.length === 1);
  check('and the plan says so rather than looking like success', renderPlan(plan).includes('Only the control leg will run'));
  rmSync(empty, { recursive: true, force: true });

  // No workflow files at all means the scan covered nothing, which is not
  // the same as finding nothing wrong.
  const none = makeWorkflows({});
  check(
    'no workflow files is reported as an ::error::',
    renderPlan(buildProbePlan(none, testConfig())).includes('::error::No workflow files found')
  );
  rmSync(none, { recursive: true, force: true });
}

// --- probeSecret -------------------------------------------------------

function testProbeVerdicts() {
  console.log('\nprobeSecret - one secret, one verdict');
  const dir = makeWorkflows({ 'deploy.yml': '${{ secrets.NEEDED }}\n${{ secrets.MAYBE }}' });
  const config = testConfig({ optionalSecrets: { MAYBE: 'only once staging exists' } });

  const present = probeSecret({ name: 'NEEDED', configuredRaw: 'true', config, workflowsDir: dir });
  check('configured -> present', present.status === 'present');
  check('and passes', !probeFailed(present));
  check('the detail names the workflow that needs it', present.detail.includes('deploy.yml'));
  check('and discloses that the value is not checked', present.detail.includes('the value itself is not checked'));

  const missing = probeSecret({ name: 'NEEDED', configuredRaw: 'false', config, workflowsDir: dir });
  check('not configured, not declared optional -> missing', missing.status === 'missing');
  check('and fails', probeFailed(missing));
  check('the report emits ::error:: naming it', renderProbe(missing).includes('::error::NEEDED'));
  check('and points at the remedy', renderProbe(missing).includes('doctor.optionalSecrets'));

  const optional = probeSecret({ name: 'MAYBE', configuredRaw: 'false', config, workflowsDir: dir });
  check('not configured but declared optional -> optional-missing', optional.status === 'optional-missing');
  check('and does NOT fail', !probeFailed(optional));
  check('the declared reason is carried through', optional.detail.includes('only once staging exists'));
  check(
    'and WITHOUT the declaration the same input fails',
    probeFailed(probeSecret({ name: 'MAYBE', configuredRaw: 'false', config: testConfig(), workflowsDir: dir }))
  );
  rmSync(dir, { recursive: true, force: true });
}

// The control leg is the anti-vacuity guard for the whole mechanism: if
// `secrets[matrix.secret]` ever stops resolving, every leg reports missing,
// which looks identical to a repo that lost all its credentials at once.
function testControlLeg() {
  console.log('\nprobeSecret - the control leg distinguishes a broken mechanism from a real gap');
  const ok = probeSecret({ name: CONTROL_SECRET, configuredRaw: 'true', config: testConfig() });
  check('control configured -> control-ok', ok.status === 'control-ok');
  check('and passes', !probeFailed(ok));

  const broken = probeSecret({ name: CONTROL_SECRET, configuredRaw: 'false', config: testConfig() });
  check('control NOT configured -> broken, not missing', broken.status === 'broken');
  check('and fails', probeFailed(broken));
  check('it says the mechanism is at fault, not the secrets', broken.detail.includes('Fix the workflow, not the secrets'));
  check(
    'and it cannot be silenced by an optionalSecrets entry',
    probeSecret({
      name: CONTROL_SECRET,
      configuredRaw: 'false',
      config: testConfig({ optionalSecrets: { [CONTROL_SECRET]: 'try to mute the control' } })
    }).status === 'broken'
  );
}

// An unreadable probe input must never be read as "configured" - that is
// the one wrong answer that turns this check into a rubber stamp.
function testUnreadableProbeIsAFailure() {
  console.log('\nprobeSecret - an unreadable input fails closed');
  for (const raw of [undefined, '', 'TRUE', 'yes', '1', 'null']) {
    const r = probeSecret({ name: 'X', configuredRaw: raw, config: testConfig() });
    check(`SECRET_CONFIGURED=${JSON.stringify(raw)} -> broken`, r.status === 'broken' && probeFailed(r));
  }
  const noName = probeSecret({ name: undefined, configuredRaw: 'true', config: testConfig() });
  check('a probe with no secret name -> broken', noName.status === 'broken' && probeFailed(noName));
  check('and renders without throwing on the missing name', renderProbe(noName).includes('(no name)'));
}

function testNoValueIsEverHandled() {
  console.log('\nprobeSecret - the contract: no code path receives a secret value');
  // The workflow collapses the secret to a boolean inside the expression,
  // so there is no value for this script to hold. This pins the shape:
  // the only secret-derived input is the true/false string, and nothing
  // the script returns carries a value field.
  const r = probeSecret({ name: 'TOKEN', configuredRaw: 'true', config: testConfig() });
  check('the verdict carries no value field', !('value' in r));
  check('the verdict carries only name, status and detail', Object.keys(r).sort().join() === 'detail,name,status');
  check('and the rendered line is name plus prose only', renderProbe(r) === `  ok   TOKEN - ${r.detail}`);
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
  const plan = buildProbePlan(ROOT_WORKFLOWS, config);
  check(`scanned this repo's workflows (${plan.workflowFiles.length})`, plan.workflowFiles.length > 5);
  check(`derived real secrets to probe (${plan.matrix.length - 1})`, plan.matrix.length - 1 > 5);
  check('the control leg is present', plan.matrix[0] === CONTROL_SECRET);
  check(
    'GLOBAL_GITHUB_TOKEN is among them - the credential whose silent invalidity started all this',
    plan.matrix.includes('GLOBAL_GITHUB_TOKEN')
  );
  check(
    'every optionalSecrets entry in floor.json is actually referenced by some workflow',
    Object.keys(config.optionalSecrets).every((n) => plan.matrix.includes(n))
  );
  check('no phantom secret named X or outputs (the KOS false positives)', !plan.matrix.includes('X') && !plan.matrix.includes('outputs'));
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
  testBuildProbePlan();
  testPlanIsNeverEmptyAndNeverSilent();
  testProbeVerdicts();
  testControlLeg();
  testUnreadableProbeIsAFailure();
  testNoValueIsEverHandled();
  testThisRepoPlansNonVacuously();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
