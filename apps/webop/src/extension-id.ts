import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey } from "@webop/core/extension-id";

/** Set by apps/webop/build.ts from the extension manifest's key; absent when the .ts sources run directly. */
declare const __WEBOP_EXTENSION_ID__: string | undefined;

/** The extension's fixed id. A built webop (script or SEA) carries it; only the dev sources read the sibling manifest. */
export async function extensionId(): Promise<string> {
  if (typeof __WEBOP_EXTENSION_ID__ !== "undefined") return __WEBOP_EXTENSION_ID__;
  const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../extension/manifest.json", import.meta.url)), "utf8"));
  return extensionIdFromKey(manifest.key);
}
