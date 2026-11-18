// T16 (spec §5.5, §6): upgrade, downgrade, same-version reinstall, disable/enable and uninstall.
// Registration must come back WITHOUT the test opening the options page (which also repairs it),
// storage and permissions must be preserved, filling must work, and only a fresh install opens
// the options page. These run after every other test.
import { EXT_ID, OPTIONS_URL, eq, ok, sleep } from "../lib/harness.mjs";

const LOCAL = "https://localhost/*";

async function seed(h, value) {
  await h.seedRules({ [h.A]: [{ selector: "#text", value }] });
  await h.expectFilled(`${h.A}/basic.html`, "#text", value);
  return (await h.extState()).storage;
}

async function policyMatches(h, timeoutMs) {
  try {
    return await h.waitFor("chrome", (id) => {
      const p = WebExtensionPolicy.getByID(id);
      if (!p || !p.active || !p.contentScripts.length) return null;
      return p.contentScripts.map((s) => s.matches.patterns.map((x) => x.pattern));
    }, timeoutMs, EXT_ID);
  } catch {
    return await h.chrome((id) => {
      const p = WebExtensionPolicy.getByID(id);
      return p ? p.contentScripts.map((s) => s.matches.patterns.map((x) => x.pattern)) : "no policy";
    }, EXT_ID);
  }
}

async function checkAfter(h, label, { storage, value, tabsBefore }) {
  const matches = await policyMatches(h, 6000);
  eq(matches, [[LOCAL]], `${label}: registration restored by the add-on itself`);
  await sleep(700);
  const opened = (await h.tabs()).filter((c) => c.url.startsWith(OPTIONS_URL) && !tabsBefore.has(c.context));
  eq(opened.length, 0, `${label}: the options page is not opened`);
  await h.expectFilled(`${h.A}/basic.html`, "#text", value);
  const st = await h.extState();
  eq(st.storage, storage, `${label}: storage preserved`);
  eq(st.origins, [LOCAL], `${label}: site access preserved`);
  eq(st.registered.map((r) => [r.id, r.matches]), [["autofill", [LOCAL]]], `${label}: registered content script`);
}

const tabSet = async (h) => new Set((await h.tabs()).map((c) => c.context));

export const tests = [
  {
    name: "T16a lifecycle upgrade (higher version installed over it): registration restored, storage and access kept, filling works",
    phase: "lifecycle",
    timeoutMs: 90000,
    async fn(h) {
      const value = "LIFE-UPGRADE-TEST";
      const storage = await seed(h, value);
      const tabsBefore = await tabSet(h);
      const version = `${h.installedVersion}.1`;
      await h.installExtension(h.extCopy(h.env.EXTENSION_DIR, version));
      h.installedVersion = version;
      await checkAfter(h, `upgrade to ${version}`, { storage, value, tabsBefore });
    },
  },
  {
    name: "T16b lifecycle downgrade (lower version, no onInstalled): registration restored, storage and access kept, filling works",
    phase: "lifecycle",
    timeoutMs: 90000,
    async fn(h) {
      const value = "LIFE-DOWNGRADE-TEST";
      const storage = await seed(h, value);
      const tabsBefore = await tabSet(h);
      await h.installExtension(h.extCopy(h.env.EXTENSION_DIR, "0.0.1"));
      h.installedVersion = "0.0.1";
      await checkAfter(h, "downgrade to 0.0.1", { storage, value, tabsBefore });
    },
  },
  {
    name: "T16c lifecycle same-version reinstall (about:debugging Reload): registration restored, storage and access kept, filling works",
    phase: "lifecycle",
    timeoutMs: 90000,
    async fn(h) {
      const value = "LIFE-RELOAD-TEST";
      const storage = await seed(h, value);
      const tabsBefore = await tabSet(h);
      await h.installExtension(h.extCopy(h.env.EXTENSION_DIR, h.installedVersion));
      await checkAfter(h, `reinstall of ${h.installedVersion}`, { storage, value, tabsBefore });
    },
  },
  {
    name: "T16d lifecycle disable then enable: registration restored, storage and access kept, filling works",
    phase: "lifecycle",
    timeoutMs: 90000,
    async fn(h) {
      const value = "LIFE-ENABLE-TEST";
      const storage = await seed(h, value);
      const tabsBefore = await tabSet(h);
      const active = await h.chrome(async (id) => {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const a = await AddonManager.getAddonByID(id);
        await a.disable();
        const whileDisabled = a.isActive;
        await a.enable();
        return { whileDisabled, after: a.isActive };
      }, EXT_ID);
      eq(active, { whileDisabled: false, after: true }, "add-on disabled then enabled");
      await checkAfter(h, "disable/enable", { storage, value, tabsBefore });
    },
  },
  {
    name: "T16e lifecycle uninstall then install: nothing left running; the new install opens the options page with no access and no registration",
    phase: "lifecycle",
    timeoutMs: 90000,
    async fn(h) {
      await seed(h, "LIFE-UNINSTALL-TEST");
      await h.bidi.send("webExtension.uninstall", { extension: EXT_ID });
      eq(await h.chrome((id) => WebExtensionPolicy.getByID(id) ? "present" : "gone", EXT_ID), "gone", "policy after uninstall");
      eq((await h.valuesAfterSettle(`${h.A}/basic.html`, ["#text"]))["#text"], "", "no fill after uninstall");
      const inst = await h.installExtension(h.env.EXTENSION_DIR, { waitForOptionsMs: 5000 });
      h.installedVersion = await h.chrome((id) => WebExtensionPolicy.getByID(id)?.extension?.version ?? null, EXT_ID);
      ok(inst.optionsTab, "the new install opened the options page");
      h.optCtx = inst.optionsTab;
      await sleep(700);
      const st = await h.extState();
      eq({ origins: st.origins, registered: st.registered }, { origins: [], registered: [] }, "fresh install state");
    },
  },
];
