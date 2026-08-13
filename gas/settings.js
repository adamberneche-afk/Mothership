// A small, token-gated settings page served by this same Apps Script Web
// App, so rotating config later (especially AI_API_KEY/GLOBAL_GITHUB_TOKEN)
// doesn't require reopening the Apps Script IDE every time. It does NOT
// remove the one manual IDE step - appsscript.json's webapp access is
// "ANYONE" (required so spokes with no Google credential can still POST to
// doPost), so a brand-new doGet needs its own gate, and that gate has to be
// some shared secret set via Script Properties first: ADMIN_SETTINGS_TOKEN.
// Bootstrap that one value via Project Settings > Script Properties (a long
// random string, not a memorable password), then everything else below can
// be viewed/updated through this page instead.
//
// Deliberately excluded from this page, on purpose: ADMIN_SETTINGS_TOKEN
// itself is never rendered or writable here, even with a correct token -
// rotating it always requires the IDE, so a leaked page token can't be used
// to silently mint its own replacement.

// The only keys this page will ever read or write - an explicit allowlist,
// not a pass-through of whatever a caller sends, so ADMIN_SETTINGS_TOKEN (or
// anything else) can never end up in a saveSettings() payload even if a
// caller tries to smuggle it in.
const SETTINGS_KEYS = [
  'AI_API_KEY',
  'AI_MODEL',
  'AI_BASE_URL',
  'GLOBAL_GITHUB_TOKEN',
  'DRY_RUN_MODE',
  'RATE_CAP_PER_REPO_PER_DAY',
  'HUB_GITHUB_OWNER',
  'HUB_GITHUB_REPO'
];

// Shown masked, never in full, and never pre-filled into an editable value -
// the input starts blank with the masked value as a placeholder, so leaving
// it untouched and submitting means "keep the current value," not "clear it."
const SETTINGS_SECRET_KEYS = ['AI_API_KEY', 'GLOBAL_GITHUB_TOKEN'];

function maskSecret_(value) {
  if (!value) return '(not set)';
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••••••' + value.slice(-4);
}

