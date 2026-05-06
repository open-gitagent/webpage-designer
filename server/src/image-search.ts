import { tool } from "gitclaw";
import type { GCToolDefinition } from "gitclaw";

interface PhotoResult {
  source: "unsplash" | "pexels" | "picsum";
  url: string;
  thumb: string;
  width: number;
  height: number;
  alt: string;
  photographer: string;
  photographer_url?: string;
  attribution_html: string;
  download_url: string;
}

async function searchUnsplash(query: string, count: number, orientation?: string): Promise<PhotoResult[]> {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return [];
  const params = new URLSearchParams({
    query,
    per_page: String(Math.min(count, 12)),
    content_filter: "high",
  });
  if (orientation) params.set("orientation", orientation);
  const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
    headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
  });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data.results ?? []).map((p: any): PhotoResult => ({
    source: "unsplash",
    url: p.urls.regular,
    thumb: p.urls.small,
    width: p.width,
    height: p.height,
    alt: p.alt_description ?? p.description ?? query,
    photographer: p.user?.name ?? "Unknown",
    photographer_url: p.user?.links?.html,
    attribution_html: `Photo by <a href="${p.user?.links?.html}?utm_source=designer&utm_medium=referral">${p.user?.name}</a> on <a href="https://unsplash.com/?utm_source=designer&utm_medium=referral">Unsplash</a>`,
    download_url: p.urls.regular,
  }));
}

async function searchPexels(query: string, count: number, orientation?: string): Promise<PhotoResult[]> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];
  const params = new URLSearchParams({
    query,
    per_page: String(Math.min(count, 12)),
  });
  if (orientation) params.set("orientation", orientation);
  const res = await fetch(`https://api.pexels.com/v1/search?${params}`, {
    headers: { Authorization: key },
  });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data.photos ?? []).map((p: any): PhotoResult => ({
    source: "pexels",
    url: p.src.large2x ?? p.src.large,
    thumb: p.src.medium,
    width: p.width,
    height: p.height,
    alt: p.alt ?? query,
    photographer: p.photographer ?? "Unknown",
    photographer_url: p.photographer_url,
    attribution_html: `Photo by <a href="${p.photographer_url}">${p.photographer}</a> on <a href="https://www.pexels.com">Pexels</a>`,
    download_url: p.src.original,
  }));
}

function picsumFallback(query: string, count: number, orientation?: string): PhotoResult[] {
  const [w, h] = orientation === "portrait" ? [800, 1200] : orientation === "square" ? [1000, 1000] : [1600, 900];
  const seed = encodeURIComponent(query.toLowerCase().replace(/\s+/g, "-"));
  return Array.from({ length: count }, (_, i) => {
    const url = `https://picsum.photos/seed/${seed}-${i + 1}/${w}/${h}`;
    return {
      source: "picsum" as const,
      url,
      thumb: `https://picsum.photos/seed/${seed}-${i + 1}/400/${Math.round((400 * h) / w)}`,
      width: w,
      height: h,
      alt: query,
      photographer: "Lorem Picsum",
      attribution_html: 'Image from <a href="https://picsum.photos">Lorem Picsum</a>',
      download_url: url,
    };
  });
}

export function buildImageSearchTools(): GCToolDefinition[] {
  const searchPhotos = tool(
    "search_photos",
    "Search free, royalty-free stock photos by keywords. Tries Unsplash first (if UNSPLASH_ACCESS_KEY is set), then Pexels (if PEXELS_API_KEY is set), then a deterministic-random Picsum fallback. Returns up to `count` results with download URLs and proper photographer attribution. Use when the user has not provided a reference image and the page needs a high-quality hero / mood image. Pair with fetch_url_image to actually save the chosen photo into site/assets/.",
    {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keywords. Be specific and visual — 'concrete brutalist building dusk' beats 'building'.",
        },
        count: {
          type: "number",
          description: "How many candidates to return (default 6, max 12).",
        },
        orientation: {
          type: "string",
          enum: ["landscape", "portrait", "square"],
          description: "Preferred image orientation.",
        },
      },
      required: ["query"],
    },
    async (args: { query: string; count?: number; orientation?: string }) => {
      const count = Math.max(1, Math.min(12, args.count ?? 6));
      let results: PhotoResult[] = [];
      try {
        results = await searchUnsplash(args.query, count, args.orientation);
      } catch {}
      if (results.length === 0) {
        try {
          results = await searchPexels(args.query, count, args.orientation);
        } catch {}
      }
      if (results.length === 0) {
        results = picsumFallback(args.query, count, args.orientation);
      }
      const list = results.map((r, i) => {
        return [
          `[${i + 1}] (${r.source}) ${r.alt}`,
          `    download: ${r.download_url}`,
          `    ${r.width}×${r.height}, by ${r.photographer}`,
          `    attribution: ${r.attribution_html}`,
        ].join("\n");
      });
      return {
        text: `Found ${results.length} photo(s) for "${args.query}":\n\n${list.join("\n\n")}\n\nNext step: pick one, call fetch_url_image with its download URL into site/assets/, then reference it in HTML with the attribution_html in the page footer or near the image.`,
      };
    },
  );

  return [searchPhotos];
}
