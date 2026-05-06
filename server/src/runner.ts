/**
 * Direct pi-agent-core runner.
 *
 * Bypasses gitclaw's SDK so we can intercept `toolcall_delta` events
 * (which gitclaw's sdk.js drops). Extracts the partial `content` field
 * from streaming write_file tool calls and writes to disk progressively,
 * letting the iframe preview redraw as the agent generates.
 */
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { parseStreamingJson } from "@mariozechner/pi-ai/dist/utils/json-parse.js";
import { Type } from "@sinclair/typebox";
import type { GCMessage } from "gitclaw";
import { projectDir, siteDir, safeJoin, normalizeSitePath } from "./paths.js";
import { buildSiteTools } from "./tools.js";
import { buildImageSearchTools } from "./image-search.js";
import { buildFalTools } from "./fal-tools.js";

export interface RunOptions {
  projectId: string;
  prompt: string;
  abortSignal?: AbortSignal;
  onMessage: (msg: GCMessage) => void;
  onFileChanged: (relPath: string) => void;
}

/**
 * Per-project serialization queue. Only one design agent runs per project at
 * a time, so concurrent triggers (voice send_to_designer + chat prompt + brand
 * book button) don't step on each other when writing files.
 */
const projectQueues = new Map<string, Promise<unknown>>();

/**
 * Run an agent serialized on `projectId`. If another agent is already running
 * for this project, this call queues until the prior one finishes. `onQueued`
 * fires the moment we decide to wait — surface this to the user UI so they
 * know the request is pending, not lost.
 */
export async function runAgentSerialized(
  opts: RunOptions,
  onQueued?: () => void,
): Promise<void> {
  const prev = projectQueues.get(opts.projectId);
  const myWork: Promise<void> = (async () => {
    if (prev) {
      onQueued?.();
      try {
        await prev;
      } catch {
        // ignore prior failure — we still run
      }
    }
    await runAgent(opts);
  })();
  projectQueues.set(opts.projectId, myWork);
  myWork.finally(() => {
    if (projectQueues.get(opts.projectId) === myWork) {
      projectQueues.delete(opts.projectId);
    }
  });
  await myWork;
}

interface ParsedManifest {
  name: string;
  preferred?: string;
  fallback?: string[];
  maxTurns?: number;
  temperature?: number;
}

async function readMaybe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function loadAgent(dir: string): Promise<{ systemPrompt: string; manifest: ParsedManifest }> {
  const manifestRaw = await fs.readFile(path.join(dir, "agent.yaml"), "utf8");
  const m = (yaml.load(manifestRaw) as any) ?? {};
  const manifest: ParsedManifest = {
    name: m.name ?? "designer",
    preferred: m.model?.preferred,
    fallback: m.model?.fallback,
    maxTurns: m.runtime?.max_turns,
    temperature: m.runtime?.constraints?.temperature,
  };

  const soul = await readMaybe(path.join(dir, "SOUL.md"));
  const rules = await readMaybe(path.join(dir, "RULES.md"));

  // Skills (each as <skill name="…">…</skill>)
  const skillsDir = path.join(dir, "skills");
  let skillsBlock = "";
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillFile = path.join(skillsDir, e.name, "SKILL.md");
      const content = await readMaybe(skillFile);
      if (content) {
        skillsBlock += `\n<skill name="${e.name}">\n${content.trim()}\n</skill>\n`;
      }
    }
  } catch {}

  const systemPrompt = [
    `# ${manifest.name}`,
    "",
    soul.trim(),
    "",
    "## Behavioral rules",
    rules.trim(),
    skillsBlock ? "\n## Skills available\n" + skillsBlock : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { systemPrompt, manifest };
}

function resolveModel(preferred: string | undefined, fallbacks: string[] = []) {
  const candidates = [preferred, ...fallbacks].filter(Boolean) as string[];
  for (const spec of candidates) {
    const [provider, modelId] = spec.split(":");
    if (!provider || !modelId) continue;
    const m = getModel(provider as any, modelId);
    if (m) return m;
  }
  throw new Error(`No model in pi-ai catalog for ${candidates.join(" / ")}`);
}

interface PartialToolCall {
  name: string;
  partialJson: string;
  lastWrittenLen: number;
  lastWriteAt: number;
}

