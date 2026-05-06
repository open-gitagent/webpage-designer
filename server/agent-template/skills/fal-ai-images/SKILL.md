---
name: fal-ai-images
description: Generate, isolate, and upscale photographic assets via fal.ai (FLUX Schnell, rembg, aura-sr). Choose between user-uploaded photos, voice-captured camera frames, stock-search results, and custom-generated imagery based on what the brand actually needs.
---

# Imagery decision tree

The page can pull imagery from four sources. Use them in this order:

## 1. User-uploaded photos (sacred — use them, don't replace them)
If the user has dragged or snapped a photo and it appears in `site/assets/`, that's their reference. Use it. Do not generate or search for an alternative unless the user explicitly asks. This is rule 7 of the base RULES — restated here because it overrides every other source.

## 2. Voice-captured / manually-snapped camera frames

### The capture pipeline (do not start using assets until it finishes)

When the user captures from the camera — either via the snap button or by saying *"snap this"* / *"use this object"* during a voice session — the runtime processes the frame through a **strict three-stage pipeline**, in this exact order:

1. **Raw save** — `<hint>-<ts>.jpg`. The frame is written to `site/assets/` immediately.
2. **Studio-ize** — `<hint>-<ts>-studio.jpg`. `fal-ai/flux-pro/kontext` rewrites the raw frame into a studio-grade shot: editorial lighting, soft diffused shadows, neutral seamless backdrop. Takes ~5–10s.
3. **Background removal of the studio version** — `<hint>-<ts>-studio-cutout.png`. `fal-ai/imageutils/rembg` strips the background from the *studio* image (not the raw), so the cutout inherits the studio lighting. Takes another ~3–5s.

Total wait: ~10–15s end-to-end. The orchestrator waits for **all three** stages before returning a result to the voice model or surfacing the prompt to you. Do **not** start designing with an earlier-stage path you happened to see in chat — by the time the prompt reaches you, the cutout is the canonical asset.

### Which file to use where

| Variant | When to use |
|---|---|
| `<hint>-<ts>-studio-cutout.png` | **Default hero.** Studio-lit transparent subject. Layer over a strong color block, gradient, or photograph. This is the magazine-grade version. |
| `<hint>-<ts>-studio.jpg` | Full-bleed feature section. Background already controlled, lighting already studio-grade. Treat as a polished editorial shot. |
| `<hint>-<ts>.jpg` (raw) | Atmosphere / mood reference only. The user's environment-as-context. Apply heavy CSS treatment (filter, mix-blend, overlay) before placing — never use raw straight. |

### Pipeline failure handling

- Studio-ize fails (quota, API): the runtime falls back to running rembg on the raw, producing `*-cutout.png` (no `-studio-cutout`). Use the cutout — it'll have phone-cam lighting but is still usable as a hero with treatment.
- Background removal fails: use whatever made it through. If only the raw is available, place it with heavy CSS treatment (color overlay, grain, vignette).
- Both fail: use the raw.

The voice model and the auto-prompt to you will tell you exactly which paths landed. Trust the prompt's path strings — they're the source of truth.

## 3. `search_photos` (free, real photographers)
For any honest stock photo need — mood imagery, lifestyle scenes, abstract textures — use `search_photos` first. Free, fast, real photographers, proper attribution. Pair with `fetch_url_image` to download and reference the result.

## 4. `generate_image` (FLUX Schnell — last resort)
Reach for `generate_image` ONLY when:
- The user asks for something stock can't deliver: a specific branded scene, an unusual conceptual composition, a mood photo of a fictional product.
- The brand direction is so specific that 6 stock candidates all feel wrong.
- The user explicitly asks ("generate me a hero of...").

When generating:
- **Be specific in the prompt.** Composition + lighting + palette + mood + camera language ("shot on Hasselblad", "shallow depth of field"). Vague prompts produce that AI-stock smell.
- **One strong hero, not four.** The first-build budget is **≤ 3 fal calls total**. Generations compound on latency and cost.
- **Add a credit** in the page footer: e.g. `<small>Imagery generated for [brand].</small>`. Transparent honesty about the source is a mark of taste, not a weakness.
- **Pair with `remove_background`** when you need just the subject (e.g. generate a single product, then cut out the backdrop for layout flexibility).
- **Pair with `upscale_image`** if the source is too small for hero use — Schnell renders at the requested aspect's standard resolution; for very large displays bump it through aura-sr.

## `remove_background` patterns

- **Product cutouts**: a snapped or generated product photo → `remove_background` → layer the transparent PNG over a strong color block, photograph, or duotone treatment.
- **Editorial portraits**: subject isolated against typography or a flat field reads as fashion-magazine, not corporate-stock.
- **Logo extraction**: when the user holds a printed logo or business card, capture + cutout = clean SVG-like asset. (For genuinely vector logos, hand-author SVG instead.)

Do not run `remove_background` on imagery where the background IS the point (a brutalist concrete wall, a moody interior). Subtractive editing destroys atmosphere.

## `upscale_image` patterns

- A 800×600 user-uploaded snapshot you want to use as a 2400×1800 hero.
- A FLUX Schnell generation that's noticeably soft when blown up.
- Almost never on stock photos from `search_photos` — Unsplash/Pexels source images are already 2k+.

## Anti-patterns

- **Don't re-generate user-uploaded content**. They gave you a photo for a reason. Use it.
- **Don't run rembg on a hero photograph just because you can.** A photograph with intentional negative space is already composed; cutting out the background can ruin it.
- **Don't generate a four-card-grid of synthetic product shots.** That's the SaaS-template tell.
- **Don't generate text inside images** (FLUX is poor at typography). Type goes in HTML, not in the rendered hero.

## Hard limits per turn

For a fresh page build, the total generative-AI budget is:
- ≤ 3 `generate_image` calls
- ≤ 3 `remove_background` calls
- ≤ 1 `upscale_image` call

If you need more than this, you're probably solving the wrong problem — go simpler with type and color, fewer images.
