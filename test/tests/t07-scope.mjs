// Where rules apply (spec §5.3, §5.4, §5.6): T7 paths, T9 disabled rules, T10 exact origin, T11 frames.
import { eq, ok } from "../lib/harness.mjs";

const LOCAL = "https://localhost/*";

export const tests = [
  {
    name: "T7 paths: exact path, * wildcard, regex characters escaped, case-sensitive, query ignored; non-matching paths not filled; UI path normalized",
    async fn(h) {
      await h.seedRules({ [h.A]: [
        { path: "/p/exact.html", selector: "#f1", value: "PATH-EXACT-TEST" },
        { path: "/p/wild/*", selector: "#f1", value: "PATH-WILD-TEST" },
        { path: "/p/*/mid.html", selector: "#f1", value: "PATH-MID-TEST" },
        { path: "/p/a+b(1).html", selector: "#f1", value: "PATH-REGEX-TEST" },
        { path: "/p/Case.html", selector: "#f1", value: "PATH-CASE-TEST" },
      ] });
      // Typed through the UI: spaces and non-ASCII must be normalized to location.pathname's encoding.
      await h.addRuleViaUI({ origin: h.A, path: "/p/a b/ü.html", selector: "#f1", value: h.v("PATH-UI-TEST") });
      const st = await h.extState();
      eq(st.storage[h.A].at(-1).path, "/p/a%20b/%C3%BC.html", "UI path stored normalized like location.pathname");

      const positives = [
        ["/p/exact.html", "PATH-EXACT-TEST"],
        ["/p/exact.html?x=1#frag", "PATH-EXACT-TEST"],
        ["/p/wild/", "PATH-WILD-TEST"],
        ["/p/wild/x.html", "PATH-WILD-TEST"],
        ["/p/wild/deep/y.html", "PATH-WILD-TEST"],
        ["/p/q/r/mid.html", "PATH-MID-TEST"],
        ["/p/a+b(1).html", "PATH-REGEX-TEST"],
        ["/p/Case.html", "PATH-CASE-TEST"],
        ["/p/a%20b/%C3%BC.html", "PATH-UI-TEST"],
      ];
      for (const [path, value] of positives) await h.expectFilled(`${h.A}${path}`, "#f1", value);
      const negatives = [
        "/p/exact.html.bak", // anchored at the end
        "/p/exactXhtml",     // "." is literal
        "/p/wild",           // "/p/wild/*" needs the slash
        "/p/aab1.html",      // "+" and "()" are literal
        "/p/case.html",      // case-sensitive
        "/p/x/p/exact.html", // anchored at the start
        "/p/other.html",
      ];
      const got = {};
      for (const path of negatives) got[path] = (await h.valuesAfterSettle(`${h.A}${path}`, ["#f1"]))["#f1"];
      eq(got, Object.fromEntries(negatives.map((p) => [p, ""])), "non-matching paths stay empty");
    },
  },

  {
    name: "T9 disabled rule: not applied (and no registration when it is the only rule); applied after re-enabling with the toggle and reloading",
    async fn(h) {
      await h.addRuleViaUI({ origin: h.A, selector: "#text", value: h.v("DISABLED-RULE-TEST"), enabled: false });
      let st = await h.extState();
      eq(st.storage[h.A].map((r) => [r.selector, r.enabled]), [["#text", false]], "rule stored disabled");
      eq(st.origins, [LOCAL], "saving requests site access");
      eq(st.registered, [], "no registration while the only rule is disabled");
      eq((await h.valuesAfterSettle(`${h.A}/basic.html`, ["#text"]))["#text"], "", "disabled rule not applied");

      await h.addRuleViaUI({ origin: h.A, selector: "#email", value: h.v("ENABLED-RULE-TEST@example.invalid") });
      const ctx = await h.expectFilled(`${h.A}/basic.html`, "#email", "ENABLED-RULE-TEST@example.invalid");
      await h.settle(ctx);
      eq(await h.evalIn(ctx, () => document.getElementById("text").value), "", "the disabled rule is skipped while another rule of the origin applies");

      const id = st.storage[h.A][0].id;
      const opt = await h.openOptions();
      eq((await h.uiState()).rows.find((r) => r.id === id)?.enabled, false, "toggle unchecked for the disabled rule");
      await h.realClick(opt, `${h.rowSel(h.A, id)} input.toggle`);
      await h.waitFor(opt, async (o, id) => (await browser.storage.local.get(o))[o].find((r) => r.id === id).enabled === true, 5000, h.A, id);
      st = await h.extState();
      eq(st.registered.map((r) => r.matches), [[LOCAL]], "registration after re-enabling");
      await h.expectFilled(`${h.A}/basic.html`, "#text", "DISABLED-RULE-TEST");
    },
  },

  {
    name: "T10 exact origin: a port-A rule does not fill port B and vice versa; the unconfigured host 127.0.0.1 gets no script and no fill",
    async fn(h) {
      await h.seedRules({ [h.A]: [{ selector: "#text", value: "PORT-A-TEST" }] });
      await h.expectFilled(`${h.A}/basic.html`, "#text", "PORT-A-TEST");
      eq((await h.valuesAfterSettle(`${h.B}/basic.html`, ["#text"]))["#text"], "", "port B not filled by a port-A rule");
      eq(await h.matchesURI(`${h.B}/basic.html`), [true], "the host pattern covers port B (the port is enforced by the script)");
      eq((await h.valuesAfterSettle(`${h.IPA}/basic.html`, ["#text"]))["#text"], "", "127.0.0.1 not filled");
      eq(await h.matchesURI(`${h.IPA}/basic.html`), [false], "no content script for 127.0.0.1");
      eq(await h.matchesURI(`${h.A}/basic.html`), [true], "content script matches the configured origin");

      await h.evalIn(h.optCtx, () => browser.storage.local.clear());
      await h.seedRules({ [h.B]: [{ selector: "#text", value: "PORT-B-TEST" }] });
      await h.expectFilled(`${h.B}/basic.html`, "#text", "PORT-B-TEST");
      eq((await h.valuesAfterSettle(`${h.A}/basic.html`, ["#text"]))["#text"], "", "port A not filled by a port-B rule");
    },
  },

  {
    name: "T11 frames: same-origin iframe filled; configured-origin iframe in an unconfigured page filled; unconfigured and other-port iframes not filled",
    async fn(h) {
      await h.seedRules({ [h.A]: [{ selector: "#f", value: "FRAME-TEST" }] });
      const src = (u) => `src=${encodeURIComponent(u)}`;
      const inner = (o) => `${o}/frame-inner.html`;

      const ctx = await h.openPage(`${h.A}/frames.html?${src(inner(h.A))}&${src(inner(h.IPA))}&${src(inner(h.B))}`);
      await h.waitFor(ctx, () => document.getElementById("f").value === "FRAME-TEST", 5000);
      const frames = await h.frames(ctx);
      eq(frames.map((f) => f.url), [inner(h.A), inner(h.IPA), inner(h.B)], "frame urls");
      await h.waitFor(frames[0].context, () => document.getElementById("f").value === "FRAME-TEST", 5000);
      const others = {};
      for (const f of frames.slice(1)) {
        await h.settle(f.context);
        others[f.url] = await h.evalIn(f.context, () => document.getElementById("f").value);
      }
      eq(others, { [inner(h.IPA)]: "", [inner(h.B)]: "" }, "unconfigured-origin iframes in a configured page");

      const ctx2 = await h.openPage(`${h.IPA}/frames.html?${src(inner(h.A))}`);
      const frames2 = await h.frames(ctx2);
      eq(frames2.map((f) => f.url), [inner(h.A)], "frame urls (unconfigured top page)");
      await h.waitFor(frames2[0].context, () => document.getElementById("f").value === "FRAME-TEST", 5000);
      await h.settle(ctx2);
      eq(await h.evalIn(ctx2, () => document.getElementById("f").value), "", "unconfigured top page not filled");
      ok(true, "done");
    },
  },
];
