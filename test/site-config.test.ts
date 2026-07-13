import { describe, expect, it } from "vitest";
import {
  blobHostname,
  renderRobotsTxt,
  renderSitemapXml,
  renderVercelJson,
} from "../src/render/site-config.js";

describe("blobHostname", () => {
  it("extracts the host from an absolute Blob base URL", () => {
    expect(blobHostname("https://abc123.public.blob.vercel-storage.com")).toBe(
      "abc123.public.blob.vercel-storage.com",
    );
  });

  it("returns null for a relative/non-absolute base (e.g. a local provider)", () => {
    expect(blobHostname("images")).toBeNull();
    expect(blobHostname("")).toBeNull();
  });
});

describe("renderVercelJson", () => {
  it("always carries security headers and a styles.css cache rule", () => {
    const cfg = JSON.parse(renderVercelJson());
    expect(cfg.$schema).toContain("vercel.json");
    const flat = JSON.stringify(cfg.headers);
    expect(flat).toContain("X-Content-Type-Options");
    expect(flat).toContain("Referrer-Policy");
    expect(flat).toContain("/styles.css");
    // No images block unless optimization is passed.
    expect(cfg.images).toBeUndefined();
  });

  it("adds an images block with sorted sizes, the quality, formats, and the Blob remotePattern", () => {
    const cfg = JSON.parse(
      renderVercelJson({
        imageOptimize: { widths: [1280, 320, 640], quality: 75, blobHost: "x.blob.example.com" },
      }),
    );
    expect(cfg.images.sizes).toEqual([320, 640, 1280]);
    expect(cfg.images.qualities).toEqual([75]);
    expect(cfg.images.formats).toEqual(["image/avif", "image/webp"]);
    expect(cfg.images.minimumCacheTTL).toBeGreaterThan(0);
    expect(cfg.images.remotePatterns).toEqual([
      { protocol: "https", hostname: "x.blob.example.com" },
    ]);
  });
});

describe("renderRobotsTxt", () => {
  it("allows all, disallows the share sheet, and points at the sitemap", () => {
    const robots = renderRobotsTxt("https://www.brickfeed.example");
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Disallow: /share.html");
    expect(robots).toContain("Sitemap: https://www.brickfeed.example/sitemap.xml");
  });
});

describe("renderSitemapXml", () => {
  it("maps '' to the origin root and prefixes the rest, escaping XML", () => {
    const xml = renderSitemapXml("https://www.brickfeed.example", ["", "about.html", "s/a&b.html"]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<loc>https://www.brickfeed.example/</loc>");
    expect(xml).toContain("<loc>https://www.brickfeed.example/about.html</loc>");
    // The ampersand in a path is XML-escaped.
    expect(xml).toContain("s/a&amp;b.html</loc>");
  });
});