export async function runAgent(opts: RunOptions): Promise<void> {
  const dir = projectDir(opts.projectId);
  const site = siteDir(opts.projectId);
  const { systemPrompt, manifest } = await loadAgent(dir);
  const model = resolveModel(manifest.preferred, manifest.fallback ?? []);

  const tools = [
    ...buildSiteTools(opts.projectId, (e) => opts.onFileChanged(e.path)),
    ...buildImageSearchTools(),
    ...buildFalTools(opts.projectId, (rel) => opts.onFileChanged(rel)),
  ];

  // Convert our gitclaw GCToolDefinition[] into pi-agent-core AgentTool[]
  // (same shape as gitclaw's internal toAgentTool).
  const agentTools = tools.map((def) => {
    const params = jsonSchemaToTypebox(def.inputSchema as any);
    return {
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: params,
      execute: async (_id: string, args: any, signal?: AbortSignal) => {
        const r = await def.handler(args, signal);
        const text = typeof r === "string" ? r : r.text;
        return { content: [{ type: "text" as const, text }], details: {} } as any;
      },
    };
  });

  const agent = new Agent({});
  agent.setSystemPrompt(systemPrompt + WRITE_PROGRESS_HINT);
  agent.setModel(model);
  agent.setTools(agentTools as any);

  // Restore conversation context from prior runs so the agent remembers what
  // was discussed before — works for both text and voice paths since both go
  // through this runner. Capped to keep prompt cost bounded.
  const historyPath = path.join(dir, ".gitagent-history.json");
  try {
    const raw = await fs.readFile(historyPath, "utf8");
    const prior = JSON.parse(raw);
    if (Array.isArray(prior) && prior.length > 0) {
      // Keep only the last 30 messages — enough for context, bounded for cost.
      const trimmed = prior.slice(-30);
      agent.replaceMessages(trimmed);
    }
  } catch {
    // No history yet — first run for this project.
  }

  // Track in-flight tool calls so we can write progressively for write_file.
  const partials = new Map<string, PartialToolCall>();
  let textBuf = "";

  const unsubscribe = agent.subscribe(async (event: any) => {
    const ev = event?.type;
    const sub = event?.assistantMessageEvent?.type;
    if (ev !== "message_update" || sub !== "text_delta") {
      // text_delta events are too noisy — log everything else
      console.log(`[runner] ${ev}${sub ? `:${sub}` : ""}`);
    }
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (!e) return;

        if (e.type === "text_delta") {
          textBuf += e.delta;
          opts.onMessage({ type: "delta", deltaType: "text", content: e.delta });
          return;
        }
        if (e.type === "thinking_delta") {
          opts.onMessage({ type: "delta", deltaType: "thinking", content: e.delta });
          return;
        }
        if (e.type === "toolcall_start") {
          // Pull the block from the partial message so we know the tool name early
          const partial = e.partial;
          const block = partial?.content?.[partial.content.length - 1];
          if (block?.type === "toolCall") {
            partials.set(block.id, { name: block.name, partialJson: "", lastWrittenLen: 0, lastWriteAt: 0 });
            opts.onMessage({
              type: "system",
              subtype: "tool_streaming",
              content: `streaming → ${block.name}`,
            } as any);
          }
          return;
        }
        if (e.type === "toolcall_delta") {
          // The block lives in partial.content[contentIndex]; find the toolCall
          const partial = e.partial;
          const block = partial?.content?.[e.contentIndex];
          if (block?.type !== "toolCall") return;
          const slot = partials.get(block.id) ?? { name: block.name, partialJson: "", lastWrittenLen: 0, lastWriteAt: 0 };
          slot.partialJson += e.delta;
          slot.name = block.name;
          partials.set(block.id, slot);

          if (slot.name === "write_file") {
            await maybeProgressiveWrite(slot, site, opts.onFileChanged);
          }
          return;
        }
        if (e.type === "toolcall_end") {
          // The full args are now finalized. Tool execution will run via
          // the standard execute handler — no double-write needed because
          // our handler also produces the final on-disk version.
          return;
        }
        return;
      }

      case "message_end": {
        const msg = event.message;
        if (msg?.role !== "assistant") return;
        const text = (msg.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        opts.onMessage({
          type: "assistant",
          content: text || textBuf,
          model: msg.model ?? "unknown",
          provider: msg.provider ?? "unknown",
          stopReason: msg.stopReason ?? "stop",
          usage: msg.usage
            ? {
                inputTokens: msg.usage.input ?? 0,
                outputTokens: msg.usage.output ?? 0,
                cacheReadTokens: msg.usage.cacheRead ?? 0,
                cacheWriteTokens: msg.usage.cacheWrite ?? 0,
                totalTokens: msg.usage.totalTokens ?? 0,
                costUsd: msg.usage.cost?.total ?? 0,
              }
            : undefined,
        } as any);
        textBuf = "";
        return;
      }

      case "tool_execution_start":
        opts.onMessage({
          type: "tool_use",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? {},
        });
        return;

      case "tool_execution_end": {
        const text = event.result?.content?.[0]?.text ?? "";
        opts.onMessage({
          type: "tool_result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          content: text,
          isError: !!event.isError,
        });
        partials.delete(event.toolCallId);
        return;
      }

      case "agent_end":
        return;
    }
  });

  // Inject runtime state into the prompt: if index.html already has substantial
  // content, the agent must default to iteration via edit_file. This is the
  // single most effective guardrail against unintended rebuilds — it lands on
  // every call regardless of what the voice model or user actually wrote.
  let runtimePreface = "";
  try {
    const indexPath = path.join(site, "index.html");
    const stat = await fs.stat(indexPath);
    if (stat.isFile() && stat.size > 1500) {
      runtimePreface =
        `[RUNTIME CONTEXT — read carefully before deciding write_file vs edit_file]\n` +
        `site/index.html already exists at ${stat.size} bytes — that's substantial content from a prior turn or build, not the empty placeholder.\n\n` +
        `**Default behavior for this turn: ITERATION via edit_file.** Read index.html first to see current state. For image swaps, color tweaks, copy edits, layout adjustments — use edit_file to change ONLY what the user asked. Keep all other content, structure, palette, and typography exactly as they are.\n\n` +
        `**Override only if the user's request is an explicit complete-rebuild signal**: a different brand/topic, or a verb like "Build:" / "rebuild from scratch" / "throw it out and start over". Otherwise iterate.\n\n` +
        `User instruction follows below.\n\n---\n\n`;
    }
  } catch {
    // index.html doesn't exist yet — fresh build is the only option.
  }

  try {
    if (manifest.maxTurns) (agent as any)._state.maxTurns = manifest.maxTurns;
    await agent.prompt(runtimePreface + opts.prompt);
  } finally {
    unsubscribe();
    // Persist updated conversation so the next run for this project picks up
    // where this one left off — text or voice.
    try {
      const finalMessages = (agent as any)._state?.messages ?? [];
      if (Array.isArray(finalMessages) && finalMessages.length > 0) {
        await fs.writeFile(
          historyPath,
          JSON.stringify(finalMessages.slice(-50), null, 2),
          "utf8",
        );
      }
    } catch {
      // ignore — best-effort
    }
  }
}

