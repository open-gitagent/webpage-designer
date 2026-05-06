import { useEffect, useRef, useState, useCallback } from "react";
import type { AgentEvent, ChatItem, GCMessage } from "./types";

let nextId = 0;
const id = () => `m${++nextId}`;

interface Args {
  projectId: string | null;
  onFileChanged: (relPath: string) => void;
}

export interface CurrentTool {
  name: string;
  summary: string;
}

export function useAgentSession({ projectId, onFileChanged }: Args) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [textRunning, setTextRunning] = useState(false);
  const [voiceRunning, setVoiceRunning] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [currentTool, setCurrentTool] = useState<CurrentTool | null>(null);
  const [activity, setActivity] = useState<string>("waking up");
  const wsRef = useRef<WebSocket | null>(null);
  const streamingAssistant = useRef<string | null>(null);
  const running = textRunning || voiceRunning !== null;

  useEffect(() => {
    if (!projectId) return;
    setItems([]);
    let cancelled = false;
    let retryTimer: number | null = null;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/agent/${projectId}`,
      );
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setTextRunning(false);
        if (cancelled) return;
        retryTimer = window.setTimeout(connect, 1500);
      };
      ws.onerror = () => setConnected(false);
      ws.onmessage = (e) => {
        let evt: AgentEvent;
        try {
          evt = JSON.parse(e.data);
        } catch {
          return;
        }
        handleEvent(evt);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleEvent = useCallback(
    (evt: AgentEvent) => {
      if (evt.type === "run_start") {
        setTextRunning(true);
        setCurrentTool(null);
        setActivity("waking up");
        streamingAssistant.current = null;
        return;
      }
      if (evt.type === "run_end") {
        setTextRunning(false);
        setCurrentTool(null);
        setActivity("waking up");
        streamingAssistant.current = null;
        return;
      }
      if (evt.type === "error") {
        setTextRunning(false);
        setCurrentTool(null);
        setItems((prev) => [
          ...prev,
          { id: id(), role: "system", text: `error: ${evt.message}` },
        ]);
        return;
      }
      if (evt.type === "file_changed") {
        onFileChanged(evt.path);
        return;
      }
      if (evt.type !== "msg") return;
      const m: GCMessage = evt.msg;
      switch (m.type) {
        case "delta": {
          if (m.deltaType === "thinking") {
            setActivity("thinking");
            return;
          }
          if (m.deltaType !== "text") return;
          setActivity("writing");
          setItems((prev) => {
            const next = [...prev];
            if (streamingAssistant.current) {
              const idx = next.findIndex((x) => x.id === streamingAssistant.current);
              if (idx >= 0) {
                next[idx] = { ...next[idx], text: next[idx].text + m.content };
                return next;
              }
            }
            const newId = id();
            streamingAssistant.current = newId;
            next.push({ id: newId, role: "assistant", text: m.content });
            return next;
          });
          return;
        }
        case "assistant": {
          // final assistant message — replace streaming buffer if present
          setItems((prev) => {
            const next = [...prev];
            const text = m.content;
            if (streamingAssistant.current) {
              const idx = next.findIndex((x) => x.id === streamingAssistant.current);
              if (idx >= 0) {
                next[idx] = {
                  ...next[idx],
                  text,
                  meta: m.usage
                    ? `${m.usage.inputTokens} in / ${m.usage.outputTokens} out${m.usage.costUsd ? ` · $${m.usage.costUsd.toFixed(4)}` : ""}`
                    : undefined,
                };
                streamingAssistant.current = null;
                return next;
              }
            }
            next.push({ id: id(), role: "assistant", text });
            return next;
          });
          return;
        }
        case "tool_use": {
          const summary = summarizeToolUse(m.toolName, m.args);
          setCurrentTool({ name: m.toolName, summary });
          setActivity(toolActivity(m.toolName));
          setItems((prev) => [
            ...prev,
            { id: id(), role: "tool", text: `→ ${m.toolName}  ${summary}` },
          ]);
          return;
        }
        case "tool_result": {
          setCurrentTool(null);
          setActivity("thinking");
          // Don't dump full content; show a tiny acknowledgement
          const head = (m.content ?? "").split("\n")[0]?.slice(0, 120) ?? "";
          setItems((prev) => [
            ...prev,
            {
              id: id(),
              role: "tool",
              text: `${m.isError ? "✕" : "✓"} ${m.toolName}  ${head}`,
            },
          ]);
          return;
        }
        case "system": {
          setItems((prev) => [
            ...prev,
            { id: id(), role: "system", text: m.content },
          ]);
          return;
        }
      }
    },
    [onFileChanged],
  );

  const send = useCallback((prompt: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setItems((prev) => [...prev, { id: id(), role: "user", text: prompt }]);
    ws.send(JSON.stringify({ type: "prompt", prompt }));
  }, []);

  const abort = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "abort" }));
  }, []);

  const pushSystem = useCallback((text: string) => {
    setItems((prev) => [...prev, { id: id(), role: "system", text }]);
  }, []);

  const beginVoiceTask = useCallback((instruction: string) => {
    setVoiceRunning(instruction);
    setActivity(`voice — ${truncate(instruction, 80)}`);
    setCurrentTool(null);
    setItems((prev) => [...prev, { id: id(), role: "user", text: `🎙️ ${instruction}` }]);
  }, []);

  // Allow the voice WS to feed GCMessage events into the same pipeline,
  // so tool calls/results triggered by voice appear in the chat.
  const feedAgentMessage = useCallback((msg: GCMessage) => {
    handleEvent({ type: "msg", msg } as AgentEvent);
  }, [handleEvent]);

  const endVoiceTask = useCallback(() => {
    setVoiceRunning(null);
    setActivity("waking up");
    setCurrentTool(null);
  }, []);

  return {
    items,
    running,
    voiceRunning,
    connected,
    currentTool,
    activity,
    send,
    abort,
    pushSystem,
    beginVoiceTask,
    endVoiceTask,
    feedAgentMessage,
  };
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function summarizeToolUse(name: string, args: any): string {
  if (!args) return "";
  if (name === "write_file") return `${args.path} (${(args.content ?? "").length} chars)`;
  if (name === "read_file") return `${args.path}`;
  if (name === "fetch_url_image") return `${args.filename} ← ${args.url}`;
  return JSON.stringify(args).slice(0, 80);
}

function toolActivity(name: string): string {
  if (name === "write_file") return "writing file";
  if (name === "read_file") return "reading file";
  if (name === "list_files") return "scanning project";
  if (name === "list_assets") return "scanning assets";
  if (name === "fetch_url_image") return "fetching image";
  return `running ${name}`;
}
