// T19 performance (spec §2 anti-goals, §5.8): page throughput on a high-churn page with the content
// script active vs not injected; scan cost on a 10k-node DOM; the event page stays asleep.
import { EXT_ID, eq, ok, sleep } from "../lib/harness.mjs";

const RULES = [
  { selector: "#perf-probe", value: "PERF-PROBE-TEST" },
  { selector: "input[name=user]", value: "PERF-USER-TEST" },
  { selector: "#idNumber", value: "PERF-ID-TEST" },
  { selector: "form.login input[type=password]", value: "PERF-PASS-TEST" },
  { selector: "select#country", value: "PERF-COUNTRY-TEST" },
];
const RUN_MS = 2000;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (x) => `${(x * 100).toFixed(2)}%`;

async function clearAll(h) {
  await h.evalIn(h.optCtx ?? (await h.openOptions({ activate: false })), async () => {
    await browser.storage.local.clear();
    await browser.scripting.unregisterContentScripts();
  });
}

async function measure(h, active) {
  await h.openOptions({ activate: false });
  if (active) await h.seedRules({ [h.A]: RULES });
  else await clearAll(h);
  const url = `${h.A}/stress.html`;
  eq((await h.matchesURI(url)).some(Boolean), active, `content script ${active ? "registered" : "absent"} for the stress page`);
  const ctx = await h.openPage(url);
  if (active) await h.waitFor(ctx, () => document.getElementById("perf-probe").value === "PERF-PROBE-TEST", 5000);
  else await sleep(400);
  await h.evalIn(ctx, () => window.runWorkload(300)); // warm-up
  const r = await h.evalIn(ctx, (ms) => window.runWorkload(ms), RUN_MS);
  if (!active) eq(await h.evalIn(ctx, () => document.getElementById("perf-probe").value), "", "inactive run really had no content script");
  return r;
}

