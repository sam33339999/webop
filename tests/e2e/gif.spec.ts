import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { call, gifInfo, launch, type Launched } from "./harness.ts";

const opened: Launched[] = [];
async function open() {
  const h = await launch();
  opened.push(h);
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

type R = Awaited<ReturnType<typeof call>>;
const errOf = (r: R) => { assert.ok("error" in r, `expected an error, got ${JSON.stringify(r).slice(0, 300)}`); return r.error; };
const textOf = (r: R): string => {
  assert.ok("content" in r, "error" in r ? `${r.error.code}: ${r.error.message}` : "no content");
  const t = r.content[0];
  assert.ok(t && t.type === "text");
  return t.text;
};
const gif = (h: Launched, action: string, extra: object = {}) => call(h.sw, "gif_creator", { action, ...extra });

async function openPage(h: Launched, page: string): Promise<number> {
  const { tab_id } = JSON.parse(textOf(await call(h.sw, "tabs_create", { url: `${h.baseUrl}/${page}` }))) as { tab_id: number };
  return tab_id;
}

/** Screenshot size from the result text ("Screenshot WxH px; ..."). */
function shotSize(r: R): [number, number] {
  const m = /Screenshot (\d+)x(\d+) px/.exec(textOf(r));
  assert.ok(m, textOf(r));
  return [Number(m[1]), Number(m[2])];
}

test("t_gif_flow: screenshot, click, type and navigate become a 4-frame GIF without the typed text", async () => {
  const h = await open();
  const tab_id = await openPage(h, "form.html");
  assert.match(textOf(await gif(h, "start_recording")), /screenshot/i);
  const [w, hgt] = shotSize(await call(h.sw, "computer", { tab_id, action: "screenshot" }));
  textOf(await call(h.sw, "computer", { tab_id, action: "left_click", coordinate: [Math.round(w / 2), Math.round(hgt / 2)] }));
  textOf(await call(h.sw, "computer", { tab_id, action: "type", text: "secret-pw" }));
  textOf(await call(h.sw, "navigate", { tab_id, url: `${h.baseUrl}/button.html` }));
  const r = await gif(h, "export");
  assert.match(textOf(r), /Exported 4 frames/);
  assert.ok("file" in r && r.file, "no file in the export result");
  assert.match(r.file.name, /^webop-.+-\d{8}-\d{6}\.gif$/);
  const bytes = Buffer.from(r.file.data, "base64");
  const info = gifInfo(bytes);
  assert.equal(info.frames, 4);
  assert.ok(info.width <= 1280 && info.width > 0, `width ${info.width}`);
  assert.deepEqual(info.delays, [1500, 1500, 1500, 3000]);
  assert.ok(!JSON.stringify(r).includes("secret-pw"));
  assert.ok(!bytes.toString("latin1").includes("secret-pw"));
  if (process.env.WEBOP_GIF_SAMPLE) await writeFile(process.env.WEBOP_GIF_SAMPLE, bytes);
});

test("t_gif_zoom_not_recorded: zoom adds no frame", async () => {
  const h = await open();
  const tab_id = await openPage(h, "button.html");
  textOf(await gif(h, "start_recording"));
  textOf(await call(h.sw, "computer", { tab_id, action: "screenshot" }));
  textOf(await call(h.sw, "computer", { tab_id, action: "zoom", region: [0, 0, 100, 100] }));
  assert.match(textOf(await gif(h, "stop_recording")), /\b1 frame/);
});

test("t_gif_no_frames: export with nothing recorded fails with no_frames", async () => {
  const h = await open();
  textOf(await gif(h, "start_recording"));
  assert.equal(errOf(await gif(h, "export")).code, "no_frames");
  assert.equal(errOf(await gif(h, "bogus")).code, "invalid_args");
  assert.equal(errOf(await gif(h, "export", { filename: 5 })).code, "invalid_args");
});

test("t_gif_session_closed: frames are dropped when the session ends", async () => {
  const h = await open();
  const tab_id = await openPage(h, "button.html");
  textOf(await gif(h, "start_recording"));
  textOf(await call(h.sw, "computer", { tab_id, action: "screenshot" }));
  await h.sw.evaluate(() => (globalThis as any).__webop.closeSession("test"));
  const code = errOf(await gif(h, "export")).code;
  assert.ok(code === "tab_not_in_session" || code === "no_frames", code);
});

test("t_gif_cap: recording stops adding frames at 50", async () => {
  const h = await open();
  const tab_id = await openPage(h, "button.html");
  textOf(await gif(h, "start_recording"));
  for (let i = 0; i < 52; i++) textOf(await call(h.sw, "computer", { tab_id, action: "screenshot" }));
  const text = textOf(await gif(h, "stop_recording"));
  assert.match(text, /\b50 frames/);
  assert.match(text, /50-frame limit/);
});
