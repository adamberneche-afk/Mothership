// Floor check 9 (see CICD_FLOOR.md) - finds a scheduled job's script that
// either has no test anywhere in the repo, or has one that exists on disk
// but which `npm test` never actually runs.
//
// Adapted from TSO's tools/coverage-gaps/check.js, itself a reshaping of
// KOS's original. KOS's answers "was this Apps Script trigger handler's body
// ever entered" using V8 coverage instrumentation over files loaded into a
// vm sandbox - a real trick, needed because GAS has no module system and
// every file in a project shares one global scope. Neither TSO nor this repo
// has that problem: scheduled-job scripts here are ordinary Node modules
// with a real module graph, so the same question is answerable by resolving
// that graph directly, with no instrumentation at all.
//
// Two deliberate changes from TSO's version, both forced by this repo:
//
//   1. IT RESOLVES ESM `import`, not just CJS `require`. Mothership is
//      "type": "module"; a require-only scanner would resolve exactly zero
//      edges here and report every scheduled script as uncovered. Both
//      forms are matched, because the distributed copy has to work in a
//      CJS spoke too.
//
//   2. THE `npm test` REACHABILITY GLOBS COME FROM floor.json, VERIFIED
//      AGAINST package.json. TSO parses its own `node --test <globs>` test
//      script to learn what CI really runs, which is what lets it tell
//      "has no test" from "has a test nothing runs". That parse is specific
//      to one command shape; this repo's test script is a shell for-loop,
//      and a distributed copy would meet a third shape in the next repo.
//      Parsing arbitrary shell is not the answer. Instead floor.json
//      DECLARES the globs, and this check asserts each declared glob
//      appears verbatim in package.json's real test command - so the two
//      cannot drift apart silently in either direction. A mismatch is a
//      hard failure, not a warning: every reachability verdict below is
//      meaningless if that declaration is stale.
//
// WHY "HAS A TEST" IS NOT THE QUESTION. TSO's version found a real instance
// of the harder case while it was still being written: a scheduled script
// with a genuine test file, six passing tests, every exported function
// exercised - and a root `npm test` whose glob only expanded files directly
// inside tests/, so it had never once run. A human had already done the work
// of writing the safety net and nothing wired it in. That is the same
// failure class as this portfolio's quoted-glob incident, and it is
// invisible to any check that asks only whether a test file exists.
//
// SCOPE, DELIBERATELY NARROW: only scripts a `schedule:`-triggered workflow
// invokes as `node <path>`. A scheduled workflow that runs no local script
// at all - this repo's self-reflect.yml and recursive-learning.yml curl a
// remote endpoint, and codeql.yml runs an action - has nothing to resolve a
// test against, so it produces no finding. It is still NAMED in the report,
// because a whole workflow silently dropping out of scope is exactly the
// kind of invisible narrowing this floor exists to prevent. Unattended jobs
// are the scope because an unattended job fails silently for as long as
// nobody happens to look; a dispatch-only tool fails in front of whoever
// ran it.
//
// Per-repo settings come from .github/floor.json under `coverageGaps`, so
// this file stays byte-identical in every repo the floor is distributed to -
// see CICD_FLOOR.md's "why runtime config instead of templating" section.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLOOR_CONFIG_PATH = join(ROOT, '.github', 'floor.json');

// Every key is optional and falls back to a documented default, so this
// keeps working in a repo whose floor.json predates a key being added - the
// same tolerance the rest of the floor applies to its own config lookups.
export function loadConfig(configPath = FLOOR_CONFIG_PATH) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')).coverageGaps || {};
  } catch (e) {
    raw = {};
  }
  return {
    excludeDirs: new Set(raw.excludeDirs || ['node_modules', '.git', '__pycache__', 'dist', 'build', 'coverage']),
    // Broad on purpose: anything that LOOKS like a test, wherever it sits.
    // This has to be wider than testCommandGlobs or the "orphaned" status
    // below can never fire, and that status is the whole point of the tool.
    testFilePatterns: raw.testFilePatterns || ['**/*.test.js', '**/*.test.mjs', 'scripts/dev-test-*.mjs'],
    // Narrow on purpose: what `npm test` actually expands. Verified against
    // package.json by checkTestCommandGlobs().
    testCommandGlobs: raw.testCommandGlobs || [],
    scriptExtensions: raw.scriptExtensions || ['.js', '.mjs', '.cjs'],
    exemptScripts: raw.exemptScripts || {}
  };
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