const PROGRESS_MIN_BYTES = 200;
const PROGRESS_MIN_INTERVAL_MS = 350;

async function maybeProgressiveWrite(
  slot: PartialToolCall,
  site: string,
  onChange: (rel: string) => void,
) {
  const partial = parseStreamingJson(slot.partialJson) as any;
  if (!partial || typeof partial.path !== "string" || typeof partial.content !== "string") return;

  const now = Date.now();
  const isFirst = slot.lastWriteAt === 0;
  const bytesGrown = partial.content.length - slot.lastWrittenLen;
  // First emit fires fast (so the user sees the page start immediately).
  // Subsequent emits require both noticeable growth AND a min cooldown,
  // which keeps the iframe from snapping ~30 times for a single file.
  if (!isFirst && (bytesGrown < PROGRESS_MIN_BYTES || now - slot.lastWriteAt < PROGRESS_MIN_INTERVAL_MS)) return;

  let target: string;
  try {
    target = safeJoin(site, normalizeSitePath(partial.path));
  } catch {
    return;
  }
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, partial.content, "utf8");
    slot.lastWrittenLen = partial.content.length;
    slot.lastWriteAt = now;
    const rel = path.relative(site, target).replaceAll(path.sep, "/");
    onChange(rel);
  } catch {
    // ignore — final tool execution will produce the authoritative file
  }
}

