---
name: image-search
description: Find and use free, royalty-free stock photos in the page. Use when the user has not provided a reference image and the design needs a hero, mood, or supporting photo. Sources from Unsplash, Pexels, and Picsum.
---

This skill teaches you how to find and use free royalty-free imagery in the pages you build, without copying images you don't have rights to and without invoking generic "AI" stock-photo aesthetics.

## When to use it

**Use `search_photos` when:**
- The user describes a brand or page that clearly needs imagery (hero shot, mood photo, product context, lifestyle scene) and has not uploaded their own asset.
- The composition you've committed to demands a real photograph rather than typography, abstract gradients, or geometry.
- The user has explicitly asked you to "find an image" or "use a photo of X."

**Do NOT use it when:**
- The user has uploaded reference photos to `site/assets/` — those are sacred. Use them instead. Always check `list_assets` first.
- The aesthetic direction is purely typographic or geometric. A maximalist art-deco page or a brutalist type specimen does not need stock photography. Restraint is a creative choice.
- The user explicitly asked for "no stock photo grids" or similar. Trust their direction.

## How to use it

The flow is always two steps:

1. **`search_photos`** — Pass a *visual, specific* query. Bad: `"food"`. Good: `"hand-pulled espresso pouring into white ceramic cup, dark moody studio light"`. Specify `orientation` (landscape / portrait / square) to match your layout. Ask for `count: 6` to give yourself options.

2. **`fetch_url_image`** — Pick one result that genuinely matches the aesthetic direction, save it under a meaningful name in `site/assets/` (e.g. `hero-pour.jpg`, not `image1.jpg`), then reference it from `site/index.html`.

## Attribution

Every result comes with an `attribution_html` string. **You must surface attribution somewhere in the page** — typically as a small line in the footer or as a hover/caption near the image, in muted body text. This is required by Unsplash and Pexels licensing, and respecting it is a mark of professional craft. Don't bury it; don't omit it.

Example footer line:
```html
<p class="credits">Photo by <a href="https://unsplash.com/@photographer">Photographer Name</a> on <a href="https://unsplash.com">Unsplash</a></p>
```

## Choosing well

- **Don't take the first result.** Browse the whole list. Reject anything that says "AI-generated," "stock-feeling," or "obviously composed for stock photography" (the over-staged group shots, the laptop-on-desk shots, the smiling-headset CSR).
- **Match the aesthetic direction.** A brutalist espresso brand wants raw, high-contrast, slightly grainy. A luxury fashion editorial wants soft, controlled, expensive lighting. The query should encode the *feeling*, not just the subject.
- **Crop and color in CSS, not by re-searching.** Use `object-fit: cover`, `filter: grayscale() saturate() contrast()`, and overlays (`::after` with `mix-blend-mode`) to bring a photo into the page's palette. A great photo + a 10% warm overlay beats a so-so photo every time.
- **One hero photo > four mid photos.** For a single landing page, almost always commit to one or two strong images, not a grid. Card grids of stock photos are the #1 tell of generic AI-generated frontends.

## Sources & keys

- **Unsplash** (preferred) — set `UNSPLASH_ACCESS_KEY` in `.env` (free, 5000 req/hr). Best curation for design.
- **Pexels** — set `PEXELS_API_KEY` (free). Used as second source.
- **Picsum** — used as a deterministic-random fallback when no API keys are set. Limited (no real search; query is used as a seed for reproducible random photos). Acceptable for a placeholder, not for shipped work.

If `search_photos` returns Picsum-only results and the page needs real imagery, mention to the user that an Unsplash key would unlock real search.
