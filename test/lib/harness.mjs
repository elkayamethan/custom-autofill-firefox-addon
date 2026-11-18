// End-to-end harness: one headless Firefox (throwaway profile) driven over WebDriver BiDi,
// the extension installed temporarily, a local HTTPS server, and helpers for the tests.
// Everything here is derived from the spec (docs/superpowers/specs/2026-11-18-custom-autofill-design.md).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BiDi, launchFirefox } from "./bidi.mjs";

export const EXT_ID = "custom-autofill@96717d3ecdad";
export const EXT_UUID = "0b7c5e1a-3d2f-4c6b-9e8a-5f4d3c2b1a09"; // pinned through extensions.webextensions.uuids
export const EXT_BASE = `moz-extension://${EXT_UUID}/`;
export const OPTIONS_URL = `${EXT_BASE}options.html`;
export const SCRIPT_ID = "autofill";
export const SAVED_MSG = "Saved. Reload open tabs of that site to apply it.";
export const MASK = "••••••••";
export const IDN_HOST = "xn--bcher-kva.example"; // bücher.example
export const ALT_HOST = "portal.example.test";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hostPattern = (origin) => `https://${new URL(origin).hostname}/*`;

export class SkipError extends Error {}
export function skip(reason) { throw new SkipError(reason); }

const fmt = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
/** Deep strict equality with a readable failure message. */
export function eq(actual, expected, what) {
  try { assert.deepStrictEqual(actual, expected); } catch {
    throw new Error(`${what}: expected ${fmt(expected)}, got ${fmt(actual)}`);
  }
}
export function ok(cond, what, detail) {
  if (!cond) throw new Error(detail === undefined ? what : `${what}: ${fmt(detail)}`);
}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The subset of a registered content script that the spec (§5.5) fixes. */
export const pickReg = (r) => ({ id: r.id, js: r.js, matches: r.matches, allFrames: r.allFrames, runAt: r.runAt, persistAcrossSessions: r.persistAcrossSessions });
export const TEXT_EVENTS = ["input:InputEvent:insertReplacementText:bubbles:composed", "change:Event:bubbles"];
export const SELECT_EVENTS = ["input:Event:bubbles:composed", "change:Event:bubbles"];

export const BASE_PREFS = {
  "extensions.webextOptionalPermissionPrompts": false,
  "extensions.webextensions.uuids": JSON.stringify({ [EXT_ID]: EXT_UUID }),
  "extensions.webextensions.keepUuidOnUninstall": true,
  // Extra loopback names for the "site typed in any form" test (IDN and mixed case).
  "network.dns.localDomains": `${ALT_HOST},${IDN_HOST}`,
  // Finer performance.now() for the perf report.
  "privacy.reduceTimerPrecision": false,
  // Event pages unload after 3 s idle instead of 30 s, so "the background stays asleep" is testable quickly.
  "extensions.background.idle.timeout": 3000,
  "browser.tabs.warnOnClose": false,
  "browser.shell.checkDefaultBrowser": false,
};

/**
 * Test-only instrumentation, loaded as a process script into every child process (web content,
 * extension, preallocated) of the throwaway profile. It runs in a privileged scope there and:
 *  - wraps ExtensionStorageLocalIDB.prototype.get, the per-process IndexedDB backend that a content
 *    script's browser.storage.local.get() ends up in (Firefox opens the add-on's database directly in
 *    the content process), and reports the requested keys;
 *  - listens to ConsoleAPIStorage, which records every console.* call of pages, content scripts and
 *    extension pages in that process, and reports the logged arguments as strings.
 * Reports go to the parent as messages (see Harness.installProcessSpy). This must be self-contained:
 * it is serialized with toString().
 */
function processSpyScript() {
  if (globalThis.__cafSpyLoaded) return;
  globalThis.__cafSpyLoaded = true;
  // Read at send time: a preallocated process takes on a site's remote type when it is used.
  const send = (name, data) => {
    try { Services.cpmm.sendAsyncMessage(name, { ...data, remoteType: String(Services.appinfo.remoteType || "parent") }); } catch {}
  };
  const str = (a) => {
    try {
      const s = typeof a === "string" ? a : JSON.stringify(a);
      return String(s === undefined ? a : s).slice(0, 4000);
    } catch {
      try { return String(a).slice(0, 4000); } catch { return "(unprintable)"; }
    }
  };
  try {
    const { ExtensionStorageLocalIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
    const proto = ExtensionStorageLocalIDB.prototype;
    const original = proto.get;
    proto.get = function (keys) {
      let req;
      try { req = keys === undefined ? { kind: "undefined" } : { kind: "json", keys: JSON.parse(JSON.stringify(keys)) }; } catch { req = { kind: "unserializable" }; }
      send("caf-test:storage-get", { ...req, t: Date.now() });
      return original.call(this, keys);
    };
  } catch (e) { send("caf-test:spy-error", { where: "storage", message: String(e) }); }
  try {
    const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);
    storage.addLogEventListener((ev) => {
      let args = [];
      try { args = Array.from(ev.arguments ?? [], str); } catch {}
      send("caf-test:console-api", { level: String(ev.level ?? ""), args, addonId: String(ev.addonId ?? ""), filename: String(ev.filename ?? "") });
    }, Services.scriptSecurityManager.getSystemPrincipal());
  } catch (e) { send("caf-test:spy-error", { where: "console", message: String(e) }); }
  send("caf-test:spy-ready", {});
}

