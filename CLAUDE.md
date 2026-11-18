# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

"Custom Autofill" is a personal Firefox MV3 add-on that automatically fills user-configured fields on user-configured exact HTTPS origins. The owner uses it for a university login that also asks for an ID number. The binding design is `docs/superpowers/specs/2026-11-18-custom-autofill-design.md`: §5 is the design, §6 the verified Firefox 160 facts it relies on.

## Commands

- Full end-to-end suite (about 90 s; headless Firefox with a throwaway profile): `node test/run.mjs`
- Subset by test-name substring: `node test/run.mjs T21` (names start with IDs such as `T5`, `T16a`)
- Real React 18/19 and Vue 3 tests (skipped when the env var is unset; the library builds are never committed): `FRAMEWORK_LIBS=<dir> node test/run.mjs`
- Other env vars: `EXTENSION_DIR` (test a mutant copy), `FIREFOX_BIN`, `TEST_TMPDIR`, `RESULTS_JSON`
- Lint, which must stay at 0 errors, warnings and notices: `npx web-ext lint --source-dir extension`
- There is no build step and there are no dependencies. Requires Node 24+ and Firefox (default `/Applications/Firefox.app`).

## Hard constraints (owner requirements; never relax)

- `extension/` is the entire package: plain hand-written JS, HTML and CSS, no dependencies, no minification. `test/lib/static-scan.mjs` pins the exact file list (update `EXPECTED_FILES` when adding a file, e.g. icons). It also forbids `console.`, `fetch`, `XMLHttpRequest`, `WebSocket`, `eval`, `innerHTML`, `storage.sync` and similar.
- No network, telemetry, remote code or update server. Values live only in `browser.storage.local` and are never logged.
- Site access only for configured hosts: the optional `https://*/*` permission plus a per-site `permissions.request`. Zero work on unconfigured sites; minimal runtime cost.
- Never change the gecko ID `custom-autofill@96717d3ecdad`: storage and permissions are keyed by it. Keep `data_collection_permissions: {"required":["none"]}` and `strict_min_version` "142.0", which AMO needs.
- No personal values anywhere in the repo; tests use dummy values.

## Architecture (the non-obvious parts)

- **Storage:** one key per exact origin (`URL.origin`, which keeps a non-default port) holding `[{id, path, selector, value, enabled, overwrite}]`. `content.js` reads only `storage.local.get(location.origin)`. Never use `get(null)` or `storage.onChanged` there: either would copy every site's values into the page's process.
- **Registration:** a single content script registered at runtime (`scripting.registerContentScripts`, id `autofill`, `js: ["/content.js"]`, allFrames, document_idle). It covers `https://<hostname>/*` for every origin that has an enabled rule; `syncRegistration()` in `common.js` (shared by the background and options pages) computes it. Firefox checks host permission per document, so registration never depends on permission state.
- **Patterns:** match and permission patterns must be lowercase punycode with **no port**. Port-bearing, uppercase or Unicode patterns are accepted but silently never match. The exact origin, port included, is enforced by the storage-key lookup.
- **Background:** Firefox wipes registrations on install, upgrade and downgrade, and fires no `onInstalled` on downgrade, so `background.js` re-syncs at top level. Its persistent `onInstalled` listener keeps the event page asleep at browser startup. Adding `runtime.onStartup` or any other listener would wake it.
- **Permission requests:** `permissions.request` must be the first async call inside a trusted user-input handler. Any `await` before it makes Firefox reject the call.
- **Filling (`content.js`):** `el.value = v` from a content script goes through Xrays to the native setter, bypassing React's value tracker. It then dispatches `InputEvent('input', {inputType: 'insertReplacementText'})` and `change`. It never focuses, clicks or submits. Each rule handles an element once (WeakSet; the first sighting decides, so fields the user clears stay cleared). The MutationObserver is disconnected while a scan is pending and reconnected at the start of each scan.
- **Options page:** its element IDs and classes are a contract the tests use (spec §5.7). `#value` is a single-line input with its own `autocomplete="off"`, because otherwise Firefox session restore saves what is typed. The CSP is `default-src 'none'`, so there are no inline styles or scripts, and DOM is built with `textContent` only.

## Testing notes

- The harness (`test/lib/`) drives Firefox over WebDriver BiDi using Node built-ins only. Only `input.performActions` clicks and keys pass the permission user-gesture gate. The harness sets `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` (needed for moz-extension pages and chrome-scope checks), on the throwaway instance only.
- Work test-first: add a failing end-to-end test, then run the full suite. Run one test Firefox at a time. Afterwards `pgrep -fl "firefox.*--headless"` must print nothing; never touch the owner's normal Firefox.
- A real browser restart can't be tested with an unsigned temporary add-on; that check needs the signed XPI.

## Status (2026-11-18)

v1.0.0 is built and verified: 51/51 end-to-end tests pass and lint is clean. Next step: sign on AMO as unlisted/self-distributed. Each signed upload needs a new version, and there is no `update_url`.

Known minor gaps left as is:
- An SPA route change that inserts no element is not re-checked.
- Cancel, Edit and Delete still act while Firefox's permission prompt is pending.
- Refreshing the table drops keyboard focus.
- Leading or trailing spaces in a value block number and dropdown fills.
- A crash right after a rule change can drop the registration until the options page is opened.
