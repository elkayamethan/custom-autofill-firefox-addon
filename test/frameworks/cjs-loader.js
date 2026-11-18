// Tiny CommonJS shim for loading React 19's CJS production builds in a page (served under /fw/).
// The test server sends no CSP, so `new Function` is allowed here.
window.loadCjs = async (list) => {
  const mods = {};
  const require = (name) => {
    if (!(name in mods)) throw new Error("module not loaded: " + name);
    return mods[name];
  };
  for (const [name, url] of list) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cannot load ${url}: ${res.status}`);
    const src = await res.text();
    const module = { exports: {} };
    new Function("module", "exports", "require", "process", src)(module, module.exports, require, { env: { NODE_ENV: "production" } });
    mods[name] = module.exports;
  }
  return mods;
};
