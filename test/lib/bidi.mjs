// Minimal zero-dependency WebDriver BiDi client and headless Firefox launcher.
// Node >= 22 (global WebSocket). Dev-only test code; never packaged.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const FIREFOX_BIN = process.env.FIREFOX_BIN || "/Applications/Firefox.app/Contents/MacOS/firefox";

export class BiDi {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Set();
  closed = false;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined && this.#pending.has(msg.id)) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === "error") {
          p.reject(Object.assign(new Error(`${p.method}: ${msg.error}: ${msg.message}`), { bidi: msg }));
        } else {
          p.resolve(msg.result);
        }
      } else if (msg.type === "event") {
        for (const fn of [...this.#listeners]) {
          try { fn(msg); } catch { /* listener errors must not break the client */ }
        }
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`${p.method}: BiDi socket closed`));
      }
      this.#pending.clear();
    });
  }

  static connect(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("BiDi connect timeout")); }, timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(new BiDi(ws)); }, { once: true });
      ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error("BiDi socket error: " + (e.message || e.type))); }, { once: true });
    });
  }

  send(method, params = {}, { timeoutMs = 60000 } = {}) {
    if (this.closed) return Promise.reject(new Error(`${method}: BiDi socket closed`));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method}: no response after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, method, timer });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  onEvent(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  close() {
    try { this.#ws.close(); } catch {}
  }
}

/**
 * Launch headless Firefox with a fresh throwaway profile under baseDir.
 * Always headless; never touches any other profile.
 */
export async function launchFirefox({ baseDir, prefs = {}, systemAccess = true, onLine = () => {} }) {
  const profile = mkdtempSync(join(baseDir, "ff-profile-"));
  const userJs = Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n");
  writeFileSync(join(profile, "user.js"), userJs + "\n");
  const env = { ...process.env };
  // Only this throwaway instance gets system access (moz-extension navigation and chrome scope).
  if (systemAccess) env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";
  else delete env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS;
  delete env.MOZ_HEADLESS_WIDTH;
  const args = ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0"];
  const proc = spawn(FIREFOX_BIN, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const remember = (l) => { lines.push(l); if (lines.length > 400) lines.shift(); onLine(l); };
  let exited = false;
  const exitPromise = new Promise((r) => proc.once("exit", (code, sig) => { exited = true; r({ code, sig }); }));

  let wsUrl;
  try {
    wsUrl = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for 'WebDriver BiDi listening' line")), 30000);
      let buf = "";
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          remember(line);
          const m = line.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
          if (m) { clearTimeout(t); resolve(m[1]); }
        }
      });
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (d) => { for (const l of d.split("\n")) if (l) remember("[stdout] " + l); });
      proc.once("exit", (code, sig) => { clearTimeout(t); reject(new Error(`firefox exited early (code=${code} sig=${sig})`)); });
      proc.once("error", (e) => { clearTimeout(t); reject(e); });
    });
  } catch (e) {
    await killProc(proc, exitPromise, () => exited);
    rmSync(profile, { recursive: true, force: true });
    throw new Error(`${e.message}\n--- firefox output ---\n${lines.slice(-30).join("\n")}`);
  }

  let cleaned = false;
  const kill = async () => {
    if (cleaned) return;
    cleaned = true;
    await killProc(proc, exitPromise, () => exited);
    rmSync(profile, { recursive: true, force: true });
  };
  return { proc, profile, wsUrl, lines, kill, exitPromise, isRunning: () => !exited };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function killProc(proc, exitPromise, isExited) {
  const pid = proc.pid;
  if (!(isExited() || proc.exitCode !== null || proc.signalCode !== null)) {
    // Give a graceful browser.close (sent by the caller) a moment to finish first.
    const graceful = await Promise.race([exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    if (!graceful) {
      try { proc.kill("SIGTERM"); } catch {}
      const termed = await Promise.race([exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
      if (!termed) {
        try { proc.kill("SIGKILL"); } catch {}
        await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
      }
    }
  }
  // Make sure the process is really gone before the caller deletes the profile.
  for (let i = 0; i < 50 && pid && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
}
