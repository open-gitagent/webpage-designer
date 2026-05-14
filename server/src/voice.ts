import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import fs from "node:fs/promises";
import path from "node:path";

const CAPTURED_ASSET_RE =
  /assets\/[\w-]+-\d{10,}(-studio)?(-cutout)?\.(png|jpe?g|webp)/gi;

/**
 * Force-rewrite a designer instruction into single-element iteration mode when
 * (a) the page already exists with substantial content, and (b) the instruction
 * references a freshly-captured asset path. This is the authoritative guardrail
 * against the voice model over-eagerly emitting "Build a new page" wording for
 * what should be a hero-image swap.
 */
async function sanitizeDesignerInstruction(
  projectId: string,
  instruction: string,
): Promise<{ instruction: string; rewritten: boolean }> {
  const indexPath = path.join(siteDir(projectId), "index.html");
  let indexSize = 0;
  try {
    const st = await fs.stat(indexPath);
    if (st.isFile()) indexSize = st.size;
  } catch {}
  if (indexSize <= 1500) return { instruction, rewritten: false };

  const matches = instruction.match(CAPTURED_ASSET_RE) ?? [];
  if (matches.length === 0) return { instruction, rewritten: false };

  // Prefer a cutout for the hero swap (transparent isolated subject).
  const heroAsset =
    matches.find((m) => /cutout/i.test(m)) ??
    matches.find((m) => /studio/i.test(m)) ??
    matches[0];

  return {
    rewritten: true,
    instruction:
      `Iterate: replace the hero image on the existing page with site/${heroAsset}. ` +
      `Keep ALL OTHER content, structure, palette, typography, colors, layout, sections, and copy EXACTLY as they currently are in site/index.html. ` +
      `read_file index.html first; locate the hero <img> or background-image; then use edit_file to change ONLY its src or url(). ` +
      `Do NOT rewrite the page. Do NOT use write_file. This is a single-element swap.`,
  };
}
import { customAlphabet } from "nanoid";
import { readProjectMeta } from "./projects.js";
import { runAgentSerialized } from "./agent.js";
import { siteDir, safeJoin, normalizeSitePath } from "./paths.js";
import { describeImage } from "./vision.js";
import { removeBackgroundInternal, studioizeImageInternal } from "./fal-tools.js";

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview";
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
const reqId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 10);

