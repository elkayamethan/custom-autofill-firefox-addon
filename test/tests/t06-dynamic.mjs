// Dynamic pages (spec §5.6 steps 2, 4, 5): T6 late content, T8 SPA, T12 user wins, T12b re-render/reset.
import { SELECT_EVENTS, TEXT_EVENTS, eq } from "../lib/harness.mjs";

const untrustedEvents = (id, gen) => window.__events.filter((e) => !e.trusted && e.id === id && (gen === undefined || e.gen === gen)).map((e) => e.desc);

export const tests = [
  {
    name: "T6 late content: field inserted after load, field inside an inserted subtree, select whose options arrive later, field after a 2 s pause",
    async fn(h) {
      await h.seedRules({ [h.A]: [
        { selector: "#late1", value: "LATE-ONE-TEST" },
        { selector: "#late2", value: "LATE-TWO-TEST" },
        { selector: "#latesel", value: "late-opt-b-TEST" },
        { selector: "#late3", value: "LATE-THREE-TEST" },
      ] });
      const ctx = await h.openPage(`${h.A}/late.html`);
      const want = { late1: "LATE-ONE-TEST", late2: "LATE-TWO-TEST", latesel: "late-opt-b-TEST", late3: "LATE-THREE-TEST" };
      try {
        await h.waitFor(ctx, (w) => Object.entries(w).every(([id, v]) => document.getElementById(id)?.value === v), 6000, want);
      } catch (e) {
        const got = await h.evalIn(ctx, (ids) => Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.value ?? null])), Object.keys(want));
        throw new Error("late fields not filled: " + JSON.stringify(got));
      }
      await h.settle(ctx);
      const ev = await h.evalIn(ctx, (f) => Object.fromEntries(["late1", "late2", "latesel", "late3"].map((id) => [id, eval(`(${f})`)(id)])), untrustedEvents.toString());
      eq(ev, { late1: TEXT_EVENTS, late2: TEXT_EVENTS, latesel: SELECT_EVENTS, late3: TEXT_EVENTS }, "each late field filled exactly once");
    },
  },

  {
    name: "T8 SPA: pushState to a matching path plus a new field is filled; a new field on a non-matching path is not",
    async fn(h) {
      await h.seedRules({ [h.A]: [
        { path: "/spa/step2", selector: "input.dyn", value: "SPA-STEP2-TEST" },
        { path: "/spa/start", selector: "#start", value: "SPA-START-TEST" },
      ] });
      const ctx = await h.openPage(`${h.A}/spa/start`);
      await h.waitFor(ctx, () => document.getElementById("start").value === "SPA-START-TEST", 5000);
      await h.evalIn(ctx, () => window.go("/spa/step2", "s2"));
      await h.waitFor(ctx, () => document.getElementById("s2")?.value === "SPA-STEP2-TEST", 3000);
      await h.evalIn(ctx, () => window.go("/spa/other", "s3"));
      await h.settle(ctx);
      eq(await h.evalIn(ctx, () => [location.pathname, document.getElementById("s3").value]), ["/spa/other", ""], "field on a non-matching SPA path");
      await h.evalIn(ctx, () => window.go("/spa/step2", "s4"));
      await h.waitFor(ctx, () => document.getElementById("s4")?.value === "SPA-STEP2-TEST", 3000);
    },
  },

  {
    name: "T12 user wins: a field the user clears is not refilled by later DOM changes; a field non-empty at first sight is never filled later",
    async fn(h) {
      await h.seedRules({ [h.A]: [
        { selector: "#text", value: "USER-WINS-TEST" },
        { selector: "#prefilled", value: "NEVER-FILLED-TEST" },
      ] });
      const ctx = await h.expectFilled(`${h.A}/basic.html`, "#text", "USER-WINS-TEST");
      await h.typeText(ctx, "#text", ""); // real select-all + Backspace
      for (let i = 0; i < 2; i++) {
        await h.evalIn(ctx, () => window.addNodes(5));
        await h.settle(ctx);
      }
      // The page clears the prefilled field itself, then changes the DOM.
      await h.evalIn(ctx, () => { document.getElementById("prefilled").value = ""; window.addNodes(5); });
      await h.settle(ctx);
      await h.evalIn(ctx, () => window.addNodes(5));
      await h.settle(ctx);
      const r = await h.evalIn(ctx, (f) => {
        const ev = eval(`(${f})`);
        return { text: document.getElementById("text").value, prefilled: document.getElementById("prefilled").value, textEvents: ev("text"), prefilledEvents: ev("prefilled") };
      }, untrustedEvents.toString());
      eq(r, { text: "", prefilled: "", textEvents: TEXT_EVENTS, prefilledEvents: [] }, "state after the user cleared #text and the page cleared #prefilled");
    },
  },

  {
    name: "T12b re-render and reset: a replaced field element is filled once; a field the page resets to empty is not refilled (no fight loop)",
    async fn(h) {
      await h.seedRules({ [h.A]: [
        { selector: "#a", value: "RERENDER-TEST" },
        { selector: "#b", value: "RESET-TEST" },
      ] });
      const ctx = await h.openPage(`${h.A}/rerender.html`);
      await h.waitFor(ctx, () => document.getElementById("a").value === "RERENDER-TEST" && window.__bResets === 1, 5000);
      await h.evalIn(ctx, () => window.replaceA());
      await h.waitFor(ctx, () => document.getElementById("a").dataset.gen === "2" && document.getElementById("a").value === "RERENDER-TEST", 3000);
      for (let i = 0; i < 3; i++) {
        await h.evalIn(ctx, () => window.addNodes(5));
        await h.settle(ctx, 400);
      }
      await h.settle(ctx);
      const r = await h.evalIn(ctx, (f) => {
        const ev = eval(`(${f})`);
        return { a: document.getElementById("a").value, b: document.getElementById("b").value, resets: window.__bResets, a1: ev("a", "1"), a2: ev("a", "2"), b1: ev("b") };
      }, untrustedEvents.toString());
      eq(r, { a: "RERENDER-TEST", b: "", resets: 1, a1: TEXT_EVENTS, a2: TEXT_EVENTS, b1: TEXT_EVENTS }, "fills and resets after re-renders and DOM churn");
    },
  },
];
