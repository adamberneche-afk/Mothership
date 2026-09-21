// Local verification harness for scripts/coverage-gaps.js (floor check 9 -
// see CICD_FLOOR.md). Adapted from TSO's tests/coverage-gaps.test.js to this
// repo's plain check()-based harness convention.
//
// Almost everything here is synthetic - scratch trees via mkdtemp, injected
// test-file lists and test commands, never the real repo - so a legitimate
// future coverage gap makes the CHECK go red without making this SUITE lie
// about its own correctness. The one exception is testThisRepoIsCovered,
// which asserts the check found this repo's real scheduled scripts and
// resolved real edges to them. That one is the anti-vacuous test: without
// it, every assertion above could pass against a tool that resolves nothing
// at all in a real ESM repo.
//
// Usage: node scripts/dev-test-coverage-gaps.mjs

import {
  loadConfig,
  globToRegExp,
  matchesAnyGlob,
  listWorkflowFiles,
  hasScheduleTrigger,
  extractNodeScriptInvocations,
  findScheduledWorkflows,
  listAllTestFiles,
  extractRelativeImports,
  fileImportsScript,
  findTestFilesCovering,
  readTestCommand,
  checkTestCommandGlobs,
  evaluateScript,
  runCoverageGaps,
  renderReport
} from './coverage-gaps.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

// --- fixtures -----------------------------------------------------------

const SCHEDULED = "name: X\non:\n  schedule:\n    - cron: '0 7 * * *'\njobs:\n  a:\n    steps:\n      - run: node scripts/thing.js\n";
const PUSH_ONLY = "name: X\non:\n  push:\njobs:\n  a:\n    steps:\n      - run: node scripts/thing.js\n";
const SCHEDULED_CURL = "name: X\non:\n  schedule:\n    - cron: '0 7 * * *'\njobs:\n  a:\n    steps:\n      - run: curl -sS https://example.invalid/endpoint\n";

function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-gaps-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// Explicit rather than inherited from the repo's floor.json, so a change to
// that file can never quietly change what these tests assert.
function testConfig(overrides = {}) {
  return {
    excludeDirs: new Set(['node_modules', '.git']),
    testFilePatterns: ['**/*.test.js', 'scripts/dev-test-*.mjs'],
    testCommandGlobs: ['scripts/dev-test-*.mjs'],
    scriptExtensions: ['.js', '.mjs', '.cjs'],
    exemptScripts: {},
    ...overrides
  };
}

// --- globs --------------------------------------------------------------

function testGlobToRegExp() {
  console.log('\nglobToRegExp');
  check("`*` does not cross a path separator", globToRegExp('scripts/dev-test-*.mjs').test('scripts/dev-test-a.mjs')
    && !globToRegExp('scripts/dev-test-*.mjs').test('scripts/sub/dev-test-a.mjs'));
  check('`**/` matches zero directories', globToRegExp('**/*.test.js').test('a.test.js'));
  check('`**/` matches many directories', globToRegExp('**/*.test.js').test('a/b/c/d.test.js'));
  check('`**` alone matches across separators', globToRegExp('src/**').test('src/a/b.js'));
  check('`?` matches exactly one non-separator char', globToRegExp('a?.js').test('ab.js') && !globToRegExp('a?.js').test('a/b.js'));
  check('a literal dot is escaped, not treated as any-char', !globToRegExp('a.js').test('axjs'));
  check('the match is anchored at both ends', !globToRegExp('*.test.js').test('x.test.js.bak'));
  check('matchesAnyGlob is an OR over the list', matchesAnyGlob('scripts/dev-test-a.mjs', ['nope/*.js', 'scripts/dev-test-*.mjs']));
  check('matchesAnyGlob is false on an empty list', !matchesAnyGlob('anything.js', []));
}

// --- schedule detection and script extraction ---------------------------

function testHasScheduleTrigger() {
  console.log('\nhasScheduleTrigger');
  check('a real schedule: block is detected', hasScheduleTrigger(SCHEDULED));
  check('a push-only workflow is not', !hasScheduleTrigger(PUSH_ONLY));
  check('prose mentioning the word is not', !hasScheduleTrigger('# schedule a follow-up\non:\n  push:\n'));
  check('an indented schedule: under on: still counts', hasScheduleTrigger('on:\n  schedule:\n'));
}