const VOICE_INSTRUCTIONS = `You are the voice front-end of a senior brand designer named "GitAgent Designer". When the user asks who you are, identify as GitAgent Designer. Talk like a calm, terse creative producer — short sentences, never corporate.

ABSOLUTE RULE — speak first, then call the tool. Keep speech short.
When the user gives you a design instruction, you MUST in this order, in the same turn:
  1. Say ONE brief spoken acknowledgement — 3-6 words max ("on it", "got it, building now", "swapping the hero"). Do NOT pre-narrate what the designer is going to do — you don't know yet. Do NOT describe sections, palettes, type choices, or anything specific. Just acknowledge.
  2. THEN call the function send_to_designer ONCE with their instruction as a clean, written brief.

Never call send_to_designer without first speaking. Never just talk without then calling the tool when an action is requested. Never call send_to_designer twice for one user message — bundle everything into one instruction.

When the designer finishes and returns a result, speak a SHORT summary (one sentence, 8-15 words) based ONLY on what the result string says. Do not invent details that weren't in the result. Do not list every file. The user already sees the page in the preview — you're confirming completion, not describing the work.

PREFIX YOUR INSTRUCTION with the right verb:
  - "Build: ..." for a new page or a topic pivot (different brand/subject than what's currently on the page). The designer will write_file all core files fresh.
  - "Iterate: ..." for changes to the existing page (color, copy, image swap, layout tweak). Include explicit "keep all other content, structure, palette, and typography exactly" so the designer uses edit_file for surgical changes.
  When in doubt, ask yourself: is the page topic CHANGING (build) or just MORPHING (iterate)? "Make the headline bigger" → iterate. "Build a Cheetos page" → build. "Use this captured cutout as the new hero on the existing Cheetos page" → iterate.

WHEN THE DESIGNER IS STILL WORKING.
The send_to_designer call BLOCKS until the design agent finishes. While you are awaiting that result, the user may speak again. If they do:
  - Acknowledge them briefly out loud.
  - Tell them you are still working on the previous request — say something like "still finishing the first one — give me a second".
  - Do NOT call send_to_designer again until the previous call's result has come back.

WHEN THE DESIGNER FINISHES.
You'll receive a short result string. Summarize what changed in 1-2 spoken sentences. Never read code, file paths, HTML, or CSS out loud.

VISUAL AWARENESS — you DO see when the user has the camera or screen toggle on.

You are an audio model by default, but you have access to two vision tools:
  - **look_at_camera** — lightweight glance. Use whenever the user asks awareness questions: "do you see me?", "what am I holding?", "what's behind me?", "how does this look?", "check this out". The function returns a 1–2 sentence description from a vision model. Speak the description naturally; do NOT read it verbatim if it's too long.
  - **capture_from_camera** — heavyweight save + studio + cutout pipeline. Only for when the user wants the captured image USED on the page (see CAMERA CAPTURE section below).

If the user asks "can you see me?" or similar, do NOT say no out of habit — call look_at_camera and answer based on what comes back.

When look_at_camera returns a description, **speak it essentially as-is** — the description is already written to be spoken (1-2 sentences, no jargon, opens with yes/no). Do NOT paraphrase it into something different. Do NOT say "I can't see you" if the description starts with "Yes, I can see you" — that would directly contradict the function result the user is also reading in chat.

If the function returns an error like "no camera active", THEN say "I don't see a camera feed — turn the camera or screen toggle on."

CAMERA CAPTURE — strict orchestration.

When the user mentions an object or asks you to use something they're showing on camera ("use this", "snap this", "take a picture of what I'm holding", "put this on the page", "use this object", "this product"), follow this exact sequence in ONE turn — never split it across multiple turns or duplicate the call:

  1. Call capture_from_camera FIRST. Arguments:
     - filename_hint: short kebab-case stem (e.g. "product-cup", "logo-mark").
     - remove_background: **default TRUE**. Only FALSE for explicit environment/texture references ("the room", "this backdrop").
     - reason: one short sentence.
     The function blocks ~10–15s while the pipeline runs (raw → studio → cutout). Wait for it.
  2. After capture_from_camera returns with the asset paths, speak ONE brief sentence about what you saw ("got the bag — locking it in").
  3. Call send_to_designer EXACTLY ONCE with the path. Decide the wording carefully:

     a) If the existing page is about a DIFFERENT topic and the user wants a brand-new page for this captured object — phrase as a **build**: "Build a new page for [brand/topic] using site/assets/<path> as the hero. Replace existing content."

     b) If the existing page is already on-topic and the user just wants this image incorporated (the common case for follow-up captures) — phrase as an **iteration**: "Iterate on the existing page — swap the hero image to site/assets/<path>. Keep all other content, structure, palette, and typography exactly as they are. Use edit_file, do not rebuild."

  4. Do NOT call send_to_designer twice. Once. The designer is stateless — give it everything in one instruction.

If capture_from_camera returns an error like "no camera active", tell the user once: "I don't see a camera feed — turn the camera or screen toggle on and try again." Do not keep asking.

If the user's request is genuinely unclear, ask one short clarifying question. Otherwise ship — never argue, never refuse.`;

const SEND_TO_DESIGNER_FN = {
  type: "function",
  name: "send_to_designer",
  description:
    "Forward a clean, written instruction to the design agent that writes HTML/CSS/JS. The design agent is **stateless** — each call starts fresh with no memory of previous calls. Phrase your instruction so it includes everything the agent needs:\n\n- For a NEW page or topic shift, start the instruction with 'Build:' and describe the brand/page fully.\n- For changes to the existing page, start with 'Iterate:' and tell it explicitly what to keep ('keep all other content, structure, palette, and typography exactly') and what to change. The agent will use edit_file for surgical changes.\n\nNever call this function twice for one user request — bundle everything into one instruction.",
  parameters: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description:
          "The user's intent. Start with 'Build:' for new pages, 'Iterate:' for edits to an existing page. Include any captured asset paths verbatim. Be explicit about what to keep vs change.",
      },
    },
    required: ["instruction"],
  },
};

