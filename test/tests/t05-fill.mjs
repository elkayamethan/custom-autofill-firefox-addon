// Content-script filling (spec §5.6): T5 basic fill, T5b value fidelity, T5c broad selectors.
import { EXT_BASE, SELECT_EVENTS, TEXT_EVENTS, eq, ok } from "../lib/harness.mjs";

/** Page-side snapshot of values and the extension's (untrusted) events per element id. */
function pageReport(ids) {
  const out = { values: {}, events: {}, data: {}, eventTypes: [], trustedOnElements: [] };
  for (const id of ids) {
    const el = document.getElementById(id);
    out.values[id] = el ? (el.type === "checkbox" || el.type === "radio" ? { value: el.value, checked: el.checked } : el.value) : null;
  }
  for (const e of window.__events) {
    if (e.id === "#document") continue; // the document itself gets focus when the tab is shown
    // Trusted events on elements would mean focus()/click()/keys (browser-dispatched).
    if (e.trusted) { out.trustedOnElements.push(e.type + ":" + e.id); continue; }
    (out.events[e.id] ||= []).push(e.desc);
    if (e.type === "input") (out.data[e.id] ||= []).push(e.data);
    if (!out.eventTypes.includes(e.type)) out.eventTypes.push(e.type);
  }
  out.submits = window.__submits;
  out.loadToken = window.__loadToken ?? null;
  out.path = location.pathname;
  out.active = document.activeElement ? document.activeElement.localName : null;
  return out;
}

