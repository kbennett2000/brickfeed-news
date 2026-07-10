import { describe, expect, it } from "vitest";
import {
  ApiKeyGenerator,
  SubscriptionGenerator,
  createGenerator,
} from "../src/generator/index.js";
import { makeConfig } from "./helpers.js";

describe("createGenerator (provider selection)", () => {
  it("defaults to the subscription generator", () => {
    const gen = createGenerator(makeConfig());
    expect(gen).toBeInstanceOf(SubscriptionGenerator);
  });

  it("selects the API-key stub when provider is 'apikey'", () => {
    const gen = createGenerator(
      makeConfig({ generator: { provider: "apikey", model: "test-model" } }),
    );
    expect(gen).toBeInstanceOf(ApiKeyGenerator);
  });

  it("passes an injected runner through to the subscription generator", async () => {
    let called = false;
    const gen = createGenerator(makeConfig(), {
      runner: async () => {
        called = true;
        return { stdout: "", code: 1 };
      },
    });
    // Non-zero code -> null, but the injected runner must have been used.
    const out = await gen.generate({ title: "t", sourceName: "s", url: "https://x" });
    expect(out).toBeNull();
    expect(called).toBe(true);
  });
});
