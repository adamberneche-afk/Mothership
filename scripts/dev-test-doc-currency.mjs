// Local verification harness for scripts/doc-currency.js (floor check 6 -
// see CICD_FLOOR.md). Adapted from TSO's tools/doc-currency test file to
// this repo's plain check()-based harness convention.
//
// Two kinds of test live here, deliberately:
//
//   1. HERMETIC tests over a scratch tree (mkdtemp) - every extractor,
//      matcher and the end-to-end runner, against files this harness
//      writes itself. Nothing depends on the real repo's current content,
//      so these stay meaningful forever.
//   2. ONE anti-vacuous test over the real repo - that the check actually
//      scanned docs and code here, and found nothing stale. That one is
//      what makes `npm test` (and therefore the CI `test` job) go red on
//      doc rot, not just the doc-currency workflow. A tool that only ever
//      runs against fixtures is the kind of green that means nothing.
//
// The scratch-tree tests exist specifically because of a real false
// positive found on this check's first run against this repo: the walk it
// was ported with skipped every dotfile, so README's correct citation of
// `gas/.clasp.json.example` was reported missing. testWalkSeesDotfiles is
// that bug, pinned.
//
// Usage: node scripts/dev-test-doc-currency.mjs

import {
  IGNORE_MARKER,
  loadConfig,
  stripIgnoredLines,
  isCheckableDoc,
  listDocFiles,
  loadCodeCorpus,
  listAllFiles,
  extractFileCitations,
  extractFunctionCitations,
  checkFileCitation,
  checkFunctionCitation,
  runDocCurrency,
  renderReport
} from './doc-currency.js';
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

// --- Scratch tree helpers ----------------------------------------------

function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-currency-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// The config a scratch-tree test runs under. Explicit rather than inherited
// from the repo's floor.json, so a change to that file can never quietly
// change what these tests assert.
function testConfig(overrides = {}) {
  return {
    excludeDirs: new Set(['node_modules', '.git']),
    exemptDocs: new Set(['lessons.md']),
    codeExtensions: new Set(['.js', '.py']),
    knownAbsentPaths: new Set(),
    ...overrides
  };
}

// --- loadConfig --------------------------------------------------------

function testLoadConfigFallsBackWhenTheFileIsMissing() {
  console.log('\nloadConfig - missing file falls back to defaults');
  const config = loadConfig(join(tmpdir(), 'doc-currency-no-such-floor.json'));
  check('excludeDirs still has node_modules', config.excludeDirs.has('node_modules'));
  check('codeExtensions still has .js', config.codeExtensions.has('.js'));
  check('exemptDocs is empty rather than undefined', config.exemptDocs.size === 0);
  check('knownAbsentPaths is empty rather than undefined', config.knownAbsentPaths.size === 0);
}

function testLoadConfigFallsBackOnMalformedJson() {
  console.log('\nloadConfig - malformed JSON falls back instead of throwing');
  const dir = makeTree({ 'floor.json': '{ this is not json' });
  let threw = false;
  let config;
  try {
    config = loadConfig(join(dir, 'floor.json'));
  } catch (e) {
    threw = true;
  }
  check('did not throw', !threw);
  check('returned usable defaults', config && config.codeExtensions.has('.js'));
  rmSync(dir, { recursive: true, force: true });
}

