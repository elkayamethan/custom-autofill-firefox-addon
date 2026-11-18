#!/usr/bin/env node
// End-to-end test runner for the Custom Autofill add-on (dev-only, never packaged).
//
//   node test/run.mjs [filter]
//
// Runs every test whose name contains `filter` (all tests when omitted) in ONE headless Firefox
// with a throwaway profile, resetting extension state between tests. Lifecycle tests
// (upgrade/downgrade/disable/uninstall) run after the others; whole-run privacy checks run last.
// Prints PASS/FAIL/SKIP <name> (<ms>) per test and a summary. Exit code 0 only if at least one
// test ran and none failed.
//
// Environment:
//   EXTENSION_DIR   extension directory to test (default: <repo>/extension)
//   FIREFOX_BIN     Firefox binary (default: /Applications/Firefox.app/Contents/MacOS/firefox)
//   FRAMEWORK_LIBS  directory with real React/Vue builds (optional framework suite; see test/frameworks)
//   TEST_TMPDIR     where temp files go (default: os.tmpdir())
//   RESULTS_JSON    optional path for a machine-readable copy of the results
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServers } from "./lib/server.mjs";
import { SkipError, sleep, startFirefox } from "./lib/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EXTENSION_DIR = resolve(process.env.EXTENSION_DIR || join(ROOT, "extension"));
const FRAMEWORK_LIBS = process.env.FRAMEWORK_LIBS ? resolve(process.env.FRAMEWORK_LIBS) : null;
const TMP_BASE = process.env.TEST_TMPDIR || os.tmpdir();
const filter = process.argv[2] || "";
const PHASES = ["main", "lifecycle", "final"];

async function loadTests() {
  const out = [];
  for (const dir of ["tests", "frameworks"]) {
    const d = join(HERE, dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith(".mjs")).sort()) {
      const mod = await import(pathToFileURL(join(d, f)).href);
      for (const t of mod.tests ?? []) out.push({ phase: "main", timeoutMs: 60000, ...t, file: `${dir}/${f}` });
    }
  }
  return out;
}

const withTimeout = (p, ms, what) => {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what}: timed out after ${ms} ms`)), ms); }),
  ]);
};

async function snapshotAfterInstall(h, inst) {
  if (inst.optionsTab) h.optCtx = inst.optionsTab;
  await sleep(700); // let the background's top-level sync settle
  const policy = await h.chrome((id) => {
    const p = WebExtensionPolicy.getByID(id);
    return p && { origins: p.allowedOrigins.patterns.map((x) => x.pattern), scripts: p.contentScripts.length };
  }, "custom-autofill@96717d3ecdad");
  const ctx = await h.openOptions({ activate: false });
  const st = await h.extState();
  const apiPermissions = await h.evalIn(ctx, async () => (await browser.permissions.getAll()).permissions);
  return { optionsTabOpened: !!inst.optionsTab, ...st, apiPermissions, policy, tabs: (await h.tabs()).map((c) => c.url) };
}

async function main() {
  const all = await loadTests();
  const filters = filter.split("|"); // "T5d|T9b" runs every test whose name contains either part
  const selected = all
    .filter((t) => filters.some((f) => t.name.includes(f)))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => PHASES.indexOf(a.t.phase) - PHASES.indexOf(b.t.phase) || a.i - b.i)
    .map(({ t }) => t);
  if (!selected.length) {
    console.log(`No test name contains "${filter}".`);
    return 1;
  }
  console.log(`Custom Autofill e2e: ${selected.length} test(s); extension: ${EXTENSION_DIR}`);
  const results = [];
  let tmpRoot, server, h;
  let interrupted = false;
  const cleanup = async () => {
    if (h) { await h.close().catch(() => {}); h = null; }
    if (server) { await server.close().catch(() => {}); server = null; }
    if (tmpRoot) { rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = null; }
  };
  const onSignal = () => { interrupted = true; cleanup().finally(() => process.exit(130)); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const runStart = Date.now();
  try {
    tmpRoot = mkdtempSync(join(TMP_BASE, "caf-e2e-"));
    server = await startServers({
      certDir: join(tmpRoot, "cert"),
      fixturesDir: join(HERE, "fixtures"),
      mounts: { "/fw/": join(HERE, "frameworks"), "/vendor/": FRAMEWORK_LIBS },
      aliases: [["/p/", "generic.html"], ["/spa/", "spa.html"]],
    });
    h = await startFirefox({ tmpRoot, server });
    h.env = { EXTENSION_DIR, FRAMEWORK_LIBS, ROOT, HERE, server };
    // Content-process instrumentation for the whole run (storage reads and console calls of content
    // scripts and extension pages). Loaded before the add-on so nothing escapes it. Tests that rely on
    // it fail with this error instead of passing vacuously.
    try { await h.installProcessSpy(); } catch (e) { h.spyError = e; }
    let installError = null;
    try {
      if (!existsSync(join(EXTENSION_DIR, "manifest.json"))) throw new Error(`no manifest.json in ${EXTENSION_DIR}`);
      const inst = await h.installExtension(EXTENSION_DIR, { waitForOptionsMs: 5000 });
      h.installedVersion = (await h.chrome((id) => WebExtensionPolicy.getByID(id)?.extension?.version ?? null, "custom-autofill@96717d3ecdad"));
      h.installSnapshot = await snapshotAfterInstall(h, inst);
    } catch (e) {
      installError = e;
    }
    for (const t of selected) {
      if (interrupted) break;
      h.currentTest = t.name;
      h.infoLines = [];
      const start = Date.now();
      let status = "PASS", detail = "";
      try {
        if (installError && !t.noExtension) throw new Error(`extension install failed: ${installError.message}`);
        if (!t.noReset) await withTimeout(h.resetState(), 60000, "resetState");
        await withTimeout(Promise.resolve().then(() => t.fn(h)), t.timeoutMs, t.name);
      } catch (e) {
        if (e instanceof SkipError) { status = "SKIP"; detail = e.message; }
        else { status = "FAIL"; detail = e?.stack?.split("\n").slice(0, 3).join(" | ") || String(e); }
      }
      const ms = Date.now() - start;
      results.push({ name: t.name, status, ms, detail, info: h.infoLines, file: t.file });
      console.log(`${status.padEnd(4)} ${t.name} (${ms} ms)`);
      for (const line of h.infoLines) console.log(`       ${line}`);
      if (detail) console.log(`       ${status === "SKIP" ? "reason" : "error"}: ${detail}`);
    }
  } catch (e) {
    console.log(`HARNESS ERROR: ${e?.stack || e}`);
    results.push({ name: "(harness)", status: "FAIL", ms: 0, detail: String(e?.message || e), info: [] });
  } finally {
    await cleanup();
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  const passed = count("PASS"), failed = count("FAIL"), skipped = count("SKIP");
  const secs = ((Date.now() - runStart) / 1000).toFixed(1);
  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} total) in ${secs} s`);
  if (process.env.RESULTS_JSON) {
    writeFileSync(process.env.RESULTS_JSON, JSON.stringify({ extensionDir: EXTENSION_DIR, filter, passed, failed, skipped, total: results.length, seconds: Number(secs), results }, null, 2));
  }
  return failed === 0 && passed + skipped > 0 && results.length === selected.length ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => { console.log(e?.stack || e); process.exit(1); });

