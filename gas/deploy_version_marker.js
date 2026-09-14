// DEPLOY_VERSION_SHA - this project's self-reported "what commit is this"
// marker (deploy_version_report.js's reportDeployVersion() reads it and
// sends it to this hub repo's own GitHub API; see that file and
// scripts/deploy-drift.js for the full mechanism). Ported from the exact
// pattern already proven in this account's KOS repo
// (tools/deploy-drift/README.md, kos-personal/18_DeployVersionMarker.gs).
//
// DELIBERATELY its own file, touched by nothing else. A commit can never
// embed its own SHA - the SHA is a hash of the commit's content, so "the
// SHA of the commit that sets this constant" isn't knowable until after
// that commit exists. Splitting the marker into its own file resolves
// that: scripts/deploy-drift-expected-marker.js excludes this one file
// from "what commit does git expect for gas/," so the value below -
// stamped in a SEPARATE commit, after a real code change, by
// `node scripts/deploy-drift-stamp.js` - correctly matches once both
// commits have landed.
//
// NEVER hand-edit this file, and NEVER combine a stamp with a functional
// code change in the same commit - either breaks the match above. Always:
//   1. Commit your real gas/ code change(s) normally.
//   2. Run `node scripts/deploy-drift-stamp.js`.
//   3. Commit ONLY the resulting change to this file, by itself.
//   4. clasp push, then clasp deploy -i <id> -V <n> to actually promote it
//      (pushing HEAD alone does not update the live web app's /exec
//      deployment).
const DEPLOY_VERSION_SHA = 'f9b3af1e309e92b06c0ba0ff02486eedc7cc27ff'; // stamped by scripts/deploy-drift-stamp.js - never hand-edit
