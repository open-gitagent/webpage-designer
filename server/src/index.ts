import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dir = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dir, "../../.env"), override: true });
loadEnv({ path: path.resolve(__dir, "../.env"), override: true });

import Fastify from "fastify";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import fs from "node:fs/promises";
import { PROJECTS_DIR, projectDir, assetsDir, safeJoin, siteDir } from "./paths.js";
import { listProjects, createProject, readProjectMeta } from "./projects.js";
import { runAgentSerialized } from "./agent.js";
import { registerVoice } from "./voice.js";
import { registerVision } from "./vision.js";

const PORT = Number(process.env.PORT ?? 8882);

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("[designer] WARNING: ANTHROPIC_API_KEY is not set — agent calls will fail.");
}

const app = Fastify({ logger: { level: "info" } });

await app.register(cors, { origin: true });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

await fs.mkdir(PROJECTS_DIR, { recursive: true });
await app.register(staticPlugin, {
  root: PROJECTS_DIR,
  prefix: "/preview/",
  decorateReply: false,
  index: ["index.html"],
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  },
});

// We rewrite /preview/<id>/ → /preview/<id>/site/index.html so the iframe URL stays clean.
app.addHook("onRequest", async (req, reply) => {
  const url = req.raw.url ?? "";
  const m = url.match(/^\/preview\/([a-z0-9-]+)(\/?)(\?.*)?$/);
  if (m) {
    reply.redirect(`/preview/${m[1]}/site/${m[3] ?? ""}`, 302);
  }
});

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/projects", async () => listProjects());

app.post("/api/projects", async (req, reply) => {
  const body = (req.body ?? {}) as { name?: string };
  const name = (body.name ?? "Untitled").slice(0, 80);
  const meta = await createProject(name);
  reply.send(meta);
});

app.get("/api/projects/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    const meta = await readProjectMeta(id);
    reply.send(meta);
  } catch {
    reply.code(404).send({ error: "not found" });
  }
});

app.get("/api/projects/:id/site-files", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    await readProjectMeta(id);
  } catch {
    reply.code(404).send({ error: "not found" });
    return;
  }
  const dir = siteDir(id);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".html"))
      .map((e) => e.name)
      .sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
    reply.send({ files });
  } catch {
    reply.send({ files: [] });
  }
});

app.post("/api/projects/:id/upload", async (req, reply) => {
  const { id } = req.params as { id: string };
  await readProjectMeta(id);
  const file = await req.file();
  if (!file) {
    reply.code(400).send({ error: "no file" });
    return;
  }
  const ext = path.extname(file.filename || "").toLowerCase() || ".jpg";
  const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].includes(ext) ? ext : ".jpg";
  const filename = `photo-${Date.now()}${safeExt}`;
  const dir = assetsDir(id);
  await fs.mkdir(dir, { recursive: true });
  const target = safeJoin(dir, filename);
  const buf = await file.toBuffer();
  await fs.writeFile(target, buf);
  reply.send({ filename, path: `assets/${filename}`, bytes: buf.length });
});

app.post("/api/projects/:id/cutout", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    await readProjectMeta(id);
  } catch {
    reply.code(404).send({ error: "not found" });
    return;
  }
  const body = (req.body ?? {}) as { path?: string; output_filename?: string };
  if (!body.path) {
    reply.code(400).send({ error: "path required" });
    return;
  }
  try {
    const { removeBackgroundInternal } = await import("./fal-tools.js");
    const out = body.output_filename ?? `cutout-${Date.now()}.png`;
    const result = await removeBackgroundInternal(id, body.path, out);
    reply.send(result);
  } catch (err: any) {
    reply.code(500).send({ error: err?.message ?? String(err) });
  }
});

app.post("/api/projects/:id/studio", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    await readProjectMeta(id);
  } catch {
    reply.code(404).send({ error: "not found" });
    return;
  }
  const body = (req.body ?? {}) as { path?: string; output_filename?: string; prompt?: string };
  if (!body.path) {
    reply.code(400).send({ error: "path required" });
    return;
  }
  try {
    const { studioizeImageInternal } = await import("./fal-tools.js");
    const out = body.output_filename ?? `studio-${Date.now()}.jpg`;
    const result = await studioizeImageInternal(id, body.path, out, body.prompt);
    reply.send(result);
  } catch (err: any) {
    reply.code(500).send({ error: err?.message ?? String(err) });
  }
});

app.register(async (instance) => {
  instance.get("/ws/agent/:id", { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const abort = new AbortController();

    const send = (m: unknown) => {
      try {
        socket.send(JSON.stringify(m));
      } catch {}
    };

    socket.on("message", async (raw) => {
      let parsed: any;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (parsed?.type === "abort") {
        abort.abort();
        return;
      }
      if (parsed?.type !== "prompt" || typeof parsed.prompt !== "string") return;

      try {
        await readProjectMeta(id);
      } catch {
        send({ type: "error", message: "project not found" });
        return;
      }

      // We don't emit run_start here — it's emitted by the runner only when the
      // actual agent begins (after any queue wait). This prevents two "designer
      // running" indicators from flashing when a second prompt queues behind a
      // first one in flight. The runner also emits run_queued if it has to wait.
      let runStarted = false;
      try {
        await runAgentSerialized(
          {
            projectId: id,
            prompt: parsed.prompt,
            abortSignal: abort.signal,
            onMessage: (msg) => {
              if (!runStarted) {
                runStarted = true;
                send({ type: "run_start" });
              }
              app.log.info({ kind: msg.type }, "[ws] msg out");
              send({ type: "msg", msg });
            },
            onFileChanged: (rel) => {
              if (!runStarted) {
                runStarted = true;
                send({ type: "run_start" });
              }
              send({ type: "file_changed", path: rel });
            },
          },
          () => send({ type: "run_queued" }),
        );
        if (!runStarted) send({ type: "run_start" });
        send({ type: "run_end" });
      } catch (err: any) {
        app.log.error({ err: err?.message, stack: err?.stack }, "[ws] runAgent failed");
        send({ type: "error", message: err?.message ?? String(err) });
      }
    });

    socket.on("close", () => abort.abort());
  });
});

await registerVoice(app);
await registerVision(app);

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`designer server on http://localhost:${PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
