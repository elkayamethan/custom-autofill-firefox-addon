# Custom Autofill: design

Status: the owner approved the approach and delegated the remaining design decisions and implementation to the builder (2026-11-18).
Target: Firefox desktop (built and tested against 160.0.1), Manifest V3, self-distributed and signed through AMO as "unlisted".

## 1. Intent

The owner's university login (and a few similar sites) ask for things Firefox's password manager does not handle, for example an ID number next to the username and password. The owner wants a tiny personal Firefox add-on that fills those fields automatically when the page shows them, with no clicks, keyboard shortcuts or prompts while browsing. Each rule is configured on an options page.

Privacy and minimal runtime cost matter more than features.

## 2. Goals, non-goals and anti-goals

Goals
- Rules: exact HTTPS origin, optional path restriction, CSS selector, value, enabled flag, "overwrite" flag.
- Fill matching fields automatically on page load and when they appear later (SPA steps, multi-step logins, late rendering).
- By default fill only empty fields. A per-rule "overwrite" option allows replacing an existing value.
- Dispatch the events that framework-managed forms (React, Vue, Angular, Svelte, plain listeners) need to register the value.
- Options page to add, edit, enable or disable, and delete rules.
- Firefox site access only for configured sites: asked once per site, when its first rule is saved.

Non-goals (v1)
- Checkboxes, radio buttons, contenteditable or rich-text editors.
- Fields inside shadow DOM (web components).
- Live application of rule edits to already-open tabs. Edits apply on the next page load.
- Import/export, sync, multiple profiles, keyboard shortcuts, toolbar button.

Anti-goals: the work fails if any of these happen, even if everything else works
- Any network request, telemetry, analytics, remote code, third-party code, or custom update server.
- Site access or code running on any site the user did not configure.
- A form being submitted, or a value logged anywhere (console, errors, Firefox form history).
- Personal values in the source or the package.
- Measurable work on unconfigured sites, or an always-running background.

## 3. Constraints

- Values are stored only in `browser.storage.local`. No `storage.sync`.
- No dependencies. Plain hand-written JS, HTML and CSS, unminified so AMO needs no source upload.
- The options page must say plainly that `storage.local` is not an encrypted password vault.
- AMO signing needs a permanent `browser_specific_settings.gecko.id` and `data_collection_permissions: {"required": ["none"]}`.

## 4. Approaches considered

| Approach | Verdict |
|---|---|
| **A. MV3, one content script registered at runtime (`scripting.registerContentScripts`) for exactly the configured hosts, gated by per-site optional host permissions. A tiny event-page background restores the registration after installs and updates.** | **Chosen.** Nothing runs on unconfigured sites, and nothing runs in the background during normal browsing. Verified working on Firefox 160 in a spike. |
| B. Static `content_scripts` for `https://*/*` | Rejected. Firefox 127+ grants manifest content-script hosts at install, so the add-on would get access to every site. |
| C. MV2 `contentScripts.register` | Rejected. Registrations die with the page that made them, so this needs a persistent (always running) background page. |
| D. Background injects on every navigation (`tabs.onUpdated` + `executeScript`) | Rejected. It wakes the background on every page load. |
| E. One registration for `https://*/*`, relying on per-site permission only | Rejected. If the user ever flips about:addons' "all websites" switch, the script would run on every HTTPS page. |

## 5. Design

### 5.1 Files

```
extension/            the add-on package root (the only thing that gets signed)
  manifest.json
  common.js           shared by background + options: hostPattern(), syncRegistration()
  background.js       event page: restore registration on start, open options on first install
  content.js          the filler
  options.html / options.css / options.js
test/                 dev-only end-to-end tests (Node + headless Firefox via WebDriver BiDi), never packaged
docs/                 this document
README.md
```

### 5.2 Manifest (exact)

```json
{
  "manifest_version": 3,
  "name": "Custom Autofill",
  "version": "1.0.0",
  "description": "Automatically fills form fields you configure, on HTTPS sites you configure. Rules stay in this browser's local storage and are never sent anywhere.",
  "browser_specific_settings": {
    "gecko": {
      "id": "custom-autofill@96717d3ecdad",
      "strict_min_version": "142.0",
      "data_collection_permissions": { "required": ["none"] }
    }
  },
  "permissions": ["storage", "scripting"],
  "optional_host_permissions": ["https://*/*"],
  "background": { "scripts": ["common.js", "background.js"] },
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "content_security_policy": { "extension_pages": "default-src 'none'; script-src 'self'; style-src 'self'" }
}
```

