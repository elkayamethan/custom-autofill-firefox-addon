// Options page tests (spec §5.4, §5.5, §5.7): T2, T2b, T2c, T3, T3b, T4.
// The UI is driven with real input.performActions clicks and keys.
import {
  ALT_HOST, EXT_ID, IDN_HOST, MASK, SAVED_MSG, UUID_RE, eq, hostPattern, ok, pickReg, sleep,
} from "../lib/harness.mjs";

const LOCAL = "https://localhost/*";
const REG = (matches) => [{ id: "autofill", js: ["content.js"], matches, allFrames: true, runAt: "document_idle", persistAcrossSessions: true }];

export const tests = [
  {
    name: "T2 add rule through the UI: host permission granted, rule stored under the exact origin, registration matches the host pattern",
    async fn(h) {
      const ctx = await h.openOptions();
      let ui = await h.uiState();
      eq(ui.rows, [], "no rows before adding");
      eq(ui.emptyVisible, true, "#empty shown when there are no rules");
      eq({ title: ui.formTitle, save: ui.saveText, cancel: ui.cancelVisible }, { title: "Add a rule", save: "Add rule", cancel: false }, "form starts in add mode");
      eq({ overwrite: ui.fields.overwrite, enabled: ui.fields.enabled, showValues: ui.showValues }, { overwrite: false, enabled: true, showValues: false }, "checkbox defaults");
      eq({ cls: ui.valueMasked, css: ui.valueTextSecurity }, { cls: true, css: "disc" }, "#value masked by default (class masked, -webkit-text-security: disc)");

      const value = h.v("ID-0000-TEST");
      const res = await h.addRuleViaUI({ origin: h.A, selector: "#text", value });
      eq(res.text, SAVED_MSG, "#msg after saving");

      const st = await h.extState();
      eq(Object.keys(st.storage), [h.A], "storage keys");
      const rule = st.storage[h.A][0];
      ok(UUID_RE.test(rule.id), "rule id is a random UUID", rule.id);
      eq(st.storage, { [h.A]: [{ id: rule.id, path: "", selector: "#text", value, enabled: true, overwrite: false }] }, "stored rules");
      eq(st.origins, [LOCAL], "permissions.getAll().origins");
      eq(await h.contains(LOCAL), true, "permissions.contains(https://localhost/*)");
      eq(st.registered.map(pickReg), REG([LOCAL]), "registered content script");

      ui = await h.uiState();
      eq(ui.rows.map(({ originText, grantText, ...r }) => r), [{
        origin: h.A, id: rule.id, enabled: true, grant: false, path: "any", selector: "#text", value: MASK, overwrite: "no", edit: true, del: true,
      }], "table row");
      ok(ui.rows[0].originText.includes(h.A), "origin cell shows the origin", ui.rows[0].originText);
      eq(ui.emptyVisible, false, "#empty hidden once a rule exists");
      eq(ui.msgError, false, "#msg has no error class after a save");
      eq(ui.fields, { origin: "", path: "", selector: "", value: "", overwrite: false, enabled: true }, "form reset after save");
      eq(ui.saveDisabled, false, "#save enabled again after the save");

      const texts = await h.evalIn(ctx, () => ({ title: document.title, h1: document.querySelector("h1")?.textContent.trim() ?? null, body: document.body.innerText }));
      ok(texts.title.includes("Custom Autofill") || texts.h1 === "Custom Autofill", "page title Custom Autofill", { title: texts.title, h1: texts.h1 });
      ok(/Changes apply the next time a matching page loads[.;] reload tabs that were already open\./i.test(texts.body), "reload hint shown (spec §5.7 layout item 4)");
      ok(!texts.body.includes(value), "the value is not displayed while masked");

      await h.expectFilled(`${h.A}/basic.html`, "#text", value);
    },
  },

  {
    name: "T2b options page load repairs a missing registration",
    async fn(h) {
      await h.seedRules({ [h.A]: [{ selector: "#text", value: "REPAIR-TEST" }] });
      await sleep(300);
      await h.evalIn(h.optCtx, () => browser.scripting.unregisterContentScripts());
      eq(await h.policyScripts(), [], "registration removed");
      await h.bidi.send("browsingContext.close", { context: h.optCtx });
      h.optCtx = null;
      await sleep(300);
      eq(await h.policyScripts(), [], "no registration while no extension page is open");
      await h.openOptions();
      const scripts = await h.waitFor("chrome", (id) => {
        const p = WebExtensionPolicy.getByID(id);
        return p.contentScripts.length ? p.contentScripts.map((s) => s.matches.patterns.map((x) => x.pattern)) : null;
      }, 5000, EXT_ID);
      eq(scripts, [[LOCAL]], "registration restored when the options page loads");
      await h.expectFilled(`${h.A}/basic.html`, "#text", "REPAIR-TEST");
    },
  },

  {
    name: "T2c syncRegistration(): sorted, de-duplicated host patterns of origins with an enabled rule; serialized; unregisters when empty",
    async fn(h) {
      const alt = `https://${ALT_HOST}:${h.server.portA}`;
      const map = await h.seedRules({
        [h.B]: [{ selector: "#a", value: "SYNC-B-TEST" }],
        [alt]: [{ selector: "#a", value: "SYNC-ALT-TEST" }],
        [h.A]: [{ selector: "#a", value: "SYNC-A1-TEST", enabled: false }, { selector: "#b", value: "SYNC-A2-TEST" }],
        [h.IPA]: [{ selector: "#a", value: "SYNC-IP-TEST", enabled: false }],
      });
      let st = await h.extState();
      eq(st.registered.map(pickReg), REG([LOCAL, `https://${ALT_HOST}/*`]), "after the first sync (127.0.0.1 has only a disabled rule)");

      const enabled = map[h.IPA].map((r) => ({ ...r, enabled: true }));
      await h.evalIn(h.optCtx, async (k, v) => { await browser.storage.local.set({ [k]: v }); await syncRegistration(); }, h.IPA, enabled);
      const all3 = ["https://127.0.0.1/*", LOCAL, `https://${ALT_HOST}/*`];
      st = await h.extState();
      eq(st.registered.map((r) => r.matches), [all3], "after enabling the 127.0.0.1 rule");

      const errors = await h.evalIn(h.optCtx, async () => {
        const r = await Promise.allSettled([syncRegistration(), syncRegistration(), syncRegistration()]);
        return r.filter((x) => x.status === "rejected").map((x) => String(x.reason));
      });
      eq(errors, [], "concurrent syncRegistration() calls");
      st = await h.extState();
      eq(st.registered.map(pickReg), REG(all3), "still exactly one registration after concurrent syncs");
      eq((await h.policyScripts()).map((s) => s.matches), [all3], "Firefox policy content script matches");

      const hp = await h.evalIn(h.optCtx, (os) => os.map((o) => hostPattern(o)), [h.B, `https://${IDN_HOST}:8443`, `https://${ALT_HOST}`]);
      eq(hp, [LOCAL, `https://${IDN_HOST}/*`, `https://${ALT_HOST}/*`], "hostPattern() of the extension");

      await h.evalIn(h.optCtx, async () => { await browser.storage.local.clear(); await syncRegistration(); });
      eq((await h.extState()).registered, [], "unregistered once no origin has an enabled rule");
      eq(await h.policyScripts(), [], "Firefox policy has no content script");
    },
  },

  {
    name: "T3 validation: http/path/query/hash/credentials origin, bad path, invalid selector and empty value are rejected; nothing stored",
    async fn(h) {
      const P = h.server.portA;
      const value = h.v("VAL-T3-TEST");
      const good = { origin: h.A, path: "", selector: "#text", value };
      const cases = [
        ["http origin", { origin: `http://localhost:${P}` }],
        ["origin with a path", { origin: `https://localhost:${P}/login` }],
        ["origin with a query", { origin: `https://localhost:${P}/?a=1` }],
        ["origin with a hash", { origin: `https://localhost:${P}/#top` }],
        ["origin with credentials", { origin: `https://user:pw@localhost:${P}` }],
        ["empty origin", { origin: "" }],
        ["path without leading slash", { path: "login" }],
        ["path with a query", { path: "/login?x=1" }],
        ["path with a hash", { path: "/login#x" }],
        ["invalid selector", { selector: "##bad[" }],
        ["empty selector", { selector: "" }],
        ["empty value", { value: "" }],
      ];
      for (const [label, change] of cases) {
        let res;
        try {
          res = await h.addRuleViaUI({ ...good, ...change }, { expect: "error" });
        } catch (e) {
          throw new Error(`${label}: ${e.message}`);
        }
        ok(res.text.length > 0, `${label}: an error text is shown`);
        ok(!res.text.includes(value), `${label}: the error message must not contain the value`, res.text);
        const st = await h.extState();
        eq(st.storage, {}, `${label}: storage`);
        eq(st.origins, [], `${label}: granted origins`);
        eq(st.registered, [], `${label}: registration`);
      }
      // A valid save afterwards still works (the form is not stuck).
      await h.addRuleViaUI(good);
      eq(Object.keys((await h.extState()).storage), [h.A], "a valid rule saves after the rejected ones");
    },
  },

  {
    name: "T3c wildcard sites (*, *.example.test) are rejected: rules need an exact origin, and access must never cover unconfigured sites",
    async fn(h) {
      const value = h.v("WILDCARD-TEST");
      const outcomes = [];
      // Each typed wildcard, plus a page that only that wildcard would cover.
      const cases = [
        ["*", `${h.IPA}/basic.html`],
        ["*.example.test", `https://${ALT_HOST}:${h.server.portA}/basic.html`],
        [`https://*.localhost:${h.server.portA}`, `${h.A}/basic.html`],
      ];
      for (const [typed, unconfiguredUrl] of cases) {
        let res;
        try {
          res = await h.addRuleViaUI({ origin: typed, selector: "#text", value }, { expect: "none" });
          res = await h.waitMsg(h.optCtx);
        } catch (e) {
          throw new Error(`typed ${JSON.stringify(typed)}: ${e.message}`);
        }
        const st = await h.extState();
        const injects = (await h.matchesURI(unconfiguredUrl)).some(Boolean);
        outcomes.push({ typed, saved: res.ok, storageKeys: Object.keys(st.storage), origins: st.origins, matches: st.registered.flatMap((r) => r.matches), injectsInto: injects ? unconfiguredUrl : null });
        await h.evalIn(h.optCtx, async () => {
          await browser.storage.local.clear();
          await browser.scripting.unregisterContentScripts();
          const { origins } = await browser.permissions.getAll();
          if (origins.length) await browser.permissions.remove({ origins });
        });
      }
      eq(outcomes, outcomes.map((o) => ({ typed: o.typed, saved: false, storageKeys: [], origins: [], matches: [], injectsInto: null })),
        "each wildcard site is rejected with an error and grants/registers nothing");
    },
  },

  {
    name: "T3b site typed as mixed case, trailing slash, IDN, bare host or explicit port is stored as URL.origin and fills",
    async fn(h) {
      const P = h.server.portA, Q = h.server.portB;
      const cases = [
        { typed: `Portal.Example.TEST:${P}`, origin: `https://${ALT_HOST}:${P}`, value: "T3B-MIXED-TEST", fill: true },
        { typed: `https://LOCALHOST:${P}/`, origin: `https://localhost:${P}`, value: "T3B-SLASH-TEST", fill: true },
        { typed: `bücher.example:${P}`, origin: `https://${IDN_HOST}:${P}`, value: "T3B-IDN-TEST", fill: true },
        { typed: `localhost:${Q}`, origin: `https://localhost:${Q}`, value: "T3B-BARE-TEST", fill: true },
        { typed: "HTTPS://LocalHost:443", origin: "https://localhost", value: "T3B-PORT443-TEST", fill: false },
      ];
      for (const c of cases) {
        try {
          await h.addRuleViaUI({ origin: c.typed, selector: "#text", value: h.v(c.value) });
        } catch (e) {
          throw new Error(`typed ${JSON.stringify(c.typed)}: ${e.message}`);
        }
      }
      const st = await h.extState();
      eq(Object.keys(st.storage).sort(), cases.map((c) => c.origin).sort(), "storage keys are canonical origins");
      for (const c of cases) eq(st.storage[c.origin].map((r) => r.value), [c.value], `rule stored under ${c.origin}`);
      const patterns = [...new Set(cases.map((c) => hostPattern(c.origin)))].sort();
      eq([...st.origins].sort(), patterns, "granted host patterns (lowercase, punycode, no port)");
      eq(st.registered.map((r) => r.matches), [patterns], "registration matches");
      for (const c of cases.filter((x) => x.fill)) await h.expectFilled(`${c.origin}/basic.html`, "#text", c.value);
    },
  },

  {
    name: "T4 real permission prompt: Deny keeps the rule unsaved with an error and no access; Allow then saves",
    async fn(h) {
      await h.setPref("extensions.webextOptionalPermissionPrompts", true);
      try {
        const value = h.v("T4-PROMPT-TEST");
        const ctx = await h.fillRuleForm({ origin: h.A, selector: "#text", value });
        await h.clearMsg(ctx);
        await h.realClick(ctx, "#save");
        const prompt = await h.waitPermissionPrompt();
        ok(JSON.stringify(prompt).includes("localhost"), "the prompt names the requested site", prompt);
        await h.answerPermissionPrompt(false);
        const res = await h.waitMsg(ctx);
        eq(res.ok, false, "#msg shows an error after Deny");
        ok(!res.text.includes(value), "the error does not contain the value", res.text);
        let st = await h.extState();
        eq(st.storage, {}, "storage after Deny");
        eq(st.origins, [], "granted origins after Deny");
        eq(st.registered, [], "registration after Deny");
        eq(await h.contains(LOCAL), false, "permissions.contains after Deny");
        const ui = await h.uiState();
        eq({ origin: ui.fields.origin, selector: ui.fields.selector, value: ui.fields.value }, { origin: h.A, selector: "#text", value }, "the form is kept after Deny");

        await h.clearMsg(ctx);
        await h.realClick(ctx, "#save");
        await h.waitPermissionPrompt();
        await h.answerPermissionPrompt(true);
        const res2 = await h.waitMsg(ctx);
        eq(res2, { ok: true, text: SAVED_MSG }, "#msg after Allow");
        st = await h.extState();
        eq(st.storage[h.A]?.map((r) => r.value), [value], "rule stored after Allow");
        eq(st.origins, [LOCAL], "granted origins after Allow");

        // One Allow per site: a second rule for the same host (another port) saves without a prompt.
        const value2 = h.v("T4-SECOND-TEST");
        await h.fillRuleForm({ origin: h.B, selector: "#text", value: value2 });
        await h.clearMsg(ctx);
        await h.realClick(ctx, "#save");
        const res3 = await h.waitMsg(ctx, 4000).catch(async (e) => {
          const p = await h.waitPermissionPrompt(500).catch(() => null);
          if (p) { await h.answerPermissionPrompt(false); throw new Error("a second rule for an already allowed host prompted again: " + JSON.stringify(p)); }
          throw e;
        });
        eq(res3, { ok: true, text: SAVED_MSG }, "second rule for the same host saved without a prompt");
        eq((await h.extState()).origins, [LOCAL], "still exactly one host permission");
      } finally {
        await h.setPref("extensions.webextOptionalPermissionPrompts", false);
      }
    },
  },
];
