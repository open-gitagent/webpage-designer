import fs from "node:fs/promises";
import path from "node:path";
import { customAlphabet } from "nanoid";
import { PROJECTS_DIR, TEMPLATE_DIR, projectDir, siteDir, assetsDir } from "./paths.js";

const slug = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 10);

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
}

async function copyDir(src: string, dst: string) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

export async function listProjects(): Promise<ProjectMeta[]> {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const out: ProjectMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const metaPath = path.join(PROJECTS_DIR, e.name, "project.json");
    try {
      const raw = await fs.readFile(metaPath, "utf8");
      out.push(JSON.parse(raw));
    } catch {
      // skip dirs without project.json
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export async function createProject(name: string): Promise<ProjectMeta> {
  const id = slug();
  const dir = projectDir(id);
  await copyDir(TEMPLATE_DIR, dir);
  await fs.mkdir(siteDir(id), { recursive: true });
  await fs.mkdir(assetsDir(id), { recursive: true });

  const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name.replace(/[<>&"]/g, "")}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="empty">
      <p>Tell the designer what you want to build.</p>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`;
  const stylesCss = `:root {
  color-scheme: light;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  font-family: ui-serif, Georgia, serif;
  background: #f6f4ef;
  color: #1a1a1a;
  display: grid;
  place-items: center;
}
.empty p {
  font-size: 1.05rem;
  letter-spacing: 0.02em;
  opacity: 0.6;
}
`;
  await fs.writeFile(path.join(siteDir(id), "index.html"), indexHtml);
  await fs.writeFile(path.join(siteDir(id), "styles.css"), stylesCss);
  await fs.writeFile(path.join(siteDir(id), "script.js"), "// behavior\n");

  const meta: ProjectMeta = { id, name, createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export async function readProjectMeta(id: string): Promise<ProjectMeta> {
  const raw = await fs.readFile(path.join(projectDir(id), "project.json"), "utf8");
  return JSON.parse(raw);
}
