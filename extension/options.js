'use strict';
// Options page: add, edit, enable/disable and delete rules. Rules live in
// browser.storage.local, one key per exact origin (see common.js).

const $ = id => document.getElementById(id);
const form = $('rule-form');
const tbody = $('rules').tBodies[0];
let editing = null; // { origin, id } of the rule being edited
let renderSeq = 0;

function say(text, isError = false) {
  $('msg').textContent = text;
  $('msg').className = isError ? 'error' : '';
}

const hostOf = origin => new URL(origin).host;

// "portal.example.edu" or "https://Portal.Example.EDU/" -> "https://portal.example.edu".
// Returns null for anything that is not one bare HTTPS origin. Firefox's URL
// parser accepts "*" in hosts, and a "*" host would turn into a wildcard site
// permission, so it is rejected.
function parseOrigin(input) {
  const text = input.trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  return url.protocol === 'https:' && bare && !url.hostname.includes('*') ? url.origin : null;
}

// "" -> "" (any path), "/login*" -> "/login*", invalid -> null. Encoded the
// same way as location.pathname so content.js can compare directly.
function parsePath(input) {
  const text = input.trim();
  if (!text) return '';
  if (!text.startsWith('/') || /[?#]/.test(text)) return null;
  return new URL(`https://x.invalid${text}`).pathname;
}

function isValidSelector(selector) {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

// Returns { origin, rule } or shows an error and returns undefined.
function readForm() {
  const origin = parseOrigin($('origin').value);
  if (!origin) return say('Site must be one exact HTTPS address such as https://portal.example.edu, without a path or *.', true);
  const path = parsePath($('path').value);
  if (path === null) return say('Path must start with / and cannot contain ? or #.', true);
  const selector = $('selector').value.trim();
  if (!selector || !isValidSelector(selector)) return say('Enter a valid CSS selector.', true);
  const value = $('value').value;
  if (!value) return say('Enter the value to fill in.', true);
  const rule = {
    id: editing ? editing.id : crypto.randomUUID(),
    path,
    selector,
    value,
    enabled: $('enabled').checked,
    overwrite: $('overwrite').checked,
  };
  return { origin, rule };
}

// Firefox only lets the add-on ask for site access while it is still handling
// the click or key press, so every caller makes this its first async call.
const requestAccess = origin => browser.permissions.request({ origins: [hostPattern(origin)] });

form.addEventListener('submit', event => {
  event.preventDefault();
  if ($('save').disabled) return;
  const input = readForm();
  if (!input) return;
  const { origin, rule } = input;
  const previous = editing;
  $('save').disabled = true;
  requestAccess(origin)
    .then(async granted => {
      if (!granted) {
        say(`Firefox access to ${hostOf(origin)} was not allowed, so the rule was not saved.`, true);
        return;
      }
      await saveRule(origin, rule, previous);
      resetForm();
      say('Saved. Reload open tabs of that site to apply it.');
    })
    .catch(error => say(`Could not save the rule: ${error.message}`, true))
    .finally(() => { $('save').disabled = false; });
});

async function saveRule(origin, rule, previous) {
  const moved = previous && previous.origin !== origin;
  const data = await browser.storage.local.get(moved ? [origin, previous.origin] : origin);
  const list = data[origin] || [];
  const index = list.findIndex(r => r.id === rule.id);
  if (index >= 0) list[index] = rule;
  else list.push(rule);
  await browser.storage.local.set({ [origin]: list });
  if (moved) {
    const rest = (data[previous.origin] || []).filter(r => r.id !== rule.id);
    if (rest.length) await browser.storage.local.set({ [previous.origin]: rest });
    else await browser.storage.local.remove(previous.origin);
    await releaseUnusedAccess(previous.origin);
  }
  await syncRegistration();
}

async function deleteRule(origin, id) {
  const rest = ((await browser.storage.local.get(origin))[origin] || []).filter(r => r.id !== id);
  if (rest.length) await browser.storage.local.set({ [origin]: rest });
  else await browser.storage.local.remove(origin);
  await releaseUnusedAccess(origin);
  await syncRegistration();
}

async function setEnabled(origin, id, enabled) {
  const list = (await browser.storage.local.get(origin))[origin] || [];
  const rule = list.find(r => r.id === id);
  if (!rule) return;
  rule.enabled = enabled;
  await browser.storage.local.set({ [origin]: list });
  await syncRegistration();
}

// Give up Firefox access to a host once no remaining rule (on any port) uses it.
async function releaseUnusedAccess(origin) {
  const pattern = hostPattern(origin);
  const all = await browser.storage.local.get(null);
  const used = Object.keys(all).some(o => o.startsWith('https://') && all[o].length && hostPattern(o) === pattern);
  if (!used) await browser.permissions.remove({ origins: [pattern] });
}

async function startEdit(origin, id) {
  const rule = ((await browser.storage.local.get(origin))[origin] || []).find(r => r.id === id);
  if (!rule) return;
  editing = { origin, id };
  $('origin').value = origin;
  $('path').value = rule.path;
  $('selector').value = rule.selector;
  $('value').value = rule.value;
  $('overwrite').checked = rule.overwrite;
  $('enabled').checked = rule.enabled;
  $('form-title').textContent = 'Edit rule';
  $('save').textContent = 'Save changes';
  $('cancel').hidden = false;
  say('');
  $('origin').focus();
}

function resetForm() {
  editing = null;
  form.reset();
  $('form-title').textContent = 'Add a rule';
  $('save').textContent = 'Add rule';
  $('cancel').hidden = true;
}

$('cancel').addEventListener('click', () => {
  resetForm();
  say('');
});

tbody.addEventListener('change', event => {
  const toggle = event.target.closest('.toggle');
  if (!toggle) return;
  const { origin, id } = toggle.closest('tr').dataset;
  const enabled = toggle.checked;
  // Access may have been revoked in about:addons, so re-request it when enabling.
  (enabled ? requestAccess(origin) : Promise.resolve(true))
    .then(granted => {
      if (!granted) {
        toggle.checked = false;
        say(`Firefox access to ${hostOf(origin)} was not allowed, so the rule stays off.`, true);
        return;
      }
      return setEnabled(origin, id, enabled).then(() => say(enabled ? 'Rule enabled.' : 'Rule disabled.'));
    })
    .catch(error => say(`Could not update the rule: ${error.message}`, true));
});

tbody.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const { origin, id } = button.closest('tr').dataset;
  if (button.classList.contains('grant')) {
    requestAccess(origin)
      .then(granted => granted || say(`Firefox access to ${hostOf(origin)} was not allowed.`, true))
      .catch(error => say(`Could not request access: ${error.message}`, true));
  } else if (button.classList.contains('edit')) {
    startEdit(origin, id).catch(error => say(`Could not open the rule: ${error.message}`, true));
  } else if (button.classList.contains('delete')) {
    if (!confirm('Delete this rule?')) return;
    if (editing && editing.id === id) resetForm();
    deleteRule(origin, id)
      .then(() => say('Rule deleted.'))
      .catch(error => say(`Could not delete the rule: ${error.message}`, true));
  }
});

$('show-values').addEventListener('change', () => {
  $('value').classList.toggle('masked', !$('show-values').checked);
  refresh();
});

function cell(className, ...content) {
  const td = document.createElement('td');
  td.className = className;
  td.append(...content);
  return td;
}

function button(className, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

async function render() {
  const seq = ++renderSeq;
  const all = await browser.storage.local.get(null);
  const origins = Object.keys(all).filter(o => o.startsWith('https://')).sort();
  const patterns = [...new Set(origins.map(hostPattern))];
  const access = new Map(await Promise.all(patterns.map(async p =>
    [p, await browser.permissions.contains({ origins: [p] })])));
  if (seq !== renderSeq) return; // a newer render has started
  const show = $('show-values').checked;
  const rows = [];
  for (const origin of origins) {
    for (const rule of all[origin]) {
      const row = document.createElement('tr');
      row.dataset.origin = origin;
      row.dataset.id = rule.id;
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'toggle';
      toggle.checked = rule.enabled;
      toggle.setAttribute('aria-label', 'Enabled');
      const site = cell('origin', origin);
      if (!access.get(hostPattern(origin))) site.append(' ', button('grant', 'Grant access'));
      row.append(
        cell('enabled', toggle),
        site,
        cell('path', rule.path || 'any'),
        cell('selector', rule.selector),
        cell('value', show ? rule.value : '••••••••'),
        cell('overwrite', rule.overwrite ? 'yes' : 'no'),
        cell('actions', button('edit', 'Edit'), ' ', button('delete', 'Delete')),
      );
      rows.push(row);
    }
  }
  tbody.replaceChildren(...rows);
  $('empty').hidden = rows.length > 0;
}

function refresh() {
  render().catch(error => say(`Could not show the rules: ${error.message}`, true));
}

browser.storage.local.onChanged.addListener(refresh);
browser.permissions.onAdded.addListener(refresh);
browser.permissions.onRemoved.addListener(refresh);
$('value').classList.toggle('masked', !$('show-values').checked);
refresh();
// Repair path: re-create the page-script registration if it was ever lost.
syncRegistration().catch(error => say(`Could not update the page script: ${error.message}`, true));
