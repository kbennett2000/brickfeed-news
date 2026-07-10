import { describe, expect, it } from "vitest";
import { GENERATION_INSTRUCTIONS, buildGenerationPrompt } from "../src/prompt.js";

describe("GENERATION_INSTRUCTIONS (legal guardrail regression anchor)", () => {
  const text = GENERATION_INSTRUCTIONS.toLowerCase();

  it("requires original, non-verbatim headline and description", () => {
    expect(text).toContain("original");
    expect(text).toContain("verbatim");
  });

  it("forbids brands/trademarks and demands a neutral image prompt", () => {
    expect(text).toContain("neutral");
    expect(text).toContain("brand");
    expect(text).toContain("trademark");
  });

  it("forbids toy/brick language in the image prompt (styling is downstream)", () => {
    expect(text).toContain("toy");
    expect(text).toContain("brick");
  });

  it("demands strict JSON with exactly the three keys", () => {
    expect(text).toContain("strict json");
    expect(GENERATION_INSTRUCTIONS).toContain("headline");
    expect(GENERATION_INSTRUCTIONS).toContain("description");
    expect(GENERATION_INSTRUCTIONS).toContain("imagePrompt");
  });

  it("never names the forbidden trademark (no 'lego' anywhere)", () => {
    expect(text).not.toContain("lego");
  });
});

describe("buildGenerationPrompt", () => {
  it("embeds the instructions plus the story context", () => {
    const prompt = buildGenerationPrompt({
      title: "Mayor unveils new transit plan",
      sourceName: "The Metro Times",
      url: "https://example.com/transit",
    });
    expect(prompt).toContain(GENERATION_INSTRUCTIONS);
    expect(prompt).toContain("Mayor unveils new transit plan");
    expect(prompt).toContain("The Metro Times");
    expect(prompt).toContain("https://example.com/transit");
  });

  it("tolerates an empty sourceName", () => {
    const prompt = buildGenerationPrompt({
      title: "Some story",
      sourceName: "",
      url: "https://example.com/x",
    });
    expect(prompt).toContain("unknown source");
  });
});
