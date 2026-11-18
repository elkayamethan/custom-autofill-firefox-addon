// T1 (spec §8): fresh install -> no host permissions, no registration, options page opened.
import { EXT_BASE, OPTIONS_URL, eq, ok } from "../lib/harness.mjs";

export const tests = [
  {
    name: "T1 fresh install: no site access, no registration, empty storage, options page opened",
    async fn(h) {
      const s = h.installSnapshot;
      ok(s, "install snapshot was taken right after installing the add-on");
      eq(s.optionsTabOpened, true, "options page opened by runtime.onInstalled(install)");
      ok(s.tabs.some((u) => u.startsWith(OPTIONS_URL)), "an options tab exists after install", s.tabs);
      eq(s.origins, [], "permissions.getAll().origins after install");
      eq([...s.apiPermissions].sort(), ["scripting", "storage"], "API permissions after install");
      eq(s.registered, [], "scripting.getRegisteredContentScripts() after install");
      eq(s.storage, {}, "storage.local after install");
      eq(s.policy, { origins: [`${EXT_BASE}*`], scripts: 0 }, "Firefox policy: allowed origins and content scripts");
    },
  },
];