export async function startFirefox({ tmpRoot, server, prefs = {} }) {
  const ff = await launchFirefox({ baseDir: tmpRoot, prefs: { ...BASE_PREFS, ...prefs }, systemAccess: true });
  let bidi;
  try {
    bidi = await BiDi.connect(ff.wsUrl + "/session");
    const caps = { acceptInsecureCerts: true, unhandledPromptBehavior: { default: "ignore" } };
    await bidi.send("session.new", { capabilities: { alwaysMatch: caps } });
  } catch (e) {
    bidi?.close();
    await ff.kill();
    throw e;
  }
  const h = new Harness({ ff, bidi, tmpRoot, server });
  await h.init();
  return h;
}

export class Harness {
  constructor({ ff, bidi, tmpRoot, server }) {
    this.ff = ff;
    this.bidi = bidi;
    this.tmpRoot = tmpRoot;
    this.server = server;
    this.A = `https://localhost:${server.portA}`;
    this.B = `https://localhost:${server.portB}`;
    this.IPA = `https://127.0.0.1:${server.portA}`;
    this.IPB = `https://127.0.0.1:${server.portB}`;
    this.logs = [];            // every log.entryAdded of the whole run
    this.consoleMessages = []; // everything drained from Services.console during the run
    this.prompts = [];         // user prompts (confirm/alert) seen
    this.promptAccept = true;
    this.testValues = new Set();
    this.currentTest = "(setup)";
    this.infoLines = [];
    this.optCtx = null;
    this.pageCtx = null;
    this._chrome = null;
    this.extDir = null;
    this.installSnapshot = null;
  }

  async init() {
    this.bidi.onEvent((m) => {
      if (m.method === "log.entryAdded") {
        const p = m.params;
        let args = "";
        try { args = JSON.stringify(p.args ?? []); } catch {}
        this.logs.push({ test: this.currentTest, type: p.type, level: p.level, text: String(p.text ?? ""), args, source: p.source?.context ?? null });
      } else if (m.method === "browsingContext.userPromptOpened") {
        // Web pages only: BiDi cannot close dialogs of moz-extension tabs (clickWithConfirm handles those).
        if (m.params.context === this.optCtx) return;
        const accept = this.promptAccept;
        this.prompts.push({ test: this.currentTest, type: m.params.type, message: m.params.message, accepted: accept });
        this.bidi.send("browsingContext.handleUserPrompt", { context: m.params.context, accept }).catch(() => {});
      }
    });
    await this.bidi.send("session.subscribe", { events: ["log.entryAdded", "browsingContext.userPromptOpened"] });
    const ctxs = await this.tabs();
    this.pageCtx = ctxs[0]?.context ?? (await this.bidi.send("browsingContext.create", { type: "tab" })).context;
  }

  // ---------- bookkeeping ----------
  v(value) { this.testValues.add(value); return value; }
  info(line) { this.infoLines.push(line); }