function testLoadConfigReadsTheDocCurrencyBlock() {
  console.log('\nloadConfig - reads the docCurrency block');
  const dir = makeTree({
    'floor.json': JSON.stringify({
      docCurrency: {
        excludeDirs: ['vendor'],
        exemptDocs: ['NOTES.md'],
        codeExtensions: ['.rb'],
        knownAbsentPaths: { 'a/b.yml': 'a reason' }
      }
    })
  });
  const config = loadConfig(join(dir, 'floor.json'));
  check('excludeDirs comes from the file', config.excludeDirs.has('vendor'));
  check('exemptDocs is lowercased for case-insensitive matching', config.exemptDocs.has('notes.md'));
  check('codeExtensions comes from the file', config.codeExtensions.has('.rb'));
  check(
    'knownAbsentPaths uses the map KEYS, discarding the reason prose',
    config.knownAbsentPaths.has('a/b.yml') && !config.knownAbsentPaths.has('a reason')
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- stripIgnoredLines -------------------------------------------------

function testStripIgnoredLinesBlanksOnlyTheMarkedLine() {
  console.log('\nstripIgnoredLines - blanks only the marked line');
  const content = ['keep `a/b.js`', `drop \`c/d.js\` <!-- ${IGNORE_MARKER} -->`, 'keep `e/f.js`'].join('\n');
  const stripped = stripIgnoredLines(content);
  check('kept line before the marker', stripped.includes('a/b.js'));
  check('dropped the marked line', !stripped.includes('c/d.js'));
  check('kept line after the marker', stripped.includes('e/f.js'));
  check('preserved the line count, so line numbers still line up', stripped.split('\n').length === 3);
}

// --- extractFileCitations ----------------------------------------------

function testExtractFileCitations() {
  console.log('\nextractFileCitations');
  check(
    'finds a backticked slash-containing path with an extension',
    extractFileCitations('see `api/handler.js` for details').includes('api/handler.js')
  );
  check(
    'finds a dotfile path (the gas/.clasp.json.example class)',
    extractFileCitations('copy `gas/.clasp.json.example`').includes('gas/.clasp.json.example')
  );
  check(
    'ignores a bare word in backticks',
    extractFileCitations('the `handler` function').length === 0
  );
  check(
    'ignores a path with no extension',
    extractFileCitations('the `api/handlers` directory').length === 0
  );
  check(
    'ignores a filename with no slash - too weak a signal to resolve',
    extractFileCitations('see `handler.js`').length === 0
  );
  check(
    'ignores a shell flag',
    extractFileCitations('pass `--exclude-dir=node_modules`').length === 0
  );
  check(
    'rejects an elided illustrative path',
    extractFileCitations('files like `gas/.../review_queue.js`').length === 0
  );
  const dupes = extractFileCitations('`a/b.js` and again `a/b.js`');
  check('dedupes repeated citations', dupes.length === 1);
  check(
    'honours the ignore marker',
    extractFileCitations(`create \`a/new.js\` <!-- ${IGNORE_MARKER} -->`).length === 0
  );
}

// --- extractFunctionCitations ------------------------------------------

function testExtractFunctionCitations() {
  console.log('\nextractFunctionCitations');
  check(
    'finds a bare call',
    extractFunctionCitations('call `harvestReviewResults()` first').includes('harvestReviewResults')
  );
  check(
    'finds a call with arguments, keeping only the name',
    extractFunctionCitations('`finalizeReviewResult_(row, result)`').includes('finalizeReviewResult_')
  );
  check(
    'does NOT match a method call - the identifier must follow the backtick',
    extractFunctionCitations('`array.push(x)`').length === 0
  );
  check(
    'does not match a call that is not fully inside one backtick span',
    extractFunctionCitations('`foo(` bar `)`').length === 0
  );
  check(
    'honours the ignore marker',
    extractFunctionCitations(`add \`notYetWritten()\` <!-- ${IGNORE_MARKER} -->`).length === 0
  );
}

// --- checkFileCitation / checkFunctionCitation -------------------------

function testCheckFileCitation() {
  console.log('\ncheckFileCitation');
  const files = ['api/handler.js', 'gas/sub/dir/thing.js', 'mylib/secrets.js'];
  check('exact root-relative match resolves', checkFileCitation('api/handler.js', files));
  check('path-boundary suffix match resolves', checkFileCitation('sub/dir/thing.js', files));
  check(
    'a suffix that is NOT on a path boundary does not resolve',
    !checkFileCitation('lib/secrets.js', files)
  );
  check('an absent path does not resolve', !checkFileCitation('api/gone.js', files));
}

function testCheckFunctionCitation() {
  console.log('\ncheckFunctionCitation');
  const corpus = [{ relPath: 'a.js', content: 'function runner() { return processRequest(); }' }];
  check('a name present in the corpus resolves', checkFunctionCitation('processRequest', corpus));
  check('a definition site counts, not just a call site', checkFunctionCitation('runner', corpus));
  check('whole-word only - "run" must not match inside "runner"', !checkFunctionCitation('run', corpus));
  check('an absent name does not resolve', !checkFunctionCitation('deletedHelper', corpus));
  check(
    'regex metacharacters in the name are escaped, not interpreted',
    !checkFunctionCitation('r.nner', [{ relPath: 'a.js', content: 'runner' }])
  );
}

// --- isCheckableDoc ----------------------------------------------------

function testIsCheckableDoc() {
  console.log('\nisCheckableDoc');
  const config = testConfig();
  check('a plain .md is checkable', isCheckableDoc('README.md', config));
  check('a non-.md file is not', !isCheckableDoc('handler.js', config));
  check('an exempt doc is not', !isCheckableDoc('lessons.md', config));
  check('the exempt match is case-insensitive', !isCheckableDoc('LESSONS.md', config));
  check(
    'a dated snapshot is skipped - naming what used to exist is what a record is FOR',
    !isCheckableDoc('POST_MORTEM_2026-09.md', config)
  );
}

// --- the walk ----------------------------------------------------------

function testWalkSeesDotfiles() {
  console.log('\nthe walk - dotfiles are part of "exists in the repo" (pinned regression)');
  const dir = makeTree({
    'gas/.clasp.json.example': '{}',
    '.github/workflows/ci.yml': 'name: CI',
    'README.md': '# hi'
  });
  const files = listAllFiles(testConfig(), dir);
  check('a dotfile is listed', files.includes('gas/.clasp.json.example'));
  check('a file inside a dot-directory is listed', files.includes('.github/workflows/ci.yml'));
  check('an ordinary file is listed', files.includes('README.md'));
  rmSync(dir, { recursive: true, force: true });
}

function testWalkPrunesExcludedDirsOnly() {
  console.log('\nthe walk - excludeDirs is the only pruning mechanism');
  const dir = makeTree({
    'node_modules/dep/index.js': 'module.exports = 1;',
    '.git/config': '[core]',
    'lib/real.js': 'export const real = 1;',
    'docs/guide.md': '# guide'
  });
  const config = testConfig();
  const files = listAllFiles(config, dir);
  check('an excluded dir is pruned', !files.some((f) => f.startsWith('node_modules/')));
  check('.git is pruned because it is NAMED in excludeDirs', !files.some((f) => f.startsWith('.git/')));
  check('a nested real file is found', files.includes('lib/real.js'));

  const corpus = loadCodeCorpus(config, dir);
  check('the code corpus honours codeExtensions', corpus.length === 1 && corpus[0].relPath === 'lib/real.js');
  check('the code corpus carries file contents', corpus[0].content.includes('export const real'));

  const docs = listDocFiles(config, dir);
  check('doc listing finds the nested doc', docs.includes('docs/guide.md'));
  check('doc listing excludes non-docs', !docs.includes('lib/real.js'));
  rmSync(dir, { recursive: true, force: true });
}

// --- runDocCurrency, end to end over a scratch tree --------------------

function testRunReportsAMissingFileCitation() {
  console.log('\nrunDocCurrency - a doc citing a nonexistent FILE goes red');
  const dir = makeTree({
    'README.md': 'The entrypoint is `api/deleted_handler.js`.',
    'api/handler.js': 'export function handle() {}'
  });
  const { findings, hasFindings } = runDocCurrency({ config: testConfig(), root: dir });
  check('reports exactly one finding', findings.length === 1);
  check('the finding is typed cited-file-missing', findings[0].type === 'cited-file-missing');
  check('the finding names the doc', findings[0].doc === 'README.md');
  check('the finding names the citation', findings[0].cited === 'api/deleted_handler.js');
  check('hasFindings is true', hasFindings === true);
  rmSync(dir, { recursive: true, force: true });
}

function testRunReportsAMissingFunctionCitation() {
  console.log('\nrunDocCurrency - a doc citing a nonexistent FUNCTION goes red');
  const dir = makeTree({
    'README.md': 'Call `longSinceDeleted()` to start.',
    'api/handler.js': 'export function handle() {}'
  });
  const { findings } = runDocCurrency({ config: testConfig(), root: dir });
  check('reports exactly one finding', findings.length === 1);
  check('the finding is typed cited-function-missing', findings[0].type === 'cited-function-missing');
  check('the finding renders the citation with parens', findings[0].cited === 'longSinceDeleted()');
  rmSync(dir, { recursive: true, force: true });
}

function testRunIsQuietOnRealCitations() {
  console.log('\nrunDocCurrency - real citations resolve (anti-vacuous)');
  const dir = makeTree({
    'README.md': 'See `api/handler.js`, which defines `handle()`.',
    'api/handler.js': 'export function handle() {}'
  });
  const { findings, hasFindings } = runDocCurrency({ config: testConfig(), root: dir });
  check('no findings', findings.length === 0);
  check('hasFindings is false', hasFindings === false);
  rmSync(dir, { recursive: true, force: true });
}

function testRunHonoursTheIgnoreMarker() {
  console.log('\nrunDocCurrency - the per-line ignore marker suppresses both kinds');
  const dir = makeTree({
    'README.md': [
      `Create \`api/not_yet.js\`. <!-- ${IGNORE_MARKER} -->`,
      `Then call \`notYetWritten()\`. <!-- ${IGNORE_MARKER} -->`
    ].join('\n'),
    'api/handler.js': 'export function handle() {}'
  });
  const { findings } = runDocCurrency({ config: testConfig(), root: dir });
  check('no findings', findings.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

function testRunHonoursKnownAbsentPaths() {
  console.log('\nrunDocCurrency - knownAbsentPaths suppresses a path cited repeatedly');
  const dir = makeTree({
    'README.md': 'A spoke has `.github/workflows/call-hub.yml`, and a second mention of `.github/workflows/call-hub.yml`.',
    'api/handler.js': 'export function handle() {}'
  });
  const config = testConfig({ knownAbsentPaths: new Set(['.github/workflows/call-hub.yml']) });
  check('no findings', runDocCurrency({ config, root: dir }).findings.length === 0);
  check(
    'and it really was absent - without the entry it WOULD have fired',
    runDocCurrency({ config: testConfig(), root: dir }).findings.length === 1
  );
  rmSync(dir, { recursive: true, force: true });
}

function testRunSkipsExemptDocs() {
  console.log('\nrunDocCurrency - an exempt doc is not scanned at all');
  const dir = makeTree({
    'lessons.md': 'We used to have `api/deleted.js` and `goneForever()`.',
    'api/handler.js': 'export function handle() {}'
  });
  check('no findings', runDocCurrency({ config: testConfig(), root: dir }).findings.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

function testRunScansEveryDoc() {
  console.log('\nrunDocCurrency - every checkable doc is scanned, not just the first');
  const dir = makeTree({
    'README.md': 'cites `api/gone_a.js`',
    'docs/deep/GUIDE.md': 'cites `api/gone_b.js`',
    'api/handler.js': 'export function handle() {}'
  });
  const { findings } = runDocCurrency({ config: testConfig(), root: dir });
  check('two findings, one per doc', findings.length === 2);
  check(
    'both docs are named',
    findings.some((f) => f.doc === 'README.md') && findings.some((f) => f.doc === join('docs', 'deep', 'GUIDE.md'))
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- renderReport ------------------------------------------------------

function testRenderReport() {
  console.log('\nrenderReport');
  const clean = renderReport({ findings: [], hasFindings: false });
  check('a clean run says so', clean.includes('No stale file or function citations found.'));
  check('a clean run emits no ::error:: annotation', !clean.includes('::error::'));

  const dirty = renderReport({
    findings: [{ type: 'cited-file-missing', doc: 'README.md', cited: 'api/gone.js' }],
    hasFindings: true
  });
  check('a finding emits a GitHub ::error:: annotation', dirty.includes('::error::'));
  check('the annotation names the doc', dirty.includes('README.md'));
  check('the annotation names the citation', dirty.includes('api/gone.js'));
  check('the remedy names the ignore marker', dirty.includes(IGNORE_MARKER));
}

// --- the one test against the real repo --------------------------------

function testThisRepoIsCurrent() {
  console.log("\nthis repo's own docs - non-vacuous and clean");
  const config = loadConfig();
  const docs = listDocFiles(config);
  const corpus = loadCodeCorpus(config);
  check(`scanned some docs (${docs.length})`, docs.length > 0);
  check(`loaded some code (${corpus.length} files)`, corpus.length > 0);
  check('README.md is among the scanned docs', docs.includes('README.md'));

  const result = runDocCurrency({ config, docFiles: docs, codeCorpus: corpus });
  if (result.hasFindings) {
    console.error(renderReport(result));
  }
  check('no stale citations in this repo', !result.hasFindings);
}

// --- main --------------------------------------------------------------

function main() {
  console.log('doc-currency (floor check 6) - local verification\n');

  testLoadConfigFallsBackWhenTheFileIsMissing();
  testLoadConfigFallsBackOnMalformedJson();
  testLoadConfigReadsTheDocCurrencyBlock();
  testStripIgnoredLinesBlanksOnlyTheMarkedLine();
  testExtractFileCitations();
  testExtractFunctionCitations();
  testCheckFileCitation();
  testCheckFunctionCitation();
  testIsCheckableDoc();
  testWalkSeesDotfiles();
  testWalkPrunesExcludedDirsOnly();
  testRunReportsAMissingFileCitation();
  testRunReportsAMissingFunctionCitation();
  testRunIsQuietOnRealCitations();
  testRunHonoursTheIgnoreMarker();
  testRunHonoursKnownAbsentPaths();
  testRunSkipsExemptDocs();
  testRunScansEveryDoc();
  testRenderReport();
  testThisRepoIsCurrent();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
