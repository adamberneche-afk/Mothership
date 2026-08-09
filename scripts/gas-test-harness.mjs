// Loads gas/*.js the same way Apps Script does: as raw script text sharing
// one global function scope, not ES modules (Apps Script has no
// import/export - see gas/github.js's header comment). This harness runs
// the literal, unmodified file content through Node's built-in `vm` module
// instead of a compiled/bundled intermediate, so there's exactly one
// canonical source for each file - what this loads for testing is
// byte-for-byte what `clasp push` uploads for real.
//
// Usage: const { processRequest, makeGithubClient } = loadGasGlobals('github.js', 'autonomous_agent.js');
//
// Pass a `seed` object to pre-populate the sandbox before any file runs -
// this is how tests that exercise Code.js (which references Apps
// Script-only globals: UrlFetchApp, PropertiesService, ContentService,
// Utilities) supply fakes for those, the same way the other harnesses fake
// github/aiFetch for the decision-logic files.

import vm from 'vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAS_DIR = join(__dirname, '..', 'gas');

export function loadGasGlobals(...args) {
  const files = args.filter((a) => typeof a === 'string');
  const seed = args.find((a) => typeof a === 'object') || {};
  const context = { ...seed };
  vm.createContext(context);
  for (const file of files) {
    const source = readFileSync(join(GAS_DIR, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return context;
}
