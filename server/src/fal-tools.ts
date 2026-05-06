import { fal } from "@fal-ai/client";
import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "gitclaw";
import type { GCToolDefinition } from "gitclaw";
import { assetsDir, safeJoin, normalizeSitePath } from "./paths.js";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY not set");
  fal.config({ credentials: process.env.FAL_KEY });
  configured = true;
}

async function downloadIntoAssets(
  projectId: string,
  url: string,
  filename: string,
): Promise<{ rel: string; bytes: number }> {
  const dir = assetsDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const target = safeJoin(dir, filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(target, buf);
  return { rel: `assets/${filename}`, bytes: buf.length };
}

function stripPrefixes(p: string): string {
  let s = normalizeSitePath(p);
  if (s.startsWith("assets/")) s = s.slice(7);
  return s;
}

/** Generate an image from a prompt and save to site/assets/. Returns { rel, bytes }. */
export async function generateImageInternal(
  projectId: string,
  prompt: string,
  filename: string,
  imageSize:
    | "square_hd"
    | "square"
    | "landscape_16_9"
    | "landscape_4_3"
    | "portrait_4_3"
    | "portrait_16_9" = "landscape_16_9",
): Promise<{ rel: string; bytes: number }> {
  ensureConfigured();
  const result: any = await fal.subscribe("fal-ai/flux/schnell", {
    input: { prompt, image_size: imageSize, num_images: 1 },
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error("flux/schnell returned no image");
  return downloadIntoAssets(projectId, url, filename);
}

/** Remove background from an existing site/assets/* file. Saves a transparent PNG. */
export async function removeBackgroundInternal(
  projectId: string,
  inputPath: string,
  outputFilename: string,
): Promise<{ rel: string; bytes: number }> {
  ensureConfigured();
  const dir = assetsDir(projectId);
  const rel = stripPrefixes(inputPath);
  const inAbs = safeJoin(dir, rel);
  const buf = await fs.readFile(inAbs);
  const ext = (path.extname(rel).slice(1) || "jpg").toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const file = new File([new Blob([buf as any], { type: mime })], path.basename(rel), { type: mime });
  const uploadedUrl = await fal.storage.upload(file);
  const result: any = await fal.subscribe("fal-ai/imageutils/rembg", {
    input: { image_url: uploadedUrl },
  });
  const url = result?.data?.image?.url;
  if (!url) throw new Error("rembg returned no image");
  // Force .png extension on output since rembg produces transparent PNGs
  const finalName = outputFilename.endsWith(".png") ? outputFilename : outputFilename.replace(/\.[a-z]+$/i, "") + ".png";
  return downloadIntoAssets(projectId, url, finalName);
}

const STUDIO_MODEL = process.env.FAL_STUDIO_MODEL ?? "fal-ai/flux-pro/kontext";
const DEFAULT_STUDIO_PROMPT =
  "Transform this into a professional product photograph with clean editorial studio lighting, soft diffused shadows, and a neutral seamless backdrop. Preserve all original product details, proportions, and colors exactly. Magazine-quality composition, hero-shot framing, no text or logos added.";

/** Convert an existing image into a studio-grade shot via fal flux-pro/kontext. */
export async function studioizeImageInternal(
  projectId: string,
  inputPath: string,
  outputFilename: string,
  promptOverride?: string,
): Promise<{ rel: string; bytes: number }> {
  ensureConfigured();
  const dir = assetsDir(projectId);
  const rel = stripPrefixes(inputPath);
  const inAbs = safeJoin(dir, rel);
  const buf = await fs.readFile(inAbs);
  const ext = (path.extname(rel).slice(1) || "jpg").toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const file = new File([new Blob([buf as any], { type: mime })], path.basename(rel), { type: mime });
  const uploadedUrl = await fal.storage.upload(file);
  const result: any = await fal.subscribe(STUDIO_MODEL, {
    input: {
      prompt: promptOverride ?? DEFAULT_STUDIO_PROMPT,
      image_url: uploadedUrl,
    },
  });
  const url =
    result?.data?.images?.[0]?.url ??
    result?.data?.image?.url ??
    result?.data?.url;
  if (!url) throw new Error(`${STUDIO_MODEL} returned no image`);
  return downloadIntoAssets(projectId, url, outputFilename);
}

/** Upscale an existing site/assets/* file. Returns the new file's rel path. */
export async function upscaleImageInternal(
  projectId: string,
  inputPath: string,
  outputFilename: string,
): Promise<{ rel: string; bytes: number }> {
  ensureConfigured();
  const dir = assetsDir(projectId);
  const rel = stripPrefixes(inputPath);
  const inAbs = safeJoin(dir, rel);
  const buf = await fs.readFile(inAbs);
  const ext = (path.extname(rel).slice(1) || "jpg").toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const file = new File([new Blob([buf as any], { type: mime })], path.basename(rel), { type: mime });
  const uploadedUrl = await fal.storage.upload(file);
  const result: any = await fal.subscribe("fal-ai/aura-sr", {
    input: { image_url: uploadedUrl },
  });
  const url = result?.data?.image?.url ?? result?.data?.images?.[0]?.url;
  if (!url) throw new Error("upscaler returned no image");
  return downloadIntoAssets(projectId, url, outputFilename);
}

export function buildFalTools(
  projectId: string,
  onChange: (rel: string) => void,
): GCToolDefinition[] {
  const generateImage = tool(
    "generate_image",
    "Generate a custom photographic image from a text prompt using FLUX Schnell (fast, ~1.5s). Use when stock photos won't fit the brand direction — specific products, unusual moods, branded compositions stock can't deliver. Saves into site/assets/<filename>. Be specific in the prompt: composition, lighting, palette, mood. Combine with other generations sparingly — one strong hero beats four mid generations.",
    {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Vivid, specific image prompt. e.g. 'concrete brutalist coffee shop interior, soft morning light, single ceramic cup on raw wood counter, cinematic, shallow depth of field, no text, no people'.",
        },
        filename: {
          type: "string",
          description: "Output filename, e.g. 'hero-coffee.jpg'. Use .jpg or .png.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["square_hd", "square", "landscape_16_9", "landscape_4_3", "portrait_4_3", "portrait_16_9"],
          description: "FLUX image_size preset. Default landscape_16_9 for hero shots.",
        },
      },
      required: ["prompt", "filename"],
    },
    async (args: any) => {
      try {
        const { rel, bytes } = await generateImageInternal(
          projectId,
          args.prompt,
          args.filename,
          args.aspect_ratio,
        );
        onChange(rel);
        return { text: `generated ${rel} (${bytes} bytes) via FLUX Schnell. Reference it in the page as <img src="${rel}" alt="..." />` };
      } catch (err: any) {
        return { text: `ERROR: ${err?.message ?? String(err)}. Falling back? Use search_photos instead.` };
      }
    },
  );

  const removeBackground = tool(
    "remove_background",
    "Remove the background from an existing image in site/assets/, producing a transparent PNG. Useful for product photos, snapped objects (especially camera captures), and any subject you want to layer over color blocks or other backgrounds. Output is always PNG with alpha.",
    {
      type: "object",
      properties: {
        input_path: {
          type: "string",
          description: "Existing image relative to site/, e.g. 'assets/snap-123.jpg'. The leading 'site/' or 'assets/' may be omitted.",
        },
        output_filename: {
          type: "string",
          description: "Output filename inside assets/. .png will be enforced. e.g. 'product-cutout.png'.",
        },
      },
      required: ["input_path", "output_filename"],
    },
    async (args: any) => {
      try {
        const { rel, bytes } = await removeBackgroundInternal(
          projectId,
          args.input_path,
          args.output_filename,
        );
        onChange(rel);
        return { text: `cutout saved to ${rel} (${bytes} bytes, transparent PNG). Layer it over a colored block or photograph for impact.` };
      } catch (err: any) {
        return { text: `ERROR: ${err?.message ?? String(err)}` };
      }
    },
  );

  const upscaleImage = tool(
    "upscale_image",
    "Upscale a low-resolution image in site/assets/ for crisp display at large sizes. Uses fal-ai/aura-sr (~3-5s). Use when the user uploaded a small photo you want to use as a hero, or when a generated/captured image looks soft.",
    {
      type: "object",
      properties: {
        input_path: { type: "string", description: "Image path relative to site/." },
        output_filename: {
          type: "string",
          description: "Output filename inside assets/.",
        },
      },
      required: ["input_path", "output_filename"],
    },
    async (args: any) => {
      try {
        const { rel, bytes } = await upscaleImageInternal(
          projectId,
          args.input_path,
          args.output_filename,
        );
        onChange(rel);
        return { text: `upscaled saved to ${rel} (${bytes} bytes)` };
      } catch (err: any) {
        return { text: `ERROR: ${err?.message ?? String(err)}` };
      }
    },
  );

  const studioizeImage = tool(
    "studio_ize_image",
    "Convert an existing image in site/assets/ into a professional studio-grade product photograph using fal-ai/flux-pro/kontext (~5-10s). Cleans up backgrounds, applies editorial lighting, soft shadows, neutral seamless backdrop. Best for taking a casual phone snap of a product or object and producing a magazine-quality hero. Preserves the original file — saves the studio version as a separate output.",
    {
      type: "object",
      properties: {
        input_path: {
          type: "string",
          description: "Existing image relative to site/, e.g. 'assets/snap-123.jpg'.",
        },
        output_filename: {
          type: "string",
          description: "Output filename inside assets/, e.g. 'product-studio.jpg'.",
        },
        prompt: {
          type: "string",
          description: "Optional override for the studio-ize prompt. Leave blank to use the default professional product-photography prompt.",
        },
      },
      required: ["input_path", "output_filename"],
    },
    async (args: any) => {
      try {
        const { rel, bytes } = await studioizeImageInternal(
          projectId,
          args.input_path,
          args.output_filename,
          args.prompt,
        );
        onChange(rel);
        return { text: `studio-ized to ${rel} (${bytes} bytes). Use this for hero placement; the original is still available at the input path.` };
      } catch (err: any) {
        return { text: `ERROR: ${err?.message ?? String(err)}` };
      }
    },
  );

  return [generateImage, removeBackground, studioizeImage, upscaleImage];
}
