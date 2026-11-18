// Second review of the suite: requirements the first suite did not prove. Each test here was added
// because a specific mutant of the extension passed every earlier test (see the review report):
//   T5d  content script reads all keys (get(undefined)) / re-reads storage per scan / runs where it should not
//   T5e  value trimmed on save; fill that changes the field's default value
//   T9b  re-enabling a rule with the toggle does not ask for site access again
//   T14b access released while a disabled rule, or a rule on another port, still uses the host
//   T17c Cancel (or a saved edit) leaves the form editing the old rule; edit form's Enabled not synced
//   T17d a masked value leaks into the options page DOM (title/attribute/text)
//   T19d any added node (text, comment) or attribute change triggers a scan; the watcher stops after a while
//   T19e a debounced watcher starves under continuous churn
//   T18c a console call in the options page or background carries a value (invisible to BiDi's log)
import { MASK, TEXT_EVENTS, eq, ok, sleep } from "../lib/harness.mjs";

const LOCAL = "https://localhost/*";
const IP = "https://127.0.0.1/*";

function needSpy(h) {
  if (h.spyError) throw new Error(`the content-process spy is unavailable, so this cannot be checked: ${h.spyError.message}`);
}

const enabledIs = (h, ctx, origin, id, want) => h.waitFor(ctx, async (o, id, want) =>
  (await browser.storage.local.get(o))[o]?.find((r) => r.id === id)?.enabled === want, 5000, origin, id, want);

