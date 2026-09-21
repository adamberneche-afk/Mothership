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
  readAvailableSecretNames,
  runSecretsDoctor,
  renderReport
} from './secrets-doctor.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

// --- readAvailableSecretNames ------------------------------------------

function testReadAvailableSecretNames() {
  console.log('\nreadAvailableSecretNames');
  const dir = makeWorkflows({ 'names.txt': 'A\nB\n\n  C  \n' });
  const names = readAvailableSecretNames(join(dir, 'names.txt'));
  check('parses one name per line', names.includes('A') && names.includes('B'));
  check('trims whitespace', names.includes('C'));
  check('drops blank lines', names.length === 3);
  check('a missing file yields null, not an empty list', readAvailableSecretNames(join(dir, 'nope.txt')) === null);
  check('no path yields null', readAvailableSecretNames(undefined) === null);
  // An EMPTY file is a real answer - a repo with no secrets configured -
  // and must not be confused with "no list provided".
  writeFileSync(join(dir, 'empty.txt'), '');
  const empty = readAvailableSecretNames(join(dir, 'empty.txt'));
  check('an empty file yields an empty list, distinct from null', Array.isArray(empty) && empty.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// --- runSecretsDoctor --------------------------------------------------

function testAllPresentIsGreen() {
  console.log('\nrunSecretsDoctor - every referenced secret configured');
  const dir = makeWorkflows({ 'a.yml': '${{ secrets.TOKEN_A }}\n${{ secrets.TOKEN_B }}' });
  const r = runSecretsDoctor({ config: testConfig(), workflowsDir: dir, availableSecretNames: ['TOKEN_A', 'TOKEN_B'] });
  check('no findings', r.hasFindings === false);
  check('both reported present', r.checks.filter((c) => c.status === 'present').length === 2);
  check('no problems', r.problems.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

function testMissingSecretIsRed() {
  console.log('\nrunSecretsDoctor - a referenced secret that is not configured goes red');
  const dir = makeWorkflows({ 'deploy.yml': '${{ secrets.NEVER_SET }}' });
  const r = runSecretsDoctor({ config: testConfig(), workflowsDir: dir, availableSecretNames: ['SOMETHING_ELSE'] });
  check('hasFindings is true', r.hasFindings === true);
  const finding = r.checks.find((c) => c.name === 'NEVER_SET');
  check('status is missing', finding.status === 'missing');
  check('the finding names the workflow that needs it', finding.files.join() === 'deploy.yml');
  const report = renderReport(r);
  check('the report emits a ::error:: annotation', report.includes('::error::NEVER_SET'));
  check('and names the workflow in it', report.includes('deploy.yml'));
  rmSync(dir, { recursive: true, force: true });
}

function testOptionalSecretWarnsButPasses() {
  console.log('\nrunSecretsDoctor - a declared-optional secret warns without failing');
  const dir = makeWorkflows({ 'a.yml': '${{ secrets.MAYBE }}' });
  const config = testConfig({ optionalSecrets: { MAYBE: 'only needed once staging exists' } });
  const r = runSecretsDoctor({ config, workflowsDir: dir, availableSecretNames: [] });
  check('no findings', r.hasFindings === false);
  check('status is optional-missing', r.checks[0].status === 'optional-missing');
  check('the reason is carried into the report', renderReport(r).includes('only needed once staging exists'));
  check(
    'and WITHOUT the declaration it would have failed',
    runSecretsDoctor({ config: testConfig(), workflowsDir: dir, availableSecretNames: [] }).hasFindings === true
  );
  rmSync(dir, { recursive: true, force: true });
}

function testGithubTokenIsNeverMissing() {
  console.log('\nrunSecretsDoctor - GITHUB_TOKEN is minted per run, never a finding');
  const dir = makeWorkflows({ 'a.yml': '${{ secrets.GITHUB_TOKEN }}' });
  const r = runSecretsDoctor({ config: testConfig(), workflowsDir: dir, availableSecretNames: [] });
  check('no findings even with an empty available list', r.hasFindings === false);
  check('reported as built-in', r.checks[0].status === 'built-in');
  rmSync(dir, { recursive: true, force: true });
}

function testUnreferencedSecretsAreListedNotFailed() {
  console.log('\nrunSecretsDoctor - a configured secret nothing references is listed, not failed');
  const dir = makeWorkflows({ 'a.yml': '${{ secrets.USED }}' });
  const r = runSecretsDoctor({
    config: testConfig(),
    workflowsDir: dir,
    availableSecretNames: ['USED', 'OLD_RENAMED_TOKEN', 'GITHUB_TOKEN']
  });
  check('no findings', r.hasFindings === false);
  check('the orphan is listed', r.unreferenced.includes('OLD_RENAMED_TOKEN'));
  check('GITHUB_TOKEN is not listed as an orphan', !r.unreferenced.includes('GITHUB_TOKEN'));
  check('the used one is not listed as an orphan', !r.unreferenced.includes('USED'));
  check('the report explains why it is not a failure', renderReport(r).includes('not a failure'));
  rmSync(dir, { recursive: true, force: true });
}

// The two ways this check could report "clean" while having checked
// nothing. Both must be hard failures: "no list provided" and "nothing
// missing" must never look alike.
function testVacuousRunsAreFailures() {
  console.log('\nrunSecretsDoctor - a run that checked nothing is a failure, not a pass');
  const dir = makeWorkflows({ 'a.yml': '${{ secrets.TOKEN }}' });

  const noList = runSecretsDoctor({ config: testConfig(), workflowsDir: dir });
  check('no available-name list -> hasFindings', noList.hasFindings === true);
  check('and it says so as a problem, not a secret finding', noList.problems.some((p) => p.includes('nothing could be compared')));
  check('the report emits it as ::error::', renderReport(noList).includes('::error::No available-secret-name list'));

  const noWorkflows = makeWorkflows({});
  const empty = runSecretsDoctor({ config: testConfig(), workflowsDir: noWorkflows, availableSecretNames: [] });
  check('no workflow files at all -> hasFindings', empty.hasFindings === true);
  check('and it says the scan covered nothing', empty.problems.some((p) => p.includes('scanned nothing')));

  rmSync(noWorkflows, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

function testReportNeverContainsAValue() {
  console.log('\nrenderReport - names and reasons only, never a value');
  // The script is only ever handed NAMES (secrets-doctor.yml reduces the
  // context with `jq keys[]` first), so there is no value for it to leak.
  // This pins the contract: a name that looks like a value must still be
  // treated as a name, and nothing else is ever echoed.
  const dir = makeWorkflows({ 'a.yml': '${{ secrets.TOKEN }}' });
  const r = runSecretsDoctor({ config: testConfig(), workflowsDir: dir, availableSecretNames: ['TOKEN'] });
  const report = renderReport(r);
  check('the report names the secret', report.includes('TOKEN'));
  check('and discloses that presence is all it can confirm', report.includes('cannot verify the value'));
  check('the result object carries no value field', r.checks.every((c) => !('value' in c)));
  rmSync(dir, { recursive: true, force: true });
}

// --- the one test against the real repo --------------------------------

function testThisRepoScansNonVacuously() {
  console.log("\nthis repo's own workflows - non-vacuous");
  const config = loadConfig();
  // No availableSecretNames: this asserts the SCAN half against reality.
  // Whether this repo's secrets are all set is a question only a dispatch
  // can answer, and asserting it here would make the suite depend on
  // repo settings no test can control.
  const r = runSecretsDoctor({ config });
  check(`scanned this repo's workflows (${r.workflowCount})`, r.workflowCount > 5);
  check(`resolved real secret references (${r.checks.length})`, r.checks.length > 5);
  check(
    'GLOBAL_GITHUB_TOKEN is among them - the credential whose silent invalidity started all this',
    r.checks.some((c) => c.name === 'GLOBAL_GITHUB_TOKEN')
  );
  check(
    'every optionalSecrets entry in floor.json is actually referenced by some workflow',
    Object.keys(config.optionalSecrets).every((n) => r.checks.some((c) => c.name === n))
  );
  check('no phantom secret named X or outputs (the KOS false positives)', !r.checks.some((c) => c.name === 'X' || c.name === 'outputs'));
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
  testReadAvailableSecretNames();
  testAllPresentIsGreen();
  testMissingSecretIsRed();
  testOptionalSecretWarnsButPasses();
  testGithubTokenIsNeverMissing();
  testUnreferencedSecretsAreListedNotFailed();
  testVacuousRunsAreFailures();
  testReportNeverContainsAValue();
  testThisRepoScansNonVacuously();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