function testExtractNodeScriptInvocations() {
  console.log('\nextractNodeScriptInvocations');
  const exts = ['.js', '.mjs', '.cjs'];
  check('finds a bare relative path', extractNodeScriptInvocations('run: node scripts/thing.js', exts).includes('scripts/thing.js'));
  check('finds an explicitly-relative path', extractNodeScriptInvocations('run: node ./tools/check.js', exts).includes('./tools/check.js'));
  check('tolerates leading node flags', extractNodeScriptInvocations('node --enable-source-maps scripts/a.js', exts).includes('scripts/a.js'));
  check('finds a .mjs script', extractNodeScriptInvocations('node scripts/a.mjs', exts).includes('scripts/a.mjs'));
  check('finds nothing for a heredoc invocation with no file path', extractNodeScriptInvocations("node - << 'EOF'\nconsole.log(1)\nEOF", exts).length === 0);
  check('finds nothing for `node -e`', extractNodeScriptInvocations('node -e "console.log(1)"', exts).length === 0);
  check('requires at least one slash, so prose cannot match', extractNodeScriptInvocations('just run node thing.js somehow', exts).length === 0);
  check('deduplicates repeated mentions', extractNodeScriptInvocations('node a/b.js\n...\nnode a/b.js', exts).length === 1);
  check('honours scriptExtensions - a .py is not a node script', extractNodeScriptInvocations('node a/b.py', exts).length === 0);
  check('a glob argument does not resolve as a path', extractNodeScriptInvocations('node --test tests/*.test.js', exts).length === 0);
}

function testFindScheduledWorkflows() {
  console.log('\nfindScheduledWorkflows');
  const dir = makeTree({
    'scheduled.yml': SCHEDULED,
    'push-only.yml': PUSH_ONLY,
    'curl-only.yml': SCHEDULED_CURL,
    'notes.txt': 'node scripts/ignored.js'
  });
  const { withScripts, withoutScripts } = findScheduledWorkflows(dir, testConfig());
  check('only scheduled workflows contribute scripts', withScripts.length === 1 && withScripts[0].scriptPath.endsWith('scripts/thing.js'));
  check('the finding names its workflow file', withScripts[0].workflowFile === 'scheduled.yml');
  check('a scheduled workflow with no local script is listed, not dropped', withoutScripts.includes('curl-only.yml'));
  check('a push-only workflow appears in neither list', !withoutScripts.includes('push-only.yml'));
  check('a non-workflow file in the directory is ignored', listWorkflowFiles(dir).every((f) => f.endsWith('.yml') || f.endsWith('.yaml')));
  rmSync(dir, { recursive: true, force: true });
}

// --- the module graph ---------------------------------------------------

function testExtractRelativeImports() {
  console.log('\nextractRelativeImports');
  check('static import', extractRelativeImports("import { a } from './x.js';").includes('./x.js'));
  check('re-export', extractRelativeImports("export { a } from './x.js';").includes('./x.js'));
  check('dynamic import', extractRelativeImports("await import('./x.js')").includes('./x.js'));
  check('CJS require', extractRelativeImports("const a = require('./x.js');").includes('./x.js'));
  check('a parent-relative specifier', extractRelativeImports("import a from '../lib/x.js';").includes('../lib/x.js'));
  check('a bare package name is ignored - it can never be a file here', extractRelativeImports("import fs from 'fs';").length === 0);
  check('deduplicates', extractRelativeImports("import a from './x.js';\nimport('./x.js');").length === 1);
}

