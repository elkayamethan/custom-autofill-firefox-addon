// Regression tests for defects found in the code review (each failed before its fix).
import { OPTIONS_URL, eq, ok } from "../lib/harness.mjs";

export const tests = [
  {
    name: "T21a a value typed into the options page never reaches Firefox's session-restore data",
    async fn(h) {
      const ctx = await h.openOptions();
      // Control: a plain textarea added to this page instance, to prove session restore collects form data here.
      await h.evalIn(ctx, () => {
        const c = document.createElement("textarea");
        c.id = "__control";
        document.body.append(c);
      });
      const control = "SESSION-CONTROL";
      const secret = h.v("SESSION-SECRET-TEST");
      await h.typeText(ctx, "#__control", control);
      await h.typeText(ctx, "#value", secret);
      const state = await h.chrome(async (url) => {
        const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
        const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
        const tab = gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === url);
        await TabStateFlusher.flush(tab.linkedBrowser);
        return SessionStore.getTabState(tab);
      }, OPTIONS_URL);
      await h.evalIn(ctx, () => document.getElementById("__control").remove());
      ok(state.includes(control), "control: session restore collected the plain textarea, so collection works on this page");
      ok(!state.includes(secret), "the typed value is not in the session-restore tab state");
    },
  },

  {
    name: "T21b pressing Enter in the Value field saves the rule with the value exactly as typed (no line break), and a number field fills",
    async fn(h) {
      const ctx = await h.openOptions();
      const value = h.v("0012345678");
      await h.typeText(ctx, "#origin", h.A);
      await h.typeText(ctx, "#selector", "#num");
      await h.typeText(ctx, "#value", value); // leaves the focus in #value
      await h.clearMsg(ctx);
      await h.pressKeys(ctx, [""]); // WebDriver Enter
      const res = await h.waitMsg(ctx);
      eq(res.ok, true, "Enter in #value submits the form");
      const st = await h.extState();
      eq(st.storage[h.A].map((r) => r.value), [value], "stored value");
      await h.expectFilled(`${h.A}/basic.html`, "#num", value);
    },
  },

  {
    name: "T21c a field the page inserts synchronously in response to the first fill is also filled",
    async fn(h) {
      const value = "STEP-SYNC-TEST";
      await h.seedRules({ [h.A]: [{ selector: "input.step", value }] });
      const ctx = await h.openPage(`${h.A}/sync-insert.html`);
      try {
        await h.waitFor(ctx, (v) => document.getElementById("s1").value === v && document.getElementById("s2")?.value === v, 5000, value);
      } catch {
        const got = await h.evalIn(ctx, () => ({ s1: document.getElementById("s1").value.length, s2: document.getElementById("s2")?.value.length ?? null }));
        throw new Error(`expected both steps filled; value lengths: ${JSON.stringify(got)}`);
      }
    },
  },

  {
    name: "T21d a Replace rule with a broad selector leaves range and color inputs untouched",
    async fn(h) {
      const value = "SLIDER-TEST";
      await h.seedRules({ [h.A]: [{ selector: "input", value, overwrite: true }] });
      const ctx = await h.openPage(`${h.A}/sliders.html`);
      await h.waitFor(ctx, (v) => document.getElementById("t").value === v, 5000, value);
      await h.settle(ctx);
      const got = await h.evalIn(ctx, () => ({
        r: document.getElementById("r").value,
        c: document.getElementById("c").value,
        events: window.__events.filter((e) => !e.trusted && (e.id === "r" || e.id === "c")).map((e) => `${e.id}:${e.type}`),
      }));
      eq(got, { r: "30", c: "#ff0000", events: [] }, "range and color keep their values and receive no events");
    },
  },
];
