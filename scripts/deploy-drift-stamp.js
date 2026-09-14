// deploy-drift-stamp - writes the current HEAD SHA into
// gas/deploy_version_marker.js, so gas/'s next self-report matches what
// scripts/deploy-drift-expected-marker.js will compute. Ported from KOS's
// own tools/deploy-drift/stamp.js, simplified to Mothership's single GAS
// project - no projectName argument needed, KOS's fleet of nine needs
// one, this hub never will.
//
// Run this AFTER committing a real gas/ code change, as its OWN SEPARATE
// commit - never combined with the functional change, and never
// hand-edited. See gas/deploy_version_marker.js's own header comment for
// why the two have to be separate commits.
//
// Usage: node scripts/deploy-drift-stamp.js

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export const MARKER_FILE = 'gas/deploy_version_marker.js';
export const MARKER_CONSTANT = 'DEPLOY_VERSION_SHA';

function currentHeadSha(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

// cwd/markerFile/markerConstant are injectable so tests can stamp a
// scratch copy instead of this session's real marker file.
export function stamp({ cwd = process.cwd(), markerFile = MARKER_FILE, markerConstant = MARKER_CONSTANT } = {}) {
  const sha = currentHeadSha(cwd);
  const filePath = path.join(cwd, markerFile);
  const src = fs.readFileSync(filePath, 'utf8');
  // `constant` must match the name declared in `markerFile` exactly, or
  // this regex silently matches nothing and the tool would report success
  // without changing anything - checked explicitly below, not assumed.
  const re = new RegExp(`(const\\s+${markerConstant}\\s*=\\s*)'[0-9a-f]{40}'`);
  if (!re.test(src)) {
    throw new Error(`Could not find "const ${markerConstant} = '<40-hex-chars>'" in ${markerFile} - check the constant name/format haven't drifted.`);
  }
  const updated = src.replace(re, `$1'${sha}'`);
  fs.writeFileSync(filePath, updated);
  return { file: markerFile, sha };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = stamp();
    console.log(`Stamped ${result.file} with HEAD (${result.sha}).`);
    console.log('Commit ONLY this file now, as its own commit, before pushing.');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
