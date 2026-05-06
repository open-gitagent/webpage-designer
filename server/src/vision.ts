import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;
function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const DEFAULT_VISION_PROMPT = `You are a senior brand designer's eyes. The user has shared an image as visual reference for a website they're building. Describe it as design context:

- **Mood/feeling**: 1 sentence
- **Palette**: 4-6 hex codes (your best read of dominant + accent colors)
- **Texture / atmosphere**: 1 sentence (grain, glass, matte, glossy, organic, mechanical, etc.)
- **Composition / energy**: 1 sentence (asymmetric, centered, dense, airy, kinetic, still)
- **Useable elements**: list anything specific in the image that could become a hero, motif, or aesthetic anchor

Be specific and useful. No fluff. If this is a person/product photo the user uploaded for use in the page, say so.`;

export async function describeImage(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" = "image/jpeg",
  promptOverride?: string,
): Promise<string> {
  const res = await client().messages.create({
    model: "claude-opus-4-7",
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: promptOverride ?? DEFAULT_VISION_PROMPT },
        ],
      },
    ],
  });
  return res.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
}

export async function registerVision(app: FastifyInstance) {
  app.post("/api/vision", async (req, reply) => {
    const body = (req.body ?? {}) as { imageBase64?: string; mediaType?: string; prompt?: string };
    const imageBase64 = body.imageBase64;
    const mediaType = (body.mediaType ?? "image/jpeg") as
      | "image/jpeg"
      | "image/png"
      | "image/webp"
      | "image/gif";
    if (!imageBase64) {
      reply.code(400).send({ error: "imageBase64 required" });
      return;
    }
    try {
      const text = await describeImage(imageBase64, mediaType, body.prompt);
      reply.send({ description: text });
    } catch (err: any) {
      reply.code(500).send({ error: err?.message ?? String(err) });
    }
  });
}
