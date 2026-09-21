// Floor check 6 (see CICD_FLOOR.md) - catches a doc that cites a function
// or a file which no longer exists in this repo.
//
// Adapted from TSO's tools/doc-currency, which is itself a deliberately
// narrow slice of KOS's original. KOS's version is the most capable of the
// three (14 checks, plus a whole exclusions taxonomy for an Apps Script
// codebase), but it `require`s ../gas-lint/check.js for its comment/string
// stripping - a KOS-specific static analyzer that does not exist here - so
// adopting it wholesale would mean dragging gas-lint along too. TSO's
// dependency-free slice is the right base for this repo, and porting the
// two checks it kept is a deliberate choice rather than a shortfall:
//
//   1. cited-file-missing     - a doc names a backticked, slash-containing
//                               file path that doesn't exist in the repo.
//   2. cited-function-missing - a doc names a backticked bare
//                               `identifier(...)` call that appears NOWHERE
//                               in this repo's code. Any occurrence counts,
//                               a definition or a call site alike; if the
//                               name is truly gone it won't appear at all.
//
// Both are heuristics over text, and both upstream versions say so
// explicitly: treat a finding as "worth a human look", not certified fact.
// What this does NOT check is whether a documented behavior still matches
// what the code actually does, or whether a doc omits something it should
// cover. Those need a human reading the doc against the code.
//
// WHY THIS EARNS ITS PLACE ALONGSIDE docs-check: ci.yml's docs-check asks
// whether README.md was *touched* in the same PR as a new capability file.
// That is a question about diffs, not about truth - a PR can satisfy it
// completely while leaving every existing claim in the doc stale. This asks
// the other question.
//
//
// WHY .mjs AND NOT .js. This repo is "type": "module", so .js here is
// already ESM - but a floor artifact has to load unchanged in a repo that
// is not. The first spoke it shipped to has a CommonJS root package.json
// and CommonJS tests, where a .js file carrying `import` fails to parse at
// all. The .mjs extension is ESM regardless of the host package.json, so
// one set of bytes runs in both kinds of repo. That is the whole reason for
// the extension, and it is load-bearing for distribution rather than style.
// Per-repo settings (which directories to skip, which docs are exempt,
// which extensions count as code) come from .github/floor.json, so this
// file stays byte-identical in every repo the floor is distributed to -
// see CICD_FLOOR.md's "why runtime config instead of templating" section.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FLOOR_CONFIG_PATH = join(ROOT, '.github', 'floor.json');

// Every key is optional and falls back to a sane default, so this script
// keeps working in a repo whose floor.json predates a key being added -
// the same tolerance the floor's workflows apply to their own jq lookups.
export function loadConfig(configPath = FLOOR_CONFIG_PATH) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')).docCurrency || {};
  } catch (e) {
    raw = {};
  }
  return {
    excludeDirs: new Set(raw.excludeDirs || ['node_modules', '.git', 'dist', 'build', 'coverage']),
    exemptDocs: new Set((raw.exemptDocs || []).map((d) => d.toLowerCase())),
    codeExtensions: new Set(raw.codeExtensions || ['.js', '.mjs', '.cjs', '.ts', '.py']),
    knownAbsentPaths: new Set(Object.keys(raw.knownAbsentPaths || {}))
  };
}

// A floor artifact reaches another repo by being copied verbatim, so the
// one thing it must never do is guess wrong about where the repo root is
// and then report a confident answer about a tree it never walked. ROOT is
// "one level above this file", which is right at the canonical path
// scripts/<name>.mjs and wrong anywhere else - and wrong QUIETLY, because a
// walk rooted at the wrong directory finds nothing and prints "clean".
// That is a vacuous green, the exact failure this floor exists to remove.
//
// Found while shipping this file to its first spoke, whose own tooling
// lives at tools/<name>/check.js: at that depth ROOT would have resolved to
// tools/ and the check would have passed by seeing almost nothing.
// Asserting .github/ is present turns that silence into a loud refusal.
export function repoRootLooksValid(root = ROOT) {
  return existsSync(join(root, '.github'));
}