export const tests = [
  {
    name: "T5 basic fill: text/password/email/textarea/select filled exactly; prefilled, hidden, checkbox untouched; input then change events; no submit",
    async fn(h) {
      const rules = [
        { selector: "#text", value: "ID-0000-TEST" },
        { selector: "#pass", value: "Sw0rdfish-TEST" },
        { selector: "#email", value: "user-TEST@example.invalid" },
        { selector: "#area", value: "Area value TEST" },
        { selector: "#selv", value: "opt-b-TEST" },             // select by option value
        { selector: "#sell", value: "Gamma Label" },            // select by trimmed option text
        { selector: "#selfull", value: "full-b-TEST" },         // non-empty select, no overwrite
        { selector: "#selfullow", value: "full-b-TEST", overwrite: true },
        { selector: "#selprio", value: "Prio-TEST" },           // a value match wins over a text match
        { selector: "#prefilled", value: "NEW-TEST" },          // non-empty, no overwrite
        { selector: "#prefilled-ow", value: "OVERWRITTEN-TEST", overwrite: true },
        { selector: "#same", value: "SAME-TEST", overwrite: true }, // already equal: nothing to do
        { selector: "#hidden", value: "HIDDEN-TEST" },
        { selector: "#check", value: "CHECK-TEST" },
        { selector: "#radio", value: "RADIO-TEST" },
        { selector: "#btn", value: "BTN-TEST" },
        { selector: "#disabled", value: "DISABLED-TEST" },      // disabled fields are filled (spec §9)
        { selector: "#readonly", value: "READONLY-TEST" },      // read-only fields are filled
        { selector: ".multi", value: "MULTI-TEST" },            // every match is filled
        { selector: "#numrej", value: "not-a-number-TEST" },    // rejected by type=number
        { selector: "#numow", value: "also-not-a-number-TEST", overwrite: true }, // rejected: the old value comes back
      ];
      await h.seedRules({ [h.A]: rules });
      const hitsBefore = h.server.hits.length;
      const ctx = await h.openPage(`${h.A}/basic.html`);
      const token = await h.evalIn(ctx, () => window.__loadToken);
      await h.waitFor(ctx, () => ["text", "pass", "email", "area", "readonly", "multi2"].every((id) => document.getElementById(id).value !== "") && document.getElementById("selv").value !== "", 5000);
      await h.settle(ctx);
      const ids = ["text", "text2", "pass", "email", "num", "area", "selv", "sell", "selfull", "selfullow", "selprio", "prefilled", "prefilled-ow", "same", "hidden", "check", "radio", "btn", "disabled", "readonly", "multi1", "multi2", "numrej", "numow"];
      const r = await h.evalIn(ctx, pageReport, ids);
      eq(r.values, {
        text: "ID-0000-TEST", text2: "", pass: "Sw0rdfish-TEST", email: "user-TEST@example.invalid", num: "", area: "Area value TEST",
        selv: "opt-b-TEST", sell: "code-x1", selfull: "full-a-TEST", selfullow: "full-b-TEST", selprio: "Prio-TEST",
        prefilled: "keep-me", "prefilled-ow": "OVERWRITTEN-TEST", same: "SAME-TEST", hidden: "hidden-orig",
        check: { value: "on", checked: false }, radio: { value: "r1", checked: false }, btn: "Btn",
        disabled: "DISABLED-TEST", readonly: "READONLY-TEST", multi1: "MULTI-TEST", multi2: "MULTI-TEST", numrej: "", numow: "42",
      }, "field values after the fill");
      const { disabled: _ignored, ...events } = r.events; // events on a disabled control are not asserted
      eq(events, {
        text: TEXT_EVENTS, pass: TEXT_EVENTS, email: TEXT_EVENTS, area: TEXT_EVENTS,
        selv: SELECT_EVENTS, sell: SELECT_EVENTS, selfullow: SELECT_EVENTS, selprio: SELECT_EVENTS,
        "prefilled-ow": TEXT_EVENTS, readonly: TEXT_EVENTS, multi1: TEXT_EVENTS, multi2: TEXT_EVENTS,
      }, "events per element (input then change; none for untouched fields)");
      eq({ text: r.data.text, pass: r.data.pass, area: r.data.area }, { text: ["ID-0000-TEST"], pass: ["Sw0rdfish-TEST"], area: ["Area value TEST"] }, "InputEvent.data is the value");
      eq(r.data.selv, [null], "select input event is a plain Event (no data)");
      eq(r.eventTypes.filter((t) => t !== "input" && t !== "change"), [], "no focus, blur, key, click, beforeinput or submit events");
      eq(r.trustedOnElements, [], "no browser-dispatched (trusted) events on any element: no focus(), click() or keys");
      eq(r.submits, 0, "submit events");
      eq({ token: r.loadToken, path: r.path }, { token, path: "/basic.html" }, "no navigation happened");
      eq(r.active, "body", "no field was focused");
      const posts = h.server.hits.slice(hitsBefore).filter((x) => x.method !== "GET" || x.url.startsWith("/submitted"));
      eq(posts, [], "no form submission reached the server");
    },
  },

  {
    name: "T5b value fidelity through the UI: leading zeros (number and text), Hebrew, emoji in a password, quotes and inner spaces arrive byte-for-byte",
    async fn(h) {
      const cases = [
        { selector: "#num", value: "0012345678" },
        { selector: "#text2", value: "0012345678" },
        { selector: "#text", value: "שלום-TEST" },
        { selector: "#pass", value: "emoji-😀-TEST" },
        { selector: "#area", value: `quote "double" and 'single'  inner   spaces TEST` },
        { selector: "#email", value: "a.b+TEST@example.invalid" },
      ];
      for (const c of cases) await h.addRuleViaUI({ origin: h.A, selector: c.selector, value: h.v(c.value) });
      const st = await h.extState();
      eq(st.storage[h.A].map((r) => [r.selector, r.value]), cases.map((c) => [c.selector, c.value]), "stored values are exactly what was typed");
      const ctx = await h.openPage(`${h.A}/basic.html`);
      const want = Object.fromEntries(cases.map((c) => [c.selector.slice(1), c.value]));
      try {
        await h.waitFor(ctx, (w) => Object.entries(w).every(([id, v]) => document.getElementById(id).value === v), 5000, want);
      } catch {
        const got = await h.evalIn(ctx, (ids) => Object.fromEntries(ids.map((id) => [id, [...document.getElementById(id).value].map((c) => c.codePointAt(0).toString(16))])), Object.keys(want));
        throw new Error("field values differ from the stored values (code points): " + JSON.stringify(got));
      }
      const r = await h.evalIn(ctx, pageReport, Object.keys(want));
      eq(r.values, want, "field values");
      for (const id of Object.keys(want)) eq(r.data[id], [want[id]], `InputEvent.data for #${id}`);
    },
  },

  {
    name: "T5c broad selectors (input, *, form *) fill only eligible fields, skip an invalid selector, and nothing throws",
    async fn(h) {
      const V = "BROAD-TEST";
      await h.seedRules({ [h.A]: [
        { selector: "##bad[", value: V },
        { selector: "input", value: V },
        { selector: "*", value: V },
        { selector: "form *", value: V },
      ] });
      const ctx = await h.openPage(`${h.A}/broad.html`);
      await h.waitFor(ctx, (v) => ["t1", "t2", "t3", "t4", "t5"].every((id) => document.getElementById(id).value === v), 5000, V);
      await h.settle(ctx);
      const state = await h.evalIn(ctx, () => {
        const $ = (id) => document.getElementById(id);
        return {
          b1: $("b1").value, b2: $("b2").value, hid: $("hid").value, cb: [$("cb").value, $("cb").checked], rd: [$("rd").value, $("rd").checked],
          file: $("file").value, sub: $("sub").value, rst: $("rst").value, img: $("img").value, ibtn: $("ibtn").value,
          sel: $("sel").value, o1: $("o1").value, o2: $("o2").value, out: $("out").value, prog: $("prog").value, met: $("met").value,
          dat: $("dat").value, li: $("li").value, d1: $("d1").textContent, sp: $("sp").textContent, num: $("num").value,
          t: ["t1", "t2", "t3", "t4", "t5"].map((id) => $(id).value),
        };
      });
      eq(state, {
        b1: "bv", b2: "sv", hid: "h0", cb: ["on", false], rd: ["r0", false], file: "", sub: "Go", rst: "Reset", img: "", ibtn: "ib",
        sel: "o1", o1: "o1", o2: "o2", out: "o", prog: 0.5, met: 0.5, dat: "dv", li: 3, d1: "div text", sp: "span text", num: "",
        t: [V, V, V, V, V],
      }, "ineligible elements untouched; eligible text fields filled; a rejected number value restored");
      const r = await h.evalIn(ctx, pageReport, []);
      eq(r.events, { t1: TEXT_EVENTS, t2: TEXT_EVENTS, t3: TEXT_EVENTS, t4: TEXT_EVENTS, t5: TEXT_EVENTS }, "events only on the eligible fields, once each despite 3 matching rules");
      const msgs = await h.drainConsole();
      const csErrors = msgs.filter((m) => m.kind === "error" && !m.warning && m.source.startsWith(EXT_BASE));
      eq(csErrors.map((m) => m.text), [], "errors reported from the extension's scripts");
      const jsLogs = h.logs.filter((l) => l.test === h.currentTest && l.type === "javascript" && l.level === "error");
      eq(jsLogs.map((l) => l.text), [], "page JavaScript errors during the test");
      ok(true, "done");
    },
  },
];
