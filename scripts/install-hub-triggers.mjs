// Asks the deployed hub to install its own time-driven triggers, so a
// deploy finishes setup without anyone opening the Apps Script editor. Runs
// after `clasp deploy` - from deploy-apps-script.yml, or from KOS's run.js
// on the operator's machine. See installHubTriggers() in gas/settings.js
// for why the hub installs them itself rather than `clasp run`.
//
// Usage: ADMIN_SETTINGS_TOKEN=... node scripts/install-hub-triggers.mjs <web app URL>
//
// Exits 0 when the hub confirms, 1 otherwise. Apps Script web apps always
// answer HTTP 200, so success is read from the JSON body's _httpStatus.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// True when this file is the script node was asked to run, not an import.
// Compares URLs built the same way on both sides: `file://${argv[1]}` never
// matched on Windows (a C:\ path against a file:///C:/ URL), so the script
// exited 0 having asked the hub for nothing, and KOS's run.js reported
// "triggers ok" with the spoke poller never installed (2026-11-02).
export function isMainModule(metaUrl, argv1) {
  return !!argv1 && metaUrl === pathToFileURL(resolve(argv1)).href;
}

export async function installHubTriggers(webAppUrl, adminToken, { fetchImpl = fetch } = {}) {
  if (!webAppUrl) throw new Error('No web app URL given.');
  if (!adminToken) throw new Error('ADMIN_SETTINGS_TOKEN is not set.');
  const url = `${webAppUrl.replace(/\?.*$/, '')}?endpoint=install-triggers`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminToken }),
    redirect: 'follow'
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new Error(`The hub did not answer with JSON (HTTP ${res.status}); is this the /exec URL of a deployment that has install-triggers?`);
  }
  if (body._httpStatus !== 200) {
    throw new Error(`The hub refused: ${body._httpStatus} ${body.error || ''}`.trim());
  }
  return { installed: body.installed || [], present: body.present || [] };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  installHubTriggers(process.argv[2], process.env.ADMIN_SETTINGS_TOKEN)
    .then(({ installed, present }) => {
      console.log(installed.length
        ? `Installed: ${installed.join(', ')}.`
        : 'Every hub trigger was already installed.');
      console.log(`Triggers now present: ${present.join(', ')}.`);
    })
    .catch((err) => {
      console.error(`install-hub-triggers: ${err.message}`);
      process.exitCode = 1;
    });
}
