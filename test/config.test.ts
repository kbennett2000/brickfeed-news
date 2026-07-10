import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config.js";

describe("validateConfig", () => {
  it("accepts a well-formed config", () => {
    const cfg = validateConfig({
      feedUrls: ["https://news.google.com/rss"],
      manifestPath: "data/manifest.json",
    });
    expect(cfg.feedUrls).toEqual(["https://news.google.com/rss"]);
    expect(cfg.manifestPath).toBe("data/manifest.json");
  });

  it("rejects an empty feedUrls array", () => {
    expect(() => validateConfig({ feedUrls: [], manifestPath: "m.json" })).toThrow();
  });

  it("rejects a missing manifestPath", () => {
    expect(() => validateConfig({ feedUrls: ["https://x"] })).toThrow();
  });

  it("rejects non-string feed entries", () => {
    expect(() =>
      validateConfig({ feedUrls: [123], manifestPath: "m.json" }),
    ).toThrow();
  });

  it("rejects a non-object config", () => {
    expect(() => validateConfig(null)).toThrow();
    expect(() => validateConfig("nope")).toThrow();
  });
});
