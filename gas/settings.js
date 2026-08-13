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
      return (
        '<div style="margin-bottom:12px"><label>' + key + '<br>' +
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
    '</script>' +
    '</body></html>'
  );
}