function testFileImportsScript() {
  console.log('\nfileImportsScript - real graph resolution, not a naming guess');
  const dir = makeTree({
    'scripts/watchdog.js': 'export function run() {}',
    'scripts/other.js': 'export function other() {}',
    'scripts/dev-test-watchdog.mjs': "import { run } from './watchdog.js';",
    'scripts/dev-test-other.mjs': "import { other } from './other.js';",
    'tests/deep/nested.test.js': "const { run } = require('../../scripts/watchdog.js');",
    'scripts/dev-test-lookalike.mjs': '// named after watchdog but imports nothing'
  });
  const config = testConfig();
  check('resolves an import relative to the IMPORTER, not the repo root',
    fileImportsScript('scripts/dev-test-watchdog.mjs', 'scripts/watchdog.js', config, dir));
  check('resolves a deep parent-relative require',
    fileImportsScript('tests/deep/nested.test.js', 'scripts/watchdog.js', config, dir));
  check('does not match a different file in the same directory',
    !fileImportsScript('scripts/dev-test-other.mjs', 'scripts/watchdog.js', config, dir));
  check('a name-alike that imports nothing does NOT count as coverage',
    !fileImportsScript('scripts/dev-test-lookalike.mjs', 'scripts/watchdog.js', config, dir));
  check('a missing importer returns false instead of throwing',
    !fileImportsScript('scripts/does-not-exist.mjs', 'scripts/watchdog.js', config, dir));

  const extensionless = makeTree({
    'lib/thing.js': 'module.exports = {};',
    'tests/a.test.js': "require('../lib/thing');"
  });
  check('an extensionless specifier resolves against scriptExtensions',
    fileImportsScript('tests/a.test.js', 'lib/thing.js', config, extensionless));
  rmSync(extensionless, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

function testListAllTestFiles() {
  console.log('\nlistAllTestFiles');
  const dir = makeTree({
    'scripts/dev-test-a.mjs': '',
    'scripts/not-a-test.mjs': '',
    'tests/deep/b.test.js': '',
    'node_modules/dep/c.test.js': '',
    'src/app.js': ''
  });
  const found = listAllTestFiles(testConfig(), dir);
  check('a root-anchored pattern matches', found.includes('scripts/dev-test-a.mjs'));
  check('a `**/` pattern matches at depth', found.includes(join('tests', 'deep', 'b.test.js')));
  check('a non-test file is excluded', !found.includes('scripts/not-a-test.mjs'));
  check('an excluded dir is pruned even though the name matches', !found.some((f) => f.startsWith('node_modules')));
  rmSync(dir, { recursive: true, force: true });
}

// --- the floor.json <-> package.json drift gate -------------------------

function testCheckTestCommandGlobs() {
  console.log('\ncheckTestCommandGlobs - the gate that keeps "orphaned" honest');
  check('a declared glob present in the test command is clean',
    checkTestCommandGlobs(testConfig(), 'for f in scripts/dev-test-*.mjs; do node "$f" || exit 1; done').length === 0);
  check('a declared glob ABSENT from the test command is a problem',
    checkTestCommandGlobs(testConfig(), 'node --test tests/*.test.js').length === 1);
  check('the problem text names the offending glob',
    checkTestCommandGlobs(testConfig(), 'node --test tests/*.test.js')[0].includes('scripts/dev-test-*.mjs'));
  check('an empty testCommandGlobs is itself a problem, not a free pass',
    checkTestCommandGlobs(testConfig({ testCommandGlobs: [] }), 'anything').length === 1);
  check('a missing test script is a problem', checkTestCommandGlobs(testConfig(), '').length === 1);

  const dir = makeTree({ 'package.json': JSON.stringify({ scripts: { test: 'echo hi' } }) });
  check('readTestCommand reads the real script', readTestCommand(join(dir, 'package.json')) === 'echo hi');
  check('readTestCommand returns empty for a missing file', readTestCommand(join(dir, 'nope.json')) === '');
  rmSync(dir, { recursive: true, force: true });
}

// --- evaluateScript -----------------------------------------------------

function testEvaluateScript() {
  console.log('\nevaluateScript');
  const s = { workflowFile: 'w.yml', scriptPath: 'scripts/a.js' };
  check('no covering test at all -> uncovered',
    evaluateScript(s, [], testConfig()).status === 'uncovered');
  check('a covering test the command runs -> covered',
    evaluateScript(s, ['scripts/dev-test-a.mjs'], testConfig()).status === 'covered');
  const orphan = evaluateScript(s, ['tests/deep/a.test.js'], testConfig());
  check('a covering test the command NEVER runs -> orphaned', orphan.status === 'orphaned');
  check('the orphaned finding names the unreachable test file', orphan.testFiles.includes('tests/deep/a.test.js'));
  check('one reachable test among several unreachable ones is enough for covered',
    evaluateScript(s, ['tests/deep/a.test.js', 'scripts/dev-test-a.mjs'], testConfig()).status === 'covered');
  check('covered reports only the REACHABLE test files, not the dead ones',
    evaluateScript(s, ['tests/deep/a.test.js', 'scripts/dev-test-a.mjs'], testConfig()).testFiles.length === 1);
  const exempt = evaluateScript(s, [], testConfig({ exemptScripts: { 'scripts/a.js': 'a written reason' } }));
  check('an exempt script is skipped even with zero coverage', exempt.status === 'exempt');
  check('the exemption carries its reason forward into the report', exempt.reason === 'a written reason');
}

// --- runCoverageGaps, end to end over a scratch tree --------------------

function scratchRepo(extra = {}) {
  return makeTree({
    'package.json': JSON.stringify({ scripts: { test: 'for f in scripts/dev-test-*.mjs; do node "$f" || exit 1; done' } }),
    '.github/workflows/covered.yml': SCHEDULED.replace('scripts/thing.js', 'scripts/covered.js'),
    'scripts/covered.js': 'export function a() {}',
    'scripts/dev-test-covered.mjs': "import { a } from './covered.js';",
    ...extra
  });
}

function testRunIsGreenWhenEverythingIsCovered() {
  console.log('\nrunCoverageGaps - green when every scheduled script is covered and reachable');
  const dir = scratchRepo();
  const r = runCoverageGaps({ config: testConfig(), root: dir });
  check('no findings', r.hasFindings === false);
  check('no config problems', r.configProblems.length === 0);
  check('the one scheduled script is reported covered', r.results.length === 1 && r.results[0].status === 'covered');
  rmSync(dir, { recursive: true, force: true });
}

function testRunReportsUncovered() {
  console.log('\nrunCoverageGaps - a scheduled script with no test at all goes red');
  const dir = scratchRepo({
    '.github/workflows/naked.yml': SCHEDULED.replace('scripts/thing.js', 'scripts/naked.js'),
    'scripts/naked.js': 'export function b() {}'
  });
  const r = runCoverageGaps({ config: testConfig(), root: dir });
  const finding = r.results.find((x) => x.scriptPath === 'scripts/naked.js');
  check('hasFindings is true', r.hasFindings === true);
  check('the naked script is reported uncovered', finding && finding.status === 'uncovered');
  check('the covered script is still reported covered', r.results.find((x) => x.scriptPath === 'scripts/covered.js').status === 'covered');
  rmSync(dir, { recursive: true, force: true });
}

function testRunReportsOrphaned() {
  console.log('\nrunCoverageGaps - a real test `npm test` never runs goes red (the hard case)');
  const dir = scratchRepo({
    '.github/workflows/orphan.yml': SCHEDULED.replace('scripts/thing.js', 'scripts/orphan.js'),
    'scripts/orphan.js': 'export function c() {}',
    // A genuine, thorough test file - in a directory the test command's glob
    // does not expand. Exactly the shape TSO's version found for real.
    'src/__tests__/orphan.test.js': "import { c } from '../../scripts/orphan.js';"
  });
  const r = runCoverageGaps({ config: testConfig(), root: dir });
  const finding = r.results.find((x) => x.scriptPath === 'scripts/orphan.js');
  check('hasFindings is true', r.hasFindings === true);
  check('status is orphaned, NOT uncovered - the distinction is the point', finding && finding.status === 'orphaned');
  check('the finding names the test file that exists but never runs',
    finding.testFiles.includes(join('src', '__tests__', 'orphan.test.js')));
  const report = renderReport(r);
  check('the report explains the remedy rather than just the symptom', report.includes('never runs'));
  rmSync(dir, { recursive: true, force: true });
}

function testRunFailsOnConfigDrift() {
  console.log('\nrunCoverageGaps - config drift fails even when every script is covered');
  const dir = scratchRepo({
    'package.json': JSON.stringify({ scripts: { test: 'node --test tests/*.test.js' } })
  });
  const r = runCoverageGaps({ config: testConfig(), root: dir });
  check('hasFindings is true despite full coverage', r.hasFindings === true);
  check('the reason is a config problem, not a script finding',
    r.configProblems.length === 1 && r.results.every((x) => x.status === 'covered'));
  check('the report emits it as an ::error:: annotation', renderReport(r).includes('::error::config:'));
  rmSync(dir, { recursive: true, force: true });
}

function testRunNamesOutOfScopeWorkflows() {
  console.log('\nrunCoverageGaps - a scheduled workflow with no local script is named, not silently dropped');
  const dir = scratchRepo({ '.github/workflows/ping.yml': SCHEDULED_CURL });
  const r = runCoverageGaps({ config: testConfig(), root: dir });
  check('it produces no finding', r.hasFindings === false);
  check('but it IS listed', r.scheduledWorkflowsWithNoLocalScript.includes('ping.yml'));
  check('and the report says so', renderReport(r).includes('ping.yml'));
  rmSync(dir, { recursive: true, force: true });
}

function testRunHonoursExemptions() {
  console.log('\nrunCoverageGaps - an exemption suppresses, and would otherwise have fired');
  const dir = scratchRepo({
    '.github/workflows/naked.yml': SCHEDULED.replace('scripts/thing.js', 'scripts/naked.js'),
    'scripts/naked.js': 'export function b() {}'
  });
  check('exempt -> green', runCoverageGaps({ config: testConfig({ exemptScripts: { 'scripts/naked.js': 'why' } }), root: dir }).hasFindings === false);
  check('and without the exemption it WOULD have fired', runCoverageGaps({ config: testConfig(), root: dir }).hasFindings === true);
  rmSync(dir, { recursive: true, force: true });
}

// --- renderReport -------------------------------------------------------

function testRenderReport() {
  console.log('\nrenderReport');
  const clean = renderReport({
    results: [{ status: 'covered', scriptPath: 'a.js', workflowFile: 'w.yml', testFiles: ['t.mjs'] }],
    scheduledWorkflowsWithNoLocalScript: [],
    configProblems: [],
    testFileCount: 3,
    hasFindings: false
  });
  check('a clean run emits no ::error:: annotation', !clean.includes('::error::'));
  check('a clean run says so plainly', clean.includes('Every scheduled script has real, CI-reachable test coverage.'));
  check('a clean run still discloses how much it scanned', clean.includes('Scanned 3 test file(s)'));

  const dirty = renderReport({
    results: [{ status: 'uncovered', scriptPath: 'scripts/naked.js', workflowFile: 'naked.yml' }],
    scheduledWorkflowsWithNoLocalScript: [],
    configProblems: [],
    testFileCount: 3,
    hasFindings: true
  });
  check('an uncovered finding emits ::error::', dirty.includes('::error::'));
  check('the annotation names the script and its workflow', dirty.includes('scripts/naked.js') && dirty.includes('naked.yml'));

  const exempt = renderReport({
    results: [{ status: 'exempt', scriptPath: 'a.js', workflowFile: 'w.yml', reason: 'the written reason' }],
    scheduledWorkflowsWithNoLocalScript: [],
    configProblems: [],
    testFileCount: 1,
    hasFindings: false
  });
  check('an exemption prints its reason in the log', exempt.includes('the written reason'));
}

// --- the one test against the real repo ---------------------------------

function testThisRepoIsCovered() {
  console.log("\nthis repo's own scheduled jobs - non-vacuous and clean");
  const config = loadConfig();
  const result = runCoverageGaps({ config });
  check('floor.json actually declares the coverageGaps block', config.testCommandGlobs.length > 0);
  check(`found this repo's scheduled scripts (${result.results.length})`, result.results.length >= 4);
  check(`resolved real coverage edges (${result.testFileCount} test files scanned)`, result.testFileCount > 0);
  check(
    'every scheduled script resolved to a test that `npm test` really runs',
    result.results.every((r) => r.status === 'covered' && r.testFiles.length > 0)
  );
  check('floor.json and package.json agree on what the test command globs', result.configProblems.length === 0);
  if (result.hasFindings) console.error(renderReport(result));
  check('no findings', !result.hasFindings);
}

// --- main ---------------------------------------------------------------

function main() {
  console.log('coverage-gaps (floor check 9) - local verification\n');

  testGlobToRegExp();
  testHasScheduleTrigger();
  testExtractNodeScriptInvocations();
  testFindScheduledWorkflows();
  testExtractRelativeImports();
  testFileImportsScript();
  testListAllTestFiles();
  testCheckTestCommandGlobs();
  testEvaluateScript();
  testRunIsGreenWhenEverythingIsCovered();
  testRunReportsUncovered();
  testRunReportsOrphaned();
  testRunFailsOnConfigDrift();
  testRunNamesOutOfScopeWorkflows();
  testRunHonoursExemptions();
  testRenderReport();
  testThisRepoIsCovered();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