const WRITE_PROGRESS_HINT = `

## STEP 1 ON EVERY TURN — assess fresh-build vs iteration
Before any write_file or edit_file, **read_file index.html first** (and styles.css if relevant). The project may already contain content from a prior session.

**Honor explicit verb prefixes** if the user's prompt starts with one:
- "Build: ..." → fresh build, write_file everything from scratch.
- "Iterate: ..." → surgical edit, prefer edit_file for the specific change requested. Keep all other content, structure, palette, and typography exactly as-is. Do NOT regenerate the whole page just because a single image was swapped or a color was tweaked.

If there is no explicit prefix:
- If the request topic is **DIFFERENT** from index.html (e.g. site is "Tito's vodka" and prompt is "build a Cheetos page"), this is a **fresh build**. Use write_file. Do NOT edit_file new content onto a stale layout — that produces frankenstein pages like a Cheetos image embedded in a Tito's design.
- If the request is genuinely an **iteration** of the existing page ("make the headline bigger", "warmer palette", "swap the hero image"), use edit_file.

The signal is the **topic**, not the request size. A short "build cheetos page" is a fresh build; a long instruction "make the third section's color slightly more amber and tighten the spacing between heading and body" is an iteration.

## File-path protocol — read carefully
All paths passed to write_file, edit_file, read_file, fetch_url_image are **relative to site/**. Do NOT include "site/" in the path. Correct: \`"path": "index.html"\`, \`"path": "styles.css"\`, \`"path": "assets/hero.jpg"\`. WRONG: \`"path": "site/index.html"\` — that creates site/site/index.html.

## Progressive write protocol
When you call write_file, the runtime writes the file to disk **as you stream the JSON arguments** — the user sees the page redraw in real time before your tool call finishes. Two implications:
- Order the JSON keys so "path" comes before "content". Write the path FIRST, then content.
- Keep the content valid HTML/CSS at logical breakpoints (close tags as you go). The user is watching it grow live.

## Imagery — always multiple, always parallel
Every brand-tier page ships with **3–5 images**: 1 hero + 2–4 supporting. Type-only is reserved for explicit type-specimen / manifesto direction.

In your FIRST assistant turn for a new page, emit (all in the same turn, as separate parallel tool calls):
- write_file for index.html
- write_file for styles.css
- 2–3 search_photos calls with DIFFERENT specific queries (hero, mood, supporting context)
- optionally 1 generate_image for a branded scene stock can't deliver

Reference the destination paths in your HTML/CSS even before the downloads complete — the iframe re-renders as each file lands. Always surface photographer attribution for stock; add a "Imagery generated for [brand]" footer credit for FLUX outputs.

## Camera-capture pipeline
When a camera capture happens, the runtime processes the frame through 3 sequential stages: raw → studio-ize (kontext) → rembg of the studio version. Total ~10–15s. The auto-prompt to you only fires AFTER all three are saved. Default to the studio-cutout (\`*-studio-cutout.png\`) for the hero — it has studio-grade lighting baked into the transparent isolated subject. See the fal-ai-images skill for the full table.`;

// Minimal JSON-Schema → Typebox conversion for our simple tool schemas
// (object with primitive properties: string, number, boolean, enum).
function jsonSchemaToTypebox(schema: any): any {
  if (!schema) return Type.Any();
  if (schema.type === "object") {
    const props: Record<string, any> = {};
    const required: string[] = schema.required ?? [];
    for (const [k, v] of Object.entries<any>(schema.properties ?? {})) {
      props[k] = jsonSchemaToTypebox(v);
    }
    return Type.Object(props, { required });
  }
  if (schema.enum) return Type.Union(schema.enum.map((v: any) => Type.Literal(v)));
  if (schema.type === "string") return Type.String();
  if (schema.type === "number" || schema.type === "integer") return Type.Number();
  if (schema.type === "boolean") return Type.Boolean();
  if (schema.type === "array") return Type.Array(jsonSchemaToTypebox(schema.items));
  return Type.Any();
}
