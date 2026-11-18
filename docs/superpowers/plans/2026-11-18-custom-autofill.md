# Custom Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dependency-free Firefox MV3 add-on that automatically fills configured fields on configured HTTPS origins, plus a dev-only end-to-end test suite that proves it.

**Architecture:** One content script, registered at runtime for exactly the configured hosts and gated by per-site optional host permissions. A sleeping event-page background restores the registration after install, update and downgrade. The options page owns rules (in `storage.local`, one key per origin), permissions and registration sync.

**Tech Stack:** Plain JS/HTML/CSS (extension). Node 24 built-ins + headless Firefox 160 over WebDriver BiDi (tests). No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-18-custom-autofill-design.md` (section numbers below refer to it).

## Global Constraints

- Extension files live only in `extension/`: `manifest.json`, `common.js`, `background.js`, `content.js`, `options.html`, `options.css`, `options.js`. Nothing else is packaged.
- Manifest exactly as spec §5.2 (ID `custom-autofill@96717d3ecdad`, `strict_min_version` "142.0", `data_collection_permissions` `{"required":["none"]}`, CSP `default-src 'none'; script-src 'self'; style-src 'self'`).
- No `console.*`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `eval`, `Function(`, `innerHTML`, `import(`, `storage.sync` anywhere in `extension/`.
- No inline `<script>`, `<style>` or `style=""` attributes (the CSP forbids them).
- Test values are dummies; no personal data anywhere.
- No git repository exists, so there are no commit steps.
- Firefox binary: `/Applications/Firefox.app/Contents/MacOS/firefox` (override with env `FIREFOX_BIN`).

## Review Focus

1. **Site typed in any reasonable form** (`Portal.Example.EDU`, `portal.example.edu`, `https://portal.example.edu/`, IDN `bücher.example`, explicit port): it must be stored as the canonical `URL.origin` (lowercase, punycode, port kept), and the fill must still happen. Test T3b in Task 4.
2. **Value fidelity**: values like an ID with leading zeros (`0012345678`), Hebrew/RTL text, emoji, quotes and inner spaces must arrive in the field byte-for-byte, including in `type=number` (digits only) and password fields. Test T5b in Task 3.
3. **Double submit**: double-clicking "Add rule", or pressing Enter twice, must create exactly one rule. Disable `#save` while the save is pending. Test T17b in Task 4.
4. **Broad selectors** (`input`, `*`, `form *`) that also match buttons, checkboxes, hidden inputs and divs: only eligible fields are filled, and nothing throws. Test T5c in Task 3.
5. **Framework re-render and resets**: if a page replaces the field element, the new element is filled once. If a page programmatically resets our value to `""`, it is not refilled (no fight loop). Test T12b in Task 3.

---

### Task 1: Test harness and full end-to-end suite (written first, from the spec only)

**Files:**
- Create: `test/run.mjs`, `test/lib/bidi.mjs`, `test/lib/server.mjs`, `test/lib/harness.mjs`, `test/fixtures/*.html`, `test/tests/*.mjs`
- Create (optional suite): `test/frameworks/*` for real React/Vue. Library builds are loaded from env `FRAMEWORK_LIBS` and are never copied into the repo; the suite is skipped when the env var is unset.

**Interfaces:**
- Consumes: the spec §5.3 storage format, §5.5 `SCRIPT_ID` "autofill", §5.7 element contract, and the globals `hostPattern(origin)` and `syncRegistration()` defined by `extension/common.js` in the options-page realm.
- Produces: `node test/run.mjs [nameFilter]` prints `PASS`/`FAIL <name> (<ms>)` per test plus a summary, and exits 0 only if everything ran and passed. Harness helpers (in `harness.mjs`): `startFirefox()`, `installExtension(dir)`, `openOptions()`, `addRuleViaUI(rule)`, `seedRules(map)` (storage write + permission grant from chrome scope + `syncRegistration()`), `openPage(url)`, `evalIn(context, fn, ...args)`, `waitFor(context, fn, timeoutMs)`, `realClick(context, selector)`, `typeText(context, selector, text)`, `chrome(fn)`, `resetState()`.

- [ ] **Step 1: Harness.** A self-signed cert (LibreSSL with `-pkeyopt ec_param_enc:named_curve`) is generated at runtime into a temp dir. HTTPS servers on two ports serve `test/fixtures/` (on `localhost`, plus `127.0.0.1` for the unconfigured host). Fresh profile `user.js` sets:
  - `extensions.webextensions.uuids` to `{"custom-autofill@96717d3ecdad":"<fixed uuid>"}`
  - `extensions.webextensions.keepUuidOnUninstall` to true
  - `extensions.webextOptionalPermissionPrompts` to false

  Launch with `--headless --no-remote --profile <dir> --remote-debugging-port 0` and env `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`; the session uses `acceptInsecureCerts: true`. Install with `webExtension.install {type:"path"}`. Always close Firefox and delete the profile in `finally`. Keep the tab under test in the foreground (background tabs clamp timers to ≥1 s).
- [ ] **Step 2: Write tests T1–T19 from spec §8**, plus the Review Focus tests T3b, T5b, T5c, T12b and T17b. Each test asserts concrete values. Examples:
  - T5 asserts `value === "ID-0000-TEST"` and the event log equals `["input:InputEvent:insertReplacementText:bubbles:composed", "change:Event:bubbles"]` for a text field.
  - T10 asserts `WebExtensionPolicy.getByID(id).contentScripts[0].matchesURI(https://127.0.0.1:…)` is false (via chrome scope).
  - T18 subscribes to `log.entryAdded` for the whole run and asserts no entry contains any test value. It also checks Firefox form history (`FormHistory.count`) for the saved values via chrome scope and statically scans `extension/` for the forbidden tokens.
  - T19 reports numbers (busy-loop throughput on a high-churn page with and without the script, and scan cost on a 10k-node DOM). It fails only if the slowdown is above 5%.
- [ ] **Step 3: Run the suite before the extension exists.** Run: `node test/run.mjs`. Expected: harness boots, then the extension tests FAIL (or the install fails) for missing files. That proves the tests can fail.
- [ ] **Step 4: Once Tasks 2–4 land, re-run.** Expected: all PASS. A failure caused by the test is fixed in the test. A failure caused by the extension is reported with evidence; do not edit `extension/`.

### Task 2: Manifest, registration sync and background

**Files:**
- Create: `extension/manifest.json` (spec §5.2 verbatim), `extension/common.js`, `extension/background.js`

**Interfaces:**
- Produces: globals `SCRIPT_ID = "autofill"`, `hostPattern(origin: string): string`, `syncRegistration(): Promise<void>` (serialized, idempotent; algorithm in spec §5.5).

- [ ] **Step 1: Run** `node test/run.mjs T1` and `node test/run.mjs T16`. Expected: FAIL.
- [ ] **Step 2: Implement** per spec §5.5. `background.js` calls `syncRegistration()` at top level. It registers one `runtime.onInstalled` listener that opens the options page on `reason === "install"`, and no other listeners.
- [ ] **Step 3: Run** the same tests. Expected: PASS once Task 4 exists (T1 checks that the options tab opened).

### Task 3: Content script

**Files:**
- Create: `extension/content.js`

**Interfaces:**
- Consumes: storage format (spec §5.3). Runs injected; no globals exported.

- [ ] **Step 1: Run** `node test/run.mjs T5`, then `T6`–`T13`. Expected: FAIL.
- [ ] **Step 2: Implement** spec §5.6 exactly: eligibility, select option matching with retry, first-sighting rule, Xray native set with rejected-value restore, event sequence, 100 ms throttled observer with element-only early exit.
- [ ] **Step 3: Run** `T5`–`T13`, `T5b`, `T5c` and `T12b`. Expected: PASS.

### Task 4: Options page

**Files:**
- Create: `extension/options.html`, `extension/options.css`, `extension/options.js`

**Interfaces:**
- Consumes: `hostPattern`, `syncRegistration` from Task 2 (loaded via `<script src="common.js">` before `options.js`).
- Produces: the element contract of spec §5.7, verbatim IDs and classes.

- [ ] **Step 1: Run** `T2`, `T3`, `T3b`, `T4`, `T14`, `T15`, `T17`, `T17b`. Expected: FAIL.
- [ ] **Step 2: Implement** spec §5.7. `permissions.request` is the first async call in the submit, toggle and grant handlers. `#save` is disabled while a save is pending. Rows are built with DOM APIs only. The privacy notice text follows spec §5.7 item 2.
- [ ] **Step 3: Run** the same tests. Expected: PASS.

### Task 5: README and packaging check

**Files:**
- Create: `README.md` covering what it does, install for testing (about:debugging) and normal install (signed XPI), how to write a rule (finding a selector with the inspector), the privacy explanation (not an encrypted vault), limitations (spec §7), and how to run the tests.

- [ ] **Step 1: Run** `node test/run.mjs` (full). Expected: all PASS.
- [ ] **Step 2: Run** `web-ext lint --source-dir extension` (scratchpad copy of web-ext). Expected: `errors 0, notices 0, warnings 0`.

### Task 6: Independent review and final verification

- [ ] **Step 1:** Run a multi-lens adversarial review (requirements coverage, privacy/security, Firefox platform correctness, performance, UX of the options page) against `extension/` and the spec; verify each finding before fixing.
- [ ] **Step 2:** Fix confirmed findings. Re-run the full suite, the framework suite (`FRAMEWORK_LIBS=…`) and lint. Expected: all PASS, lint clean.