// A filename carrying a 4-digit year (POST_MORTEM_2026-09.md) is as strong
// a "point-in-time snapshot, not a living doc" signal as an explicit
// CHANGELOG name, so it is skipped without needing a floor.json entry.
// Naming something that used to exist is exactly what a dated record is
// FOR - flagging one would be flagging the record for being a record.
const CONTAINS_YEAR_RE = /\d{4}/;

// A line carrying this marker has its citations skipped - for a citation
// that genuinely isn't "this repo's own file or function right now": an
// instruction to create a file that doesn't exist yet, or a deliberate
// cross-repo reference named for contrast. Declared, not inferred: reach
// for it only when the citation isn't this check's business, and let the
// surrounding prose say why.
export const IGNORE_MARKER = 'doc-currency:ignore';

export function stripIgnoredLines(content) {
  return content
    .split('\n')
    .map((line) => (line.includes(IGNORE_MARKER) ? '' : line))
    .join('\n');
}

// Anchored to the backtick span itself, not just "a slash-containing string
// somewhere near backticks" - requires at least one `/` and a trailing
// extension, so a bare word or a shell flag can never match.
const FILE_CITATION_RE = /`([\w.\-]+(?:\/[\w.\-]+)+\.[A-Za-z0-9]+)`/g;

// Anchored the same way: the identifier must start immediately after the
// opening backtick and the closing paren must be immediately followed by
// the closing backtick. A method call like `array.push(x)` structurally
// cannot match - the regex has nothing to retry from once "array" fails to
// be followed directly by "(".
const FUNCTION_CITATION_RE = /`([A-Za-z_$][\w$]*)\([^`\n)]*\)`/g;

// excludeDirs is the ONLY thing that prunes this walk. The upstream version
// additionally skipped every dotfile and dot-directory except .github, and
// that produced a real false positive on this repo's first run: README
// correctly cites `gas/.clasp.json.example`, a checked-in template that is
// genuinely present, but the walk never saw it because the name starts with
// a dot - so the citation was reported missing. A hidden heuristic that
// silently narrows what "exists in the repo" means is exactly the wrong
// shape for a tool whose whole job is answering that question. Dot-
// directories that should be skipped (.git) are named in excludeDirs
// instead, where they are visible and configurable.
function walk(dir, predicate, excludeDirs, results = []) {
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue;
      walk(full, predicate, excludeDirs, results);
    } else if (entry.isFile() && predicate(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

export function isCheckableDoc(filename, config = loadConfig()) {
  if (!filename.endsWith('.md')) return false;
  if (config.exemptDocs.has(filename.toLowerCase())) return false;
  if (CONTAINS_YEAR_RE.test(filename)) return false;
  return true;
}

export function listDocFiles(config = loadConfig(), root = ROOT) {
  return walk(root, (f) => isCheckableDoc(f, config), config.excludeDirs).map((p) => relative(root, p));
}

// Read once, reused across every citation in every doc - the check is
// O(docs x code files) in comparisons but O(code files) in disk reads.
export function loadCodeCorpus(config = loadConfig(), root = ROOT) {
  return walk(root, (f) => config.codeExtensions.has(extname(f)), config.excludeDirs).map((absPath) => ({
    relPath: relative(root, absPath),
    content: readFileSync(absPath, 'utf8')
  }));
}

// Every real file in the repo, any type, for citation resolution -
// deliberately not scoped to code extensions, since a doc can legitimately
// cite a workflow, a manifest, or another doc.
export function listAllFiles(config = loadConfig(), root = ROOT) {
  return walk(root, () => true, config.excludeDirs).map((p) => relative(root, p));
}

export function extractFileCitations(content) {
  const raw = [...new Set([...stripIgnoredLines(content).matchAll(FILE_CITATION_RE)].map((m) => m[1]))];
  // Reject an illustrative/elided path like `gas/.../review_queue.js` - a
  // real elision in the doc's own prose, not a citation of an actual file.
  return raw.filter((p) => !p.includes('...'));
}

export function extractFunctionCitations(content) {
  return [...new Set([...stripIgnoredLines(content).matchAll(FUNCTION_CITATION_RE)].map((m) => m[1]))];
}

// Accepts an exact repo-root-relative match OR a path-boundary-safe suffix
// match, so a doc citing a file relative to its own directory still
// resolves. Deliberately permissive in the same direction TSO's version
// documents choosing: the alternative reports false conflicts, and a check
// that cries wolf is a check that gets muted. The tradeoff is that a very
// loose citation could in principle suffix-match an unintended file whose
// path shares a long common tail - accepted, same as upstream.
export function checkFileCitation(citedPath, allFiles) {
  return allFiles.some((real) => real === citedPath || real.endsWith('/' + citedPath));
}

// Complete regex-metacharacter escape. FUNCTION_CITATION_RE already
// restricts the name to identifier characters, so nothing else can reach
// here today - but CodeQL's js/incomplete-sanitization correctly flagged a
// partial version of this upstream, and a real escape costs nothing.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word match, not substring - "run" must not match inside "runner".
export function checkFunctionCitation(name, codeCorpus) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  return codeCorpus.some((f) => re.test(f.content));
}

export function runDocCurrency({ config = loadConfig(), root = ROOT, docFiles, codeCorpus, allFiles } = {}) {
  const docs = docFiles || listDocFiles(config, root);
  const corpus = codeCorpus || loadCodeCorpus(config, root);
  const files = allFiles || listAllFiles(config, root);

  const findings = [];
  for (const docRelPath of docs) {
    // resolve, not join: docRelPath is normally root-relative, but a test
    // may inject an absolute path, and resolve correctly treats an
    // already-absolute second argument as the final answer.
    const content = readFileSync(resolve(root, docRelPath), 'utf8');

    for (const citedPath of extractFileCitations(content)) {
      // knownAbsentPaths is a floor.json map of path -> why it is
      // legitimately absent, for a citation that is structurally not this
      // repo's own file: a spoke's file the hub documents, a gitignored
      // file, another repo's file cited for attribution. It is a map
      // rather than a list specifically so adding one forces you to write
      // down the reason, which is what makes an entry reviewable instead
      // of a silent mute. The per-line IGNORE_MARKER stays the right tool
      // for one-off prose; this is for paths cited repeatedly and forever.
      if (config.knownAbsentPaths.has(citedPath)) continue;
      if (!checkFileCitation(citedPath, files)) {
        findings.push({ type: 'cited-file-missing', doc: docRelPath, cited: citedPath });
      }
    }
    for (const fnName of extractFunctionCitations(content)) {
      if (!checkFunctionCitation(fnName, corpus)) {
        findings.push({ type: 'cited-function-missing', doc: docRelPath, cited: `${fnName}()` });
      }
    }
  }
  return { findings, hasFindings: findings.length > 0 };
}

export function renderReport({ findings, hasFindings }) {
  const lines = ['doc-currency - stale citations', ''];
  if (findings.length === 0) {
    lines.push('No stale file or function citations found.');
  } else {
    for (const f of findings) {
      const what = f.type === 'cited-file-missing' ? 'file' : 'function';
      lines.push(`::error::${f.doc} cites ${what} \`${f.cited}\`, not found anywhere in the repo`);
    }
  }
  lines.push('');
  lines.push(
    hasFindings
      ? `One or more docs cite something that no longer exists. Each is worth a human look, not certified fact - if a citation is genuinely not this repo's own, put a "${IGNORE_MARKER}" marker on that line and say why in the prose.`
      : 'Clean.'
  );
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!repoRootLooksValid()) {
    console.error(
      `::error::doc-currency: computed repo root ${ROOT} contains no .github/ directory, so this is ` +
        'probably not the repository root. This file belongs at <repo>/scripts/doc-currency.mjs - ' +
        'see CICD_FLOOR.md. Refusing to report a result for a tree that may not be the repo.'
    );
    process.exit(2);
  }
  const result = runDocCurrency();
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : renderReport(result));
  process.exitCode = result.hasFindings ? 1 : 0;
}