function htmlEscape_(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Entry point called from Code.js's doGet for ?endpoint=settings. Returns an
// HtmlService output in every case - never leaks whether ADMIN_SETTINGS_TOKEN
// is set vs. wrong via different response shapes for the "unset" vs. "wrong
// token" cases would be nice, but "unset" has to say something actionable to
// whoever legitimately owns the deployment, so it's the one case allowed to
// be explicit; a wrong-token response stays generic on purpose.
function renderSettingsPage(token) {
  const props = PropertiesService.getScriptProperties();
  const adminToken = props.getProperty('ADMIN_SETTINGS_TOKEN');

  if (!adminToken) {
    return HtmlService.createHtmlOutput(renderBootstrapNeededHtml_());
  }
  if (token !== adminToken) {
    return HtmlService.createHtmlOutput(renderNotFoundHtml_());
  }

  const currentValues = {};
  SETTINGS_KEYS.forEach((key) => {
    currentValues[key] = props.getProperty(key);
  });
  return HtmlService.createHtmlOutput(renderFormHtml_(token, currentValues));
}

// Called via google.script.run from the form rendered above. Re-validates
// the token server-side - the client having rendered the form is never, by
// itself, treated as proof of authorization.
function saveSettings(token, values) {
  const props = PropertiesService.getScriptProperties();
  const adminToken = props.getProperty('ADMIN_SETTINGS_TOKEN');
  if (!adminToken || token !== adminToken) {
    throw new Error('Unauthorized');
  }

  const update = {};
  SETTINGS_KEYS.forEach((key) => {
    const v = values && values[key];
    if (typeof v === 'string' && v !== '') {
      update[key] = v;
    }
  });

  // Explicit merge (deleteAllOthers = false) - ADMIN_SETTINGS_TOKEN and
  // anything else not in SETTINGS_KEYS must survive this write untouched.
  props.setProperties(update, false);
  return { updated: Object.keys(update) };
}

// --- live diagnostics: catch a bad credential the moment this page opens,
// not after N silent failed runs - exactly what happened this session with
// GLOBAL_GITHUB_TOKEN's 401 on health-report.yml, undetected for 5 runs.
// Two checks only - the two credentials whose failure mode is silent and
// easy to miss otherwise; DRY_RUN_MODE/RATE_CAP_PER_REPO_PER_DAY/HUB_* are
// plain values with no independent "is this valid" check to run.

function checkGithubToken_(token) {
  if (!token) return { ok: false, detail: 'not configured' };
  const res = UrlFetchApp.fetch('https://api.github.com/rate_limit', {
    headers: { Authorization: 'token ' + token },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code === 200) return { ok: true, detail: 'valid' };
  if (code === 401) return { ok: false, detail: 'invalid or expired (401)' };
  return { ok: false, detail: 'unexpected response (' + code + ')' };
}

function checkAiKey_(baseUrl, apiKey) {
  if (!apiKey) return { ok: false, detail: 'not configured' };
  if (!baseUrl) return { ok: false, detail: 'AI_BASE_URL not configured' };
  // Same URL-join convention as the real AI call in autonomous_agent.js
  // (`${config.aiBaseUrl}/chat/completions`) - plain concatenation, no
  // trailing-slash normalization. Listing models is the standard
  // OpenAI-compatible way to validate a key without spending completion
  // tokens.
  const res = UrlFetchApp.fetch(baseUrl + '/models', {
    headers: { Authorization: 'Bearer ' + apiKey },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code === 200) return { ok: true, detail: 'valid' };
  if (code === 401 || code === 403) return { ok: false, detail: 'invalid or unauthorized (' + code + ')' };
  return { ok: false, detail: 'unexpected response (' + code + ')' };
}

// Called via google.script.run right after the settings page loads.
// Re-validates the admin token first, exactly like saveSettings does -
// google.script.run exposes every top-level function in this project to
// anyone who can reach the deployed URL, admin token or not, so skipping
// this check would turn checkConfig itself into an unauthenticated way to
// probe whether credentials are configured.
function checkConfig(token) {
  const props = PropertiesService.getScriptProperties();
  const adminToken = props.getProperty('ADMIN_SETTINGS_TOKEN');
  if (!adminToken || token !== adminToken) {
    throw new Error('Unauthorized');
  }
  return {
    github: checkGithubToken_(props.getProperty('GLOBAL_GITHUB_TOKEN')),
    ai: checkAiKey_(props.getProperty('AI_BASE_URL'), props.getProperty('AI_API_KEY'))
  };
}

function renderBootstrapNeededHtml_() {
  return (
    '<!doctype html><html><body style="font-family:sans-serif;max-width:560px;margin:40px auto;line-height:1.5">' +
    '<h1>Settings page not yet enabled</h1>' +
    '<p>Set <code>ADMIN_SETTINGS_TOKEN</code> as a Script Property first (Project Settings &gt; Script Properties in the Apps Script IDE) - a long random string, not a memorable password. ' +
    'Once it is set, reload this page with <code>?endpoint=settings&amp;token=&lt;that value&gt;</code>.</p>' +
    '</body></html>'
  );
}

function renderNotFoundHtml_() {
  return '<!doctype html><html><body><h1>Not found</h1></body></html>';
}

function renderFormHtml_(token, currentValues) {
  const fieldsHtml = SETTINGS_KEYS.map((key) => {
    const isSecret = SETTINGS_SECRET_KEYS.indexOf(key) !== -1;
    if (key === 'DRY_RUN_MODE') {
      const current = currentValues[key];
      const options = ['', 'true', 'false']
        .map((opt) => {
          const label = opt === '' ? '(leave unchanged - currently ' + htmlEscape_(current || 'unset, defaults to true') + ')' : opt;
          return '<option value="' + opt + '">' + htmlEscape_(label) + '</option>';
        })
        .join('');
      return (
        '<div style="margin-bottom:12px"><label>' + key + '<br>' +
        '<select name="' + key + '" style="width:100%;padding:6px">' + options + '</select>' +
        '</label></div>'
      );
    }
    if (isSecret) {
      const placeholder = maskSecret_(currentValues[key]);
      // GLOBAL_GITHUB_TOKEN and AI_API_KEY are the two credentials that get
      // a live "is this actually valid" check (see checkConfig below) - the
      // status span next to each is filled in by that check once the page
      // loads, starting as "checking…" rather than blank so it's clear a
      // check is even happening.
      const statusSpanId = key === 'GLOBAL_GITHUB_TOKEN' ? 'github-check-status' : key === 'AI_API_KEY' ? 'ai-check-status' : null;
      const statusSpan = statusSpanId ? ' <span id="' + statusSpanId + '" style="font-size:0.85em;color:#888">checking…</span>' : '';
      return (
        '<div style="margin-bottom:12px"><label>' + key + statusSpan + '<br>' +
        '<input type="password" name="' + key + '" placeholder="' + htmlEscape_(placeholder) + ' - leave blank to keep" style="width:100%;padding:6px" autocomplete="off">' +
        '</label></div>'
      );
    }
    const current = currentValues[key] || '';
    return (
      '<div style="margin-bottom:12px"><label>' + key + '<br>' +
      '<input type="text" name="' + key + '" value="' + htmlEscape_(current) + '" style="width:100%;padding:6px" autocomplete="off">' +
      '</label></div>'
    );
  }).join('');

  return (
    '<!doctype html><html><body style="font-family:sans-serif;max-width:560px;margin:40px auto;line-height:1.5">' +
    '<h1>Mothership hub settings</h1>' +
    '<p style="color:#666">Secret fields show a masked placeholder, never the real value. Leave a field blank to keep its current value unchanged.</p>' +
    '<form id="settings-form">' + fieldsHtml +
    '<button type="submit" style="padding:8px 16px">Save</button>' +
    '</form>' +
    '<p id="status"></p>' +
    '<script>' +
    'var TOKEN = ' + JSON.stringify(token) + ';' +
    'var FIELD_KEYS = ' + JSON.stringify(SETTINGS_KEYS) + ';' +
    'document.getElementById("settings-form").addEventListener("submit", function(ev) {' +
    '  ev.preventDefault();' +
    '  var form = ev.target;' +
    '  var values = {};' +
    '  FIELD_KEYS.forEach(function(key) {' +
    '    var el = form.elements[key];' +
    '    if (el && el.value !== "") { values[key] = el.value; }' +
    '  });' +
    '  document.getElementById("status").textContent = "Saving...";' +
    '  google.script.run' +
    '    .withSuccessHandler(function(result) {' +
    '      document.getElementById("status").textContent = result.updated.length ? ("Saved: " + result.updated.join(", ")) : "Nothing changed.";' +
    '    })' +
    '    .withFailureHandler(function(err) {' +
    '      document.getElementById("status").textContent = "Error: " + err.message;' +
    '    })' +
    '    .saveSettings(TOKEN, values);' +
    '});' +
    // Auto-runs once on load, not gated behind a button - the whole point
    // is catching a bad credential the moment this page opens, the way
    // this session's own GLOBAL_GITHUB_TOKEN 401 sat undetected for 5 real
    // runs because nothing checked it until something else already failed.
    'function fillCheckStatus(id, result) {' +
    '  var el = document.getElementById(id);' +
    '  if (!el) return;' +
    '  el.textContent = result.ok ? "✓ valid" : ("✗ " + result.detail);' +
    '  el.style.color = result.ok ? "green" : "crimson";' +
    '}' +
    'google.script.run' +
    '  .withSuccessHandler(function(result) {' +
    '    fillCheckStatus("github-check-status", result.github);' +
    '    fillCheckStatus("ai-check-status", result.ai);' +
    '  })' +
    '  .withFailureHandler(function(err) {' +
    '    fillCheckStatus("github-check-status", { ok: false, detail: "check failed" });' +
    '    fillCheckStatus("ai-check-status", { ok: false, detail: "check failed" });' +
    '  })' +
    '  .checkConfig(TOKEN);' +
    '</script>' +
    '</body></html>'
  );
}