  // ---------- contexts ----------
  async tabs() {
    const tree = await this.bidi.send("browsingContext.getTree", { maxDepth: 0 });
    return tree.contexts;
  }
  async frames(ctx) {
    const tree = await this.bidi.send("browsingContext.getTree", { root: ctx });
    const out = [];
    const walk = (c) => { for (const ch of c.children ?? []) { out.push({ context: ch.context, url: ch.url }); walk(ch); } };
    for (const c of tree.contexts) walk(c);
    return out;
  }
  /**
   * Bring a tab to the foreground. browsingContext.activate refuses privileged contexts
   * (moz-extension pages, about:home), and input.performActions hangs on background tabs,
   * so select the tab from chrome scope via the remote agent's own id mapping.
   */
  async activate(ctx) {
    const res = await this.chrome((id) => {
      const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
      const browser = NavigableManager.getBrowserById(id);
      if (!browser) return { ok: false };
      const gb = browser.ownerDocument?.defaultView?.gBrowser ?? gBrowser;
      const tab = gb.getTabForBrowser(browser);
      if (!tab) return { ok: false };
      const switched = gb.selectedTab !== tab;
      if (switched) gb.selectedTab = tab;
      return { ok: gb.selectedBrowser === browser, switched };
    }, ctx);
    if (!res.ok) throw new Error(`activate: no tab for context ${ctx}`);
    if (res.switched) {
      // A tab that was just brought forward can drop synthesized input until it has painted.
      await this.waitFor(ctx, () => document.visibilityState === "visible" &&
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))), 3000).catch(() => {});
    }
  }
  async ensurePageCtx() {
    const ids = (await this.tabs()).map((c) => c.context);
    if (!this.pageCtx || !ids.includes(this.pageCtx)) {
      this.pageCtx = (await this.bidi.send("browsingContext.create", { type: "tab" })).context;
    }
    return this.pageCtx;
  }

  // ---------- script evaluation ----------
  /** Run fn(...args) inside the context's realm. fn must be self-contained; args/result are JSON. */
  async evalIn(ctx, fn, ...args) {
    if (ctx === "chrome") ctx = await this.chromeCtx();
    const src = typeof fn === "function" ? fn.toString() : `() => (${fn})`;
    const expression = `(async () => { const __r = await (${src})(...${JSON.stringify(args)}); return __r === undefined ? "__undefined__" : JSON.stringify(__r); })()`;
    const res = await this.bidi.send("script.evaluate", { expression, target: { context: ctx }, awaitPromise: true, resultOwnership: "none" });
    if (res.type === "exception") throw new Error(`evalIn: ${res.exceptionDetails?.text}`);
    const r = res.result;
    if (r.type !== "string") throw new Error(`evalIn: unexpected result type ${r.type}`);
    return r.value === "__undefined__" ? undefined : JSON.parse(r.value);
  }

  /** Poll fn in ctx until it returns a truthy value; returns that value. */
  async waitFor(ctx, fn, timeoutMs = 5000, ...args) {
    const deadline = Date.now() + timeoutMs;
    let last, lastErr;
    for (;;) {
      try {
        last = await this.evalIn(ctx, fn, ...args);
        lastErr = null;
        if (last) return last;
      } catch (e) { lastErr = e; }
      if (Date.now() > deadline) {
        const what = (typeof fn === "function" ? fn.toString() : String(fn)).replace(/\s+/g, " ").slice(0, 160);
        throw new Error(`waitFor timed out after ${timeoutMs} ms: ${what} | last=${JSON.stringify(last)}${lastErr ? " | error=" + lastErr.message : ""}`);
      }
      await sleep(50);
    }
  }

  async chromeCtx() {
    if (this._chrome) {
      const ok = await this.bidi.send("browsingContext.getTree", { "moz:scope": "chrome" }).then((t) => t.contexts.some((c) => c.context === this._chrome), () => false);
      if (ok) return this._chrome;
    }
    const tree = await this.bidi.send("browsingContext.getTree", { "moz:scope": "chrome" });
    const win = tree.contexts.find((c) => c.url === "chrome://browser/content/browser.xhtml") ?? tree.contexts[0];
    if (!win) throw new Error("no chrome context (is MOZ_REMOTE_ALLOW_SYSTEM_ACCESS set?)");
    this._chrome = win.context;
    return this._chrome;
  }
  /** Privileged script in the browser window (needs MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1). */
  async chrome(fn, ...args) { return this.evalIn("chrome", fn, ...args); }

  // ---------- real input ----------
  async elementRef(ctx, selector) {
    const r = await this.bidi.send("script.evaluate", {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollIntoView({ block: "center", inline: "center" }); return el; })()`,
      target: { context: ctx }, awaitPromise: false, resultOwnership: "none",
    });
    if (r.type === "exception") throw new Error(`element lookup ${selector}: ${r.exceptionDetails?.text}`);
    if (r.result.type !== "node") throw new Error(`no element matches ${selector}`);
    return r.result.sharedId;
  }

  /**
   * Trusted click via input.performActions (the only input that passes permissions.request's gate).
   * Verifies that a trusted click reached the element; if no click reached the page at all
   * (input dropped by the browser), it retries once and records the retry.
   */
  async realClick(ctx, selector, { count = 1 } = {}) {
    await this.activate(ctx);
    for (let attempt = 1; ; attempt++) {
      const sharedId = await this.elementRef(ctx, selector);
      await this.evalIn(ctx, (sel) => {
        const w = window;
        w.__hClick = { target: document.querySelector(sel), onTarget: 0, any: 0 };
        if (!w.__hClickHook) {
          w.__hClickHook = true;
          w.addEventListener("click", (e) => {
            if (!e.isTrusted || !w.__hClick) return;
            w.__hClick.any++;
            const t = w.__hClick.target;
            if (t && (e.target === t || t.contains(e.target))) w.__hClick.onTarget++;
          }, true);
        }
      }, selector);
      const actions = [{ type: "pointerMove", x: 0, y: 0, duration: 0, origin: { type: "element", element: { sharedId } } }];
      for (let i = 0; i < count; i++) actions.push({ type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 });
      await this.bidi.send("input.performActions", { context: ctx, actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });
      await this.bidi.send("input.releaseActions", { context: ctx });
      const got = await this.evalIn(ctx, () => ({ onTarget: window.__hClick.onTarget, any: window.__hClick.any, disabled: !!window.__hClick.target?.disabled }));
      if (got.onTarget > 0) return;
      if (got.any > 0) throw new Error(`realClick(${selector}): the click hit another element`);
      if (got.disabled) throw new Error(`realClick(${selector}): the element is disabled, so the click did nothing`);
      if (attempt >= 2) throw new Error(`realClick(${selector}): the click never reached the page (2 attempts)`);
      this.clickRetries = (this.clickRetries || 0) + 1;
      this.info(`note: a click on ${selector} was dropped by the browser and retried`);
      await sleep(150);
    }
  }

  /** Trusted key presses (values are WebDriver key values, e.g. "" for Enter). */
  async pressKeys(ctx, keys) {
    await this.activate(ctx);
    const actions = [];
    for (const k of keys) actions.push({ type: "keyDown", value: k }, { type: "keyUp", value: k });
    await this.bidi.send("input.performActions", { context: ctx, actions: [{ type: "key", id: "kbd", actions }] });
    await this.bidi.send("input.releaseActions", { context: ctx });
  }

  /** Click the field, select its content, and type text with real key events (replacing the content). */
  async typeText(ctx, selector, text) {
    await this.realClick(ctx, selector);
    const hadValue = await this.evalIn(ctx, (sel) => {
      const el = document.querySelector(sel);
      el.focus();
      el.select();
      return el.value.length > 0;
    }, selector);
    const keys = [];
    if (hadValue) keys.push(""); // Backspace removes the selection
    for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) keys.push(segment);
    if (keys.length) await this.pressKeys(ctx, keys);
    const got = await this.evalIn(ctx, (sel) => document.querySelector(sel).value, selector);
    if (got !== text) throw new Error(`typeText(${selector}): the field does not hold the typed text (got ${got.length} chars, wanted ${text.length})`);
  }

  /**
   * Real click on an element whose handler opens a tab-modal confirm() in an extension page.
   * The click does not complete until the dialog closes, so answer it from chrome scope.
   * Returns the dialog text.
   */
  async clickWithConfirm(ctx, selector, accept) {
    const click = this.realClick(ctx, selector);
    click.catch(() => {});
    let text;
    try {
      text = await this.waitFor("chrome", (id, accept) => {
        const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
        const b = NavigableManager.getBrowserById(id);
        if (!b) return null;
        const box = gBrowser.getTabDialogBox(b);
        for (const mgr of [box.getContentDialogManager(), box.getTabDialogManager()]) {
          for (const d of mgr._dialogs) {
            const w = d.frameContentWindow;
            const dlg = w?.document?.querySelector("dialog");
            if (!dlg || !w.Dialog?.args) continue;
            const t = String(w.Dialog.args.text ?? "");
            if (accept) dlg.acceptDialog(); else dlg.cancelDialog();
            return { text: t };
          }
        }
        return null;
      }, 5000, ctx, accept);
    } finally {
      await Promise.race([click, sleep(5000)]);
    }
    return text.text;
  }

  /** Cancel every open tab-modal dialog (cleanup after a failed test). */
  async dismissDialogs() {
    return this.chrome(() => {
      let n = 0;
      for (const b of gBrowser.browsers) {
        const box = gBrowser.getTabDialogBox(b);
        for (const mgr of [box.getContentDialogManager(), box.getTabDialogManager()]) {
          for (const d of [...mgr._dialogs]) {
            const dlg = d.frameContentWindow?.document?.querySelector("dialog");
            if (dlg) { dlg.cancelDialog(); n++; }
          }
        }
      }
      return n;
    });
  }

  /** The real optional-permission doorhanger (only when extensions.webextOptionalPermissionPrompts is true). */
  async waitPermissionPrompt(timeoutMs = 5000) {
    return this.waitFor("chrome", () => {
      for (const b of gBrowser.browsers) {
        const n = PopupNotifications.getNotification("addon-webext-permissions", b);
        if (!n) continue;
        let msgs = null;
        try { msgs = [...(n.options?.customElementOptions?.strings?.msgs ?? [])].map(String); } catch {}
        return { message: String(n.message ?? ""), msgs, accept: n.mainAction?.label ?? null, deny: (n.secondaryActions || []).map((a) => a.label) };
      }
      return null;
    }, timeoutMs);
  }

  async answerPermissionPrompt(accept) {
    return this.chrome((accept) => {
      const el = PopupNotifications.panel.querySelector("#addon-webext-permissions-notification");
      if (el && (accept ? el.button : el.secondaryButton)) {
        (accept ? el.button : el.secondaryButton).click();
        return "clicked";
      }
      for (const b of gBrowser.browsers) {
        const n = PopupNotifications.getNotification("addon-webext-permissions", b);
        if (!n) continue;
        if (accept) n.mainAction.callback(); else n.secondaryActions[0].callback();
        n.remove();
        return "callback";
      }
      return "none";
    }, accept);
  }

  async setCheckbox(ctx, selector, checked) {
    const cur = await this.evalIn(ctx, (sel) => document.querySelector(sel).checked, selector);
    if (cur !== checked) await this.realClick(ctx, selector);
    const now = await this.evalIn(ctx, (sel) => document.querySelector(sel).checked, selector);
    if (now !== checked) throw new Error(`setCheckbox(${selector}) failed`);
  }

  // ---------- pages ----------
  async openPage(url, { wait = "complete" } = {}) {
    const ctx = await this.ensurePageCtx();
    await this.activate(ctx); // foreground: background tabs clamp timers to >= 1 s
    await this.bidi.send("browsingContext.navigate", { context: ctx, url, wait });
    return ctx;
  }

  /** Load url and wait until selector's value equals value. */
  async expectFilled(url, selector, value, timeoutMs = 5000) {
    const ctx = await this.openPage(url);
    try {
      await this.waitFor(ctx, (s, v) => document.querySelector(s)?.value === v, timeoutMs, selector, value);
    } catch {
      const got = await this.evalIn(ctx, (s) => document.querySelector(s)?.value ?? null, selector).catch(() => "?");
      throw new Error(`${url} ${selector}: expected it to be filled (${value.length} chars), field holds ${JSON.stringify(got)}`);
    }
    return ctx;
  }

  /** Load url, wait for the page to settle, and return { selector: value } for each selector. */
  async valuesAfterSettle(url, selectors) {
    const ctx = await this.openPage(url);
    await this.settle(ctx);
    return this.evalIn(ctx, (sels) => Object.fromEntries(sels.map((s) => [s, document.querySelector(s)?.value ?? null])), selectors);
  }

  /** Resolve once the document had no DOM mutation for quietMs (negative assertions use this). */
  async settle(ctx, quietMs = 700, maxMs = 10000) {
    return this.evalIn(ctx, (quiet, max) => new Promise((resolve) => {
      const start = performance.now();
      let last = start;
      const mo = new MutationObserver(() => { last = performance.now(); });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const tick = () => {
        const now = performance.now();
        if (now - last >= quiet || now - start > max) { mo.disconnect(); resolve(Math.round(now - start)); } else setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    }), quietMs, maxMs);
  }

  // ---------- options page ----------
  async openOptions({ reload = false, activate = true } = {}) {
    let tabs = await this.tabs();
    if (!this.optCtx || !tabs.some((c) => c.context === this.optCtx)) {
      const existing = tabs.find((c) => c.url.startsWith(OPTIONS_URL) && c.context !== this.pageCtx);
      if (existing) this.optCtx = existing.context;
      else {
        this.optCtx = (await this.bidi.send("browsingContext.create", { type: "tab", background: true })).context;
        reload = true;
      }
      tabs = await this.tabs();
    }
    const cur = tabs.find((c) => c.context === this.optCtx);
    if (reload || !cur || !cur.url.startsWith(OPTIONS_URL)) {
      await this.bidi.send("browsingContext.navigate", { context: this.optCtx, url: OPTIONS_URL, wait: "complete" });
      await this.waitFor(this.optCtx, () => document.readyState === "complete" && !!document.querySelector("form#rule-form"), 5000);
    }
    if (activate) await this.activate(this.optCtx);
    return this.optCtx;
  }

  /** Snapshot of the options page (spec §5.7 element contract). */
  async uiState() {
    const ctx = await this.openOptions({ activate: false });
    return this.evalIn(ctx, () => {
      const q = (s) => document.querySelector(s);
      const textNoButtons = (td) => td ? [...td.childNodes].filter((n) => !(n.nodeType === 1 && n.matches("button, button *"))).map((n) => n.textContent).join("").trim() : null;
      const rows = [...document.querySelectorAll("#rules tbody tr[data-origin][data-id]")].map((tr) => ({
        origin: tr.dataset.origin,
        id: tr.dataset.id,
        enabled: tr.querySelector("input.toggle")?.checked ?? null,
        originText: textNoButtons(tr.querySelector("td.origin")),
        grant: !!tr.querySelector("td.origin button.grant"),
        grantText: tr.querySelector("td.origin button.grant")?.textContent.trim() ?? null,
        path: tr.querySelector("td.path")?.textContent.trim() ?? null,
        selector: tr.querySelector("td.selector")?.textContent.trim() ?? null,
        value: tr.querySelector("td.value")?.textContent.trim() ?? null,
        overwrite: tr.querySelector("td.overwrite")?.textContent.trim() ?? null,
        edit: !!tr.querySelector("button.edit"),
        del: !!tr.querySelector("button.delete"),
      }));
      const vis = (s) => { const el = q(s); return el ? el.checkVisibility() : null; };
      return {
        rows,
        emptyVisible: vis("#empty"),
        msg: q("#msg")?.textContent.trim() ?? null,
        msgError: q("#msg")?.classList.contains("error") ?? null,
        formTitle: q("#form-title")?.textContent.trim() ?? null,
        saveText: q("#save")?.textContent.trim() ?? null,
        saveDisabled: q("#save")?.disabled ?? null,
        cancelVisible: vis("#cancel"),
        fields: {
          origin: q("#origin")?.value, path: q("#path")?.value, selector: q("#selector")?.value,
          value: q("#value")?.value, overwrite: q("#overwrite")?.checked, enabled: q("#enabled")?.checked,
        },
        valueMasked: q("#value")?.classList.contains("masked") ?? null,
        valueTextSecurity: q("#value") ? getComputedStyle(q("#value")).getPropertyValue("-webkit-text-security") : null,
        showValues: q("#show-values")?.checked ?? null,
      };
    });
  }

  rowSel(origin, id) { return `#rules tbody tr[data-origin="${origin}"][data-id="${id}"]`; }

  async clearMsg(ctx) {
    await this.evalIn(ctx, () => { const m = document.querySelector("#msg"); if (m) { m.textContent = ""; m.classList.remove("error"); } });
  }

  async waitMsg(ctx, timeoutMs = 8000) {
    try {
      return await this.waitFor(ctx, (SAVED) => {
        const m = document.querySelector("#msg");
        if (!m) return null;
        const text = m.textContent.trim();
        if (m.classList.contains("error") && text) return { ok: false, text };
        if (text === SAVED) return { ok: true, text };
        return null;
      }, timeoutMs, SAVED_MSG);
    } catch (e) {
      const ui = await this.uiState().catch((x) => ({ error: x.message }));
      const st = await this.extState().catch((x) => ({ error: x.message }));
      const fields = ui.fields ? { ...ui.fields, value: ui.fields.value ? `(${ui.fields.value.length} chars)` : "" } : null;
      throw new Error(`no save result in #msg after ${timeoutMs} ms; msg=${JSON.stringify(ui.msg)} saveDisabled=${ui.saveDisabled} title=${JSON.stringify(ui.formTitle)} fields=${JSON.stringify(fields)} rows=${ui.rows?.length} storedRules=${Object.values(st.storage ?? {}).flat().length}`);
    }
  }

  /** Fill the rule form with real clicks and keys. Does not submit. */
  async fillRuleForm({ origin, path = "", selector, value, overwrite = false, enabled = true }) {
    const ctx = await this.openOptions();
    await this.typeText(ctx, "#origin", origin);
    await this.typeText(ctx, "#path", path);
    await this.typeText(ctx, "#selector", selector);
    await this.typeText(ctx, "#value", value);
    await this.setCheckbox(ctx, "#overwrite", overwrite);
    await this.setCheckbox(ctx, "#enabled", enabled);
    return ctx;
  }

  async submitRuleForm(ctx, how = "click") {
    if (how === "click") await this.realClick(ctx, "#save");
    else if (how === "dblclick") await this.realClick(ctx, "#save", { count: 2 });
    else if (how === "enter") { await this.realClick(ctx, "#selector"); await this.pressKeys(ctx, [""]); }
    else if (how === "enter2") { await this.realClick(ctx, "#selector"); await this.pressKeys(ctx, ["", ""]); }
    else throw new Error("unknown submit mode " + how);
  }

  /**
   * Add a rule through the real options UI. expect: "saved" | "error" | "none".
   * Returns { ok, text } from #msg (or null for "none").
   */
  async addRuleViaUI(rule, { expect = "saved", submit = "click" } = {}) {
    if (rule.value) this.v(rule.value);
    const ctx = await this.fillRuleForm(rule);
    await this.clearMsg(ctx);
    await this.submitRuleForm(ctx, submit);
    if (expect === "none") return null;
    const res = await this.waitMsg(ctx);
    if (expect === "saved" && !res.ok) throw new Error(`addRuleViaUI: expected the rule to be saved, got error: ${res.text}`);
    if (expect === "error" && res.ok) throw new Error(`addRuleViaUI: expected a validation error, but it saved`);
    return res;
  }

  /** Click Edit on a row, change fields with real input, save. */
  async editRuleViaUI(origin, id, changes, { expect = "saved" } = {}) {
    const ctx = await this.openOptions();
    await this.realClick(ctx, `${this.rowSel(origin, id)} button.edit`);
    await this.waitFor(ctx, () => document.querySelector("#form-title")?.textContent.trim() === "Edit rule", 3000);
    if (changes.origin !== undefined) await this.typeText(ctx, "#origin", changes.origin);
    if (changes.path !== undefined) await this.typeText(ctx, "#path", changes.path);
    if (changes.selector !== undefined) await this.typeText(ctx, "#selector", changes.selector);
    if (changes.value !== undefined) { this.v(changes.value); await this.typeText(ctx, "#value", changes.value); }
    if (changes.overwrite !== undefined) await this.setCheckbox(ctx, "#overwrite", changes.overwrite);
    if (changes.enabled !== undefined) await this.setCheckbox(ctx, "#enabled", changes.enabled);
    await this.clearMsg(ctx);
    await this.realClick(ctx, "#save");
    const res = await this.waitMsg(ctx);
    if (expect === "saved" && !res.ok) throw new Error(`editRuleViaUI: expected save, got error: ${res.text}`);
    return res;
  }

  // ---------- extension state ----------
  async extState() {
    const ctx = await this.openOptions({ activate: false });
    return this.evalIn(ctx, async () => ({
      storage: await browser.storage.local.get(null),
      origins: (await browser.permissions.getAll()).origins,
      registered: await browser.scripting.getRegisteredContentScripts(),
    }));
  }
  async contains(pattern) {
    const ctx = await this.openOptions({ activate: false });
    return this.evalIn(ctx, (p) => browser.permissions.contains({ origins: [p] }), pattern);
  }

  /** Storage write in the options realm + origin grant from chrome scope + syncRegistration(). */
  async seedRules(map, { grant = true, sync = true } = {}) {
    const full = {};
    for (const [origin, rules] of Object.entries(map)) {
      full[origin] = rules.map((r) => {
        if (r.value && r.value.length >= 4) this.v(r.value);
        return { id: randomUUID(), path: "", selector: "", value: "", enabled: true, overwrite: false, ...r };
      });
    }
    const ctx = await this.openOptions({ activate: false });
    await this.evalIn(ctx, async (m) => { await browser.storage.local.set(m); }, full);
    if (grant) await this.grantOrigins([...new Set(Object.keys(full).map(hostPattern))]);
    if (sync) await this.evalIn(ctx, async () => { await syncRegistration(); });
    return full;
  }

  async grantOrigins(origins) {
    return this.chrome(async (id, origins) => {
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      const policy = WebExtensionPolicy.getByID(id);
      await ExtensionPermissions.add(id, { permissions: [], origins }, policy.extension);
      return policy.allowedOrigins.patterns.map((p) => p.pattern);
    }, EXT_ID, origins);
  }

  /** Same call path as the about:addons per-site toggle. */
  async revokeOrigins(origins) {
    return this.chrome(async (id, origins) => {
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      const policy = WebExtensionPolicy.getByID(id);
      await ExtensionPermissions.remove(id, { permissions: [], origins }, policy.extension);
      return policy.allowedOrigins.patterns.map((p) => p.pattern);
    }, EXT_ID, origins);
  }

  /** The live content scripts of the extension's policy (what Firefox actually matches against). */
  async policyScripts() {
    return this.chrome((id) => {
      const policy = WebExtensionPolicy.getByID(id);
      if (!policy) return null;
      return policy.contentScripts.map((s) => ({
        matches: s.matches.patterns.map((p) => p.pattern),
        allFrames: s.allFrames,
        runAt: s.runAt,
        jsPaths: s.jsPaths,
      }));
    }, EXT_ID);
  }

  /** For each registered content script: would Firefox inject it into url (pattern + permission)? */
  async matchesURI(url) {
    return this.chrome((id, url) => {
      const policy = WebExtensionPolicy.getByID(id);
      if (!policy) return null;
      const uri = Services.io.newURI(url);
      return policy.contentScripts.map((s) => s.matchesURI(uri));
    }, EXT_ID, url);
  }

  async setPref(name, value) {
    return this.chrome((name, value) => {
      if (typeof value === "boolean") Services.prefs.setBoolPref(name, value);
      else if (typeof value === "number") Services.prefs.setIntPref(name, value);
      else Services.prefs.setStringPref(name, value);
      return true;
    }, name, value);
  }

  /** Move everything from Services.console into this.consoleMessages and return what was new. */
  async drainConsole() {
    const msgs = await this.chrome(() => {
      const out = (Services.console.getMessageArray() || []).map((m) => {
        if (m instanceof Ci.nsIScriptError) return { kind: "error", warning: !!(m.flags & Ci.nsIScriptError.warningFlag), text: String(m.errorMessage), source: String(m.sourceName || ""), category: String(m.category || "") };
        return { kind: "message", text: String(m.message) };
      });
      Services.console.reset();
      return out;
    });
    for (const m of msgs) m.test = this.currentTest;
    this.consoleMessages.push(...msgs);
    return msgs;
  }

  // ---------- content-process spy (see processSpyScript) ----------
  /** Load the spy into every current and future child process. Records live in the chrome window. */
  async installProcessSpy() {
    const url = "data:application/javascript;charset=utf-8," + encodeURIComponent(`(${processSpyScript.toString()})();`);
    this.spyUrl = url;
    await this.chrome((url) => {
      if (window.__cafSpy) return true;
      const s = (window.__cafSpy = { gets: [], consoleApi: [], ready: [], errors: [], listeners: {} });
      s.listeners = {
        "caf-test:storage-get": (m) => s.gets.push(m.data),
        "caf-test:console-api": (m) => s.consoleApi.push(m.data),
        "caf-test:spy-ready": (m) => s.ready.push(m.data),
        "caf-test:spy-error": (m) => s.errors.push(m.data),
      };
      for (const [name, fn] of Object.entries(s.listeners)) Services.ppmm.addMessageListener(name, fn);
      Services.ppmm.loadProcessScript(url, true);
      return true;
    }, url);
    // At least the extension or a preallocated process must report in, or the spy is not working.
    const ready = await this.waitFor("chrome", () => window.__cafSpy.ready.length > 0 && window.__cafSpy.ready, 5000);
    const errors = await this.chrome(() => window.__cafSpy.errors);
    if (errors.length) throw new Error("process spy errors: " + JSON.stringify(errors));
    this.spyReady = ready;
    return ready;
  }
  /** storage.local.get() calls made outside the extension process (i.e. by content scripts). */
  async spyGets({ clear = false } = {}) {
    return this.chrome((clear) => {
      const s = window.__cafSpy;
      if (!s) throw new Error("process spy not installed");
      const out = s.gets.filter((g) => g.remoteType !== "extension");
      if (clear) s.gets.length = 0;
      return out;
    }, clear);
  }
  async spyConsoleApi() {
    return this.chrome(() => {
      const s = window.__cafSpy;
      if (!s) throw new Error("process spy not installed");
      return { messages: s.consoleApi, errors: s.errors };
    });
  }

  // ---------- extension install ----------
  /** Temporary install from a directory. Returns { id, optionsTab } (optionsTab = tab opened by the add-on itself). */
  async installExtension(dir, { waitForOptionsMs = 0 } = {}) {
    // Tabs already showing the options page before the install do not count as "opened by the add-on".
    const before = new Set((await this.tabs()).filter((c) => c.url.startsWith(OPTIONS_URL)).map((c) => c.context));
    const r = await this.bidi.send("webExtension.install", { extensionData: { type: "path", path: dir } });
    this.extDir = dir;
    let optionsTab = null;
    const deadline = Date.now() + waitForOptionsMs;
    while (Date.now() < deadline) {
      // Firefox may open a new tab or reuse a blank one (about:home / about:blank).
      const t = (await this.tabs()).find((c) => !before.has(c.context) && c.url.startsWith(OPTIONS_URL));
      if (t) { optionsTab = t.context; break; }
      await sleep(100);
    }
    if (optionsTab && optionsTab === this.pageCtx) this.pageCtx = null; // a fresh page tab is created on demand
    return { id: r.extension, optionsTab };
  }

  /** Copy the extension to tmpRoot with a different manifest version (upgrade/downgrade simulation). */
  extCopy(srcDir, version) {
    const dir = join(this.tmpRoot, `ext-copy-${version}-${randomUUID().slice(0, 8)}`);
    cpSync(srcDir, dir, { recursive: true });
    const mf = join(dir, "manifest.json");
    const m = JSON.parse(readFileSync(mf, "utf8"));
    m.version = version;
    writeFileSync(mf, JSON.stringify(m, null, 2));
    return dir;
  }

  // ---------- state reset between tests ----------
  async resetState() {
    await this.dismissDialogs().catch(() => {});
    await this.drainConsole().catch(() => {});
    this.promptAccept = true;
    await this.setPref("extensions.webextOptionalPermissionPrompts", false);
    // Close every tab except the page tab and the options tab.
    const tabs = await this.tabs();
    if (!tabs.some((c) => c.context === this.pageCtx)) this.pageCtx = null;
    if (!tabs.some((c) => c.context === this.optCtx)) this.optCtx = null;
    for (const c of tabs) {
      if (c.context === this.pageCtx || c.context === this.optCtx) continue;
      if (!this.optCtx && c.url.startsWith(OPTIONS_URL)) { this.optCtx = c.context; continue; }
      if (!this.pageCtx) { this.pageCtx = c.context; continue; }
      await this.bidi.send("browsingContext.close", { context: c.context }).catch(() => {});
    }
    await this.ensurePageCtx();
    await this.bidi.send("browsingContext.navigate", { context: this.pageCtx, url: "about:blank", wait: "complete" });
    // Wipe extension state from an extension page, then load a fresh options page.
    const ctx = await this.openOptions({ activate: false });
    await this.evalIn(ctx, async () => {
      await browser.storage.local.clear();
      await browser.scripting.unregisterContentScripts();
      const { origins } = await browser.permissions.getAll();
      if (origins.length) await browser.permissions.remove({ origins });
    });
    await this.openOptions({ reload: true, activate: false });
    const st = await this.extState();
    if (Object.keys(st.storage).length || st.origins.length || st.registered.length) {
      // The page's load-time repair may still be running; wait once more.
      await sleep(300);
      const st2 = await this.extState();
      if (Object.keys(st2.storage).length || st2.origins.length || st2.registered.length) {
        throw new Error("resetState: extension state not clean: " + JSON.stringify(st2));
      }
    }
    await this.activate(this.pageCtx);
    await this.drainConsole().catch(() => {});
  }

  async close() {
    try { await this.bidi.send("browser.close", {}, { timeoutMs: 5000 }); } catch {}
    this.bidi.close();
    await this.ff.kill();
  }
}