// Supports `**/` (any number of directories, including none), `**`, `*` (no
// slash) and `?`. A disclosed subset, not a general glob engine - it covers
// every shape the floor's configs actually use, and anything it cannot
// express belongs in a second pattern rather than in a bigger parser.
export function globToRegExp(glob) {
  const DIRS = '\u0000';
  const ANY = '\u0001';
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, DIRS)
    .replace(/\*\*/g, ANY)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(DIRS)
    .join('(?:[^/]+/)*')
    .split(ANY)
    .join('.*');
  return new RegExp(`^${body}$`);
}

export function matchesAnyGlob(relPath, globs) {
  return globs.some((g) => globToRegExp(g).test(relPath));
}

// ---------------------------------------------------------------------------
// Scheduled scripts, discovered from the workflow files themselves
// ---------------------------------------------------------------------------

export function listWorkflowFiles(dir = join(ROOT, '.github', 'workflows')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

// A plain-string check, not a YAML parse - the same choice watchdog.js makes
// for the same reason: this must stay honest about a file YAML cannot even
// load, which is a failure this portfolio has actually had (workflow files
// sat unparseable for five months in a sibling repo). A parser would throw
// and report nothing; this reads what is on the line.
export function hasScheduleTrigger(fileContent) {
  return /^\s*schedule:\s*$/m.test(fileContent);
}

// Every `node <relative/path>` invocation anywhere in a workflow's text.
// Requires at least one `/` so a stray "node something.js" in a comment
// can't match, and tolerates leading flags so `node --enable-source-maps
// scripts/x.js` still resolves. A heredoc or `-e` invocation has no path and
// correctly finds nothing.
export function extractNodeScriptInvocations(fileContent, scriptExtensions = ['.js', '.mjs', '.cjs']) {
  const exts = scriptExtensions.map((e) => e.replace(/^\./, '')).join('|');
  const re = new RegExp(`\\bnode\\s+(?:--[\\w-]+(?:=\\S+)?\\s+)*(\\.{0,2}\\/?[\\w.-]+(?:\\/[\\w.-]+)+\\.(?:${exts}))\\b`, 'g');
  return [...new Set([...fileContent.matchAll(re)].map((m) => m[1]))];
}

// Normalizes `./scripts/x.js` and `scripts/x.js` to the same repo-relative
// key, so the same script invoked both ways is one entry, not two.
function normalizeScriptPath(scriptPath) {
  return relative(ROOT, resolve(ROOT, scriptPath));
}

export function findScheduledWorkflows(dir = join(ROOT, '.github', 'workflows'), config = loadConfig()) {
  const withScripts = [];
  const withoutScripts = [];
  for (const workflowFile of listWorkflowFiles(dir)) {
    const content = readFileSync(join(dir, workflowFile), 'utf8');
    if (!hasScheduleTrigger(content)) continue;
    const scripts = extractNodeScriptInvocations(content, config.scriptExtensions);
    if (scripts.length === 0) {
      withoutScripts.push(workflowFile);
      continue;
    }
    for (const scriptPath of scripts) {
      withScripts.push({ workflowFile, scriptPath: normalizeScriptPath(scriptPath) });
    }
  }
  return { withScripts, withoutScripts };
}

// ---------------------------------------------------------------------------
// The module graph
// ---------------------------------------------------------------------------

// Collects every file and leaves the filtering to the caller. Deliberately
// takes no predicate: a pattern like `scripts/dev-test-*.mjs` is anchored at
// the repo root, so a predicate applied mid-recursion would be matching
// against the wrong base - a quiet way to make the match narrower than it
// reads. excludeDirs is the only thing that prunes, the same choice
// doc-currency.js makes and for the same reason.
function walkAllFiles(dir, excludeDirs, results = []) {
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue;
      walkAllFiles(full, excludeDirs, results);
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export function listAllTestFiles(config = loadConfig(), root = ROOT) {
  return walkAllFiles(root, config.excludeDirs)
    .map((p) => relative(root, p))
    .filter((rel) => matchesAnyGlob(rel, config.testFilePatterns));
}

// Every relative specifier a file imports or requires: static `import`,
// re-export (`export ... from`), dynamic `import()`, and CJS `require()`.
// Only relative specifiers - a bare package name can never resolve to a
// file in this repo.
//
// WHY THIS IS A SCANNER AND NOT A REGEX. A regex over raw source text also
// matches an import statement that appears INSIDE a string or a comment,
// and that is not a hypothetical: the first real run of this check reported
// scripts/watchdog.js as covered by scripts/dev-test-coverage-gaps.mjs,
// which does not import it - the harness merely contains the text
// "import { run } from './watchdog.js';" as a string fixture. That is a
// false coverage edge, and false coverage edges are the exact failure this
// check exists to prevent: with one, deleting the real dev-test-watchdog.mjs
// would still read "covered". A tool whose job is detecting vacuous green
// cannot itself report one.
//
// So this walks the source instead, skipping comments outright and
// consuming each string literal whole. A specifier counts only when the
// CODE immediately preceding its literal - code, not text - is `from`,
// `import(` or `require(`. A quoted import statement nested inside another
// string is never seen as its own literal, because the outer string is
// consumed as one unit; the code before it is whatever followed the opening
// quote's context, which is not `from`.
//
// This is the same correctness problem KOS's original solved by requiring
// gas-lint's comment/string stripping. Rather than drag that dependency in,
// the scanner here is ~50 lines of node builtins and stays inside this
// file's "imports nothing" constraint.
const STRING_QUOTES = new Set(["'", '"', '`']);

// A `/` starts a regex literal rather than a division when the last
// significant code character cannot end an expression. Getting this wrong
// costs at most a MISSED import (a loud false "uncovered"), never a
// fabricated one, which is the safe direction for this tool to fail in.
const REGEX_PRECEDERS = new Set(['=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

// Returns the string literals in `source` that appear in code position,
// each paired with the code that preceded it (comments and other strings
// removed). Template literals are treated as plain literals; one containing
// `${` is skipped, since an interpolated path cannot be resolved statically
// anyway.
function scanCodePositionStrings(source) {
  const found = [];
  let code = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/') {
      const lastCode = code.trimEnd().slice(-1);
      if (lastCode === '' || REGEX_PRECEDERS.has(lastCode)) {
        // Consume a regex literal, honouring escapes and character classes
        // so a quote inside one never flips us into string mode.
        i++;
        let inClass = false;
        while (i < source.length) {
          const r = source[i];
          if (r === '\\') { i += 2; continue; }
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) { i++; break; }
          else if (r === '\n') break;
          i++;
        }
        code += ' ';
        continue;
      }
      code += c;
      i++;
      continue;
    }

    if (STRING_QUOTES.has(c)) {
      const quote = c;
      let value = '';
      let interpolated = false;
      i++;
      while (i < source.length) {
        const r = source[i];
        if (r === '\\') { value += source.slice(i, i + 2); i += 2; continue; }
        if (r === quote) { i++; break; }
        if (quote === '`' && r === '$' && source[i + 1] === '{') interpolated = true;
        if (quote !== '`' && r === '\n') break; // unterminated - bail out of string mode
        value += r;
        i++;
      }
      if (!interpolated) found.push({ value, precedingCode: code });
      code += ' ';
      continue;
    }

    code += c;
    i++;
  }
  return found;
}

const IMPORT_POSITION_RE = /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*$/;

export function extractRelativeImports(source) {
  const specs = scanCodePositionStrings(source)
    .filter(({ value, precedingCode }) => value.startsWith('.') && IMPORT_POSITION_RE.test(precedingCode))
    .map(({ value }) => value);
  return [...new Set(specs)];
}

// Real graph resolution against the importing file's OWN directory, with or
// without a trailing extension - not a naming-convention guess. A
// convention guess ("watchdog.js is covered because dev-test-watchdog.mjs
// exists") would call a renamed-but-never-reconnected test file covered,
// which is precisely the state this check exists to find.
export function fileImportsScript(importerRelPath, scriptRelPath, config = loadConfig(), root = ROOT) {
  const importerAbs = join(root, importerRelPath);
  const scriptAbs = join(root, scriptRelPath);
  let source;
  try {
    source = readFileSync(importerAbs, 'utf8');
  } catch (e) {
    return false;
  }
  for (const spec of extractRelativeImports(source)) {
    const resolved = resolve(dirname(importerAbs), spec);
    if (resolved === scriptAbs) return true;
    if (!extname(resolved) && config.scriptExtensions.some((ext) => `${resolved}${ext}` === scriptAbs)) return true;
  }
  return false;
}

export function findTestFilesCovering(scriptRelPath, testFiles, config = loadConfig(), root = ROOT) {
  return testFiles.filter((t) => fileImportsScript(t, scriptRelPath, config, root));
}

// ---------------------------------------------------------------------------
// The floor.json <-> package.json drift gate
// ---------------------------------------------------------------------------

export function readTestCommand(packageJsonPath = join(ROOT, 'package.json')) {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return (pkg.scripts && pkg.scripts.test) || '';
  } catch (e) {
    return '';
  }
}

