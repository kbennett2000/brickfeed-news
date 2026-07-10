import { describe, expect, it } from "vitest";
import {
  ApiKeyGenerator,
  GrokGenerator,
  GrokTerminalGenerator,
  SubscriptionGenerator,
  createGenerator,
} from "../src/generator/index.js";
import { makeConfig } from "./helpers.js";

describe("createGenerator (provider selection)", () => {
  it("defaults to the Grok generator", () => {
    const gen = createGenerator(makeConfig());
    expect(gen).toBeInstanceOf(GrokGenerator);
  });

  it("selects the subscription generator when provider is 'claude'", () => {
    const gen = createGenerator(
      makeConfig({
        generator: {
          provider: "claude",
          model: "test-model",
          grok: { baseUrl: "https://grok.test/v1", model: "grok-test" },
          grokTerminal: { command: "grok-test", args: [] },
        },
      }),
    );
    expect(gen).toBeInstanceOf(SubscriptionGenerator);
  });

  it("selects the API-key stub when provider is 'apikey'", () => {
    const gen = createGenerator(
      makeConfig({
        generator: {
          provider: "apikey",
          model: "test-model",
          grok: { baseUrl: "https://grok.test/v1", model: "grok-test" },
          grokTerminal: { command: "grok-test", args: [] },
        },
      }),
    );
    expect(gen).toBeInstanceOf(ApiKeyGenerator);
  });

  it("selects the grok-terminal generator when provider is 'grok-terminal'", () => {
    const config = makeConfig();
    config.generator.provider = "grok-terminal";
    expect(createGenerator(config)).toBeInstanceOf(GrokTerminalGenerator);
  });

  it("passes an injected terminalRunner through to the grok-terminal generator", async () => {
    const config = makeConfig();
    config.generator.provider = "grok-terminal";
    let called = false;
    const gen = createGenerator(config, {
      terminalRunner: async () => {
        called = true;
        return { stdout: "", code: 1 };
      },
    });
    const out = await gen.generate({ title: "t", sourceName: "s", url: "https://x" });
    expect(out).toBeNull();
    expect(called).toBe(true);
  });

  it("passes an injected grokRunner through to the Grok generator", async () => {
    let called = false;
    const gen = createGenerator(makeConfig(), {
      grokRunner: async () => {
        called = true;
        return { ok: false, status: 500, body: "" };
      },
    });
    // Non-ok -> null, but the injected runner must have been used.
    const out = await gen.generate({ title: "t", sourceName: "s", url: "https://x" });
    expect(out).toBeNull();
    expect(called).toBe(true);
  });

  it("passes an injected runner through to the subscription generator", async () => {
    let called = false;
    const gen = createGenerator(
      makeConfig({
        generator: {
          provider: "claude",
          model: "test-model",
          grok: { baseUrl: "https://grok.test/v1", model: "grok-test" },
          grokTerminal: { command: "grok-test", args: [] },
        },
      }),
      {
        runner: async () => {
          called = true;
          return { stdout: "", code: 1 };
        },
      },
    );
    const out = await gen.generate({ title: "t", sourceName: "s", url: "https://x" });
    expect(out).toBeNull();
    expect(called).toBe(true);
  });
});
