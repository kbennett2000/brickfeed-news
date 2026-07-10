import { describe, expect, it } from "vitest";
import { ApiKeyGenerator } from "../src/generator/apikey.js";

describe("ApiKeyGenerator (Slice 2b stub)", () => {
  it("throws NotImplemented rather than silently no-op'ing", async () => {
    const gen = new ApiKeyGenerator();
    await expect(
      gen.generate({ title: "t", sourceName: "s", url: "https://x" }),
    ).rejects.toThrow(/NotImplemented/);
  });
});
