// Shared React test app for react18.html and react19.html (served under /fw/).
// Controlled text input, password input, textarea and select; state is exposed on window and
// rendered into #state.
window.mountReactApp = (React, createRoot, label) => {
  const e = React.createElement;
  let latest = null;
  window.__getState = () => latest;
  function App() {
    const [s, setS] = React.useState({ text: "", pass: "", area: "", sel: "" });
    const [tick, setTick] = React.useState(0);
    latest = s;
    window.__rerender = () => setTick((t) => t + 1);
    const bind = (k) => ({ value: s[k], onChange: (ev) => { const v = ev.target.value; setS((p) => ({ ...p, [k]: v })); } });
    return e("form", { id: "f", onSubmit: (ev) => ev.preventDefault() },
      e("input", { id: "text", name: "text", ...bind("text") }),
      e("input", { id: "pass", name: "pass", type: "password", ...bind("pass") }),
      e("textarea", { id: "area", name: "area", ...bind("area") }),
      e("select", { id: "sel", name: "sel", ...bind("sel") },
        e("option", { value: "" }, "--"),
        e("option", { value: "fw-opt-b-TEST" }, "Beta")),
      e("pre", { id: "state" }, JSON.stringify(s)),
      e("span", { id: "tick" }, String(tick)));
  }
  createRoot(document.getElementById("root")).render(e(App));
  window.__framework = `React ${label} (${React.version})`;
};
