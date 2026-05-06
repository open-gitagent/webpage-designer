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

export interface RunOptions {
  projectId: string;
  prompt: string;
  abortSignal?: AbortSignal;
  onMessage: (msg: GCMessage) => void;
  onFileChanged: (relPath: string) => void;
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

  try {
    if (manifest.maxTurns) (agent as any)._state.maxTurns = manifest.maxTurns;
    await agent.prompt(opts.prompt);
  } finally {
    unsubscribe();
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

## File-path protocol — read carefully
All paths passed to write_file, edit_file, read_file, fetch_url_image are **relative to site/**. Do NOT include "site/" in the path. Correct: \`"path": "index.html"\`, \`"path": "styles.css"\`, \`"path": "assets/hero.jpg"\`. WRONG: \`"path": "site/index.html"\` — that creates site/site/index.html.

## Progressive write protocol
When you call write_file, the runtime writes the file to disk **as you stream the JSON arguments** — the user sees the page redraw in real time before your tool call finishes. Two implications:
- Order the JSON keys so "path" comes before "content". Write the path FIRST, then content.
- Keep the content valid HTML/CSS at logical breakpoints (close tags as you go). The user is watching it grow live.`;

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
