import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "gitclaw";
import type { GCToolDefinition } from "gitclaw";
import { projectDir, siteDir, assetsDir, safeJoin, normalizeSitePath } from "./paths.js";

type Emitter = (event: { type: "file_changed"; path: string }) => void;

export function buildSiteTools(projectId: string, onChange: Emitter): GCToolDefinition[] {
  const root = projectDir(projectId);
  const site = siteDir(projectId);
  const assets = assetsDir(projectId);

  const writeFile = tool(
    "write_file",
    "Write the COMPLETE contents of a file in the site/ directory. Replaces the file wholesale. Use for site/index.html, site/styles.css, site/script.js, or any file under site/.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to site/, e.g. 'index.html' or 'styles.css' or 'assets/foo.svg'." },
        content: { type: "string", description: "Full file contents." },
      },
      required: ["path", "content"],
    },
    async (args: { path: string; content: string }) => {
      const target = safeJoin(site, normalizeSitePath(args.path));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, args.content, "utf8");
      const rel = path.relative(site, target).replaceAll(path.sep, "/");
      onChange({ type: "file_changed", path: rel });
      return { text: `wrote site/${rel} (${args.content.length} chars)` };
    },
  );

  const editFile = tool(
    "edit_file",
    "Edit an existing file in site/ by replacing exact text. MUCH faster and cheaper than write_file for small changes — emits only the diff, not the whole file. Use this for: copy edits, color tweaks, swapping a single class name, fixing a typo, changing one CSS value. Use write_file (full rewrite) only when creating a new file or rewriting most of an existing one.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to site/, e.g. 'index.html' or 'styles.css'." },
        old_string: { type: "string", description: "Exact substring to find. Must appear EXACTLY ONCE in the file unless replace_all is true. Include enough surrounding context to be unique." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "If true, replace every occurrence. Default false." },
      },
      required: ["path", "old_string", "new_string"],
    },
    async (args: { path: string; old_string: string; new_string: string; replace_all?: boolean }) => {
      const target = safeJoin(site, normalizeSitePath(args.path));
      let original: string;
      try {
        original = await fs.readFile(target, "utf8");
      } catch (err: any) {
        return { text: `ERROR: cannot read ${args.path}: ${err.message}` };
      }
      if (args.old_string === args.new_string) {
        return { text: `no-op: old_string equals new_string` };
      }
      const occurrences = original.split(args.old_string).length - 1;
      if (occurrences === 0) {
        return { text: `ERROR: old_string not found in site/${args.path}. The file does not contain the literal text you provided. Use read_file to see current contents, or use write_file for a full rewrite.` };
      }
      if (occurrences > 1 && !args.replace_all) {
        return { text: `ERROR: old_string matches ${occurrences} occurrences in site/${args.path}. Add more surrounding context to make it unique, or set replace_all: true.` };
      }
      const updated = args.replace_all
        ? original.split(args.old_string).join(args.new_string)
        : original.replace(args.old_string, args.new_string);
      await fs.writeFile(target, updated, "utf8");
      const rel = path.relative(site, target).replaceAll(path.sep, "/");
      onChange({ type: "file_changed", path: rel });
      const delta = updated.length - original.length;
      const sign = delta >= 0 ? "+" : "";
      return { text: `edited site/${rel} (${occurrences} replacement${occurrences > 1 ? "s" : ""}, ${sign}${delta} chars)` };
    },
  );

  const readFile = tool(
    "read_file",
    "Read the current contents of a file in site/.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to site/." },
      },
      required: ["path"],
    },
    async (args: { path: string }) => {
      const target = safeJoin(site, normalizeSitePath(args.path));
      try {
        const content = await fs.readFile(target, "utf8");
        return { text: content };
      } catch (err: any) {
        return { text: `ERROR: ${err.message}` };
      }
    },
  );

  const listFiles = tool(
    "list_files",
    "List all files currently in the site/ directory (recursive).",
    { type: "object", properties: {} },
    async () => {
      const out: string[] = [];
      async function walk(dir: string, prefix: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
          else out.push(rel);
        }
      }
      try {
        await walk(site, "");
      } catch {
        return { text: "(no files yet)" };
      }
      return { text: out.length ? out.join("\n") : "(no files yet)" };
    },
  );

  const listAssets = tool(
    "list_assets",
    "List user-uploaded reference images and photos available in site/assets/. Use these in the page when relevant.",
    { type: "object", properties: {} },
    async () => {
      try {
        const entries = await fs.readdir(assets, { withFileTypes: true });
        const files = entries.filter((e) => e.isFile()).map((e) => `assets/${e.name}`);
        return { text: files.length ? files.join("\n") : "(no assets uploaded)" };
      } catch {
        return { text: "(no assets uploaded)" };
      }
    },
  );

  const fetchUrlImage = tool(
    "fetch_url_image",
    "Download an image from a public URL into site/assets/ so you can reference it from the page. Use sparingly; prefer user-uploaded assets.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "Direct image URL (jpg/png/webp/svg)." },
        filename: { type: "string", description: "Filename to save as inside assets/, e.g. 'hero.jpg'." },
      },
      required: ["url", "filename"],
    },
    async (args: { url: string; filename: string }) => {
      if (!/^https?:\/\//.test(args.url)) return { text: "ERROR: only http(s) URLs allowed" };
      // accept either bare filename, "assets/foo.jpg", or "site/assets/foo.jpg"
      let rel = normalizeSitePath(args.filename);
      if (rel.startsWith("assets/")) rel = rel.slice(7);
      const target = safeJoin(assets, rel);
      try {
        const res = await fetch(args.url);
        if (!res.ok) return { text: `ERROR: fetch ${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, buf);
        const rel = path.relative(site, target).replaceAll(path.sep, "/");
        onChange({ type: "file_changed", path: rel });
        return { text: `saved ${rel} (${buf.length} bytes)` };
      } catch (err: any) {
        return { text: `ERROR: ${err.message}` };
      }
    },
  );

  return [writeFile, editFile, readFile, listFiles, listAssets, fetchUrlImage];
}
