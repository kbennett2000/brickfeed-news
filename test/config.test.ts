import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEPLOY_COMMAND,
  DEFAULT_GROK_BASE_URL,
  DEFAULT_GROK_MODEL,
  DEFAULT_GROK_TERMINAL_COMMAND,
  DEFAULT_IMAGE_ASPECT_RATIO,
  DEFAULT_IMAGE_GROK_BASE_URL,
  DEFAULT_IMAGE_GROK_MODEL,
  DEFAULT_IMAGE_LOCAL_STYLE,
  DEFAULT_IMAGE_LOCAL_URL,
  DEFAULT_IMAGE_OPTIMIZE_ENABLED,
  DEFAULT_IMAGE_OPTIMIZE_MAX_EDGE,
  DEFAULT_IMAGE_OPTIMIZE_QUALITY,
  DEFAULT_IMAGE_RESOLUTION,
  DEFAULT_MAX_AGE_HOURS,
  DEFAULT_MODEL,
  DEFAULT_PUBLISHED_PATH,
  DEFAULT_RENDER_OUTPUT_DIR,
  DEFAULT_RENDER_SECONDARY_STORY_COUNT,
  DEFAULT_RENDER_TIME_ZONE,
  DEFAULT_RENDER_SITE_BASE_URL,
  DEFAULT_RENDER_ANALYTICS,
  DEFAULT_RENDER_IMAGE_OPTIMIZATION_ENABLED,
  DEFAULT_RENDER_IMAGE_OPTIMIZATION_WIDTHS,
  DEFAULT_RENDER_IMAGE_OPTIMIZATION_QUALITY,
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
      grokTerminal: { command: DEFAULT_GROK_TERMINAL_COMMAND, args: [] },
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

  it("defaults the generator block to the keyless grok-terminal provider when absent", () => {
    const cfg = validateConfig(base);
    expect(cfg.generator.provider).toBe("grok-terminal");
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

  it("defaults the image block to the keyless grok-terminal provider + nested defaults when absent", () => {
    const cfg = validateConfig(base);
    expect(cfg.image.provider).toBe("grok-terminal");
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
    expect(cfg.image.optimize).toEqual({
      enabled: DEFAULT_IMAGE_OPTIMIZE_ENABLED,
      maxEdge: DEFAULT_IMAGE_OPTIMIZE_MAX_EDGE,
      quality: DEFAULT_IMAGE_OPTIMIZE_QUALITY,
    });
  });

  it("defaults image.optimize to ON (enabled=true) when absent", () => {
    const cfg = validateConfig(base);
    expect(cfg.image.optimize.enabled).toBe(true);
  });

  it("accepts an explicit image.optimize block and defaults its fields per-field", () => {
    const cfg = validateConfig({
      ...base,
      image: { provider: "grok-terminal", optimize: { enabled: false, maxEdge: 1024 } },
    });
    expect(cfg.image.optimize.enabled).toBe(false);
    expect(cfg.image.optimize.maxEdge).toBe(1024);
    expect(cfg.image.optimize.quality).toBe(DEFAULT_IMAGE_OPTIMIZE_QUALITY);
  });

  it("rejects invalid image.optimize values", () => {
    expect(() =>
      validateConfig({ ...base, image: { optimize: { enabled: "yes" } } }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...base, image: { optimize: { maxEdge: 0 } } }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...base, image: { optimize: { quality: 150 } } }),
    ).toThrow();
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

  it("defaults the render block when absent", () => {
    const cfg = validateConfig(base);
    expect(cfg.render).toEqual({
      outputDir: DEFAULT_RENDER_OUTPUT_DIR,
      secondaryStoryCount: DEFAULT_RENDER_SECONDARY_STORY_COUNT,
      timeZone: DEFAULT_RENDER_TIME_ZONE,
      siteBaseUrl: DEFAULT_RENDER_SITE_BASE_URL,
      analytics: DEFAULT_RENDER_ANALYTICS,
      share: {},
      imageOptimization: {
        enabled: DEFAULT_RENDER_IMAGE_OPTIMIZATION_ENABLED,
        widths: DEFAULT_RENDER_IMAGE_OPTIMIZATION_WIDTHS,
        quality: DEFAULT_RENDER_IMAGE_OPTIMIZATION_QUALITY,
      },
    });
  });

  it("defaults render.analytics to none and accepts an explicit vercel/none", () => {
    expect(validateConfig({ ...base, render: { outputDir: "public" } }).render.analytics).toBe(
      "none",
    );
    expect(
      validateConfig({ ...base, render: { analytics: "vercel" } }).render.analytics,
    ).toBe("vercel");
    expect(
      validateConfig({ ...base, render: { analytics: "none" } }).render.analytics,
    ).toBe("none");
  });

  it("rejects an unknown render.analytics value", () => {
    expect(() =>
      validateConfig({ ...base, render: { analytics: "google" } }),
    ).toThrow(/render\.analytics/);
  });

  it("defaults render.imageOptimization to ON with the standard width ladder when absent", () => {
    const io = validateConfig({ ...base, render: { outputDir: "public" } }).render.imageOptimization;
    expect(io.enabled).toBe(true);
    expect(io.widths).toEqual(DEFAULT_RENDER_IMAGE_OPTIMIZATION_WIDTHS);
    expect(io.quality).toBe(DEFAULT_RENDER_IMAGE_OPTIMIZATION_QUALITY);
  });

  it("accepts an explicit render.imageOptimization and defaults its fields per-field", () => {
    const io = validateConfig({
      ...base,
      render: { imageOptimization: { enabled: false } },
    }).render.imageOptimization;
    expect(io.enabled).toBe(false);
    expect(io.widths).toEqual(DEFAULT_RENDER_IMAGE_OPTIMIZATION_WIDTHS); // defaulted
    expect(io.quality).toBe(DEFAULT_RENDER_IMAGE_OPTIMIZATION_QUALITY); // defaulted
  });

  it("rejects invalid render.imageOptimization values", () => {
    expect(() =>
      validateConfig({ ...base, render: { imageOptimization: { enabled: "yes" } } }),
    ).toThrow(/imageOptimization\.enabled/);
    expect(() =>
      validateConfig({ ...base, render: { imageOptimization: { widths: [] } } }),
    ).toThrow(/imageOptimization\.widths/);
    expect(() =>
      validateConfig({ ...base, render: { imageOptimization: { widths: [320, -1] } } }),
    ).toThrow(/imageOptimization\.widths/);
    expect(() =>
      validateConfig({ ...base, render: { imageOptimization: { quality: 0 } } }),
    ).toThrow(/imageOptimization\.quality/);
    expect(() =>
      validateConfig({ ...base, render: { imageOptimization: { quality: 101 } } }),
    ).toThrow(/imageOptimization\.quality/);
  });

  it("defaults render.siteBaseUrl when omitted and keeps a valid explicit one", () => {
    expect(validateConfig({ ...base, render: { outputDir: "public" } }).render.siteBaseUrl).toBe(
      DEFAULT_RENDER_SITE_BASE_URL,
    );
    const cfg = validateConfig({
      ...base,
      render: { siteBaseUrl: "https://www.brickfeed.news" },
    });
    expect(cfg.render.siteBaseUrl).toBe("https://www.brickfeed.news");
  });

  it("rejects a render.siteBaseUrl with a trailing slash or a non-http value", () => {
    expect(() =>
      validateConfig({ ...base, render: { siteBaseUrl: "https://www.brickfeed.news/" } }),
    ).toThrow(/trailing slash/);
    expect(() =>
      validateConfig({ ...base, render: { siteBaseUrl: "brickfeed.news" } }),
    ).toThrow(/http/);
    expect(() =>
      validateConfig({ ...base, render: { siteBaseUrl: "" } }),
    ).toThrow();
  });

  it("defaults render.share to empty and validates a configured share block", () => {
    expect(validateConfig(base).render.share).toEqual({});
    const cfg = validateConfig({
      ...base,
      render: { share: { handle: "@brickfeednews", hashtags: ["#brickfeed", "news"] } },
    });
    // Leading @ and # are stripped for the Web Intent params.
    expect(cfg.render.share).toEqual({ handle: "brickfeednews", hashtags: ["brickfeed", "news"] });
  });

  it("rejects a bad render.share.handle or hashtags", () => {
    expect(() =>
      validateConfig({ ...base, render: { share: { handle: "" } } }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...base, render: { share: { hashtags: "brickfeed" } } }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...base, render: { share: { hashtags: ["ok", ""] } } }),
    ).toThrow();
  });

  it("accepts an explicit render block and defaults per-field", () => {
    const cfg = validateConfig({ ...base, render: { outputDir: "public" } });
    expect(cfg.render.outputDir).toBe("public");
    expect(cfg.render.secondaryStoryCount).toBe(DEFAULT_RENDER_SECONDARY_STORY_COUNT);
    expect(cfg.render.timeZone).toBe(DEFAULT_RENDER_TIME_ZONE);
    expect(validateConfig({ ...base, render: { secondaryStoryCount: 0 } }).render.secondaryStoryCount).toBe(0);
  });

  it("accepts an explicit render.timeZone", () => {
    const cfg = validateConfig({ ...base, render: { timeZone: "America/Denver" } });
    expect(cfg.render.timeZone).toBe("America/Denver");
  });

  it("rejects a blank render.outputDir, a bad render.secondaryStoryCount, and a blank render.timeZone", () => {
    expect(() => validateConfig({ ...base, render: { outputDir: "" } })).toThrow();
    expect(() =>
      validateConfig({ ...base, render: { secondaryStoryCount: -1 } }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...base, render: { secondaryStoryCount: 2.5 } }),
    ).toThrow();
    expect(() => validateConfig({ ...base, render: { timeZone: "" } })).toThrow();
  });

  it("accepts the 'grok-terminal' generator + image providers and defaults grokTerminal", () => {
    const cfg = validateConfig({
      ...base,
      generator: { provider: "grok-terminal" },
      image: { provider: "grok-terminal" },
    });
    expect(cfg.generator.provider).toBe("grok-terminal");
    expect(cfg.image.provider).toBe("grok-terminal");
    expect(cfg.generator.grokTerminal).toEqual({
      command: DEFAULT_GROK_TERMINAL_COMMAND,
      args: [],
    });
    expect(cfg.image.grokTerminal).toEqual({ command: DEFAULT_GROK_TERMINAL_COMMAND, args: [] });
  });

  it("accepts an explicit grokTerminal command + args and rejects non-string args", () => {
    const cfg = validateConfig({
      ...base,
      generator: { provider: "grok-terminal", grokTerminal: { command: "xai", args: ["chat"] } },
    });
    expect(cfg.generator.grokTerminal).toEqual({ command: "xai", args: ["chat"] });
    expect(() =>
      validateConfig({ ...base, generator: { grokTerminal: { args: [1, 2] } } }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...base, generator: { grokTerminal: { command: "" } } }),
    ).toThrow();
  });

  it("accepts an explicit grokTerminal.timeoutMs and rejects an invalid one", () => {
    const cfg = validateConfig({
      ...base,
      image: { provider: "grok-terminal", grokTerminal: { command: "grok", timeoutMs: 90000 } },
    });
    expect(cfg.image.grokTerminal.timeoutMs).toBe(90000);
    // Absent → undefined (provider applies its own default).
    expect(cfg.generator.grokTerminal.timeoutMs).toBeUndefined();
    for (const bad of [0, -1, 1.5, "60000"]) {
      expect(() =>
        validateConfig({ ...base, generator: { grokTerminal: { timeoutMs: bad } } }),
      ).toThrow(/timeoutMs must be a positive integer/);
    }
  });

  it("defaults concurrency + maxStoriesPerCycle when absent", () => {
    const cfg = validateConfig(base);
    expect(cfg.concurrency).toBe(4);
    expect(cfg.maxStoriesPerCycle).toBe(40);
  });

  it("accepts explicit concurrency + maxStoriesPerCycle", () => {
    const cfg = validateConfig({ ...base, concurrency: 8, maxStoriesPerCycle: 50 });
    expect(cfg.concurrency).toBe(8);
    expect(cfg.maxStoriesPerCycle).toBe(50);
  });

  it("rejects a non-positive-integer concurrency or maxStoriesPerCycle", () => {
    for (const bad of [0, -2, 2.5, "4"]) {
      expect(() => validateConfig({ ...base, concurrency: bad })).toThrow(
        /concurrency must be a positive integer/,
      );
    }
    for (const bad of [0, -1, 3.3, "20"]) {
      expect(() => validateConfig({ ...base, maxStoriesPerCycle: bad })).toThrow(
        /maxStoriesPerCycle must be a positive integer/,
      );
    }
  });

  it("defaults the deploy block when absent (cwd = render.outputDir)", () => {
    const cfg = validateConfig(base);
    expect(cfg.deploy).toEqual({
      command: DEFAULT_DEPLOY_COMMAND,
      cwd: DEFAULT_RENDER_OUTPUT_DIR,
      enabled: true,
    });
  });

  it("defaults deploy.cwd to a custom render.outputDir", () => {
    const cfg = validateConfig({ ...base, render: { outputDir: "public" } });
    expect(cfg.deploy.cwd).toBe("public");
  });

  it("accepts an explicit deploy block and defaults per-field", () => {
    const cfg = validateConfig({
      ...base,
      deploy: { command: "netlify deploy --prod", enabled: false },
    });
    expect(cfg.deploy.command).toBe("netlify deploy --prod");
    expect(cfg.deploy.enabled).toBe(false);
    expect(cfg.deploy.cwd).toBe(DEFAULT_RENDER_OUTPUT_DIR);
  });

  it("rejects a blank deploy.command and a non-boolean deploy.enabled", () => {
    expect(() => validateConfig({ ...base, deploy: { command: "" } })).toThrow();
    expect(() => validateConfig({ ...base, deploy: { enabled: "yes" } })).toThrow();
  });

  describe("legacy provider back-compat + actionable enum errors", () => {
    afterEach(() => vi.restoreAllMocks());

    it("maps legacy generator.provider \"subscription\" to \"claude\" with a stderr warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cfg = validateConfig(
        { ...base, generator: { provider: "subscription", model: "claude-sonnet-5" } },
        "config.json",
      );
      expect(cfg.generator.provider).toBe("claude");
      expect(cfg.generator.model).toBe("claude-sonnet-5");
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain("config.json");
      expect(msg).toContain("subscription");
      expect(msg).toContain("claude");
    });

    it("does not warn for a valid, current provider value", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      validateConfig({ ...base, generator: { provider: "claude" } });
      expect(warn).not.toHaveBeenCalled();
    });

    it("still rejects a truly unknown provider — with an actionable message", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(() =>
        validateConfig({ ...base, generator: { provider: "openai" } }, "config.json"),
      ).toThrow(/config\.json.*generator\.provider.*"openai".*Allowed values.*"grok".*"claude".*"apikey".*"grok-terminal"/s);
      // The rename hint is present for the generator provider (it has an alias).
      expect(() =>
        validateConfig({ ...base, generator: { provider: "openai" } }),
      ).toThrow(/"subscription" → "claude"/);
      // An unknown provider is an error, never a silent warning.
      expect(warn).not.toHaveBeenCalled();
    });

    it("gives actionable image + storage enum errors (no rename hint — never renamed)", () => {
      expect(() =>
        validateConfig({ ...base, image: { provider: "midjourney" } }, "config.json"),
      ).toThrow(/config\.json.*image\.provider.*"midjourney".*Allowed values.*"grok".*"local".*"grok-terminal"/s);
      expect(() =>
        validateConfig({ ...base, storage: { provider: "s3" } }, "config.json"),
      ).toThrow(/config\.json.*storage\.provider.*"s3".*Allowed values.*"blob".*"local"/s);
      // These blocks have no renamed values, so no misleading rename hint.
      expect(() => validateConfig({ ...base, image: { provider: "midjourney" } })).toThrow(
        /^(?!.*renamed).*$/s,
      );
    });

    it("describes a non-string bad provider value in the error", () => {
      expect(() =>
        validateConfig({ ...base, generator: { provider: 42 } }, "config.json"),
      ).toThrow(/generator\.provider is 42/);
    });
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
