import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  DEFAULT_CATEGORY,
  NEWS_CATEGORIES,
  normalizeCategory,
  normalizeNewsCategory,
} from "../src/category.js";

describe("category taxonomy (Slice 6)", () => {
  it("is the fixed 8-section nav in order", () => {
    expect([...CATEGORIES]).toEqual([
      "WORLD",
      "POLITICS",
      "BUSINESS",
      "TECHNOLOGY",
      "SCIENCE",
      "SPORTS",
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
    expect(normalizeCategory({ category: "SPORTS" })).toBe("WORLD");
  });
});

describe("normalizeNewsCategory (ADR-0033: OPINION reserved for authored columns)", () => {
  it("excludes OPINION from the news taxonomy", () => {
    expect([...NEWS_CATEGORIES]).toEqual(CATEGORIES.filter((c) => c !== "OPINION"));
    expect(NEWS_CATEGORIES).not.toContain("OPINION");
  });

  it("coerces a news story tagged OPINION back to the default (WORLD)", () => {
    expect(normalizeNewsCategory("OPINION")).toBe("WORLD");
    expect(normalizeNewsCategory("opinion")).toBe("WORLD");
    expect(normalizeNewsCategory("  Opinion ")).toBe("WORLD");
  });

  it("passes valid non-OPINION categories through unchanged", () => {
    expect(normalizeNewsCategory("SPORTS")).toBe("SPORTS");
    expect(normalizeNewsCategory("politics")).toBe("POLITICS");
  });

  it("still falls back to WORLD for unknown/missing values", () => {
    expect(normalizeNewsCategory("GOSSIP")).toBe("WORLD");
    expect(normalizeNewsCategory(undefined)).toBe("WORLD");
  });
});