// Each declared glob must appear verbatim in the real `npm test` command.
// This is what keeps the "orphaned" verdict honest: without it, floor.json
// could claim CI runs a glob it stopped running months ago and every verdict
// here would still read green.
export function checkTestCommandGlobs(config = loadConfig(), testCommand = readTestCommand()) {
  const problems = [];
  if (config.testCommandGlobs.length === 0) {
    problems.push(
      'coverageGaps.testCommandGlobs is empty in .github/floor.json, so this check cannot tell ' +
        'a script with no test from one whose test `npm test` never runs. Declare the glob(s) the ' +
        'test command expands.'
    );
    return problems;
  }
  if (!testCommand) {
    problems.push('package.json has no "test" script, so the declared testCommandGlobs cannot be verified against anything.');
    return problems;
  }
  for (const glob of config.testCommandGlobs) {
    if (!testCommand.includes(glob)) {
      problems.push(
        `coverageGaps.testCommandGlobs declares "${glob}", but package.json's test script does not contain it. ` +
          'One of the two has changed without the other; every coverage verdict below is untrustworthy until they agree.'
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

// Pure: no filesystem reads beyond what is passed in.
export function evaluateScript({ workflowFile, scriptPath }, coveringTestFiles, config) {
  if (Object.prototype.hasOwnProperty.call(config.exemptScripts, scriptPath)) {
    return { status: 'exempt', workflowFile, scriptPath, reason: config.exemptScripts[scriptPath] };
  }
  if (coveringTestFiles.length === 0) {
    return { status: 'uncovered', workflowFile, scriptPath };
  }
  const reachable = coveringTestFiles.filter((f) => matchesAnyGlob(f, config.testCommandGlobs));
  if (reachable.length === 0) {
    return { status: 'orphaned', workflowFile, scriptPath, testFiles: coveringTestFiles };
  }
  return { status: 'covered', workflowFile, scriptPath, testFiles: reachable };
}

export function runCoverageGaps({
  config = loadConfig(),
  root = ROOT,
  workflowsDir,
  testFiles,
  testCommand
} = {}) {
  const dir = workflowsDir || join(root, '.github', 'workflows');
  const tests = testFiles || listAllTestFiles(config, root);
  const configProblems = checkTestCommandGlobs(config, testCommand === undefined ? readTestCommand(join(root, 'package.json')) : testCommand);

  const { withScripts, withoutScripts } = findScheduledWorkflows(dir, config);
  const results = withScripts.map((s) =>
    evaluateScript(s, findTestFilesCovering(s.scriptPath, tests, config, root), config)
  );

  const hasFindings = configProblems.length > 0 || results.some((r) => r.status === 'uncovered' || r.status === 'orphaned');
  return { results, scheduledWorkflowsWithNoLocalScript: withoutScripts, configProblems, testFileCount: tests.length, hasFindings };
}

export function renderReport({ results, scheduledWorkflowsWithNoLocalScript, configProblems, testFileCount, hasFindings }) {
  const lines = ['coverage-gaps - scheduled-job test coverage', ''];

  for (const problem of configProblems) {
    lines.push(`::error::config: ${problem}`);
  }
  if (configProblems.length > 0) lines.push('');

  if (results.length === 0) {
    lines.push('No scheduled workflow invokes a local script.');
  }
  for (const r of results) {
    if (r.status === 'covered') {
      lines.push(`  ok   ${r.scriptPath} (${r.workflowFile}) - covered by ${r.testFiles.join(', ')}`);
    } else if (r.status === 'exempt') {
      lines.push(`  skip ${r.scriptPath} (${r.workflowFile}) - exempt: ${r.reason}`);
    } else if (r.status === 'orphaned') {
      lines.push(
        `::error::${r.scriptPath} (${r.workflowFile}) has a real test (${r.testFiles.join(', ')}) ` +
          'that `npm test` never runs - move it to where the test command actually globs, or widen that command'
      );
    } else {
      lines.push(`::error::${r.scriptPath} (${r.workflowFile}) - no test anywhere in the repo imports this file`);
    }
  }

  lines.push('');
  // Named, not silently dropped: a scheduled workflow leaving this tool's
  // scope should be visible to whoever reads the log.
  if (scheduledWorkflowsWithNoLocalScript.length > 0) {
    lines.push(
      `Scheduled workflows invoking no local script (nothing to cover, listed so the scope is visible): ${scheduledWorkflowsWithNoLocalScript.join(', ')}`
    );
  }
  lines.push(`Scanned ${testFileCount} test file(s) for coverage edges.`);
  lines.push('');
  lines.push(
    hasFindings
      ? 'One or more scheduled scripts have a coverage gap, or the config that judges them has drifted - see above.'
      : 'Every scheduled script has real, CI-reachable test coverage.'
  );
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runCoverageGaps();
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : renderReport(result));
  process.exitCode = result.hasFindings ? 1 : 0;
}
