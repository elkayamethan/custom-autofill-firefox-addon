// T18 privacy (spec §2 anti-goals, §3, §5.2, §5.6, §5.7, §8).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXT_ID, OPTIONS_URL, eq, ok, sleep } from "../lib/harness.mjs";
import { EXPECTED_FILES, FORBIDDEN, listFiles, matches, splitHtml, splitJs } from "../lib/static-scan.mjs";

// Spec §5.2, verbatim.
const SPEC_MANIFEST = {
  manifest_version: 3,
  name: "Custom Autofill",
  version: "1.0.0",
  description: "Automatically fills form fields you configure, on HTTPS sites you configure. Rules stay in this browser's local storage and are never sent anywhere.",
  browser_specific_settings: {
    gecko: {
      id: "custom-autofill@96717d3ecdad",
      strict_min_version: "142.0",
      data_collection_permissions: { required: ["none"] },
    },
  },
  permissions: ["storage", "scripting"],
  optional_host_permissions: ["https://*/*"],
  background: { scripts: ["common.js", "background.js"] },
  options_ui: { page: "options.html", open_in_tab: true },
  content_security_policy: { extension_pages: "default-src 'none'; script-src 'self'; style-src 'self'" },
};
const CSP = SPEC_MANIFEST.content_security_policy.extension_pages;

