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
import { PROJECTS_DIR, projectDir, assetsDir, safeJoin } from "./paths.js";
import { listProjects, createProject, readProjectMeta } from "./projects.js";
import { runAgent } from "./agent.js";
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

      send({ type: "run_start" });
      try {
        await runAgent({
          projectId: id,
          prompt: parsed.prompt,
          abortSignal: abort.signal,
          onMessage: (msg) => {
            app.log.info({ kind: msg.type }, "[ws] msg out");
            send({ type: "msg", msg });
          },
          onFileChanged: (rel) => send({ type: "file_changed", path: rel }),
        });
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
