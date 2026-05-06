---
name: motion
description: Add fluid, physical animation to plain HTML/CSS/JS pages using the Motion library (the vanilla successor to framer-motion) loaded from CDN. Use for orchestrated entrance animations, scroll-linked effects, gesture interactions, springs, and stagger reveals. Adapted from the official framer-motion skills for our no-React, vanilla-HTML output target.
---

# Motion (vanilla)

## Why this exists

The official Framer Motion library is React-only. Since this agent ships **plain HTML/CSS/JS**, we use **Motion** (the same project, vanilla build) loaded from CDN. The conceptual API is the same — declarative animation, motion values, springs, gestures, scroll, stagger — just called as functions on DOM elements instead of as JSX props.

## When to use Motion vs CSS

**Default to CSS** for:
- Single transitions on hover/focus.
- One-off entrance animations on a page.
- Any animation that lives entirely in a `:hover` / `:focus` / `@keyframes` rule.

**Reach for Motion** when:
- You need orchestrated multi-element entrances (staggered reveals).
- You need scroll-linked or scroll-triggered animation.
- You need spring physics (CSS easing curves don't have real spring behavior).
- You need gestures: drag, momentum, hover/press with animated values.
- You need to animate to a runtime value (e.g. element bounding box, scroll progress).

The page should still feel *composed*, not animated-everywhere. One orchestrated entrance choreography per page is more memorable than fifteen micro-bounces. (Same rule as the frontend-design skill — Motion just gives you better tools to execute it.)

## Loading

Add to `<head>` of the HTML page that needs animation. ESM-only; modern browsers, no build step:

```html
<script type="module">
  import {
    animate, inView, scroll, hover, press,
    stagger, spring
  } from "https://cdn.jsdelivr.net/npm/motion@latest/+esm";

  // your code below
</script>
```

If multiple pages share animation logic, put it in `script.js` with `type="module"` in the `<script>` tag and import there. Don't load Motion on pages that don't use it.

## Core API

### `animate(target, keyframes, options?)`

`target` is a CSS selector, an Element, or an array of Elements. `keyframes` is an object of CSS properties. Returns a `MotionAnimation` you can `.then()`, `.cancel()`, or attach event listeners to.

```js
animate("h1", { opacity: 1, y: 0 }, { duration: 0.6, ease: "easeOut" });

// from-to syntax
animate(".card",
  { opacity: [0, 1], y: [40, 0] },
  { duration: 0.7, delay: 0.2 }
);

// physics-based
animate(".chip", { scale: 1.1 }, { type: "spring", stiffness: 300, damping: 20 });
```

### Easing & timing

- `ease`: `"linear"`, `"easeIn"`, `"easeOut"`, `"easeInOut"`, or a `[x1, y1, x2, y2]` cubic-bezier array.
- `duration`: in seconds.
- `delay`: in seconds.
- `repeat`: number or `Infinity`. `repeatType: "loop" | "reverse" | "mirror"`.
- For springs, drop `duration`/`ease` and use `type: "spring"` with `stiffness`, `damping`, `mass`, or `bounce`.

## Orchestrated entrance — the most common use

This is the one effect that genuinely elevates a page. Do it once on first paint, well.

```html
<script type="module">
  import { animate, stagger } from "https://cdn.jsdelivr.net/npm/motion@latest/+esm";

  // Hero text resolves up; below-the-fold chrome eases in after.
  animate(
    ".hero-line",
    { opacity: [0, 1], y: [24, 0] },
    { duration: 0.9, delay: stagger(0.08), ease: [0.2, 0.7, 0.2, 1] }
  );
  animate(
    ".meta",
    { opacity: [0, 0.7] },
    { duration: 0.7, delay: 0.6 }
  );
</script>
```

`stagger(time)` returns a delay function that produces incrementally larger delays per element — Motion does the indexing for you.

## Scroll

### Scroll-triggered (one-shot when in view)

```js
import { animate, inView } from "https://cdn.jsdelivr.net/npm/motion@latest/+esm";

inView(".section", (info) => {
  animate(info.target,
    { opacity: [0, 1], y: [30, 0] },
    { duration: 0.7, ease: "easeOut" }
  );
  // return a cleanup fn if you want exit logic; omit for one-shot
});
```

### Scroll-linked (continuous binding to scroll progress)

```js
import { animate, scroll } from "https://cdn.jsdelivr.net/npm/motion@latest/+esm";

// Bar at top of the page that fills as the user scrolls.
scroll(animate(".progress", { scaleX: [0, 1] }));

// Element-bound: animate while .hero is on screen.
const target = document.querySelector(".hero img");
scroll(
  animate(target, { y: [0, -120], opacity: [1, 0.4] }),
  { target: target.parentElement, offset: ["start end", "end start"] }
);
```

`offset` syntax matches Framer Motion: `"start end"` means *the start of the element meets the end of the viewport*. Common combinations:
- `["start end", "end start"]` — for the duration the element is anywhere on screen.
- `["start 80%", "end 20%"]` — only while it's in the central band.

## Gestures

`hover` and `press` accept callbacks and clean themselves up.

```js
import { hover, press, animate } from "https://cdn.jsdelivr.net/npm/motion@latest/+esm";

hover(".card", (el) => {
  animate(el, { scale: 1.04, rotate: -1 }, { type: "spring", stiffness: 300 });
  return () => animate(el, { scale: 1, rotate: 0 });
});

press("button", (el) => {
  animate(el, { scale: 0.96 });
  return () => animate(el, { scale: 1 });
});
```

Don't sprinkle these on every element. Hover affordance on primary CTAs, link cards, and image tiles — that's it. Buttons should have a press response. Body text should not.

## Drag

```js
import { animate } from "https://cdn.jsdelivr.net/npm/motion@latest/+esm";

// Motion 11+ exposes a `drag` helper; for simple cases native pointer events
// + animate() are usually enough. Reach for drag only for genuine drag-to-reorder
// or carousel UI, which a brand landing page rarely needs.
```

For most brand pages, drag is overkill — leave it out unless the design genuinely calls for it (interactive moodboard, carousel without arrows, etc.).

## Choreography rules

1. **One orchestrated entrance per page.** Hero type, then images, then chrome — staggered. Don't also entrance-animate the footer, the nav, every section. Quietly fade the rest in.
2. **Movement should match the aesthetic.** Editorial / refined → slow easeOut, 0.7–1.0s, subtle y-translate. Brutalist → fast and snappy, no easing curves, instant translates. Playful → springs with bounce. Match the design direction; don't default to the same generic 0.4s easeIn.
3. **Reduce motion when the user has asked.** Wrap your motion code in:
   ```js
   if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
     // animate
   }
   ```
4. **Don't animate layout-shifting properties on every element.** `y`, `opacity`, `scale`, `rotate` are cheap. `width`, `height`, `top`, `left` are not — use Motion's `layout` API or transform-based equivalents.
5. **Pair with the type system.** A staggered fade on individual letters (split text into spans first, then `stagger(0.02)`) reads as type-driven motion and feels editorial. Whole-word fades feel generic.

## Reference

Source skills (React API, for translation reference):
- https://github.com/C-Jeril/framer-motion-skills (motion-core, scroll, variants, gestures, layout, react)

Library docs:
- https://motion.dev (vanilla + React)
- The vanilla API surface is the subset of Motion that works without React: `animate`, `scroll`, `inView`, `hover`, `press`, `stagger`, `spring`, plus selectors as targets.

## Concrete pattern checklist

When the user asks for "make it feel alive" or "add motion," default to this order, top to bottom:

1. **Entrance**: stagger reveal of hero type + a single image, ~0.7s, easeOut.
2. **Hover affordances** on primary clickable elements: small scale or slight rotate, spring.
3. **Scroll reveals** for below-the-fold sections: `inView` + fade-up, one-shot.
4. **Scroll-linked details** (parallax on hero, progress bar) — only if the page is long enough to feel it. Don't add parallax to a single-screen page.
5. **Gestures** (drag, press feedback) — only if interaction warrants it.

If you've ticked 1–3, the page already feels lively. 4 and 5 are the optional layers, not the baseline.
