# Custom Autofill

A tiny Firefox add-on that automatically fills form fields you choose on HTTPS sites you choose. It is meant for logins that Firefox's password manager can't handle, for example a login that also asks for an ID number. There are no clicks or shortcuts while browsing, and it never submits a form.

## Privacy and security

- **This is not an encrypted password vault.** Rules and their values are stored **unencrypted** in your Firefox profile (`browser.storage.local`). Anyone or anything that can read your profile folder can read them: someone using your computer account, malware, or a backup of the profile. Firefox's Primary Password does not protect them.
- **Everything stays on your computer.** No sync, no network requests, no telemetry or analytics, no remote or third-party code, and no update server. The add-on's own pages run under a content security policy that blocks every network connection.
- **Access only to sites you add.** Firefox asks once per site, when you save that site's first rule. Deleting a site's last rule gives the access back. In about:addons, leave the add-on's "Access your data for all websites" switch off.
- **Ports:** Firefox site access can't be limited to a port, so access to a host covers all of its ports. Rules still fill only on the exact origin you entered, including its port.
- **Values are never logged.** The options page masks them unless you tick "Show values". Neither Firefox's form history nor its session restore keeps what you type there.
- **Embedded frames:** if another website embeds one of your configured sites in a frame, fields inside that frame are filled too. The embedding site can't read them, and most login pages refuse to be embedded at all.
- **What Firefox itself keeps and sends:** Firefox records which sites you allowed (not your values) in its profile settings. As it does for every add-on, Firefox periodically asks Mozilla whether an update exists, using the add-on's ID. The ID is a random string that says nothing about you.

## Install

- **Try it now (temporary):** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…** and select `extension/manifest.json`. Firefox removes temporary add-ons, along with their rules, when it restarts.
- **Permanent:** this needs a copy signed by Mozilla, uploaded as a self-distributed ("On your own") add-on. That's the next step.

## Adding a rule

1. Open the add-on's options: about:addons → Custom Autofill → Preferences. It also opens once by itself after install.
2. **Site:** the page's address up to the first `/`, e.g. `https://portal.example.edu`. Include `:port` only if the site uses one.
3. **Path** (optional): `/login`, or `/login*` where `*` matches anything. Leave it empty to match every page on the site. For passwords, set a path so the rule runs only on the login page.
4. **CSS selector:** identifies the field. Right-click the field → **Inspect**. The highlighted element usually shows an `id` or `name`; use it as `#idNumber` or `input[name="username"]`. Avoid long selectors that count positions (`div:nth-child(3) > input`), such as the ones **Copy → CSS Selector** sometimes produces: they can match a different field on another page of the site.
5. **Value**, then **Add rule**. Firefox asks once to allow the site; choose **Allow**.
6. Reload any tabs of that site that were already open.

### How filling behaves

- It fills only empty fields, unless the rule has **Replace a value that is already in the field** ticked.
- Each field is handled once per page. If you clear a field, it stays cleared.
- Fields that appear later (multi-step logins, single-page apps) are filled when they appear.
- It fills text-type inputs (including password, email and number), text areas, and dropdowns. Dropdown options are matched by their value or by their visible text. It skips checkboxes, radio buttons, hidden inputs, sliders and color pickers.
- A dropdown counts as empty only while its selected option has an empty value, as a typical "Choose…" placeholder does. If it already shows a real choice, or its placeholder has a value such as `0`, tick **Replace** for that rule.
- After filling, it sends the `input` and `change` events that sites built with React, Vue, Angular and similar frameworks listen for.
- It also fills inside an embedded frame when that frame is itself one of your configured sites.
- It never submits forms and never clicks anything.

### Limitations

- It can't reach fields inside web components (shadow DOM).
- Sites that react only to real keystrokes can't be satisfied by any add-on.
- On React 19.1 or older, a server-rendered form that finishes loading after the fill may ignore it. Firefox's own autofill has the same problem.
- Angular fields configured to update only on blur won't pick up the value, because the add-on doesn't fake focus or blur.
- Firefox doesn't let add-ons run on its restricted sites (addons.mozilla.org, accounts.firefox.com, …).
- Private windows are filled only if you allow it: about:addons → Custom Autofill → **Run in Private Windows**.
- An app that changes its address without adding anything to the page is re-checked only when something new appears on the page.
- Edits apply the next time a page loads.

## Development

- `extension/` is the add-on: the only folder that gets packaged and signed. No dependencies, no build step.
- `test/` is a development-only end-to-end suite. It runs a headless Firefox through its built-in automation protocol and needs only Node 24+ and Firefox (`/Applications/Firefox.app`, or set `FIREFOX_BIN`).
  - Run everything: `node test/run.mjs`
  - Run tests whose name matches: `node test/run.mjs T5`
  - Optional real-framework tests (React/Vue builds you supply, never committed): `FRAMEWORK_LIBS=/path/to/libs node test/run.mjs framework`
- Lint: `npx web-ext lint --source-dir extension`
- `docs/` holds the design and the implementation plan.
