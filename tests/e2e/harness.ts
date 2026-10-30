import { chromium, type BrowserContext, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolName, ToolResult } from "@webop/core/protocol";
import { startServer } from "./fixtures/server.ts";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../apps/extension/dist");

export interface Launched {
  context: BrowserContext;
  sw: Worker;
  baseUrl: string;
  altUrl: string;
  close(): Promise<void>;
}

/** Always a throwaway profile under the OS temp dir; never the user's own profile. */
export async function launch(opts: { nativeHost?: boolean; deviceScaleFactor?: number } = {}): Promise<Launched> {
  const userDataDir = await mkdtemp(join(tmpdir(), "webop-e2e-"));
  const server = await startServer();
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    // A real browser-level scale factor (not Playwright's per-page emulation), so devicePixelRatio and capture sizes match a user's HiDPI display.
    viewport: null,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      `--force-device-scale-factor=${opts.deviceScaleFactor ?? 1}`,
      "--window-size=1280,800",
    ],
  });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await sw.evaluate(() => chrome.storage.local.set({ "webop.allow": ["localhost"] }));
  return {
    context,
    sw,
    baseUrl: `http://localhost:${server.port}`,
    altUrl: `http://127.0.0.1:${server.port}`,
    async close() {
      await context.close();
      await server.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

export function call(sw: Worker, tool: ToolName, args: object, session_id = "test"): Promise<ToolResult> {
  return sw.evaluate(
    ([t, a, s]) => (globalThis as any).__webop.dispatch({ id: crypto.randomUUID(), session_id: s, tool: t, args: a }),
    [tool, args, session_id] as const,
  );
}

/** Opens `url` in a new tab via the extension APIs and returns the tab id. */
export async function openTab(sw: Worker, url: string): Promise<number> {
  return sw.evaluate(async (u) => {
    const tab = await chrome.tabs.create({ url: u, active: true });
    if (tab.id === undefined) throw new Error("no tab id");
    if (u.startsWith("http")) {
      await new Promise<void>((resolve) => {
        const on = (id: number, info: { status?: string }) => {
          if (id === tab.id && info.status === "complete") { chrome.tabs.onUpdated.removeListener(on); resolve(); }
        };
        chrome.tabs.onUpdated.addListener(on);
      });
    }
    return tab.id;
  }, url);
}

/** Width/height from the first SOF marker of a JPEG. */
export function jpegSize(buf: Buffer): { width: number; height: number } {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not a jpeg");
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("no SOF marker");
}
