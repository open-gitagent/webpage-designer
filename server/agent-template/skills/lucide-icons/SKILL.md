---
name: lucide-icons
description: Use Lucide icons (the open-source successor to Feather) loaded via CDN to add small, sharp, consistent line icons to a page. Use ONLY when the design genuinely needs an icon — utility navigation, status indicators, primary action affordances. Skip otherwise.
---

# Lucide Icons (use sparingly)

## When to use icons

**Use Lucide when:**
- A primary CTA needs an action affordance: `arrow-right` next to "Apply", `download` next to a file action, `play` on a video tile.
- Utility nav needs them: `menu` (burger), `x` (close), `search`, `chevron-down` for accordion/disclosure.
- Status communication: `check`, `alert-triangle`, `info`, `clock` for an order page or process indicator.
- Footer / contact strip: `mail`, `phone`, `map-pin`, `instagram`, `linkedin` (when text labels would be redundant).

**Do NOT use Lucide when:**
- Decorative-only — if you're tempted to put an icon next to every section heading, don't. That's the #1 tell of generic SaaS-template aesthetics.
- The page is type-driven editorial. A magazine layout doesn't need a `book-open` icon next to "About". The type is the icon.
- Emojis would already work and the tone is casual.
- You can't articulate the *function* of the icon. If a designer can't justify it in one sentence, remove it.

A brand-tier landing page typically uses **0 to 3** icons total. Often zero. The frontend-design skill's banned-AI-aesthetics list explicitly calls out "rounded-2xl shadow-md card grids" — gratuitous icons on cards are the same family of mistake.

## Loading

Single `<script>` tag in `<head>`. Then call `lucide.createIcons()` after DOM is ready.

```html
<head>
  <script src="https://unpkg.com/lucide@latest" defer></script>
</head>
<body>
  <!-- ... -->
  <button class="cta">
    Apply
    <i data-lucide="arrow-right"></i>
  </button>

  <script>
    document.addEventListener("DOMContentLoaded", () => {
      // eslint-disable-next-line no-undef
      lucide.createIcons();
    });
  </script>
</body>
```

`data-lucide="name"` is the markup. `lucide.createIcons()` replaces those `<i>` elements with inline `<svg>`. Re-call it if you inject new DOM dynamically (e.g. after fetching content).

## Sizing & color

Icons inherit `currentColor` for stroke. Set size and stroke via CSS or the standard data attributes:

```html
<i data-lucide="arrow-right" width="16" height="16" stroke-width="1.5"></i>
```

Or via CSS, which is cleaner for design consistency:

```css
[data-lucide],
.icon svg {
  width: 1em;
  height: 1em;
  stroke-width: 1.5;
}
```

**Match the type.** Icon size should follow font-size, not be set in pixels. Stroke width should match the typography weight: pair `1` stroke with thin/regular type, `1.5` with regular/medium (most common), `2` with bold heavy display type. Mismatched weight is the loudest tell that the icons were dropped in without thought.

## Curated icon set for brand pages

Resist the temptation to use exotic icons. The boring ones look most refined. From most useful to least, on a brand-tier page:

- Navigation / utility: `menu`, `x`, `search`, `chevron-down`, `chevron-right`, `arrow-right`, `arrow-up-right` (great for outbound links), `external-link`.
- Action: `play`, `pause`, `download`, `share-2`, `copy`.
- Contact / footer: `mail`, `phone`, `map-pin`, `instagram`, `linkedin`, `twitter` (use `x` icon for X / formerly Twitter — Lucide also has `twitter-x`).
- Status: `check`, `alert-triangle`, `info`, `clock`, `loader-circle` (for explicit loading affordance).

Full catalog at <https://lucide.dev/icons>. Search there only after you've decided you actually need an icon.

## Anti-patterns

1. **Icon-on-everything section headings**: `<i data-lucide="zap"/>` next to "Speed", `<i data-lucide="shield"/>` next to "Security". This is *the* AI/SaaS-template stencil. Avoid.
2. **Three-feature card grid with circle-icon-headline-paragraph**: again, the most overused pattern in stock AI output. The frontend-design skill bans this layout.
3. **Mismatched stroke weights** on the same page (some 1, some 2). Pick one.
4. **Icons larger than 1.2× cap height** in body text. Looks clumsy.
5. **Decorative icons that move attention from the type system you've carefully chosen.** If the page's spine is typography, don't introduce a competing visual language.

## When ambiguous, leave them out

Default to no icons. Add one only when the *function* of the icon is unmistakable. The page being light on icons is a positive signal of taste, not an absence.