export const tests = [
  {
    name: "T19 performance: high-churn page throughput with the content script active vs not injected (fails above 5% slowdown); 10k-node scan cost",
    timeoutMs: 120000,
    async fn(h) {
      const order = [false, true, true, false, false, true];
      const runs = { true: [], false: [] };
      for (const active of order) runs[active].push(await measure(h, active));
      const itA = runs.true.map((r) => r.iters), itI = runs.false.map((r) => r.iters);
      const bestA = Math.max(...itA), bestI = Math.max(...itI);
      const medA = median(itA), medI = median(itI);
      const slowBest = 1 - bestA / bestI, slowMed = 1 - medA / medI;
      const churn = runs.true[0];
      h.info(`stress page: ${RUN_MS} ms per run, ~${Math.round(churn.inserted / (churn.elapsed / 1000))} insertions/s and ~${Math.round(churn.removed / (churn.elapsed / 1000))} removals/s plus text updates, ~5,000 static nodes`);
      h.info(`busy-loop iterations, active (rules for the origin): ${itA.join(", ")} | best ${bestA}, median ${medA}`);
      h.info(`busy-loop iterations, inactive (no content script): ${itI.join(", ")} | best ${bestI}, median ${medI}`);
      h.info(`slowdown: best-of-3 ${pct(slowBest)}, median ${pct(slowMed)} (limit 5%)`);
      h.perf = { itA, itI, bestA, bestI, medA, medI, slowBest, slowMed };

      // One full set of the rules' queries on a 10k-node DOM (page realm, same selectors).
      await clearAll(h);
      const ctx = await h.openPage(`${h.A}/bigdom.html`);
      const scan = await h.evalIn(ctx, (sels) => {
        const run = () => { let n = 0; for (const s of sels) n += document.querySelectorAll(s).length; return n; };
        for (let i = 0; i < 20; i++) run();
        const N = 200, times = [];
        for (let k = 0; k < 5; k++) {
          const t0 = performance.now();
          for (let i = 0; i < N; i++) run();
          times.push((performance.now() - t0) / N);
        }
        times.sort((a, b) => a - b);
        return { nodes: document.getElementsByTagName("*").length, matched: run(), perScanMs: times[2] };
      }, RULES.map((r) => r.selector));
      ok(scan.nodes >= 10000, "big DOM has at least 10k nodes", scan.nodes);
      h.info(`one full scan (${RULES.length} rule queries) on a ${scan.nodes}-node DOM: ${(scan.perScanMs * 1000).toFixed(1)} µs (median of 5 x 200 runs, page realm)`);
      h.perf.scan = scan;

      ok(slowBest <= 0.05, `throughput slowdown with the content script active is at most 5% (best-of-3 ${pct(slowBest)}, median ${pct(slowMed)})`);
    },
  },

  {
    name: "T19c observer throttle: with a new field every 10 ms, fills come in scans at most ~10 per second, at least ~100 ms apart, each field once",
    async fn(h) {
      await h.seedRules({ [h.A]: [{ selector: "input.burst", value: "BURST-TEST" }] });
      const ctx = await h.openPage(`${h.A}/throttle.html`);
      await sleep(300);
      const ins = await h.evalIn(ctx, (ms) => window.runInsertions(ms), 2000);
      await h.settle(ctx);
      const r = await h.evalIn(ctx, () => {
        const fills = window.__fills;
        const batches = [];
        for (const f of fills) {
          const last = batches.at(-1);
          if (last && f.t - last.end < 20) { last.end = f.t; last.n++; } else batches.push({ start: f.t, end: f.t, n: 1 });
        }
        const values = [...document.querySelectorAll("input.burst")].map((i) => i.value);
        return {
          fills: fills.length, unique: new Set(fills.map((f) => f.id)).size, fields: values.length,
          allFilled: values.every((v) => v === "BURST-TEST"), batches: batches.length,
          gaps: batches.slice(1).map((b, i) => Math.round(b.start - batches[i].start)),
        };
      });
      const rate = r.batches / (ins.elapsed / 1000);
      h.info(`inserted ${ins.inserted} fields in ${Math.round(ins.elapsed)} ms; filled in ${r.batches} scans (${rate.toFixed(1)}/s); gaps between scans ${Math.min(...r.gaps)}-${Math.max(...r.gaps)} ms`);
      eq({ allFilled: r.allFilled, fills: r.fills, unique: r.unique }, { allFilled: true, fills: r.fields, unique: r.fields }, "every inserted field filled exactly once");
      ok(rate <= 12, "at most about 10 scans per second", rate);
      ok(Math.min(...r.gaps) >= 90, "scans are at least ~100 ms apart", r.gaps);
    },
  },

  {
    name: "T19b the event page stays asleep while configured and unconfigured pages load and rules are saved, toggled and deleted",
    async fn(h) {
      const state = () => h.chrome((id) => WebExtensionPolicy.getByID(id)?.extension?.backgroundState ?? null, EXT_ID);
      const initial = await state();
      ok(["running", "stopped", "suspending", "starting"].includes(initial), "background state is readable", initial);
      try {
        await h.waitFor("chrome", (id) => WebExtensionPolicy.getByID(id).extension.backgroundState === "stopped", 12000, EXT_ID);
      } catch {
        throw new Error(`the event page did not go to sleep within 12 s (idle timeout 3 s); state: ${await state()}`);
      }
      const seen = new Set();
      const note = async (label) => { const s = await state(); seen.add(`${label}:${s}`); return s; };
      await h.addRuleViaUI({ origin: h.A, selector: "#text", value: h.v("ASLEEP-TEST") });
      await note("after saving a rule");
      await h.expectFilled(`${h.A}/basic.html`, "#text", "ASLEEP-TEST");
      await note("after a configured page filled");
      await h.valuesAfterSettle(`${h.IPA}/basic.html`, ["#text"]);
      await note("after an unconfigured page loaded");
      const opt = await h.openOptions();
      const id = (await h.extState()).storage[h.A][0].id;
      await h.realClick(opt, `${h.rowSel(h.A, id)} input.toggle`);
      await sleep(300);
      await note("after toggling");
      await h.clickWithConfirm(opt, `${h.rowSel(h.A, id)} button.delete`, true);
      await sleep(500);
      await note("after deleting");
      eq([...seen].filter((s) => !s.endsWith(":stopped")), [], "background state during browsing and options-page use");
    },
  },
];
