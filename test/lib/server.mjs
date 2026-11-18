// Local HTTPS static server for the end-to-end tests. Two ports on 127.0.0.1, reachable as
// https://localhost:<port> and https://127.0.0.1:<port> (plus any host mapped to loopback by the
// test profile's network.dns.localDomains pref). Sends no CSP and no caching headers.
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Self-signed EC cert. LibreSSL (macOS /usr/bin/openssl) needs ec_param_enc:named_curve, or NSS rejects the key. */
export function makeCert(dir) {
  mkdirSync(dir, { recursive: true });
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const openssl = existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl";
  execFileSync(openssl, [
    "req", "-x509", "-newkey", "ec",
    "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve",
    "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:portal.example.test,DNS:xn--bcher-kva.example",
  ], { stdio: "ignore" });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function safeJoin(root, rel) {
  const p = resolve(root, "." + sep + rel);
  if (p !== root && !p.startsWith(root + sep)) return null;
  return p;
}

/**
 * mounts: { "/vendor/": dir, "/fw/": dir } (optional extra static roots).
 * aliases: [[prefix, file]] -> any path under prefix serves fixturesDir/file (for path/SPA tests).
 */
export async function startServers({ certDir, fixturesDir, mounts = {}, aliases = [] }) {
  const tls = makeCert(certDir);
  const hits = [];
  const root = resolve(fixturesDir);
  const mountList = Object.entries(mounts).filter(([, d]) => d).map(([p, d]) => [p, resolve(d)]);

  const handler = (port) => (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "https://x.invalid").pathname); } catch { pathname = "/"; }
    hits.push({ port, method: req.method, url: req.url, host: req.headers.host, t: Date.now() });
    const send = (code, body, type = "text/plain; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (req.method !== "GET") {
      // Forms in fixtures post here; tests assert that this never happens.
      req.resume();
      return send(200, "<!doctype html><title>submitted</title><p id=submitted>submitted</p>", TYPES[".html"]);
    }
    let file = null;
    for (const [prefix, f] of aliases) {
      if (pathname.startsWith(prefix)) { file = join(root, f); break; }
    }
    if (!file) {
      for (const [prefix, dir] of mountList) {
        if (pathname.startsWith(prefix)) { file = safeJoin(dir, pathname.slice(prefix.length)); break; }
      }
    }
    if (!file && !mountList.some(([p]) => pathname.startsWith(p))) file = safeJoin(root, pathname.slice(1));
    if (!file) return send(404, "not found");
    try {
      const st = statSync(file);
      if (st.isDirectory()) return send(404, "not found");
      return send(200, readFileSync(file), TYPES[extname(file)] || TYPES[".html"]);
    } catch {
      return send(404, "not found");
    }
  };

  const listen = () => new Promise((resolveListen, reject) => {
    const s = createServer(tls);
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.on("request", handler(port));
      resolveListen({ server: s, port });
    });
  });
  const a = await listen();
  const b = await listen();
  const close = async () => {
    for (const { server } of [a, b]) {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  };
  return { portA: a.port, portB: b.port, hits, close };
}
