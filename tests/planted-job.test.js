// PLANTED VIOLATION - floor check 9 proof, removed before merge.
//
// A genuine, thorough test for scripts/planted-job.js: it really imports the
// script and really asserts on it. The gap is not that the safety net is
// missing - it is that `npm test` globs scripts/dev-test-*.mjs and will
// never expand this path, so nothing here has ever run. This is the state
// that reads green to every check that only asks "does a test exist".
import { plantedScheduledWork } from '../scripts/planted-job.js';
import assert from 'assert';

assert.equal(plantedScheduledWork(), 'nothing real');
console.log('ok - a test that exists and is never run');
