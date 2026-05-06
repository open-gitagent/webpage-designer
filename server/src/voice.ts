import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { readProjectMeta } from "./projects.js";
import { runAgent } from "./agent.js";

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview";
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

const VOICE_INSTRUCTIONS = `You are the voice front-end of a senior brand designer named "Designer". Talk like a calm, terse creative producer — short sentences, never corporate.

ABSOLUTE RULE — speak first, then call the tool.
When the user gives you a design instruction, you MUST in this order, in the same turn:
  1. Say a brief spoken acknowledgement out loud first ("on it", "let me try a brutalist take", "adding the photo now").
  2. THEN call the function send_to_designer with their instruction as a clean, written brief.
Never call send_to_designer without first speaking. Never just talk without then calling the tool when an action is requested.

WHEN THE DESIGNER IS STILL WORKING.
The send_to_designer call BLOCKS until the design agent finishes. While you are awaiting that result, the user may speak again. If they do:
  - Acknowledge them briefly out loud.
  - Tell them you are still working on the previous request — say something like "still finishing the first one — give me a second" or "wrapping up the brutalist version, then I'll do that next".
  - Do NOT call send_to_designer again until the previous call's result has come back.
  - Once the previous result lands, address the new request next.

WHEN THE DESIGNER FINISHES.
You'll receive a short result string. Summarize what changed in 1-2 spoken sentences. Never read code, file paths, HTML, or CSS out loud.

If the user's request is genuinely unclear, ask one short clarifying question. Otherwise ship — never argue, never refuse.`;

const SEND_TO_DESIGNER_FN = {
  type: "function",
  name: "send_to_designer",
  description: "Forward a clean, written instruction to the design agent that builds the HTML/CSS/JS page.",
  parameters: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description: "The user's design intent, written cleanly as if typed.",
      },
    },
    required: ["instruction"],
  },
};

export async function registerVoice(app: FastifyInstance) {
  app.register(async (instance) => {
    instance.get("/voice/:id", { websocket: true }, (socket, req) => {
      const { id } = req.params as { id: string };
      const apiKey = process.env.OPENAI_API_KEY;

      if (!apiKey) {
        socket.send(JSON.stringify({ type: "error", message: "OPENAI_API_KEY is not set" }));
        socket.close();
        return;
      }

      readProjectMeta(id).catch(() => {
        socket.send(JSON.stringify({ type: "error", message: "project not found" }));
        socket.close();
      });

      const upstream = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      const sendUp = (m: unknown) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(m));
      };
      const sendDown = (m: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
      };

      upstream.on("open", () => {
        app.log.info(`[voice] upstream open, model=${REALTIME_MODEL}`);
        sendUp({
          type: "session.update",
          session: {
            instructions: VOICE_INSTRUCTIONS,
            voice: "shimmer",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "server_vad", threshold: 0.6, prefix_padding_ms: 400, silence_duration_ms: 800, create_response: true },
            tools: [SEND_TO_DESIGNER_FN],
            tool_choice: "auto",
            modalities: ["audio", "text"],
          },
        });
        sendDown({ type: "voice_ready" });
      });

      upstream.on("message", async (raw) => {
        const text = raw.toString();
        let evt: any;
        try {
          evt = JSON.parse(text);
        } catch {
          return;
        }

        if (evt.type === "error" || evt.type === "session.created" || evt.type === "session.updated" || evt.type === "response.done") {
          app.log.info({ voiceEvent: evt.type, error: evt.error }, "[voice] upstream");
        }

        // forward everything to the browser so it can drive UI/audio playback
        sendDown(evt);

        // intercept the function call: bridge to the design agent
        if (
          evt.type === "response.function_call_arguments.done" &&
          evt.name === "send_to_designer"
        ) {
          let args: { instruction?: string } = {};
          try {
            args = JSON.parse(evt.arguments ?? "{}");
          } catch {}
          const instruction = (args.instruction ?? "").trim();
          if (!instruction) return;

          sendDown({ type: "designer_start", instruction });
          let summary = "Done.";
          try {
            await runAgent({
              projectId: id,
              prompt: instruction,
              onMessage: (msg) => sendDown({ type: "designer_msg", msg }),
              onFileChanged: (relPath) => sendDown({ type: "file_changed", path: relPath }),
            });
            summary = "Files updated. Take a look.";
          } catch (err: any) {
            summary = `Designer error: ${err?.message ?? String(err)}`;
          }
          sendDown({ type: "designer_end" });

          // hand the result back to the realtime model so it speaks the summary
          sendUp({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: evt.call_id,
              output: summary,
            },
          });
          sendUp({ type: "response.create" });
        }
      });

      upstream.on("close", () => sendDown({ type: "voice_closed" }));
      upstream.on("error", (err) => sendDown({ type: "error", message: err.message }));

      socket.on("message", (raw) => {
        // browser sends already-formatted Realtime events
        if (upstream.readyState === WebSocket.OPEN) upstream.send(raw.toString());
      });
      socket.on("close", () => upstream.close());
    });
  });
}
