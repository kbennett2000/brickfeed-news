import { describe, expect, it } from "vitest";
import { normalizeUrl, storyId } from "../src/id.js";

describe("normalizeUrl", () => {
  it("lowercases the host", () => {
    expect(normalizeUrl("https://Www.Example.COM/path")).toBe(
      "https://www.example.com/path",
    );
  });

  it("strips the query string (including utm/tracking) and fragment", () => {
    expect(
      normalizeUrl("https://example.com/story?utm_source=google&utm_medium=rss#top"),
    ).toBe("https://example.com/story");
  });

  it("strips a trailing slash from a non-root path", () => {
    expect(normalizeUrl("https://example.com/a/b/")).toBe("https://example.com/a/b");
  });

  it("keeps the root path slash", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("degrades gracefully for an unparseable URL", () => {
    expect(normalizeUrl("  NotAUrl  ")).toBe("notaurl");
  });
});

describe("storyId", () => {
  it("is a stable sha256 hex string", () => {
    const id = storyId("https://example.com/story");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(storyId("https://example.com/story")).toBe(id); // deterministic
  });

  it("same article via different tracking params => same ID", () => {
    const a = storyId("https://example.com/story?utm_source=a&fbclid=123");
    const b = storyId("https://example.com/story?utm_source=b&gclid=999");
    const c = storyId("https://example.com/story/");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("different articles => different IDs", () => {
    expect(storyId("https://example.com/one")).not.toBe(
      storyId("https://example.com/two"),
    );
  });
});
