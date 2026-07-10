import { describe, expect, it } from "vitest";
import { CATEGORIES, DEFAULT_CATEGORY, normalizeCategory } from "../src/category.js";

describe("category taxonomy (Slice 6)", () => {
  it("is the fixed 8-section nav in order", () => {
    expect([...CATEGORIES]).toEqual([
      "WORLD",
      "POLITICS",
      "BUSINESS",
      "TECHNOLOGY",
      "SCIENCE",
      "SPORT",
      "CULTURE",
      "OPINION",
    ]);
  });

  it("defaults to WORLD", () => {
    expect(DEFAULT_CATEGORY).toBe("WORLD");
    expect(CATEGORIES).toContain(DEFAULT_CATEGORY);
  });
});

describe("normalizeCategory", () => {
  it("passes each valid value through unchanged", () => {
    for (const c of CATEGORIES) {
      expect(normalizeCategory(c)).toBe(c);
    }
  });

  it("upcases and trims a valid-but-miscased value", () => {
    expect(normalizeCategory("science")).toBe("SCIENCE");
    expect(normalizeCategory("  Politics  ")).toBe("POLITICS");
    expect(normalizeCategory("tEcHnOlOgY")).toBe("TECHNOLOGY");
  });

  it("falls back to WORLD for an unknown string", () => {
    expect(normalizeCategory("GOSSIP")).toBe("WORLD");
    expect(normalizeCategory("")).toBe("WORLD");
    expect(normalizeCategory("   ")).toBe("WORLD");
  });

  it("falls back to WORLD for non-string / missing values", () => {
    expect(normalizeCategory(undefined)).toBe("WORLD");
    expect(normalizeCategory(null)).toBe("WORLD");
    expect(normalizeCategory(42)).toBe("WORLD");
    expect(normalizeCategory(["POLITICS"])).toBe("WORLD");
    expect(normalizeCategory({ category: "SPORT" })).toBe("WORLD");
  });
});
