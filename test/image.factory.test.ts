import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GrokImageProvider,
  GrokTerminalImageProvider,
  LocalImageProvider,
  createImageProvider,
} from "../src/image/index.js";
import { bytes, fakeImageRunner, makeConfig } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createImageProvider (provider selection)", () => {
  it("defaults to the Grok Imagine provider", () => {
    expect(createImageProvider(makeConfig())).toBeInstanceOf(GrokImageProvider);
  });

  it("selects the local imagegen provider when provider is 'local'", () => {
    const config = makeConfig();
    config.image.provider = "local";
    expect(createImageProvider(config)).toBeInstanceOf(LocalImageProvider);
  });

  it("selects the grok-terminal provider when provider is 'grok-terminal'", () => {
    const config = makeConfig();
    config.image.provider = "grok-terminal";
    expect(createImageProvider(config)).toBeInstanceOf(GrokTerminalImageProvider);
  });

  it("passes an injected terminalRunner through to the grok-terminal provider", async () => {
    const config = makeConfig();
    config.image.provider = "grok-terminal";
    const gen = createImageProvider(config, {
      terminalRunner: async () => ({ bytes: bytes("PNG"), code: 0 }),
    });
    expect(await gen.generate("a wrapped prompt")).toEqual(bytes("PNG"));
  });

  it("passes an injected runner through to the Grok provider", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const runner = fakeImageRunner({
      routes: {
        ["POST https://img.test/v1/images/generations"]: {
          bytes: bytes(JSON.stringify({ data: [{ url: "https://cdn.img.test/z.png" }] })),
        },
        ["GET https://cdn.img.test/z.png"]: { bytes: bytes("PNG") },
      },
    });
    const gen = createImageProvider(makeConfig(), { runner });
    expect(await gen.generate("a wrapped prompt")).toEqual(bytes("PNG"));
    expect(runner.calls.length).toBeGreaterThan(0);
  });

  it("passes an injected runner through to the local provider", async () => {
    const config = makeConfig();
    config.image.provider = "local";
    const runner = fakeImageRunner({
      routes: { ["POST http://imagegen.test/generate"]: { bytes: bytes("PNG") } },
    });
    const gen = createImageProvider(config, { runner });
    expect(await gen.generate("a wrapped prompt")).toEqual(bytes("PNG"));
    expect(runner.calls[0].url).toBe("http://imagegen.test/generate");
  });
});
