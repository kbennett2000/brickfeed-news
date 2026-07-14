import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TTS_URL, validateConfig } from "../src/config.js";
import { resolveTtsUrl } from "../src/generator/tts.js";

const BASE = {
  feedUrls: ["https://feed"],
  manifestPath: "manifest.json",
  brickStyle: { styleLanguage: "toy-brick diorama" },
};

describe("config: generator.tts block (ADR-0022)", () => {
  it("leaves generator.tts undefined when the block is absent (disabled by default)", () => {
    const c = validateConfig(BASE);
    expect(c.generator.tts).toBeUndefined();
  });

  it("defaults url to DEFAULT_TTS_URL and all task flags to false when present-but-empty", () => {
    const c = validateConfig({ ...BASE, generator: { provider: "claude", tts: {} } });
    expect(c.generator.tts).toEqual({
      url: DEFAULT_TTS_URL,
      storyCover: false,
      opinionGate: false,
      opinionImageBrief: false,
    });
  });

  it("parses url and task flags", () => {
    const c = validateConfig({
      ...BASE,
      generator: {
        provider: "claude",
        tts: { url: "http://tts.lan:8712", storyCover: true, opinionGate: true, opinionImageBrief: false },
      },
    });
    expect(c.generator.tts).toEqual({
      url: "http://tts.lan:8712",
      storyCover: true,
      opinionGate: true,
      opinionImageBrief: false,
    });
  });

  it("rejects a non-object tts block", () => {
    expect(() => validateConfig({ ...BASE, generator: { tts: "nope" } })).toThrow(
      /generator\.tts must be an object/,
    );
  });

  it("rejects a non-boolean task flag", () => {
    expect(() =>
      validateConfig({ ...BASE, generator: { tts: { opinionGate: "yes" } } }),
    ).toThrow(/generator\.tts\.opinionGate must be a boolean/);
  });

  it("rejects an empty url string", () => {
    expect(() => validateConfig({ ...BASE, generator: { tts: { url: "" } } })).toThrow(
      /generator\.tts\.url must be a non-empty string/,
    );
  });
});

describe("resolveTtsUrl — TTS_URL env override (cron)", () => {
  const saved = process.env.TTS_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.TTS_URL;
    else process.env.TTS_URL = saved;
  });

  it("uses the config url when TTS_URL is unset", () => {
    delete process.env.TTS_URL;
    expect(resolveTtsUrl("http://config-host:8712")).toBe("http://config-host:8712");
  });

  it("lets TTS_URL override the config url", () => {
    process.env.TTS_URL = "http://cron-host:9999";
    expect(resolveTtsUrl("http://config-host:8712")).toBe("http://cron-host:9999");
  });
});
