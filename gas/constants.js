// Shared constants across gas/*.js files. Apps Script gives every file in
// a project one global scope - no import/export, no per-file isolation
// (see github.js's header comment) - so a name declared with `const` in
// two files is a real SyntaxError the moment both load together, not a
// namespace clash a bundler would quietly resolve. Caught exactly this way
// by scripts/dev-test-gas-code.mjs, which loads every gas/*.js file into
// one vm context the same way a real deployment shares one script scope.
// This file exists so DEFAULT_HUB_OWNER/DEFAULT_HUB_REPO are declared
// exactly once, loaded before anything that references them.
const DEFAULT_HUB_OWNER = 'adamberneche-afk';
const DEFAULT_HUB_REPO = 'Mothership';
