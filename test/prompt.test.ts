import { describe, expect, it } from "vitest";
import { GENERATION_INSTRUCTIONS, buildGenerationPrompt } from "../src/prompt.js";

describe("GENERATION_INSTRUCTIONS (legal guardrail regression anchor)", () => {
  const text = GENERATION_INSTRUCTIONS.toLowerCase();

  it("requires original, non-verbatim headline and description", () => {
    expect(text).toContain("original");
    expect(text).toContain("verbatim");
  });

  it("forbids brands/trademarks and demands a neutral headline", () => {
    expect(text).toContain("neutral");
    expect(text).toContain("brand");
    expect(text).toContain("trademark");
  });

  it("forbids any written words/text inside the image scene", () => {
    expect(text).toContain("no text");
    expect(text).toContain("letters");
    expect(text).toContain("written words");
  });

  it("asks for a short, humorous, cartoonish image prompt", () => {
    expect(text).toContain("playful");
    expect(text).toContain("cartoonish");
    expect(text).toContain("short");
  });

  it("demands strict JSON with exactly the three keys", () => {
    expect(text).toContain("strict json");
    expect(GENERATION_INSTRUCTIONS).toContain("headline");
    expect(GENERATION_INSTRUCTIONS).toContain("description");
    expect(GENERATION_INSTRUCTIONS).toContain("imagePrompt");
  });

  it("never names the downstream styling terms (no brick/toy/lego in instructions)", () => {
    expect(text).not.toContain("brick");
    expect(text).not.toContain("toy");
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
