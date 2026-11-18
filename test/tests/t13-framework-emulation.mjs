// T13 (spec §5.6 step 4, §6): a React-style per-node value tracker must see the fill.
// Real React 18/19 and Vue 3 run in the optional suite in test/frameworks/.
import { eq } from "../lib/harness.mjs";

export const tests = [
  {
    name: "T13 React-style value-tracker emulation sees the fill (native setter through Xray + bubbling events) for input, textarea, password and select",
    async fn(h) {
      const want = { t1: "EMU-TEXT-TEST", t2: "EMU-AREA-TEST", t3: "EMU-PASS-TEST", s1: "emu-opt-b-TEST" };
      await h.seedRules({ [h.A]: Object.entries(want).map(([id, value]) => ({ selector: `#${id}`, value })) });
      const ctx = await h.openPage(`${h.A}/react-emu.html`);
      try {
        await h.waitFor(ctx, (w) => Object.entries(w).every(([id, v]) => window.__state[id] === v), 5000, want);
      } catch {
        const got = await h.evalIn(ctx, () => ({ state: window.__state, dom: Object.fromEntries(["t1", "t2", "t3", "s1"].map((id) => [id, document.getElementById(id).value])), changes: window.__onChange }));
        throw new Error("the page's change handling did not see the fill: " + JSON.stringify(got));
      }
      await h.settle(ctx);
      const r = await h.evalIn(ctx, () => ({
        state: window.__state,
        dom: Object.fromEntries(["t1", "t2", "t3", "s1"].map((id) => [id, document.getElementById(id).value])),
        changes: window.__onChange,
      }));
      eq(r.state, { ...want, ctl: "" }, "page state (what the framework saw)");
      eq(r.dom, want, "DOM values were not reverted by the controlled-value restore");
      eq(r.changes, ["t1:input", "t2:input", "t3:input", "s1:change"], "onChange calls (selects react to change only)");
      const self = await h.evalIn(ctx, async () => {
        const res = window.__selfCheck();
        await new Promise((r) => setTimeout(r, 0));
        return { state: window.__state.ctl, dom: document.getElementById("ctl").value, sync: res };
      });
      eq({ state: self.state, dom: self.dom }, { state: "", dom: "" }, "fixture self-check: a fill through the page-visible setter is NOT seen and is reverted");
    },
  },
];