Notes
- `scripting` and `storage` show no install-time warning. `scripting` must be a required permission: Firefox restores persisted registrations only if it is held.
- `optional_host_permissions: ["https://*/*"]` must be declared, because `permissions.request` only accepts origins covered by declared optional origins. Nothing is granted at install.
- The CSP blocks every network connection from extension pages (`default-src 'none'`). It also forbids inline styles and inline scripts, so all CSS is in options.css and all UI is built with DOM APIs (`textContent`, never `innerHTML`).
- `strict_min_version` "142.0" keeps `web-ext lint` at zero warnings with `data_collection_permissions`.
- No `update_url`. Updates are installed manually from newly signed XPIs.
- The ID is random and non-personal (Firefox sends it to AMO's update check). Never change it: storage, permissions and registrations are keyed by it.

### 5.3 Data model (`browser.storage.local`)

One key per exact origin (the `URL.origin` string, which keeps a non-default port), holding that origin's rules in creation order:

```js
"https://portal.example.edu": [
  { id: "<crypto.randomUUID()>", path: "", selector: "#idNumber", value: "…", enabled: true, overwrite: false },
  { id: "…", path: "/login*", selector: "input[name=password]", value: "…", enabled: true, overwrite: false }
]
```

- Keys always start with `https://`. There are no other keys in v1.
- `path` is `""` (any path) or a normalized path pattern (see 5.6).
- The content script reads only its own origin's key, so values for other sites never enter that page's process.

### 5.4 Site access (permissions)

- `hostPattern(origin) = "https://" + new URL(origin).hostname + "/*"`. This form is lowercase, punycode and has no port. Firefox match patterns never match a pattern that contains a port, uppercase letters or Unicode. A host pattern therefore covers every port of the host, and the exact origin (including the port) is enforced by the content script's storage key lookup.
- Saving a rule (add, edit) calls `browser.permissions.request({origins: [hostPattern(origin)]})` **synchronously as the very first async call of the submit handler**, before any `await`. Firefox rejects the call once the user-input context is lost. An already-granted host resolves `true` without any prompt. If `false`, the rule is not saved and the page says why.
- Re-enabling a rule (checkbox `change`) and the per-site "Grant access" button also call `request` first.
- When no stored origin with at least one rule (enabled or not) maps to a host pattern any more (delete, or edit that moves a rule to another origin), call `browser.permissions.remove` for it.
- The options page shows live access status per site (`permissions.contains`, refreshed on `permissions.onAdded` and `onRemoved`), because the user can also revoke or grant access in about:addons or the extensions panel.

### 5.5 Registration and background

`common.js`
- `SCRIPT_ID = "autofill"`.
- `syncRegistration()` is serialized through a promise chain and idempotent:
  - Desired `matches` = the sorted, de-duplicated `hostPattern(o)` for every origin key with at least one **enabled** rule.
  - Read the current registration with `getRegisteredContentScripts({ids: [SCRIPT_ID]})`.
  - Desired empty: unregister if one is registered.
  - Nothing registered: `registerContentScripts([{ id, js: ["/content.js"], matches, allFrames: true, runAt: "document_idle", persistAcrossSessions: true }])`. If that fails because another context registered first, fall back to `updateContentScripts`.
  - Registered with different `matches`: `updateContentScripts([{ id, matches }])`. Equal: no-op.
- The `js` path starts with `/` because relative paths resolve against the calling page.
- Registration never depends on permission state. Firefox checks host permission per document at injection time (MV3 always does), so revoked sites stop getting the script automatically, and re-granted sites resume.

`background.js`
- Calls `syncRegistration()` at top level. Firefox deletes persisted registrations on install, upgrade and downgrade, and a downgrade does not fire `onInstalled`. Top-level code runs on every non-startup start (install, upgrade, downgrade, enable).
- Adds `runtime.onInstalled` listener: on `reason === "install"` it calls `runtime.openOptionsPage()`. Being a persistent listener, it also keeps the event page **asleep at normal browser startups**, where registrations are restored by Firefox itself. Do not add `runtime.onStartup` or other listeners; each would wake the background.

### 5.6 Content script (`content.js`)

Runs at `document_idle` in every frame whose own URL matches a registered host and has permission.

1. `rules = (await browser.storage.local.get(location.origin))[location.origin]`, keep `enabled` ones; if none, return (no observer). Never call `get()`/`get(null)`/`getKeys()`, and never listen to `storage.onChanged` here: it would deliver every changed value into the page's process.
2. Per rule: `done = new WeakSet()`, and if `path` is set, `re = ^` + path with each `*` turned into `.*` and everything else regex-escaped + `$`, tested against `location.pathname` on **every** scan (SPA navigations change it without reinjecting).
3. `scan()`: for each rule whose path matches, `document.querySelectorAll(selector)` (try/catch; skip invalid), and for each element not in `done`, `fill(el, rule)`.
4. `fill(el, rule)`:
   - Eligible: `localName` `input` (except types hidden, file, checkbox, radio, submit, reset, button, image, range, color), `textarea`, `select`. Range and color inputs are skipped because they can never be "empty" and a Replace rule would only reset them. Ineligible elements go into `done`. Use `localName` and `type` strings, not `instanceof`, because of Xrays and cross-realm elements. Disabled and read-only fields are not skipped: some sites set `readonly` until focus specifically to defeat autofill.
   - `select`: pick the option whose `value` equals the rule value, else whose trimmed `text` equals it. If none, **return without marking done**: options may load later and the next scan retries.
   - Mark done. If the current value already equals the target, or the field is non-empty and `overwrite` is off, stop. The first sighting decides, so a field the user later clears is never refilled.
   - `el.value = v`. In a content script this goes through the Xray, i.e. the native setter, so React's per-node value tracker is not updated and React sees the change. If the field rejected the value (now `""`, e.g. type=number), restore the old value and stop.
   - Dispatch `input` (`InputEvent`, `bubbles`, `composed`, `inputType: "insertReplacementText"`, `data: v` for input/textarea; plain `Event('input', {bubbles, composed})` for select), then `Event('change', {bubbles: true})`. No focus, blur or keyboard events, and never `submit()`, `requestSubmit()`, `click()` or Enter. This mirrors Firefox's own autofill (`setUserInput` on an unfocused field).
5. One `MutationObserver` on `document` (`childList`, `subtree`; no attributes or characterData). Every `scan()` (re)connects it **before** filling, so fields a page inserts in response to that scan's fills are recorded. When a batch adds an Element node, the callback disconnects the observer and schedules `scan()` 100 ms later. While the scan is pending no mutation records are built, which halved the measured overhead on a high-churn page; the scan re-checks the whole page anyway. Text-only churn never triggers a scan, and there are at most about 10 scans per second.
6. No logging of any kind.

### 5.7 Options page

Layout, top to bottom:
1. Title "Custom Autofill".
2. Privacy notice (`#privacy`):
   - **Not an encrypted password vault.** Rules and their values are stored **unencrypted** in this Firefox profile (`browser.storage.local`). Anyone or anything that can read the profile folder (someone using your computer account, malware, a backup) can read them. Firefox's Primary Password does not protect them. They are not synced and never sent anywhere.
   - Site access: Firefox asks once per site, records which sites are allowed (not values) in its own profile settings, and loses access when the site's last rule is deleted. Tell the user to leave the about:addons "all websites" switch off.
3. Rule form (`form#rule-form`, `autocomplete="off"` so Firefox form history never records values, `novalidate`). All fields are single-line `type=text` inputs, never `type=password`, so the password manager never offers to save anything. `#value` also carries its own `autocomplete="off"`: Firefox's session restore collects an input's or textarea's typed content unless that element itself (for textareas) or its form (for inputs) opts out. The single-line input also means Enter submits instead of adding an invisible line break.
4. Rules table, then the "Changes apply the next time a matching page loads; reload tabs that were already open." hint.

Element contract (tests depend on it):

| Element | Meaning |
|---|---|
| `#origin` (text input) | Site. Accepts `https://host[:port]` or a bare host (https assumed). Rejects http, paths, query, hash, credentials and any `*` in the host (Firefox's URL parser accepts `*`, which would become a wildcard site permission). Stored as `URL.origin`. |
| `#path` (text input) | Optional. Must start with `/`, no `?` or `#`. `*` = wildcard. Normalized via `new URL("https://x.invalid" + path).pathname` so it matches `location.pathname` encoding. |
| `#selector` (text input) | Required; validated with `document.createDocumentFragment().querySelector()`. |
| `#value` (single-line text input, own `autocomplete="off"`) | Required, non-empty. Masked with `-webkit-text-security: disc` (class `masked`) unless "Show values" is on. |
| `#overwrite` (checkbox) | Default off. |
| `#enabled` (checkbox) | Default on. |
| `#save` (submit button) | Text "Add rule", or "Save changes" when editing. |
| `#cancel` (button) | Hidden unless editing. |
| `#form-title` | "Add a rule" / "Edit rule". |
| `#msg` | Status text; has class `error` for errors. |
| `#show-values` (checkbox) | Default off; unmasks values in the table and the textarea. |
| `#rules` table, `tbody tr[data-origin][data-id]` | One row per rule, sorted by origin then creation order. Cells: `input.toggle` (enabled checkbox), `td.origin` (+ `button.grant` "Grant access" only when Firefox access for that host is missing), `td.path` ("any" when empty), `td.selector`, `td.value` ("••••••••" when masked, regardless of length), `td.overwrite` ("yes"/"no"), `button.edit`, `button.delete`. |
| `#empty` | Shown when there are no rules. |

Flows
- **Add or edit** (submit): validate synchronously, show an error in `#msg` and stop if invalid. Call `permissions.request` first. If not granted, show an error and keep the form. If granted: write the rule (keeping its `id` and position when editing; moving it between origin keys if the origin changed), release the old host's permission if now unused, `syncRegistration()`, reset the form, and show "Saved. Reload open tabs of that site to apply it."
- **Toggle**: request first when enabling; then update `enabled` and sync.
- **Delete**: `confirm("Delete this rule?")`, then remove it (remove the key when its list is empty), release the host if unused, sync. Cancels an edit of that rule.
- **Grant access**: `permissions.request` for that host.
- The table re-renders on `storage.local.onChanged`, `permissions.onAdded` and `permissions.onRemoved`, and on load. Stale async renders are dropped with a sequence counter. On load the page also calls `syncRegistration()` as a repair path.
- Error messages never include values.

### 5.8 Performance budget

| Situation | Cost |
|---|---|
| Unconfigured site | Zero. The script is not injected; Firefox's native match check only. |
| Normal browser startup | Zero. The event page stays asleep; Firefox restores the registration itself. |
| Install, update, downgrade or enable | One short background run (one storage read, one or two scripting calls), then unload after Firefox's idle timeout. |
| Configured site | About 2–3 KB script at `document_idle`, one keyed storage read, one `querySelectorAll` per applicable rule per scan. Observer is disconnected while a scan is pending, ignores text-only churn, and scans at most about every 100 ms. Measured on a stress page with about 13,800 insertions/s: about 1% median slowdown (noise is about ±1%). One scan of 5 rules on a 10,000-node page takes about 13 µs. |

## 6. Platform facts relied on (verified on Firefox 160.0.1, source and/or experiment)

- `registerContentScripts` validates pattern syntax only; host permission is checked per document at injection (MV3). Registering or granting does not inject into already-open documents. Revoking does not unload already-injected scripts.
- Persisted registrations are wiped on ADDON_INSTALL, UPGRADE and DOWNGRADE, and kept across restarts and disable/enable. `onInstalled` does not fire on downgrade.
- An event page with at least one persistent listener (e.g. `onInstalled`) and no `onStartup` listener is not started at APP_STARTUP.
- `permissions.request` requires a trusted user-input event (click, submit by click or Enter, checkbox change) still being handled. Any real `await` before it makes it reject.
- Port-bearing, uppercase or Unicode host patterns are accepted but never match.
- In content scripts, `el.value = v` uses the native setter through Xrays. React (18 and 19) tracks values with a per-node own property, which Xrays bypass, so a bubbling `input` makes React see the change. React `<select>` listens to `change`.
- Content-script `storage.local.get(key)` reads only that key. Content-script `storage.onChanged` receives all changed keys and values.
- `-webkit-text-security` is supported (used in Firefox's own forms.css).
- Content scripts never run on Mozilla-restricted domains (addons.mozilla.org, accounts.firefox.com, …) or quarantined domains; rules there silently do nothing.

## 7. Known limitations (documented to the user)

- No shadow DOM, checkboxes or radios. Sites that only react to real keystrokes cannot be satisfied by any extension, because synthetic events are `isTrusted: false`.
- React apps on React 19.1 or older that hydrate server-rendered forms **after** the fill may ignore the filled value (React 19.2+ replays it). This is the same limitation Firefox's own autofill has.
- Angular controls configured with `updateOn: 'blur'` need a blur, which this add-on deliberately does not fake.
- Rule edits apply on the next page load.
- One grant covers all ports of a host; rules still fire only on the exact origin.

## 8. Test plan (all automated, headless Firefox, throwaway profile)

Harness: Node 24 with no dependencies. A local HTTPS server (self-signed EC cert with named-curve encoding) runs on two ports. Firefox runs headless with `--remote-debugging-port`, env `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` (throwaway profile only, to script moz-extension pages and chrome scope), and prefs that pin the add-on UUID and set `extensions.webextOptionalPermissionPrompts=false` (except in the deny test). The add-on is installed temporarily from `extension/` via `webExtension.install`. The options UI is driven with real `input.performActions` clicks and keys, since only trusted input passes the permission gate.

| # | Scenario | Pass criteria |
|---|---|---|
| T1 | Fresh install | No host permissions, no registration, options page opened. |
| T2 | Add rule through the UI | Permission for the host pattern granted; storage holds the rule under the exact origin; registration `matches` = host pattern. |
| T3 | Validation | http origin, origin with path, bad path, invalid selector and empty value are each rejected with an error and nothing is stored. |
| T4 | Real prompt, Deny | Rule not saved; error shown; no permission. |
| T5 | Basic fill | text/password/email/textarea/select-by-value/select-by-label filled exactly; prefilled field untouched; overwrite rule replaces; hidden and checkbox untouched; `input` (InputEvent `insertReplacementText` / Event for select) then `change`, bubbling (input composed); no submit event, no navigation. |
| T6 | Late content | Field inserted after load, field inside an inserted subtree, and select whose options arrive later are all filled. |
| T7 | Paths | Exact path, `*` wildcard, non-matching path not filled. |
| T8 | SPA | `pushState` to a matching path + new field → filled; new field on a non-matching path → not filled. |
| T9 | Disabled rule | Not applied; applied again after re-enable + reload. |
| T10 | Exact origin | Rule for port A does not fill on port B of the same host and vice versa; unconfigured host (127.0.0.1) gets no script (`matchesURI` false) and no fill. |
| T11 | Frames | Same-origin iframe filled; configured-origin iframe inside an unconfigured page filled; unconfigured iframe inside a configured page not filled. |
| T12 | User wins | After a fill, the user clears the field; DOM mutations do not refill it. Non-empty field at first sight is never filled later. |
| T13 | Frameworks | React-style value-tracker emulation sees the change. Real React 18 and 19 and Vue 3 run as a one-off check with the builds kept outside the repo. |
| T14 | Delete | Deleting a host's last rule removes its permission and registration, and the next load is not filled. A rule on another port of the same host keeps the permission. |
| T15 | Revoked externally | After revocation the next load is not filled, the options page shows "Grant access", and Grant restores filling. |
| T16 | Lifecycle | Upgrade (re-install with higher version), downgrade, disable/enable: registration restored; storage and permissions preserved; filling works. |
| T17 | Edit/toggle/mask | Edit value, path and origin (moving origin releases the old host if unused); toggle enabled; Show values masks and unmasks; state survives a reload of the options page. |
| T18 | Privacy | No console entry contains a test value. Static scan of `extension/` finds no `console.`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `eval`, `Function(`, `innerHTML`, `import(` or `storage.sync`. The CSP is in effect. Firefox form history has no entry for saved values. The package contains only the expected files. |
| T19 | Performance | Stress page with heavy DOM churn: page throughput with the script active vs inactive differs negligibly; scan cost on a large DOM is reported. |
| T20 | Lint | `web-ext lint` on `extension/`: 0 errors, 0 warnings. |
| T21 | Review regressions | A typed value never reaches session-restore data; Enter in Value saves without a line break; a field inserted synchronously by the first fill is filled; Replace rules leave range and color inputs alone. (Wildcard sites are covered by T3c.) |

Test values are dummies (e.g. `ID-0000-TEST`). Real personal values never appear in the repo.

## 9. Builder's calls (made without the owner, by delegation)

- Name "Custom Autofill"; ID `custom-autofill@96717d3ecdad`; version 1.0.0; strict_min_version 142.0.
- Paths: exact match with `*` wildcard, case-sensitive, compared with `location.pathname`.
- Dropdowns count as empty only when their value is `""`. Otherwise the rule needs "overwrite".
- All matching elements are filled (`querySelectorAll`), not just the first.
- Disabled and read-only fields are filled; hidden inputs are not.
- Open the options page once on first install (there is no toolbar button).
- Values are masked on the options page by default.
- Real framework builds used in tests are not vendored into the repo.
- Value is a single-line field (after review): multi-line values are not supported, which logins never need.
- Filling inside a configured site's frame is kept even when another site embeds it (agreed with the owner). Values only reach that site's own document, which the embedding site cannot read. This is documented in the README.