export const tests = [
  {
    name: "T18 privacy (static): no network, eval, innerHTML, console or storage.sync in the code; content.js reads only its own key and never submits or focuses; exactly the 7 files; manifest as specified",
    noReset: true,
    async fn(h) {
      const dir = h.env.EXTENSION_DIR;
      const files = listFiles(dir);
      const dot = files.filter((f) => f.split("/").some((p) => p.startsWith(".")));
      eq(files.filter((f) => !dot.includes(f)), EXPECTED_FILES, "files in the package (dotfiles excluded)");
      if (dot.length) h.info(`note: dotfiles present (not packaged by web-ext): ${dot.join(", ")}`);

      const code = {}, comments = {};
      for (const f of EXPECTED_FILES) {
        const src = readFileSync(join(dir, f), "utf8");
        const parts = f.endsWith(".js") ? splitJs(src) : f.endsWith(".html") ? splitHtml(src) : { code: src, comments: "" };
        code[f] = parts.code;
        comments[f] = parts.comments;
      }
      const hits = [], commentHits = [];
      for (const [label, re] of FORBIDDEN) {
        for (const f of EXPECTED_FILES) {
          hits.push(...matches(f, code[f], re).map((m) => `[${label}] ${m}`));
          commentHits.push(...matches(f, comments[f], re).map((m) => `[${label}] ${m}`));
        }
      }
      eq(hits, [], "forbidden tokens in extension code");
      if (commentHits.length) h.info(`note: forbidden words only inside comments: ${commentHits.join(" ; ")}`);

      // Content script (spec §5.6): only its own origin's key, no change listener, never submit/click/focus/keys.
      const cs = code["content.js"];
      const csRules = [
        ["storage.local.get() / get(null)", /\.get\(\s*(null)?\s*\)/],
        ["getKeys", /getKeys/],
        ["onChanged", /onChanged/],
        ["submit()/requestSubmit()/click()", /\.(submit|requestSubmit|click)\s*\(/],
        ["focus()/blur()", /\.(focus|blur)\s*\(/],
        ["KeyboardEvent", /KeyboardEvent/],
        ["setInterval", /setInterval/],
      ];
      const csHits = csRules.flatMap(([label, re]) => matches("content.js", cs, re).map((m) => `[${label}] ${m}`));
      eq(csHits, [], "content.js anti-patterns");
      ok(/storage\s*\.\s*local\s*\.\s*get\s*\(\s*[^)\s]/.test(cs), "content.js reads storage.local with a key argument");

      // Background (spec §5.5): one persistent listener (runtime.onInstalled), no onStartup, no timers.
      const bg = code["background.js"];
      eq(matches("background.js", bg, /addListener\s*\(/).length, 1, "number of addListener calls in background.js");
      ok(/runtime\s*\.\s*onInstalled\s*\.\s*addListener/.test(bg), "background.js listens to runtime.onInstalled");
      eq(matches("background.js", bg, /onStartup|setInterval/), [], "background.js: no onStartup listener and no polling timer");
      ok(/syncRegistration\s*\(\s*\)/.test(bg), "background.js calls syncRegistration()");

      // Options page: no inline script/style, no inline handlers, no remote resources.
      const html = code["options.html"];
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      eq(scripts.filter((m) => !/\bsrc\s*=/.test(m[1]) || m[2].trim()).length, 0, "inline <script> blocks in options.html");
      eq(scripts.map((m) => (m[1].match(/\bsrc\s*=\s*["']?([^"'\s>]+)/) || [])[1]).filter((s) => !s || /^[a-z]+:|^\/\//i.test(s)), [], "non-local script sources");
      eq(matches("options.html", html, /<style\b|\sstyle\s*=|\son[a-z]+\s*=/i), [], "inline styles or event-handler attributes in options.html");
      eq(matches("options.html", html, /(src|href)\s*=\s*["']?(https?:)?\/\//i), [], "remote resources in options.html");
      eq(matches("options.css", code["options.css"], /@import|url\(\s*["']?(https?:)?\/\//i), [], "remote resources in options.css");

      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      eq(manifest, SPEC_MANIFEST, "manifest.json (spec §5.2, exact)");
    },
  },

  {
    name: "T18 privacy (runtime): CSP in effect (fetch blocked before reaching the server, inline script blocked); form autocomplete off, no password inputs; notice says it is not an encrypted vault",
    async fn(h) {
      const policyCsp = await h.chrome((id) => WebExtensionPolicy.getByID(id).extensionPageCSP, EXT_ID);
      eq(policyCsp, CSP, "Firefox accepted the manifest CSP (an invalid one silently falls back to the default)");
      const opt = await h.openOptions();
      const probe = `/csp-probe-${Date.now()}.txt`;
      const hitsBefore = h.server.hits.length;
      const res = await h.evalIn(opt, async (u) => {
        const fetchResult = await fetch(u).then((r) => "allowed:" + r.status, (e) => "blocked:" + e.name);
        const s = document.createElement("script");
        s.textContent = "window.__inlineRan = true;";
        document.head.append(s);
        await new Promise((r) => setTimeout(r, 50));
        s.remove();
        return { fetchResult, inlineRan: window.__inlineRan === true };
      }, `${h.A}${probe}`);
      await sleep(300);
      eq(res, { fetchResult: "blocked:TypeError", inlineRan: false }, "fetch and inline script from the options page");
      eq(h.server.hits.slice(hitsBefore).filter((x) => x.url.startsWith(probe)), [], "no request reached the server");

      const form = await h.evalIn(opt, () => ({
        autocomplete: document.querySelector("form#rule-form")?.getAttribute("autocomplete"),
        novalidate: document.querySelector("form#rule-form")?.hasAttribute("novalidate"),
        passwords: document.querySelectorAll("input[type=password]").length,
        // #value is a single-line text input with its own autocomplete="off": Enter submits instead of adding
        // a line break, and Firefox's session restore and form history never keep the value (see T21a).
        valueTag: document.querySelector("#value")?.localName,
        valueAutocomplete: document.querySelector("#value")?.getAttribute("autocomplete"),
        textInputs: ["#origin", "#path", "#selector", "#value"].map((s) => document.querySelector(s)?.type),
        privacy: document.querySelector("#privacy")?.textContent.replace(/\s+/g, " ").trim() ?? "",
      }));
      eq({ ...form, privacy: undefined }, { autocomplete: "off", novalidate: true, passwords: 0, valueTag: "input", valueAutocomplete: "off", textInputs: ["text", "text", "text", "text"], privacy: undefined }, "rule form attributes");
      for (const re of [/not an encrypted password vault/i, /unencrypted/i, /primary password/i, /(not|never) synced/i, /never (sent|sends)/i, /all websites/i]) {
        ok(re.test(form.privacy), `#privacy notice mentions ${re}`, form.privacy.slice(0, 200));
      }
    },
  },

  {
    name: "T18 privacy (whole run): no log entry, browser-console message or Firefox form-history entry contains any test value",
    phase: "final",
    timeoutMs: 60000,
    async fn(h) {
      // Exercise the UI and a fill here too, so this check is meaningful when run on its own.
      const value = h.v("FINAL-PRIVACY-TEST");
      await h.addRuleViaUI({ origin: h.A, selector: "#text", value });
      await h.expectFilled(`${h.A}/basic.html`, "#text", value);
      await h.openOptions({ reload: true }); // navigating away from a filled-in form can trigger form-history capture
      await sleep(500);

      // Controls: prove that each capture path works in this profile, so finding no test value means something.
      const page = await h.openPage(`${h.A}/control.html`);
      await h.evalIn(page, () => {
        console.log("LOG-PIPELINE-CONTROL");
        setTimeout(() => { throw new Error("CONSOLE-PIPELINE-CONTROL"); }, 0);
      });
      await h.typeText(page, "#ctl", "FORMHISTORY-CONTROL");
      await h.pressKeys(page, [""]); // a real Enter submits the form
      await h.waitFor("chrome", async () => {
        const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");
        return (await FormHistory.count({ fieldname: "ctl", value: "FORMHISTORY-CONTROL" })) > 0;
      }, 8000).catch(() => { throw new Error("control: a normal form submission was not recorded in form history, so the form-history check would be meaningless"); });
      const deadline = Date.now() + 5000;
      while (!h.logs.some((l) => l.text.includes("LOG-PIPELINE-CONTROL")) && Date.now() < deadline) await sleep(50);
      ok(h.logs.some((l) => l.text.includes("LOG-PIPELINE-CONTROL")), "control: log.entryAdded captures page console output");
      await h.drainConsole();
      ok(h.consoleMessages.some((m) => (m.text || "").includes("CONSOLE-PIPELINE-CONTROL")), "control: Services.console captures page errors");

      const values = [...h.testValues];
      const logHits = h.logs.filter((l) => values.some((v) => l.text.includes(v) || l.args.includes(v)));
      eq(logHits.map((l) => `${l.test}: ${l.text.slice(0, 80)}`), [], "log.entryAdded entries containing a test value");
      const consoleHits = h.consoleMessages.filter((m) => values.some((v) => (m.text || "").includes(v)));
      eq(consoleHits.map((m) => `${m.test}: ${(m.text || "").slice(0, 80)}`), [], "Services.console messages containing a test value");
      const fh = await h.chrome(async (vals) => {
        const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");
        const counts = {};
        for (const v of vals) counts[v] = await FormHistory.count({ value: v });
        const all = await FormHistory.search(["fieldname", "value"], {});
        return { counts, total: all.length, matching: all.filter((e) => vals.some((v) => String(e.value).includes(v))).length };
      }, values);
      eq(Object.entries(fh.counts).filter(([, n]) => n > 0), [], "form history entries for saved values");
      eq(fh.matching, 0, "form history entries containing a test value");
      const logins = await h.chrome(async () => (await Services.logins.getAllLogins()).length);
      eq(logins, 0, "saved logins");
      h.info(`checked ${values.length} test values against ${h.logs.length} log entries, ${h.consoleMessages.length} console messages, ${fh.total} form-history entries`);
      ok(OPTIONS_URL, "done");
    },
  },
];
