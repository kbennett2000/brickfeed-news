import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROK_BASE_URL,
  DEFAULT_GROK_MODEL,
  DEFAULT_IMAGE_ASPECT_RATIO,
  DEFAULT_IMAGE_GROK_BASE_URL,
  DEFAULT_IMAGE_GROK_MODEL,
  DEFAULT_IMAGE_LOCAL_STYLE,
  DEFAULT_IMAGE_LOCAL_URL,
  DEFAULT_IMAGE_RESOLUTION,
  DEFAULT_MAX_AGE_HOURS,
  DEFAULT_MODEL,
  DEFAULT_PUBLISHED_PATH,
  DEFAULT_STORAGE_BLOB_PATH_PREFIX,
  DEFAULT_STORAGE_LOCAL_DIR,
  DEFAULT_STORAGE_LOCAL_PUBLIC_BASE_URL,
  validateConfig,
} from "../src/config.js";

const base = {
  feedUrls: ["https://news.google.com/rss"],
  manifestPath: "data/manifest.json",
  brickStyle: { styleLanguage: "generic toy-brick diorama" },
};

describe("validateConfig", () => {
  it("accepts a well-formed config", () => {
    const cfg = validateConfig({
      ...base,
      generator: {
        provider: "grok",
        model: "claude-sonnet-5",
        grok: { baseUrl: "https://api.x.ai/v1", model: "grok-4.5" },
      },
    });
    expect(cfg.feedUrls).toEqual(["https://news.google.com/rss"]);
    expect(cfg.manifestPath).toBe("data/manifest.json");
    expect(cfg.generator).toEqual({
      provider: "grok",
      model: "claude-sonnet-5",
      grok: { baseUrl: "https://api.x.ai/v1", model: "grok-4.5" },
    });
    expect(cfg.brickStyle.styleLanguage).toBe("generic toy-brick diorama");
  });

  it("accepts the 'claude' (subscription) provider", () => {
    const cfg = validateConfig({
      ...base,
      generator: { provider: "claude", model: "claude-sonnet-5" },
    });
    expect(cfg.generator.provider).toBe("claude");
    expect(cfg.generator.model).toBe("claude-sonnet-5");
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

  it("defaults the generator block to grok + default model + grok defaults when absent", () => {
    const cfg = validateConfig(base);
    expect(cfg.generator.provider).toBe("grok");
    expect(cfg.generator.model).toBe(DEFAULT_MODEL);
    expect(cfg.generator.grok).toEqual({
      baseUrl: DEFAULT_GROK_BASE_URL,
      model: DEFAULT_GROK_MODEL,
    });
  });

  it("defaults model but keeps an explicit provider", () => {
    const cfg = validateConfig({ ...base, generator: { provider: "apikey" } });
    expect(cfg.generator.provider).toBe("apikey");
    expect(cfg.generator.model).toBe(DEFAULT_MODEL);
  });

  it("defaults the nested grok block per-field when partially specified", () => {
    const cfg = validateConfig({
      ...base,
      generator: { provider: "grok", grok: { model: "grok-mini" } },
    });
    expect(cfg.generator.grok.baseUrl).toBe(DEFAULT_GROK_BASE_URL);
    expect(cfg.generator.grok.model).toBe("grok-mini");
  });

  it("rejects an unknown generator.provider", () => {
    expect(() =>
      validateConfig({ ...base, generator: { provider: "openai" } }),
    ).toThrow();
  });

  it("rejects a non-string generator.model", () => {
    expect(() =>
      validateConfig({ ...base, generator: { provider: "claude", model: 42 } }),
    ).toThrow();
  });

  it("rejects a blank generator.grok.baseUrl", () => {
    expect(() =>
      validateConfig({ ...base, generator: { provider: "grok", grok: { baseUrl: "" } } }),
    ).toThrow();
  });

  it("defaults the image block to grok + nested defaults when absent", () => {
    const cfg = validateConfig(base);
    expect(cfg.image.provider).toBe("grok");
    expect(cfg.image.grok).toEqual({
      baseUrl: DEFAULT_IMAGE_GROK_BASE_URL,
      model: DEFAULT_IMAGE_GROK_MODEL,
      aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
      resolution: DEFAULT_IMAGE_RESOLUTION,
    });
    expect(cfg.image.local).toEqual({
      url: DEFAULT_IMAGE_LOCAL_URL,
      style: DEFAULT_IMAGE_LOCAL_STYLE,
    });
  });

  it("accepts the 'local' image provider", () => {
    const cfg = validateConfig({ ...base, image: { provider: "local" } });
    expect(cfg.image.provider).toBe("local");
  });

  it("defaults the nested image.grok block per-field when partially specified", () => {
    const cfg = validateConfig({
      ...base,
      image: { provider: "grok", grok: { model: "grok-imagine-fast" } },
    });
    expect(cfg.image.grok.model).toBe("grok-imagine-fast");
    expect(cfg.image.grok.baseUrl).toBe(DEFAULT_IMAGE_GROK_BASE_URL);
    expect(cfg.image.grok.aspectRatio).toBe(DEFAULT_IMAGE_ASPECT_RATIO);
  });

  it("rejects an unknown image.provider", () => {
    expect(() =>
      validateConfig({ ...base, image: { provider: "midjourney" } }),
    ).toThrow();
  });

  it("rejects a blank image.grok.baseUrl", () => {
    expect(() =>
      validateConfig({ ...base, image: { provider: "grok", grok: { baseUrl: "" } } }),
    ).toThrow();
  });

  it("rejects a blank image.local.url", () => {
    expect(() =>
      validateConfig({ ...base, image: { provider: "local", local: { url: "" } } }),
    ).toThrow();
  });

  it("defaults the storage block to blob + nested defaults when absent", () => {
    const cfg = validateConfig(base);
    expect(cfg.storage.provider).toBe("blob");
    expect(cfg.storage.blob).toEqual({
      pathPrefix: DEFAULT_STORAGE_BLOB_PATH_PREFIX,
      publicBaseUrl: "", // optional — empty until a Blob store is configured
    });
    expect(cfg.storage.local).toEqual({
      dir: DEFAULT_STORAGE_LOCAL_DIR,
      publicBaseUrl: DEFAULT_STORAGE_LOCAL_PUBLIC_BASE_URL,
    });
  });

  it("accepts the 'local' storage provider and a real blob publicBaseUrl", () => {
    const cfg = validateConfig({
      ...base,
      storage: {
        provider: "local",
        blob: { publicBaseUrl: "https://s.public.blob.vercel-storage.com" },
        local: { dir: "var/img", publicBaseUrl: "http://lan/img" },
      },
    });
    expect(cfg.storage.provider).toBe("local");
    expect(cfg.storage.blob.publicBaseUrl).toBe("https://s.public.blob.vercel-storage.com");
    expect(cfg.storage.local).toEqual({ dir: "var/img", publicBaseUrl: "http://lan/img" });
  });

  it("rejects an unknown storage.provider", () => {
    expect(() => validateConfig({ ...base, storage: { provider: "s3" } })).toThrow();
  });

  it("rejects a blank storage.blob.pathPrefix and a non-string publicBaseUrl", () => {
    expect(() =>
      validateConfig({ ...base, storage: { provider: "blob", blob: { pathPrefix: "" } } }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...base, storage: { provider: "blob", blob: { publicBaseUrl: 5 } } }),
    ).toThrow();
  });

  it("rejects a blank storage.local.dir", () => {
    expect(() =>
      validateConfig({ ...base, storage: { provider: "local", local: { dir: "" } } }),
    ).toThrow();
  });

  it("defaults maxAgeHours and publishedPath when absent", () => {
    const cfg = validateConfig(base);
    expect(cfg.maxAgeHours).toBe(DEFAULT_MAX_AGE_HOURS);
    expect(cfg.publishedPath).toBe(DEFAULT_PUBLISHED_PATH);
  });

  it("accepts an explicit positive maxAgeHours", () => {
    expect(validateConfig({ ...base, maxAgeHours: 24 }).maxAgeHours).toBe(24);
  });

  it("rejects a non-positive or non-number maxAgeHours", () => {
    expect(() => validateConfig({ ...base, maxAgeHours: 0 })).toThrow();
    expect(() => validateConfig({ ...base, maxAgeHours: -5 })).toThrow();
    expect(() => validateConfig({ ...base, maxAgeHours: "72" })).toThrow();
  });

  it("rejects a blank publishedPath", () => {
    expect(() => validateConfig({ ...base, publishedPath: "" })).toThrow();
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
