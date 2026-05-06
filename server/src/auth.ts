import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

const COOKIE_NAME = "designer-session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const tokens = new Map<string, number>(); // token → expiresAt

function newToken(): string {
  const tok = randomBytes(24).toString("hex");
  tokens.set(tok, Date.now() + SESSION_TTL_MS);
  return tok;
}

function validToken(tok: string | undefined): boolean {
  if (!tok) return false;
  const exp = tokens.get(tok);
  if (!exp) return false;
  if (exp < Date.now()) {
    tokens.delete(tok);
    return false;
  }
  return true;
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = (req.headers.cookie as string | undefined) ?? "";
  for (const part of raw.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name) return v;
  }
  return undefined;
}

const PUBLIC_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/health",
]);

export function isAuthed(req: FastifyRequest): boolean {
  return validToken(readCookie(req, COOKIE_NAME));
}

export async function registerAuth(app: FastifyInstance) {
  // Gate every request except the public paths.
  app.addHook("onRequest", async (req, reply) => {
    const url = (req.raw.url ?? "").split("?")[0];
    if (PUBLIC_PATHS.has(url)) return;
    if (isAuthed(req)) return;
    // For HTML/JS clients we want a 401 to trigger the login flow.
    reply.code(401).send({ error: "unauthorized" });
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    const expectedUser = process.env.AUTH_USER ?? "lyzr";
    const expectedPass = process.env.AUTH_PASS ?? "lyzr2b28";
    if (body.username !== expectedUser || body.password !== expectedPass) {
      reply.code(401).send({ error: "invalid credentials" });
      return;
    }
    const tok = newToken();
    reply.header(
      "set-cookie",
      `${COOKIE_NAME}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
    );
    reply.send({ ok: true, user: expectedUser });
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const tok = readCookie(req, COOKIE_NAME);
    if (tok) tokens.delete(tok);
    reply.header("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!isAuthed(req)) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    reply.send({ ok: true, user: process.env.AUTH_USER ?? "lyzr" });
  });
}
