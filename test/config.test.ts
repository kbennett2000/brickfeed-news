import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, validateConfig } from "../src/config.js";

const base = {
  feedUrls: ["https://news.google.com/rss"],
  manifestPath: "data/manifest.json",
  brickStyle: { styleLanguage: "generic toy-brick diorama" },
};

describe("validateConfig", () => {
  it("accepts a well-formed config", () => {
    const cfg = validateConfig({
      ...base,
      generator: { provider: "subscription", model: "claude-sonnet-5" },
    });
    expect(cfg.feedUrls).toEqual(["https://news.google.com/rss"]);
    expect(cfg.manifestPath).toBe("data/manifest.json");
    expect(cfg.generator).toEqual({ provider: "subscription", model: "claude-sonnet-5" });
    expect(cfg.brickStyle.styleLanguage).toBe("generic toy-brick diorama");
  });

  it("rejects an empty feedUrls array", () => {
    expect(() => validateConfig({ ...base, feedUrls: [] })).toThrow();
  });

  it("rejects a missing manifestPath", () => {
    expect(() =>
      validateConfig({ feedUrls: ["https://x"], brickStyle: base.brickStyle }),
    ).toThrow();
  });

  it("rejects non-string feed entries", () => {
    expect(() => validateConfig({ ...base, feedUrls: [123] })).toThrow();
  });

  it("rejects a non-object config", () => {
    expect(() => validateConfig(null)).toThrow();
    expect(() => validateConfig("nope")).toThrow();
  });

  it("defaults the generator block to subscription + default model when absent", () => {
    const cfg = validateConfig(base);
    expect(cfg.generator.provider).toBe("subscription");
    expect(cfg.generator.model).toBe(DEFAULT_MODEL);
  });

  it("defaults model but keeps an explicit provider", () => {
    const cfg = validateConfig({ ...base, generator: { provider: "apikey" } });
    expect(cfg.generator.provider).toBe("apikey");
    expect(cfg.generator.model).toBe(DEFAULT_MODEL);
  });

  it("rejects an unknown generator.provider", () => {
    expect(() =>
      validateConfig({ ...base, generator: { provider: "openai" } }),
    ).toThrow();
  });

  it("rejects a non-string generator.model", () => {
    expect(() =>
      validateConfig({ ...base, generator: { provider: "subscription", model: 42 } }),
    ).toThrow();
  });

  it("rejects a missing or blank brickStyle.styleLanguage", () => {
    expect(() =>
      validateConfig({ feedUrls: base.feedUrls, manifestPath: base.manifestPath }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...base, brickStyle: { styleLanguage: "   " } }),
    ).toThrow();
  });
});
