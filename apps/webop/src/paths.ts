import os from "node:os";
import path from "node:path";

export function rootDir(root?: string): string {
  return root ?? process.env.WEBOP_ROOT ?? path.join(os.homedir(), ".webop");
}
export function runDir(root?: string): string {
  return path.join(rootDir(root), "run");
}
export function logDir(root?: string): string {
  return path.join(rootDir(root), "log");
}
export function socketPath(profileId: string, root?: string): string {
  return path.join(runDir(root), `${profileId}.sock`);
}
export function descriptorPath(profileId: string, root?: string): string {
  return path.join(runDir(root), `${profileId}.json`);
}