export const tests = [
  {
    name: "T5d content script reads only its own origin's key, once per document (spy in the content process); 127.0.0.1 pages and frames get no script at all",
    timeoutMs: 90000,
    async fn(h) {
      needSpy(h);
      await h.seedRules({
        [h.A]: [{ selector: "#text", value: "SPY-A-TEST" }, { selector: "#f", value: "SPY-AF-TEST" }],
        [h.B]: [{ selector: "#text", value: "SPY-B-TEST" }, { selector: "#f", value: "SPY-BF-TEST" }],
        [h.IPA]: [{ selector: "#text", value: "SPY-IP-TEST", enabled: false }],
      });
      eq((await h.extState()).registered.map((r) => r.matches), [[LOCAL]], "registration covers localhost only (127.0.0.1 has only a disabled rule)");
      const inner = (o) => `${o}/frame-inner.html`;
      const src = (u) => `src=${encodeURIComponent(u)}`;
      // fills: [frame index or null for the top document, selector, value] that must appear first,
      // so the scripts that should run have run. want: the keys every content script of the load asked for.
      const cases = [
        { label: "port A page", url: `${h.A}/basic.html`, fills: [[null, "#text", "SPY-A-TEST"]], want: [h.A] },
        { label: "port B page", url: `${h.B}/basic.html`, fills: [[null, "#text", "SPY-B-TEST"]], want: [h.B] },
        { label: "127.0.0.1 page", url: `${h.IPA}/basic.html`, fills: [], want: [] },
        {
          label: "port A page with port A, 127.0.0.1 and port B frames",
          url: `${h.A}/frames.html?${src(inner(h.A))}&${src(inner(h.IPA))}&${src(inner(h.B))}`,
          fills: [[null, "#f", "SPY-AF-TEST"], [0, "#f", "SPY-AF-TEST"], [2, "#f", "SPY-BF-TEST"]],
          want: [h.A, h.A, h.B],
        },
        { label: "127.0.0.1 page with a port A frame", url: `${h.IPA}/frames.html?${src(inner(h.A))}`, fills: [[0, "#f", "SPY-AF-TEST"]], want: [h.A] },
      ];
      const got = [];
      for (const c of cases) {
        await h.spyGets({ clear: true });
        const ctx = await h.openPage(c.url);
        const docs = [ctx, ...(await h.frames(ctx)).map((f) => f.context)];
        for (const [fi, sel, v] of c.fills) {
          await h.waitFor(fi === null ? ctx : docs[fi + 1], (s, v) => document.querySelector(s)?.value === v, 5000, sel, v);
        }
        // Element insertions make every injected script scan again: a script that re-reads storage per
        // scan would show up as extra reads.
        for (let round = 0; round < 2; round++) {
          for (const d of docs) await h.evalIn(d, () => { document.body.append(document.createElement("div")); });
          await sleep(200);
        }
        await sleep(700); // negative check: nothing else may arrive
        const gets = await h.spyGets({ clear: true });
        got.push({ label: c.label, keys: gets.map((g) => (g.kind === "json" ? g.keys : `(${g.kind})`)).sort() });
      }
      eq(got, cases.map((c) => ({ label: c.label, keys: [...c.want].sort() })), "storage.local.get() keys requested by content scripts per page load (one plain origin string per document)");
    },
  },

  {
    name: "T5e value fidelity: leading and trailing spaces, $& and backslashes and HTML-like text are stored and filled byte-for-byte; the fill changes only the current value, never the default",
    async fn(h) {
      const cases = [
        { selector: "#v1", value: "  padded value TEST  " },
        { selector: "#v2", value: " pw with spaces-TEST " },
        { selector: "#v3", value: "back\\slash $& $1 $$ <b>&amp;</b> TEST" },
        { selector: "#v4", value: "trailing space TEST " },
      ];
      for (const c of cases) await h.addRuleViaUI({ origin: h.A, selector: c.selector, value: h.v(c.value) });
      const st = await h.extState();
      eq(st.storage[h.A].map((r) => [r.selector, r.value]), cases.map((c) => [c.selector, c.value]), "stored values are exactly what was typed (nothing trimmed)");
      const ctx = await h.openPage(`${h.A}/fidelity.html`);
      const want = Object.fromEntries(cases.map((c) => [c.selector.slice(1), c.value]));
      try {
        await h.waitFor(ctx, (w) => Object.entries(w).every(([id, v]) => document.getElementById(id).value === v), 5000, want);
      } catch {
        const lens = await h.evalIn(ctx, (ids) => ids.map((id) => document.getElementById(id).value.length), Object.keys(want));
        throw new Error(`fields differ from the typed values; lengths ${JSON.stringify(lens)}, wanted ${JSON.stringify(Object.values(want).map((v) => v.length))}`);
      }
      await h.settle(ctx);
      const r = await h.evalIn(ctx, (ids) => ids.map((id) => {
        const el = document.getElementById(id);
        const mine = window.__events.filter((e) => !e.trusted && e.id === id);
        return {
          id, value: el.value, defaultValue: el.defaultValue, valueAttr: el.getAttribute("value"),
          text: el.localName === "textarea" ? el.textContent : null,
          events: mine.map((e) => e.desc), data: mine.filter((e) => e.type === "input").map((e) => e.data),
        };
      }), Object.keys(want));
      eq(r, Object.keys(want).map((id) => ({
        id, value: want[id], defaultValue: "", valueAttr: null, text: id === "v3" ? "" : null, events: TEXT_EVENTS, data: [want[id]],
      })), "value, default value, value attribute, textarea text and events after the fill");
      const afterReset = await h.evalIn(ctx, (ids) => { document.getElementById("f").reset(); return ids.map((id) => document.getElementById(id).value); }, Object.keys(want));
      eq(afterReset, ["", "", "", ""], "form.reset() brings back the empty defaults");
    },
  },

  {
    name: "T9b re-enabling a rule asks for site access again: access revoked in about:addons comes back with the toggle; with the real prompt, Deny keeps the rule off",
    timeoutMs: 90000,
    async fn(h) {
      const value = h.v("REENABLE-TEST");
      await h.addRuleViaUI({ origin: h.A, selector: "#text", value });
      const id = (await h.extState()).storage[h.A][0].id;
      const opt = await h.openOptions();
      const toggle = `${h.rowSel(h.A, id)} input.toggle`;
      const grant = `${h.rowSel(h.A, id)} td.origin button.grant`;

      await h.realClick(opt, toggle);
      await enabledIs(h, opt, h.A, id, false);
      await h.revokeOrigins([LOCAL]); // same call path as the about:addons per-site switch
      await h.waitFor(opt, (s) => !!document.querySelector(s), 5000, grant);
      await h.realClick(opt, toggle);
      await enabledIs(h, opt, h.A, id, true);
      await h.waitFor(opt, (p) => browser.permissions.contains({ origins: [p] }), 5000, LOCAL)
        .catch(() => { throw new Error("turning the rule back on did not ask for site access: localhost is still not allowed"); });
      await h.waitFor(opt, (s) => !document.querySelector(s), 5000, grant);
      let st = await h.extState();
      eq({ origins: st.origins, matches: st.registered.map((r) => r.matches) }, { origins: [LOCAL], matches: [[LOCAL]] }, "access and registration after re-enabling");
      await h.expectFilled(`${h.A}/basic.html`, "#text", value);

      // The real prompt, answered Deny.
      await h.openOptions();
      await h.realClick(opt, toggle);
      await enabledIs(h, opt, h.A, id, false);
      await h.revokeOrigins([LOCAL]);
      await h.waitFor(opt, (s) => !!document.querySelector(s), 5000, grant);
      await h.setPref("extensions.webextOptionalPermissionPrompts", true);
      try {
        await h.clearMsg(opt);
        await h.realClick(opt, toggle);
        const prompt = await h.waitPermissionPrompt().catch(() => null);
        ok(prompt, "turning the rule back on showed Firefox's site-access prompt");
        ok(JSON.stringify(prompt).includes("localhost"), "the prompt names the rule's site", prompt);
        await h.answerPermissionPrompt(false);
        const msg = await h.waitFor(opt, () => { const m = document.querySelector("#msg"); return m.classList.contains("error") && m.textContent.trim(); }, 5000);
        ok(!msg.includes(value), "the error does not contain the value", msg);
        await sleep(500); // negative check: nothing may be saved after Deny
        st = await h.extState();
        eq({ enabled: st.storage[h.A][0].enabled, origins: st.origins, registered: st.registered }, { enabled: false, origins: [], registered: [] }, "after Deny: rule still off, no access, no registration");
        eq(await h.evalIn(opt, (s) => document.querySelector(s).checked, toggle), false, "the toggle is unchecked again after Deny");
      } finally {
        await h.setPref("extensions.webextOptionalPermissionPrompts", false);
      }
    },
  },

  {
    name: "T14b site access is released only when no rule on any port of the host is left, disabled rules included; moving a rule to another port of the same host keeps access",
    timeoutMs: 90000,
    async fn(h) {
      const v1 = h.v("RELEASE-ONE-TEST"), v2 = h.v("release-two-TEST@example.invalid");
      await h.addRuleViaUI({ origin: h.A, selector: "#text", value: v1 });
      await h.addRuleViaUI({ origin: h.A, selector: "#email", value: v2 });
      let st = await h.extState();
      const [r1, r2] = st.storage[h.A];
      const opt = await h.openOptions();

      // r2 off, then delete r1: only a disabled rule is left on the host.
      await h.realClick(opt, `${h.rowSel(h.A, r2.id)} input.toggle`);
      await enabledIs(h, opt, h.A, r2.id, false);
      await h.clickWithConfirm(opt, `${h.rowSel(h.A, r1.id)} button.delete`, true);
      // Deletion stores, then releases unused access, then syncs; the registration disappearing marks the end.
      await h.waitFor(opt, async (o) => (await browser.storage.local.get(o))[o]?.length === 1 &&
        (await browser.scripting.getRegisteredContentScripts()).length === 0, 5000, h.A);
      st = await h.extState();
      eq(st.storage, { [h.A]: [{ ...r2, enabled: false }] }, "only the disabled rule is left");
      eq(st.origins, [LOCAL], "site access kept: a disabled rule still uses the host");
      eq(st.registered, [], "no registration without an enabled rule");
      await h.waitFor(opt, () => document.querySelectorAll("#rules tbody tr[data-id]").length === 1, 3000);
      eq((await h.uiState()).rows.map((r) => r.grant), [false], "no Grant access button for the remaining rule");

      // Move the remaining (only) rule from port A to port B of the same host.
      await h.editRuleViaUI(h.A, r2.id, { origin: h.B });
      st = await h.extState();
      eq(st.storage, { [h.B]: [{ ...r2, enabled: false }] }, "the rule moved to port B with its id; the port A key is gone");
      eq(st.origins, [LOCAL], "site access kept: the moved rule still uses the host");

      // Turn it on: it fills on port B without any new grant.
      await h.openOptions();
      await h.realClick(opt, `${h.rowSel(h.B, r2.id)} input.toggle`);
      await enabledIs(h, opt, h.B, r2.id, true);
      await h.waitFor(opt, async () => (await browser.scripting.getRegisteredContentScripts()).length === 1, 5000);
      await h.expectFilled(`${h.B}/basic.html`, "#email", v2);
      eq((await h.valuesAfterSettle(`${h.A}/basic.html`, ["#email"]))["#email"], "", "port A no longer filled");
    },
  },

  {
    name: "T17c after Cancel or a saved edit the form is back in Add mode, so the next save adds a new rule; unchecking Enabled in the edit form updates the registration",
    timeoutMs: 90000,
    async fn(h) {
      const v1 = h.v("FORM-ONE-TEST"), v2 = h.v("FORM-TWO-TEST"), v1b = h.v("FORM-ONE-EDITED-TEST"), v3 = h.v("FORM-THREE-TEST"), v4 = h.v("FORM-IP-TEST");
      await h.addRuleViaUI({ origin: h.A, selector: "#text", value: v1 });
      const [r1] = (await h.extState()).storage[h.A];
      const opt = await h.openOptions();

      await h.realClick(opt, `${h.rowSel(h.A, r1.id)} button.edit`);
      await h.waitFor(opt, () => document.querySelector("#form-title")?.textContent.trim() === "Edit rule", 3000);
      await h.realClick(opt, "#cancel");
      await h.waitFor(opt, () => document.querySelector("#form-title")?.textContent.trim() === "Add a rule", 3000);
      await h.addRuleViaUI({ origin: h.A, selector: "#text2", value: v2 });
      let st = await h.extState();
      eq(st.storage[h.A].map((r) => [r.id === r1.id ? "r1" : "new", r.selector, r.value]), [["r1", "#text", v1], ["new", "#text2", v2]],
        "after Edit, Cancel and Add: the edited rule is unchanged and a new rule was added");
      const r2 = st.storage[h.A][1];

      await h.editRuleViaUI(h.A, r1.id, { value: v1b });
      const ui = await h.uiState();
      eq({ title: ui.formTitle, save: ui.saveText, cancel: ui.cancelVisible }, { title: "Add a rule", save: "Add rule", cancel: false }, "Add mode after a saved edit");
      await h.addRuleViaUI({ origin: h.A, selector: "#area", value: v3 });
      st = await h.extState();
      eq(st.storage[h.A].map((r) => [r.selector, r.value]), [["#text", v1b], ["#text2", v2], ["#area", v3]], "after a saved edit and Add: three rules");
      eq(st.storage[h.A].slice(0, 2).map((r) => r.id), [r1.id, r2.id], "ids kept");

      // Enabled is part of the edit form too.
      await h.addRuleViaUI({ origin: h.IPA, selector: "#text", value: v4 });
      const r4 = (await h.extState()).storage[h.IPA][0];
      eq((await h.extState()).registered.map((r) => r.matches), [[IP, LOCAL]], "both hosts registered");
      await h.editRuleViaUI(h.IPA, r4.id, { enabled: false });
      st = await h.extState();
      eq(st.storage[h.IPA], [{ ...r4, enabled: false }], "rule disabled through the edit form");
      eq(st.registered.map((r) => r.matches), [[LOCAL]], "127.0.0.1 left the registration once its only rule was disabled in the edit form");
      eq([...st.origins].sort(), [IP, LOCAL], "access kept while the disabled rule exists");
      await h.editRuleViaUI(h.IPA, r4.id, { enabled: true });
      eq((await h.extState()).registered.map((r) => r.matches), [[IP, LOCAL]], "back in the registration after re-enabling in the edit form");
      await h.expectFilled(`${h.IPA}/basic.html`, "#text", v4);
    },
  },

  {
    name: "T17d masked values never reach the options page's DOM: no text, attribute, title or serialized HTML holds a value while Show values is off, in the table or in the edit form",
    async fn(h) {
      const values = [h.v("MASK-SHORT-TEST"), h.v("MASK-A-MUCH-LONGER-VALUE-TEST-0123456789"), h.v("<b>&amp;MASK-HTML-TEST")];
      await h.seedRules({ [h.A]: values.map((value, i) => ({ selector: `#m${i}`, value })) });
      const opt = await h.openOptions({ reload: true });
      await h.waitFor(opt, () => document.querySelectorAll("#rules tbody tr[data-id]").length === 3, 5000);
      const leaks = (ignoreValueInput = false) => h.evalIn(opt, (vals, ignoreValueInput) => {
        const html = document.documentElement.outerHTML;
        const attrs = [...document.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => a.value));
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
        const texts = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n.data);
        const live = [...document.querySelectorAll("input, textarea, select")].filter((e) => !(ignoreValueInput && e.id === "value")).map((e) => e.value);
        const found = [];
        vals.forEach((v, i) => {
          for (const [where, list] of [["serialized HTML", [html]], ["attribute", attrs], ["text node", texts], ["title", [document.title]], ["form field", live]]) {
            if (list.some((s) => s.includes(v))) found.push(`value #${i} in a ${where}`);
          }
        });
        return found;
      }, values, ignoreValueInput);
      eq(await leaks(), [], "values in the options page DOM while masked");
      eq((await h.uiState()).rows.map((r) => r.value), [MASK, MASK, MASK], "table cells show the mask");

      await h.setCheckbox(opt, "#show-values", true);
      await h.waitFor(opt, (want) => JSON.stringify([...document.querySelectorAll("#rules tbody tr[data-id] td.value")].map((td) => td.textContent)) === JSON.stringify(want), 3000, values);
      await h.setCheckbox(opt, "#show-values", false);
      await h.waitFor(opt, (m) => [...document.querySelectorAll("#rules tbody tr[data-id] td.value")].every((td) => td.textContent.trim() === m), 3000, MASK);
      eq(await leaks(), [], "values in the DOM after Show values was turned off again");

      const id = (await h.extState()).storage[h.A][1].id;
      await h.realClick(opt, `${h.rowSel(h.A, id)} button.edit`);
      await h.waitFor(opt, () => document.querySelector("#form-title")?.textContent.trim() === "Edit rule", 3000);
      const edit = await h.evalIn(opt, () => {
        const v = document.querySelector("#value");
        return { value: v.value, attr: v.getAttribute("value"), masked: v.classList.contains("masked"), css: getComputedStyle(v).getPropertyValue("-webkit-text-security") };
      });
      eq(edit, { value: values[1], attr: null, masked: true, css: "disc" }, "#value while editing: holds the value as its live value only, rendered masked");
      eq(await leaks(true), [], "values anywhere else in the DOM while editing");
      await h.realClick(opt, "#cancel");
      await h.waitFor(opt, () => document.querySelector("#value").value === "", 3000);
      eq(await leaks(), [], "values in the DOM after Cancel");
    },
  },

  {
    name: "T19d observer: attribute, character-data, text and comment changes never trigger a scan; an element added 6.5 s after load still does (the watcher never stops)",
    async fn(h) {
      await h.seedRules({ [h.A]: [{ selector: "#probe", value: "OBS-PROBE-TEST" }, { selector: "input.ready", value: "OBS-READY-TEST" }] });
      const ctx = await h.openPage(`${h.A}/observer.html`);
      await h.waitFor(ctx, () => document.getElementById("probe").value === "OBS-PROBE-TEST", 5000);
      const rounds = await h.evalIn(ctx, () => { window.markReady(); return window.churnNonElements(40); });
      await h.settle(ctx);
      const mid = await h.evalIn(ctx, () => ({ x: document.getElementById("x").value, cls: document.getElementById("x").className }));
      eq(mid, { x: "", cls: "ready" }, `#x matches a rule once its class is set, but ${rounds} rounds of attribute, text, comment and character-data changes added no element, so no scan may run`);

      const PAUSE = 6500;
      const elapsed = await h.evalIn(ctx, () => performance.now() - window.__loadT);
      if (elapsed < PAUSE) await sleep(PAUSE - elapsed);
      await h.activate(ctx);
      await h.evalIn(ctx, () => window.addElement());
      try {
        await h.waitFor(ctx, () => document.getElementById("x").value === "OBS-READY-TEST", 2000);
      } catch {
        throw new Error(`a <div> added ${PAUSE / 1000} s after load did not lead to a scan: the watcher stopped (a multi-step login that pauses would be missed)`);
      }
      await h.settle(ctx);
      eq(await h.evalIn(ctx, () => window.__events.filter((e) => !e.trusted && e.id === "x").map((e) => e.desc)), TEXT_EVENTS, "#x filled exactly once");
    },
  },

  {
    name: "T19e no starvation: while a page adds an element every 10 ms, fields are filled during the churn every ~100 ms, not only after it stops",
    async fn(h) {
      await h.seedRules({ [h.A]: [{ selector: "input.burst", value: "BURST-TEST" }] });
      const ctx = await h.openPage(`${h.A}/throttle.html`);
      await sleep(300); // let the content script start; the window below is measured from the first insertion
      const ins = await h.evalIn(ctx, (ms) => window.runInsertions(ms), 2000);
      await h.settle(ctx);
      const r = await h.evalIn(ctx, (start, end) => {
        const during = window.__fills.map((f) => f.t).filter((t) => t >= start && t <= end);
        const scans = [];
        for (const t of during) {
          if (!scans.length || t - scans.at(-1).end >= 20) scans.push({ start: t, end: t });
          else scans.at(-1).end = t;
        }
        const marks = [start, ...scans.map((s) => s.start), end];
        return { filledDuring: during.length, filledTotal: window.__fills.length, scans: scans.length, maxGap: Math.round(Math.max(...marks.slice(1).map((m, i) => m - marks[i]))) };
      }, ins.start, ins.end);
      h.info(`${ins.inserted} fields inserted in ${Math.round(ins.elapsed)} ms; ${r.filledDuring} filled during the churn in ${r.scans} scans; longest stretch without a fill ${r.maxGap} ms`);
      ok(r.scans >= 8, "at least 8 scans filled fields while the churn was still going (a debounced watcher waits for quiet and starves)", r);
      ok(r.maxGap <= 400, "no stretch of more than 400 ms without a fill during the churn", r);
      eq(r.filledTotal, ins.inserted, "every inserted field filled once in the end");
    },
  },

  {
    name: "T18c privacy (whole run, every process): no console call by a page, a content script, the options page or the background carried a test value",
    phase: "final",
    async fn(h) {
      needSpy(h);
      // Exercise the options page and a fill here too, so this check means something when run on its own.
      const value = h.v("CONSOLE-API-FINAL-TEST");
      await h.addRuleViaUI({ origin: h.A, selector: "#text", value });
      await h.expectFilled(`${h.A}/basic.html`, "#text", value);
      // Controls: a web page and the options page each log a marker, and both must be captured.
      const page = await h.openPage(`${h.A}/control.html`);
      await h.evalIn(page, () => console.log("WEBPAGE-CONSOLE-CONTROL"));
      const opt = await h.openOptions({ activate: false });
      await h.evalIn(opt, () => console.log("EXTPAGE-CONSOLE-CONTROL"));
      await h.waitFor("chrome", () => {
        const all = window.__cafSpy.consoleApi.map((m) => m.args.join(" "));
        return all.some((t) => t.includes("WEBPAGE-CONSOLE-CONTROL")) && all.some((t) => t.includes("EXTPAGE-CONSOLE-CONTROL"));
      }, 5000).catch(() => { throw new Error("control: the spy did not capture console.log from a web page and from the options page, so this check would be meaningless"); });
      const { messages, errors } = await h.spyConsoleApi();
      eq(errors, [], "spy errors");
      const values = [...h.testValues];
      const hits = messages.filter((m) => values.some((v) => m.args.some((a) => a.includes(v))));
      eq(hits.map((m) => `${m.remoteType} ${m.filename} console.${m.level}`), [], "console calls whose arguments contain a test value");
      h.info(`checked ${values.length} test values against ${messages.length} console calls from process types ${[...new Set(messages.map((m) => m.remoteType.split("=")[0]))].sort().join(", ")}`);
    },
  },
];