const LOOK_AT_CAMERA_FN = {
  type: "function",
  name: "look_at_camera",
  description:
    "Glance at the user's current webcam/screen frame and get a short visual description. Lightweight — no save, no background removal, no studio relight. Use this when the user asks awareness questions: 'do you see me?', 'what am I holding?', 'what's behind me?', 'how do I look?', 'check this out'. Returns a 1-2 sentence description from a vision model. If you call this with no camera/screen on, you'll get an error — tell the user to turn one on.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "One short sentence on why you're looking (surfaced to the UI).",
      },
    },
    required: ["reason"],
  },
};

const CAPTURE_FROM_CAMERA_FN = {
  type: "function",
  name: "capture_from_camera",
  description:
    "Snap the user's current webcam or screen-share frame, optionally remove the background, save into site/assets/, and return the asset path plus a short visual description. Call when the user says things like 'use this', 'snap this', 'take a picture of what I'm holding', 'remove the background of that', 'use this object'. Returns 'no camera active' as an error if neither camera nor screen-share is on.",
  parameters: {
    type: "object",
    properties: {
      filename_hint: {
        type: "string",
        description: "Short kebab-case stem, e.g. 'product-cup', 'mood-shot', 'logo-mark'. Will become assets/<hint>-<ts>.{jpg|png}.",
      },
      remove_background: {
        type: "boolean",
        description: "Defaults to TRUE — almost every camera capture should be background-removed for a clean isolated subject. Only set FALSE if the user explicitly wants a mood/atmosphere/environment photo (e.g. 'capture this room', 'snap this texture', 'use this as a background reference').",
      },
      reason: {
        type: "string",
        description: "One short sentence on why you're capturing it.",
      },
    },
    required: ["filename_hint", "remove_background", "reason"],
  },
};

