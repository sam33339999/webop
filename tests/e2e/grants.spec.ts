import { test, after } from "node:test";
import assert from "node:assert/strict";
import { call, launch, type Launched } from "./harness.ts";

const opened: Launched[] = [];
async function open() {
  const h = await launch();
  opened.push(h);
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

const get = (h: Launched, key: string) => h.sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);

async function optionsPage(h: Launched) {
  const page = await h.context.newPage();
  await page.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html`);
  return page;
}

test("t_migrate_allow: webop.allow becomes act grants and the old key is removed", async () => {
  const h = await open();
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.grants": {}, "webop.allow": ["localhost"] }));
  await h.sw.evaluate(() => (globalThis as any).__webop.migrateAllowList());
  assert.deepEqual(await get(h, "webop.grants"), { localhost: ["act"] });
  assert.equal(await get(h, "webop.allow"), undefined);
  const created = await call(h.sw, "tabs_create", { url: `${h.baseUrl}/button.html` });
  assert.ok("content" in created, "tabs_create should succeed");
  const tabId = JSON.parse((created as any).content[0].text).tab_id;
  assert.ok("content" in await call(h.sw, "computer", { action: "screenshot", tab_id: tabId }));
  const click = await call(h.sw, "computer", { tab_id: tabId, action: "left_click", coordinate: [10, 10] });
  assert.ok("content" in click, `left_click should succeed without a prompt: ${JSON.stringify(click)}`);
});

test("t_options_revoke: Revoke removes the site from webop.grants", async () => {
  const h = await open();
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.grants": { localhost: ["act"], "example.com": ["read"] } }));
  const page = await optionsPage(h);
  await page.locator('tr[data-site="example.com"] button.revoke').click();
  await page.locator('tr[data-site="example.com"]').waitFor({ state: "detached" });
  assert.deepEqual(await get(h, "webop.grants"), { localhost: ["act"] });
});

test("t_options_deny: deny list is normalised to the site key", async () => {
  const h = await open();
  const page = await optionsPage(h);
  await page.locator("#deny").fill("https://www.Example.com/x");
  await page.locator("#save-deny").click();
  await page.locator("#deny-status").filter({ hasText: "Saved" }).waitFor();
  assert.deepEqual(await get(h, "webop.deny"), ["example.com"]);
});

test("t_options_js_toggle: checkbox writes webop.js_enabled", async () => {
  const h = await open();
  const page = await optionsPage(h);
  await page.locator("#js-enabled").check();
  await page.waitForFunction(() => chrome.storage.local.get("webop.js_enabled").then((r) => r["webop.js_enabled"] === true));
  assert.equal(await get(h, "webop.js_enabled"), true);
});
