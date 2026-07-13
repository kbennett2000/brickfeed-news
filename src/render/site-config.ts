/**
 * Deploy-root artifacts emitted by the render (ADR-0012): `vercel.json`, `robots.txt`, and
 * `sitemap.xml`. These are NOT committed to the repo — `site/` is git-ignored and rebuilt every
 * render, then deployed as-is — so the render must produce them alongside the HTML, exactly like
 * `index.html`. Pure string builders, no IO.
 */

/** Escape the five XML metacharacters for safe inclusion in a `<loc>` (URLs are otherwise clean). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The Blob host (e.g. `abc123.public.blob.vercel-storage.com`) from its public base URL, or
 * null when the URL isn't an absolute origin (e.g. a `local` provider's relative `images` base) —
 * in which case image optimization is skipped rather than pointed at a bogus remote pattern. */
export function blobHostname(publicBaseUrl: string): string | null {
  try {
    const host = new URL(publicBaseUrl).hostname;
    return host || null;
  } catch {
    return null;
  }
}

/** Image-optimization inputs for `vercel.json`'s `images` block (ADR-0012). */
export interface VercelImageOptimize {
  widths: number[];
  quality: number;
  blobHost: string;
}

/**
 * Build `vercel.json`. Always carries security headers (nosniff + a conservative Referrer-Policy)
 * and a sane `Cache-Control` for the un-hashed `styles.css`. When `imageOptimize` is present it
 * also configures Vercel Image Optimization: AVIF/WebP output, the exact `sizes`/`qualities` the
 * render's `srcset` requests (Vercel rejects widths/qualities outside these lists), a long edge
 * cache, and a `remotePatterns` allow-list for the Blob host the images are proxied from.
 */
export function renderVercelJson(opts: { imageOptimize?: VercelImageOptimize } = {}): string {
  const config: Record<string, unknown> = {
    $schema: "https://openapi.vercel.sh/vercel.json",
    headers: [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // styles.css has no content hash in its name, so cache it briefly with a long
        // stale-while-revalidate rather than marking it immutable.
        source: "/styles.css",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
        ],
      },
    ],
  };

  if (opts.imageOptimize) {
    const { widths, quality, blobHost } = opts.imageOptimize;
    config.images = {
      sizes: [...new Set(widths.filter((w) => w > 0))].sort((a, b) => a - b),
      qualities: [quality],
      formats: ["image/avif", "image/webp"],
      // ~31 days: our Blob keys overwrite in place, so a long optimized-image cache is safe.
      minimumCacheTTL: 2678400,
      remotePatterns: [{ protocol: "https", hostname: blobHost }],
    };
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

/** `robots.txt`: allow everything, keep the noindex operator Share sheet out, point at the sitemap. */
export function renderRobotsTxt(siteBaseUrl: string): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /share.html",
    `Sitemap: ${siteBaseUrl}/sitemap.xml`,
    "",
  ].join("\n");
}

/**
 * `sitemap.xml` from a list of site-relative paths (`""` = the cover). Each becomes an absolute
 * `<loc>` under `siteBaseUrl`. Callers exclude the noindex Share sheet and non-page assets.
 */
export function renderSitemapXml(siteBaseUrl: string, relPaths: string[]): string {
  const urls = relPaths
    .map((p) => (p === "" ? `${siteBaseUrl}/` : `${siteBaseUrl}/${p}`))
    .map((loc) => `  <url><loc>${escapeXml(loc)}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