interface PendingFrame {
  resolve: (r: { path?: string; bytes?: number; error?: string }) => void;
}

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

      const pending = new Map<string, PendingFrame>();

      // Serialize function-call processing per voice WS. OpenAI Realtime may
      // emit multiple tool calls in one response (e.g. capture_from_camera +
      // send_to_designer). Without this chain, both handlers would run
      // concurrently — the designer would race against the still-running
      // capture pipeline and use a stale asset path. With the chain, each
      // handler waits for the prior one to fully complete (including its
      // function_call_output being sent upstream) before starting.
      let toolChain: Promise<void> = Promise.resolve();
      const serializeTool = (work: () => Promise<void>): Promise<void> => {
        const next = toolChain
          .catch(() => undefined)
          .then(() => work().catch((err) => {
            app.log.error({ err: err?.message }, "[voice] tool handler failed");
          }));
        toolChain = next;
        return next;
      };

      function requestFrame(filename_hint: string, reason: string): Promise<{ path?: string; bytes?: number; error?: string }> {
        const request_id = reqId();
        return new Promise((resolve) => {
          pending.set(request_id, { resolve });
          sendDown({ type: "request_frame", request_id, filename_hint, reason });
          setTimeout(() => {
            if (pending.has(request_id)) {
              pending.delete(request_id);
              resolve({ error: "timeout waiting for frame from browser" });
            }
          }, 30_000);
        });
      }

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
            tools: [SEND_TO_DESIGNER_FN, LOOK_AT_CAMERA_FN, CAPTURE_FROM_CAMERA_FN],
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

        sendDown(evt);

        if (evt.type !== "response.function_call_arguments.done") return;

        // All function-call handlers run inside serializeTool() so that
        // concurrent tool calls from one response (capture + designer,
        // glance + designer, etc.) execute strictly in arrival order.
        if (evt.name === "send_to_designer") {
          serializeTool(() => handleSendToDesigner(evt));
          return;
        }
        if (evt.name === "look_at_camera") {
          serializeTool(() => handleLookAtCamera(evt));
          return;
        }
        if (evt.name === "capture_from_camera") {
          serializeTool(() => handleCaptureFromCamera(evt));
          return;
        }
        return;
      });

      // ---- Function-call handlers (extracted so serializeTool can call them) ----

      async function handleSendToDesigner(evt: any): Promise<void> {
        let args: { instruction?: string } = {};
        try {
          args = JSON.parse(evt.arguments ?? "{}");
        } catch {}
        const rawInstruction = (args.instruction ?? "").trim();
        if (!rawInstruction) return;

        const { instruction, rewritten } = await sanitizeDesignerInstruction(
          id,
          rawInstruction,
        );
        if (rewritten) {
          app.log.info(
            { from: rawInstruction.slice(0, 200), to: instruction.slice(0, 200) },
            "[voice] rewrote designer instruction → single-element iteration",
          );
          sendDown({
            type: "system_note",
            note: "↩︎ rewrote voice instruction as a single-element iteration (page already exists)",
          });
        }

        let summary = "Done.";
        let wasQueued = false;
        let designerStarted = false;
        const startOnce = () => {
          if (!designerStarted) {
            designerStarted = true;
            sendDown({ type: "designer_start", instruction });
          }
        };
        try {
          await runAgentSerialized(
            {
              projectId: id,
              prompt: instruction,
              onMessage: (msg) => {
                startOnce();
                sendDown({ type: "designer_msg", msg });
              },
              onFileChanged: (relPath) => {
                startOnce();
                sendDown({ type: "file_changed", path: relPath });
              },
            },
            () => {
              wasQueued = true;
              sendDown({ type: "designer_queued", instruction });
            },
          );
          startOnce();
          summary = wasQueued
            ? "Queued behind the previous task — both are now finished."
            : "Files updated. Take a look.";
        } catch (err: any) {
          summary = `Designer error: ${err?.message ?? String(err)}`;
        }
        sendDown({ type: "designer_end" });

        sendUp({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: evt.call_id, output: summary },
        });
        sendUp({ type: "response.create" });
      }

      async function handleLookAtCamera(evt: any): Promise<void> {
        let args: { reason?: string } = {};
        try {
          args = JSON.parse(evt.arguments ?? "{}");
        } catch {}
        const reason = (args.reason ?? "").trim();

        sendDown({ type: "voice_look_start", reason });
        const frame = await requestFrame("glance", reason);
        let output: string;
        try {
          if (frame.error || !frame.path) {
            output = `ERROR: ${frame.error ?? "unknown"}`;
            sendDown({ type: "voice_look_end", error: output });
          } else {
            const abs = safeJoin(siteDir(id), normalizeSitePath(frame.path));
            const buf = await fs.readFile(abs);
            const description = await describeImage(
              buf.toString("base64"),
              "image/jpeg",
              `The user just spoke to a voice agent and asked something like "can you see me?" / "what do you see?" / "what am I holding?". You are the voice agent's eyes. Answer in 1-2 short spoken sentences. Lead with a direct yes/no:

- If a person is clearly in frame: "Yes, I can see you — [one short sentence describing them and the immediate scene]."
- If no person but other content (a room, screen, product): "I can see [what's there], but you're not in the frame right now."
- If the frame is empty/dark/blurry: "Frame's too dark/empty to make anything out — try better lighting."

No hex codes. No design jargon. No mood-board language. This is being spoken aloud as the answer to the user's question.

Reason the user gave: ${reason || "(unspecified)"}`,
            );
            output = description;
            app.log.info(
              { reason, description: description.slice(0, 200) },
              "[voice] look_at_camera result",
            );
            sendDown({ type: "voice_look_end", description });
            fs.unlink(abs).catch(() => {});
          }
        } catch (err: any) {
          output = `ERROR: ${err?.message ?? String(err)}`;
          sendDown({ type: "voice_look_end", error: output });
        }

        sendUp({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: evt.call_id, output },
        });
        sendUp({ type: "response.create" });
      }

      async function handleCaptureFromCamera(evt: any): Promise<void> {
        let args: { filename_hint?: string; remove_background?: boolean; reason?: string } = {};
        try {
          args = JSON.parse(evt.arguments ?? "{}");
        } catch {}
        const hint = (args.filename_hint || "snap").replace(/[^a-z0-9-]+/gi, "-").slice(0, 40);
        const reason = (args.reason || "").trim();
        const wantCutout = !!args.remove_background;

        sendDown({ type: "voice_capture_start", filename_hint: hint, remove_background: wantCutout, reason });

        const frame = await requestFrame(hint, reason);
        let output: string;
        try {
          if (frame.error || !frame.path) {
            output = `ERROR: ${frame.error ?? "unknown"}`;
            sendDown({ type: "voice_capture_end", error: output });
          } else {
            const rawAssetRel = frame.path;
            sendDown({ type: "file_changed", path: rawAssetRel });

            let description = "";
            try {
              const abs = safeJoin(siteDir(id), normalizeSitePath(rawAssetRel));
              const buf = await fs.readFile(abs);
              description = await describeImage(buf.toString("base64"), "image/jpeg");
            } catch (err: any) {
              description = `(vision unavailable: ${err?.message ?? "err"})`;
            }

            let studioRel: string | null = null;
            let cutoutRel: string | null = null;
            const ts = Date.now();
            if (wantCutout) {
              try {
                const studio = await studioizeImageInternal(id, rawAssetRel, `${hint}-${ts}-studio.jpg`);
                studioRel = studio.rel;
                sendDown({ type: "file_changed", path: studioRel });
              } catch (err: any) {
                description += `\n(studio-ize failed: ${err?.message ?? err} — running rembg on raw instead)`;
              }
              try {
                const sourceForCutout = studioRel ?? rawAssetRel;
                const cutoutName = studioRel
                  ? `${hint}-${ts}-studio-cutout.png`
                  : `${hint}-${ts}-cutout.png`;
                const cutout = await removeBackgroundInternal(id, sourceForCutout, cutoutName);
                cutoutRel = cutout.rel;
                sendDown({ type: "file_changed", path: cutoutRel });
              } catch (err: any) {
                description += `\n(background removal failed: ${err?.message ?? err})`;
              }
            }

            const variants = [
              `raw: ${rawAssetRel}`,
              studioRel ? `studio: ${studioRel}` : null,
              cutoutRel ? `cutout: ${cutoutRel}` : null,
            ]
              .filter(Boolean)
              .join("\n");
            const preferred = cutoutRel ?? studioRel ?? rawAssetRel;
            output = `Captured. Variants saved (in pipeline order):\n${variants}\n\nVision read:\n${description}\n\nNext step: in the SAME turn, call send_to_designer with an instruction that uses the cutout (\`${preferred}\`) for hero placement and mentions the studio version for full-bleed feature sections. The cutout already has studio-grade lighting baked in — layer it over a color block or photograph. Don't read the file paths out loud.`;
            sendDown({
              type: "voice_capture_end",
              path: preferred,
              description,
              variants: { raw: rawAssetRel, studio: studioRel, cutout: cutoutRel },
            });
          }
        } catch (err: any) {
          output = `ERROR: ${err?.message ?? String(err)}`;
          sendDown({ type: "voice_capture_end", error: output });
        }

        sendUp({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: evt.call_id, output },
        });
        sendUp({ type: "response.create" });
      }

      upstream.on("close", () => sendDown({ type: "voice_closed" }));
      upstream.on("error", (err) => sendDown({ type: "error", message: err.message }));

      socket.on("message", (raw) => {
        let parsed: any;
        const text = raw.toString();
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        // Server-only message types from the browser
        if (parsed?.type === "frame_captured") {
          const slot = pending.get(parsed.request_id);
          if (slot) {
            pending.delete(parsed.request_id);
            slot.resolve({ path: parsed.path, bytes: parsed.bytes, error: parsed.error });
          }
          return;
        }
        // Otherwise forward to OpenAI Realtime as-is
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      });
      socket.on("close", () => upstream.close());
    });
  });
}
