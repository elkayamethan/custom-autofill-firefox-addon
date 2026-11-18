// Options page editing (spec §5.7): T17 edit/toggle/mask/reload, T17b double submit.
import { MASK, eq, sleep } from "../lib/harness.mjs";

const LOCAL = "https://localhost/*";
const IP = "https://127.0.0.1/*";

export const tests = [
  {
    name: "T17 edit value, path and origin (id and position kept; moving releases the unused host); toggle; Show values; state survives reload",
    timeoutMs: 90000,
    async fn(h) {
      const v1 = h.v("EDIT-ONE-TEST");
      const v2 = h.v("EDIT-TWO-TEST-A-MUCH-LONGER-VALUE-1234567890");
      await h.addRuleViaUI({ origin: h.A, selector: "#text", value: v1 });
      await h.addRuleViaUI({ origin: h.A, path: "/basic.html", selector: "#email", value: v2, overwrite: true });
      let st = await h.extState();
      const [r1, r2] = st.storage[h.A];
      eq([r1.selector, r2.selector], ["#text", "#email"], "rules kept in creation order");
      eq(r2, { id: r2.id, path: "/basic.html", selector: "#email", value: v2, enabled: true, overwrite: true }, "second rule");
      const opt = await h.openOptions();

      // Masking
      let ui = await h.uiState();
      eq(ui.rows.map((r) => [r.value, r.path, r.overwrite]), [[MASK, "any", "no"], [MASK, "/basic.html", "yes"]], "values masked regardless of length");
      await h.setCheckbox(opt, "#show-values", true);
      await h.waitFor(opt, (want) => JSON.stringify([...document.querySelectorAll("#rules tbody tr[data-id] td.value")].map((td) => td.textContent.trim())) === JSON.stringify(want), 3000, [v1, v2]);
      ui = await h.uiState();
      eq({ cls: ui.valueMasked, css: ui.valueTextSecurity }, { cls: false, css: "none" }, "#value unmasked with Show values");
      await h.setCheckbox(opt, "#show-values", false);
      await h.waitFor(opt, (m) => [...document.querySelectorAll("#rules tbody tr[data-id] td.value")].every((td) => td.textContent.trim() === m), 3000, MASK);
      ui = await h.uiState();
      eq({ cls: ui.valueMasked, css: ui.valueTextSecurity }, { cls: true, css: "disc" }, "#value masked again");

      // Edit mode, then Cancel
      await h.realClick(opt, `${h.rowSel(h.A, r1.id)} button.edit`);
      await h.waitFor(opt, () => document.querySelector("#form-title")?.textContent.trim() === "Edit rule", 3000);
      ui = await h.uiState();
      eq({ save: ui.saveText, cancel: ui.cancelVisible, fields: ui.fields },
        { save: "Save changes", cancel: true, fields: { origin: h.A, path: "", selector: "#text", value: v1, overwrite: false, enabled: true } },
        "edit form populated from the rule");
      await h.realClick(opt, "#cancel");
      await h.waitFor(opt, () => document.querySelector("#form-title")?.textContent.trim() === "Add a rule", 3000);
      ui = await h.uiState();
      eq({ save: ui.saveText, cancel: ui.cancelVisible, fields: ui.fields },
        { save: "Add rule", cancel: false, fields: { origin: "", path: "", selector: "", value: "", overwrite: false, enabled: true } }, "after Cancel");
      eq((await h.extState()).storage, { [h.A]: [r1, r2] }, "Cancel changes nothing");

      // Edit value and path
      const v1b = h.v("EDITED-VALUE-TEST");
      await h.editRuleViaUI(h.A, r1.id, { value: v1b, path: "/basic.html" });
      const r1b = { ...r1, value: v1b, path: "/basic.html" };
      st = await h.extState();
      eq(st.storage, { [h.A]: [r1b, r2] }, "edit keeps the id and the position");
      await h.expectFilled(`${h.A}/basic.html`, "#text", v1b);

      // Move r1 to another host: localhost is still used by r2
      await h.editRuleViaUI(h.A, r1.id, { origin: h.IPA });
      st = await h.extState();
      eq(st.storage, { [h.A]: [r2], [h.IPA]: [r1b] }, "rule moved between origin keys with its id");
      eq([...st.origins].sort(), [IP, LOCAL], "both hosts have access while both are used");
      eq(st.registered.map((r) => r.matches), [[IP, LOCAL]], "registration covers both hosts");

      // Move r2 as well: localhost is now unused and must be released
      await h.editRuleViaUI(h.A, r2.id, { origin: h.IPA });
      st = await h.extState();
      eq(st.storage, { [h.IPA]: [r1b, r2] }, "both rules under 127.0.0.1; the old key is removed");
      eq(st.origins, [IP], "old host released once no rule uses it");
      eq(await h.contains(LOCAL), false, "permissions.contains(localhost) after the move");
      eq(st.registered.map((r) => r.matches), [[IP]], "registration follows the move");
      await h.expectFilled(`${h.IPA}/basic.html`, "#text", v1b);
      eq((await h.valuesAfterSettle(`${h.A}/basic.html`, ["#text"]))["#text"], "", "old origin no longer filled");

      // Toggle both off: no registration, access kept (rules still exist)
      await h.openOptions();
      for (const r of [r1, r2]) {
        await h.realClick(opt, `${h.rowSel(h.IPA, r.id)} input.toggle`);
        await h.waitFor(opt, async (o, id) => (await browser.storage.local.get(o))[o].find((x) => x.id === id).enabled === false, 5000, h.IPA, r.id);
      }
      st = await h.extState();
      eq(st.storage[h.IPA].map((r) => r.enabled), [false, false], "both disabled");
      eq(st.registered, [], "no registration without enabled rules");
      eq(st.origins, [IP], "access kept while disabled rules exist");
      eq((await h.valuesAfterSettle(`${h.IPA}/basic.html`, ["#text"]))["#text"], "", "disabled rules do not fill");

      // Toggle r1 back on
      await h.openOptions();
      await h.realClick(opt, `${h.rowSel(h.IPA, r1.id)} input.toggle`);
      await h.waitFor(opt, async (o, id) => (await browser.storage.local.get(o))[o].find((x) => x.id === id).enabled === true, 5000, h.IPA, r1.id);
      st = await h.extState();
      eq(st.registered.map((r) => r.matches), [[IP]], "registration back after re-enabling");
      await h.expectFilled(`${h.IPA}/basic.html`, "#text", v1b);

      // Reload the options page: same rows
      await h.openOptions({ reload: true });
      await h.waitFor(opt, () => document.querySelectorAll("#rules tbody tr[data-id]").length === 2, 5000);
      ui = await h.uiState();
      eq(ui.rows.map(({ originText, grantText, ...r }) => r), [
        { origin: h.IPA, id: r1.id, enabled: true, grant: false, path: "/basic.html", selector: "#text", value: MASK, overwrite: "no", edit: true, del: true },
        { origin: h.IPA, id: r2.id, enabled: false, grant: false, path: "/basic.html", selector: "#email", value: MASK, overwrite: "yes", edit: true, del: true },
      ], "rows after reloading the options page");
    },
  },

  {
    name: "T17b double submit: a double-click on Add rule and a double Enter each create exactly one rule",
    async fn(h) {
      const ctx = await h.fillRuleForm({ origin: h.A, selector: "#text", value: h.v("DOUBLE-CLICK-TEST") });
      await h.clearMsg(ctx);
      await h.submitRuleForm(ctx, "dblclick");
      await h.waitFor(ctx, async (o) => ((await browser.storage.local.get(o))[o] || []).length > 0, 5000, h.A);
      await sleep(800);
      let rules = (await h.extState()).storage[h.A] || [];
      eq(rules.map((r) => r.value), ["DOUBLE-CLICK-TEST"], "rules after a double-click");

      await h.fillRuleForm({ origin: h.A, selector: "#email", value: h.v("DOUBLE-ENTER-TEST") });
      await h.clearMsg(ctx);
      await h.submitRuleForm(ctx, "enter2");
      await h.waitFor(ctx, async (o) => ((await browser.storage.local.get(o))[o] || []).length > 1, 5000, h.A);
      await sleep(800);
      rules = (await h.extState()).storage[h.A] || [];
      eq(rules.map((r) => r.value), ["DOUBLE-CLICK-TEST", "DOUBLE-ENTER-TEST"], "rules after a double Enter");
    },
  },
];
