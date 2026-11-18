'use strict';
// Shared by the background page and the options page (not by content.js).

const SCRIPT_ID = 'autofill';

// Firefox site permissions and content-script match patterns need the
// lowercase, punycode host and must not contain a port (such patterns never
// match), so one pattern covers every port of a host. content.js enforces the
// exact origin, port included, by reading only its own origin's rules.
function hostPattern(origin) {
  return `https://${new URL(origin).hostname}/*`;
}

let syncQueue = Promise.resolve();

// Make the registered content script cover exactly the hosts that have at
// least one enabled rule. Idempotent; concurrent calls run one at a time.
function syncRegistration() {
  const run = syncQueue.then(syncNow);
  syncQueue = run.catch(() => {});
  return run;
}

async function syncNow() {
  const all = await browser.storage.local.get(null);
  const matches = [...new Set(Object.keys(all)
    .filter(origin => origin.startsWith('https://') && all[origin].some(rule => rule.enabled))
    .map(hostPattern))].sort();
  const [current] = await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!matches.length) {
    if (current) await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } else if (!current) {
    await browser.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      js: ['/content.js'],
      matches,
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]).catch(() => browser.scripting.updateContentScripts([{ id: SCRIPT_ID, matches }]));
  } else if (current.matches.join() !== matches.join()) {
    await browser.scripting.updateContentScripts([{ id: SCRIPT_ID, matches }]);
  }
}
