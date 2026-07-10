import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokImageProvider } from "../src/image/grok.js";
import { LocalImageProvider } from "../src/image/local.js";
import { bytes, fakeImageRunner } from "./helpers.js";

/**
 * wrapBrickStyle (src/brick.ts) is the SINGLE styling chokepoint. Both image
 * providers must receive the already-wrapped prompt and forward it UNCHANGED — never
 * apply (or strip) brick styling themselves. This regression guards that invariant.
 */

const WRAPPED = "TEST-STYLE plastic diorama. Scene: a cat piloting a hot-air balloon.";
const GROK_GEN = "https://img.test/v1/images/generations";
const IMG = "https://cdn.img.test/x.png";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("single styling chokepoint (wrapBrickStyle)", () => {
  it("both providers forward the wrappedPrompt byte-for-byte, unmodified", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");

    const grokRunner = fakeImageRunner({
      routes: {
        [`POST ${GROK_GEN}`]: { bytes: bytes(JSON.stringify({ data: [{ url: IMG }] })) },
        [`GET ${IMG}`]: { bytes: bytes("PNG") },
      },
    });
    const localRunner = fakeImageRunner({
      routes: { ["POST http://imagegen.test/generate"]: { bytes: bytes("PNG") } },
    });

    const grok = new GrokImageProvider({
      baseUrl: "https://img.test/v1",
      model: "img-test",
      aspectRatio: "1:1",
      resolution: "1k",
      runner: grokRunner,
    });
    const local = new LocalImageProvider({
      url: "http://imagegen.test",
      style: "test-base",
      runner: localRunner,
    });

    await grok.generate(WRAPPED);
    await local.generate(WRAPPED);

    const grokPrompt = JSON.parse(grokRunner.calls[0].body ?? "{}").prompt;
    const localPrompt = JSON.parse(localRunner.calls[0].body ?? "{}").prompt;

    // Identical input in → identical prompt out of each provider, equal to the input.
    expect(grokPrompt).toBe(WRAPPED);
    expect(localPrompt).toBe(WRAPPED);
    expect(grokPrompt).toBe(localPrompt);
  });

  it("neither provider imports or calls the brick-style module", () => {
    // The word "brick" appears in explanatory comments; what must NOT appear is any
    // dependency on the styling module — no import of src/brick, no wrapBrickStyle call.
    for (const rel of ["../src/image/grok.ts", "../src/image/local.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src).not.toContain('from "../brick'); // no import of the styling module
      expect(src).not.toContain("wrapBrickStyle("); // no call to it
      expect(src).not.toContain("styleLanguage");
    }
  });
});
