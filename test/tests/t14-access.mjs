// Site access lifecycle (spec §5.4, §5.7 flows): T14 delete, T15 access revoked outside the options page.
import { eq, ok, sleep } from "../lib/harness.mjs";

const LOCAL = "https://localhost/*";

export const tests = [
  {
    name: "T14 delete: confirm is required; deleting a host's last rule removes permission and registration; a rule on another port of the host keeps them",
    async fn(h) {
      await h.addRuleViaUI({ origin: h.A, selector: "#text", value: h.v("DEL-A-TEST") });
      await h.addRuleViaUI({ origin: h.B, selector: "#text", value: h.v("DEL-B-TEST") });
      let st = await h.extState();
      const ra = st.storage[h.A][0], rb = st.storage[h.B][0];
      const opt = await h.openOptions();

      const text1 = await h.clickWithConfirm(opt, `${h.rowSel(h.A, ra.id)} button.delete`, false);
      eq(text1, "Delete this rule?", "confirm text");
      await sleep(300);
      st = await h.extState();
      eq(Object.keys(st.storage).sort(), [h.A, h.B].sort(), "cancelled delete changes nothing");

      await h.clickWithConfirm(opt, `${h.rowSel(h.A, ra.id)} button.delete`, true);
      await h.waitFor(opt, (a) => browser.storage.local.get(null).then((all) => !(a in all)), 5000, h.A);
      st = await h.extState();
      eq(st.storage, { [h.B]: [rb] }, "storage after deleting port A's only rule (its key is removed)");
      eq(st.origins, [LOCAL], "permission kept: port B of the same host still has a rule");
      eq(st.registered.map((r) => r.matches), [[LOCAL]], "registration kept");
      await h.openOptions();
      await h.waitFor(opt, () => document.querySelectorAll("#rules tbody tr[data-id]").length === 1, 3000);
      await h.expectFilled(`${h.B}/basic.html`, "#text", "DEL-B-TEST");
      eq((await h.valuesAfterSettle(`${h.A}/basic.html`, ["#text"]))["#text"], "", "deleted rule no longer fills");

      // Editing a rule and then deleting it cancels the edit.
      await h.openOptions();
      await h.realClick(opt, `${h.rowSel(h.B, rb.id)} button.edit`);
      await h.waitFor(opt, () => document.querySelector("#form-title")?.textContent.trim() === "Edit rule", 3000);
      await h.clickWithConfirm(opt, `${h.rowSel(h.B, rb.id)} button.delete`, true);
      await h.waitFor(opt, () => browser.storage.local.get(null).then((all) => Object.keys(all).length === 0), 5000);
      st = await h.extState();
      eq(st.storage, {}, "storage after deleting the last rule");
      eq(st.origins, [], "permission removed with the host's last rule");
      eq(await h.contains(LOCAL), false, "permissions.contains after the last delete");
      eq(st.registered, [], "registration removed");
      const ui = await h.uiState();
      eq({ title: ui.formTitle, save: ui.saveText, cancel: ui.cancelVisible, rows: ui.rows.length, empty: ui.emptyVisible },
        { title: "Add a rule", save: "Add rule", cancel: false, rows: 0, empty: true }, "deleting the edited rule cancels the edit");
      eq((await h.valuesAfterSettle(`${h.B}/basic.html`, ["#text"]))["#text"], "", "next load after the last delete is not filled");
      eq(await h.matchesURI(`${h.B}/basic.html`), [], "no content script left");
    },
  },

  {
    name: "T15 revoked externally: the next load is not filled, the options page shows Grant access, and Grant restores filling",
    async fn(h) {
      await h.addRuleViaUI({ origin: h.A, selector: "#text", value: h.v("REVOKE-TEST") });
      await h.expectFilled(`${h.A}/basic.html`, "#text", "REVOKE-TEST");
      await h.revokeOrigins([LOCAL]); // same call as the about:addons per-site toggle
      eq(await h.contains(LOCAL), false, "permission revoked");
      eq((await h.valuesAfterSettle(`${h.A}/basic.html`, ["#text"]))["#text"], "", "next load after revoking is not filled");
      eq(await h.matchesURI(`${h.A}/basic.html`), [false], "registration stays but no longer matches");

      const opt = await h.openOptions();
      const id = (await h.extState()).storage[h.A][0].id;
      const grantSel = `${h.rowSel(h.A, id)} td.origin button.grant`;
      await h.waitFor(opt, (s) => !!document.querySelector(s), 5000, grantSel);
      eq((await h.uiState()).rows.map((r) => [r.grant, r.grantText]), [[true, "Grant access"]], "row shows Grant access");
      await h.realClick(opt, grantSel);
      await h.waitFor(opt, (p) => browser.permissions.contains({ origins: [p] }), 5000, LOCAL);
      await h.waitFor(opt, (s) => !document.querySelector(s), 5000, grantSel);
      eq((await h.extState()).registered.map((r) => r.matches), [[LOCAL]], "registration unchanged");
      await h.expectFilled(`${h.A}/basic.html`, "#text", "REVOKE-TEST");
      ok(true, "done");
    },
  },
];
