export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
}

export type GCMessage =
  | {
      type: "assistant";
      content: string;
      thinking?: string;
      model?: string;
      provider?: string;
      stopReason?: string;
      usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
    }
  | { type: "user"; content: string }
  | { type: "tool_use"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_result"; toolCallId: string; toolName: string; content: string; isError: boolean }
  | { type: "system"; subtype: string; content: string }
  | { type: "delta"; deltaType: "text" | "thinking"; content: string };

export type AgentEvent =
  | { type: "run_start" }
  | { type: "run_end" }
  | { type: "msg"; msg: GCMessage }
  | { type: "file_changed"; path: string }
  | { type: "error"; message: string };

export interface ChatItem {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  meta?: string;
}
