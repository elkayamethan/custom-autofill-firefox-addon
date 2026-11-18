// Shared page-side recorder for the fixtures. Records events in window.__events (never logs).
// Each entry: { type, id, gen, desc, trusted, data }, where desc is
// "<type>:<constructor name>[:<inputType>][:bubbles][:composed]".
(() => {
  const log = (window.__events = []);
  const types = ["input", "change", "beforeinput", "focus", "blur", "focusin", "focusout",
    "keydown", "keyup", "keypress", "click", "mousedown", "mouseup", "pointerdown", "pointerup",
    "submit", "reset", "invalid"];
  const describe = (e) => [e.type, e.constructor.name, e.inputType || "", e.bubbles ? "bubbles" : "", e.composed ? "composed" : ""]
    .filter(Boolean).join(":");
  for (const t of types) {
    document.addEventListener(t, (e) => {
      const el = e.target;
      log.push({
        type: e.type,
        id: (el && el.id) || (el && el.nodeName) || "",
        gen: (el && el.dataset && el.dataset.gen) || "",
        desc: describe(e),
        trusted: e.isTrusted,
        data: e.data === undefined ? null : e.data,
      });
    }, true);
  }
  window.__submits = 0;
  document.addEventListener("submit", (e) => { window.__submits++; e.preventDefault(); }, true);
  window.__loadToken = Math.random().toString(36).slice(2);
  window.__eventsFor = (id, gen) => log.filter((x) => x.id === id && (gen === undefined || x.gen === gen)).map((x) => x.desc);
  window.addNodes = (n = 3) => {
    let host = document.getElementById("__extra");
    if (!host) { host = document.createElement("div"); host.id = "__extra"; document.body.append(host); }
    for (let i = 0; i < n; i++) host.append(document.createElement("div"));
  };
})();
