import { chromium, type BrowserContext, type Worker } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey } from "@webop/core/extension-id";
import { install } from "../../apps/webop/src/install.ts";
import type { ToolName, ToolResult } from "@webop/core/protocol";
import { startServer } from "./fixtures/server.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(repo, "apps/extension/dist-dev");
export const webopBin = join(repo, "apps/webop/dist/webop.mjs");
/** The single executable (pnpm build:sea). */
export const seaBin = join(repo, "apps/webop/dist/webop");

export interface Launched {
  context: BrowserContext;
  sw: Worker;
  baseUrl: string;
  altUrl: string;
  userDataDir: string;
  /** webop root (sockets, descriptors, wrapper); only set with `nativeHost`. */
  root: string;
  /** Registers the native messaging host for this profile (done at launch with `nativeHost`). */
  installHost(): Promise<void>;
  /** Closes the browser; removes the profile and root unless `keepProfile` (for relaunch tests). */
  close(o?: { keepProfile?: boolean }): Promise<void>;
}

/** Always a throwaway profile under the OS temp dir; never the user's own profile. */
export async function launch(opts: { nativeHost?: boolean; deviceScaleFactor?: number; userDataDir?: string; root?: string; webopCommand?: string[] } = {}): Promise<Launched> {
  const userDataDir = opts.userDataDir ?? await mkdtemp(join(tmpdir(), "webop-e2e-"));
  // Short path on purpose: unix socket paths are capped near 104 bytes on macOS and os.tmpdir() there is long.
  const root = opts.root ?? await mkdtemp("/tmp/wr-");
  const installHost = async () => {
    // Chromium reads <user-data-dir>/NativeMessagingHosts/, so the throwaway profile gets its own host manifest.
    const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
    install({
      browserDir: userDataDir,
      root,
      extensionId: await extensionIdFromKey(manifest.key),
      webopCommand: opts.webopCommand ?? [process.execPath, webopBin],
    });
  };
  if (opts.nativeHost) await installHost();
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
  await sw.evaluate(() => chrome.storage.local.set({ "webop.grants": { localhost: ["act"] } }));
  return {
    context,
    sw,
    baseUrl: `http://localhost:${server.port}`,
    altUrl: `http://127.0.0.1:${server.port}`,
    userDataDir,
    root,
    installHost,
    async close(o = {}) {
      await context.close();
      await server.close();
      if (!o.keepProfile) {
        await rm(userDataDir, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

export function call(sw: Worker, tool: ToolName, args: object, session_id = "test"): Promise<ToolResult> {
  return sw.evaluate(
    ([t, a, s]) => (globalThis as any).__webop.dispatch({ id: crypto.randomUUID(), session_id: s, tool: t, args: a }),
    [tool, args, session_id] as const,
  );
}

/** Opens `url` in a new tab via the extension APIs, hands it to `session_id`, and returns the tab id. */
export async function openTab(sw: Worker, url: string, session_id = "test"): Promise<number> {
  const tabId = await openForeignTab(sw, url);
  await sw.evaluate(([s, id]) => (globalThis as any).__webop.adoptTab(s, id), [session_id, tabId] as const);
  return tabId;
}

/** Opens a tab the session does NOT own (as if the user opened it). */
export async function openForeignTab(sw: Worker, url: string): Promise<number> {
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

/** Logical screen size, frame count and per-frame delays (ms) of a GIF, read by walking its blocks. */
export function gifInfo(buf: Buffer): { width: number; height: number; frames: number; delays: number[] } {
  if (buf.subarray(0, 6).toString("latin1") !== "GIF89a") throw new Error("not a GIF89a");
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let i = 13;
  if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1));
  const skipSubBlocks = () => {
    while (i < buf.length) {
      const n = buf[i++];
      if (n === 0) return;
      i += n;
    }
  };
  let frames = 0;
  const delays: number[] = [];
  while (i < buf.length) {
    const b = buf[i++];
    if (b === 0x3b) return { width, height, frames, delays };
    if (b === 0x21) {
      const label = buf[i++];
      if (label === 0xf9) delays.push(buf.readUInt16LE(i + 2) * 10);
      skipSubBlocks();
    } else if (b === 0x2c) {
      frames++;
      const p = buf[i + 8];
      i += 9;
      if (p & 0x80) i += 3 * (1 << ((p & 0x07) + 1));
      i++; // LZW minimum code size
      skipSubBlocks();
    } else {
      throw new Error(`unexpected block 0x${b.toString(16)} at ${i - 1}`);
    }
  }
  throw new Error("GIF has no trailer");
}
