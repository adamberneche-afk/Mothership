// Local verification harness for gas/settings.js - the token-gated settings
// page and its save path. Fakes PropertiesService (with real setProperties
// recording, unlike dev-test-gas-code.mjs's read-only fake, since this file
// is the one place gas/*.js actually writes config) and HtmlService, then
// drives renderSettingsPage()/saveSettings() exactly as Code.js's doGet
// would.
//
// Usage: node scripts/dev-test-gas-settings.mjs

import { loadGasGlobals } from './gas-test-harness.mjs';

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

function makeFakePropertiesService(initialProps) {
  const store = Object.assign({}, initialProps);
  const setPropertiesCalls = [];
  return {
    store,
    setPropertiesCalls,
    getScriptProperties: () => ({
      getProperty: (key) => (store[key] !== undefined ? store[key] : null),
      setProperties: (update, deleteAllOthers) => {
        setPropertiesCalls.push({ update, deleteAllOthers });
        if (deleteAllOthers) {
          Object.keys(store).forEach((k) => delete store[k]);
        }
        Object.assign(store, update);
      }
    })
  };
}

function makeFakeHtmlService() {
  return {
    createHtmlOutput: (html) => ({ _html: html, getContent: () => html })
  };
}

function loadSettingsWithFakes(props) {
  const propertiesService = makeFakePropertiesService(props);
  const context = loadGasGlobals('settings.js', {
    PropertiesService: propertiesService,
    HtmlService: makeFakeHtmlService()
  });
  return { context, propertiesService };
}

function testNoTokenBootstrapped() {
  console.log('renderSettingsPage says the token needs bootstrapping when ADMIN_SETTINGS_TOKEN is unset');
  const { context } = loadSettingsWithFakes({});
  const output = context.renderSettingsPage('anything');
  check('mentions setting it up via Script Properties', /not yet enabled/i.test(output._html));
  check('does not render a form', !/<form/i.test(output._html));
}

function testWrongTokenIsGenericNotFound() {
  console.log('renderSettingsPage returns a generic not-found page on a wrong token, without leaking any config');
  const { context } = loadSettingsWithFakes({
    ADMIN_SETTINGS_TOKEN: 'real-secret-token',
    GLOBAL_GITHUB_TOKEN: 'ghp_abcd1234efgh5678',
    AI_API_KEY: 'sk-supersecretvalue'
  });
  const output = context.renderSettingsPage('wrong-token');
  check('generic not-found response', /not found/i.test(output._html));
  check('does not leak the real GLOBAL_GITHUB_TOKEN', !output._html.includes('ghp_abcd1234efgh5678'));
  check('does not leak the real AI_API_KEY', !output._html.includes('sk-supersecretvalue'));
  check('does not even mention field names', !/GLOBAL_GITHUB_TOKEN/.test(output._html));
}

function testCorrectTokenRendersMaskedForm() {
  console.log('renderSettingsPage with the correct token renders the form with secrets masked, never in full');
  const { context } = loadSettingsWithFakes({
    ADMIN_SETTINGS_TOKEN: 'real-secret-token',
    GLOBAL_GITHUB_TOKEN: 'ghp_abcd1234efgh5678',
    AI_API_KEY: 'sk-supersecretvalue',
    AI_MODEL: 'gpt-4o-mini',
    HUB_GITHUB_OWNER: 'adamberneche-afk'
  });
  const output = context.renderSettingsPage('real-secret-token');
  check('renders the form', /<form/i.test(output._html));
  check('masked GLOBAL_GITHUB_TOKEN placeholder present (first 4 + last 4)', output._html.includes('ghp_') && output._html.includes('5678'));
  check('raw GLOBAL_GITHUB_TOKEN never appears in full', !output._html.includes('ghp_abcd1234efgh5678'));
  check('raw AI_API_KEY never appears in full', !output._html.includes('sk-supersecretvalue'));
  check('non-secret AI_MODEL value is shown in full', output._html.includes('gpt-4o-mini'));
  check('non-secret HUB_GITHUB_OWNER value is shown in full', output._html.includes('adamberneche-afk'));
  check('the admin token itself is never rendered as a field', !/name="ADMIN_SETTINGS_TOKEN"/.test(output._html));
}

function testSaveSettingsRejectsWrongToken() {
  console.log('saveSettings throws on a wrong token and never calls setProperties');
  const { context, propertiesService } = loadSettingsWithFakes({ ADMIN_SETTINGS_TOKEN: 'real-secret-token' });
  let threw = false;
  try {
    context.saveSettings('wrong-token', { GLOBAL_GITHUB_TOKEN: 'new-value' });
  } catch (err) {
    threw = true;
  }
  check('threw an Unauthorized error', threw);
  check('setProperties was never called', propertiesService.setPropertiesCalls.length === 0);
}

function testSaveSettingsUpdatesOnlyPopulatedAllowlistedFields() {
  console.log('saveSettings with the correct token only writes populated, allowlisted fields - blanks preserve existing values, ADMIN_SETTINGS_TOKEN can never be smuggled in');
  const { context, propertiesService } = loadSettingsWithFakes({
    ADMIN_SETTINGS_TOKEN: 'real-secret-token',
    GLOBAL_GITHUB_TOKEN: 'old-token-value',
    AI_MODEL: 'old-model'
  });
  const result = context.saveSettings('real-secret-token', {
    GLOBAL_GITHUB_TOKEN: 'new-token-value',
    AI_MODEL: '', // blank - should NOT overwrite
    ADMIN_SETTINGS_TOKEN: 'attempted-token-hijack' // not in SETTINGS_KEYS - must be dropped
  });
  check('reports only GLOBAL_GITHUB_TOKEN as updated', result.updated.length === 1 && result.updated[0] === 'GLOBAL_GITHUB_TOKEN');
  check('setProperties called exactly once', propertiesService.setPropertiesCalls.length === 1);
  const call = propertiesService.setPropertiesCalls[0];
  check('update object contains only GLOBAL_GITHUB_TOKEN', Object.keys(call.update).length === 1 && call.update.GLOBAL_GITHUB_TOKEN === 'new-token-value');
  check('ADMIN_SETTINGS_TOKEN was never included in the write', !('ADMIN_SETTINGS_TOKEN' in call.update));
  check('called with deleteAllOthers=false so unrelated properties (like ADMIN_SETTINGS_TOKEN itself) survive', call.deleteAllOthers === false);
  check('AI_MODEL in the store is unchanged (blank field did not clear it)', propertiesService.store.AI_MODEL === 'old-model');
  check('ADMIN_SETTINGS_TOKEN in the store is unchanged', propertiesService.store.ADMIN_SETTINGS_TOKEN === 'real-secret-token');
}

function main() {
  testNoTokenBootstrapped();
  testWrongTokenIsGenericNotFound();
  testCorrectTokenRendersMaskedForm();
  testSaveSettingsRejectsWrongToken();
  testSaveSettingsUpdatesOnlyPopulatedAllowlistedFields();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main();
