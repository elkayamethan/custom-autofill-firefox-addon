// Optional suite: real React 18 (UMD), React 19 (CJS via a shim) and Vue 3 (global build).
//   FRAMEWORK_LIBS=/path/to/framework-libs node test/run.mjs framework
// Expected layout of FRAMEWORK_LIBS (never copied into the repo):
//   react18/react.production.min.js, react18/react-dom.production.min.js
//   react19/react.production.js, react19/react-dom.production.js, react19/react-dom-client.production.js, react19/scheduler.production.js
//   vue/vue.global.prod.js
// Skipped when FRAMEWORK_LIBS is unset or a build is missing.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq, skip } from "../lib/harness.mjs";

const FRAMEWORKS = [
  { name: "React 18", page: "/fw/react18.html", needs: ["react18/react.production.min.js", "react18/react-dom.production.min.js"] },
  { name: "React 19", page: "/fw/react19.html", needs: ["react19/react.production.js", "react19/react-dom.production.js", "react19/react-dom-client.production.js", "react19/scheduler.production.js"] },
  { name: "Vue 3", page: "/fw/vue3.html", needs: ["vue/vue.global.prod.js"] },
];

export const tests = FRAMEWORKS.map((fw) => ({
  name: `framework: ${fw.name} controlled text, password, textarea and select end up in the framework's state`,
  async fn(h) {
    if (!h.env.FRAMEWORK_LIBS) skip("FRAMEWORK_LIBS is not set");
    const missing = fw.needs.filter((f) => !existsSync(join(h.env.FRAMEWORK_LIBS, f)));
    if (missing.length) skip(`missing builds in FRAMEWORK_LIBS: ${missing.join(", ")}`);
    const want = { text: "FW-TEXT-TEST", pass: "FW-PASS-TEST", area: "FW-AREA-TEST", sel: "fw-opt-b-TEST" };
    await h.seedRules({ [h.A]: Object.entries(want).map(([id, value]) => ({ selector: `#${id}`, value })) });
    const ctx = await h.openPage(`${h.A}${fw.page}`);
    await h.waitFor(ctx, () => !!window.__framework || !!window.__loadError, 8000);
    const loaded = await h.evalIn(ctx, () => window.__framework ?? `load error: ${window.__loadError}`);
    h.info(`loaded ${loaded}`);
    try {
      await h.waitFor(ctx, (w) => { const s = window.__getState?.(); return !!s && Object.entries(w).every(([k, v]) => s[k] === v); }, 6000, want);
    } catch {
      const got = await h.evalIn(ctx, () => ({ state: window.__getState?.() ?? null, dom: Object.fromEntries(["text", "pass", "area", "sel"].map((id) => [id, document.getElementById(id)?.value ?? null])) }));
      throw new Error(`${fw.name} state did not receive the filled values: ${JSON.stringify(got)}`);
    }
    await h.evalIn(ctx, () => window.__rerender());
    await h.settle(ctx);
    const r = await h.evalIn(ctx, () => ({
      state: window.__getState(),
      dom: Object.fromEntries(["text", "pass", "area", "sel"].map((id) => [id, document.getElementById(id).value])),
      rendered: document.getElementById("state").textContent,
      tick: document.getElementById("tick").textContent,
    }));
    eq(r.state, want, `${fw.name} state`);
    eq(r.dom, want, `${fw.name} DOM values after a re-render`);
    eq(JSON.parse(r.rendered), want, `${fw.name} state rendered into the page`);
    eq(r.tick, "1", `${fw.name} re-rendered once`);
  },
}));
