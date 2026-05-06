import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_DIR = path.resolve(here, "..");
export const ROOT_DIR = path.resolve(SERVER_DIR, "..");
export const PROJECTS_DIR = path.join(ROOT_DIR, "projects");
export const TEMPLATE_DIR = path.join(SERVER_DIR, "agent-template");

export function projectDir(id: string) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid project id: ${id}`);
  return path.join(PROJECTS_DIR, id);
}

export function siteDir(id: string) {
  return path.join(projectDir(id), "site");
}

export function assetsDir(id: string) {
  return path.join(projectDir(id), "site", "assets");
}

export function safeJoin(root: string, rel: string) {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  return resolved;
}

/** Normalize an agent-provided site-relative path. Strips a leading `site/`
 *  if the model included it (it shouldn't, but it often does), and trims
 *  leading slashes. */
export function normalizeSitePath(p: string): string {
  let s = p.trim().replace(/^\/+/, "");
  if (s === "site") return "";
  if (s.startsWith("site/")) s = s.slice(5);
  return s;
}
