import { describe, expect, it } from "vitest";
import {
  HERO_MIN_LIFETIME_HOURS,
  SECTION_SLOT_LIMIT,
  heroEligibility,
  isOpinionRecord,
  sectionRanks,
  sectionSlotIds,
} from "../src/eligibility.js";
import type { Category } from "../src/category.js";
import type { ManifestRecord } from "../src/types.js";
import { makeConfig } from "./helpers.js";

const NOW = Date.parse("2026-07-10T12:00:00.000Z");
const config = makeConfig(); // maxAgeHours 72, opinionMaxAgeHours 168

const iso = (ms: number) => new Date(ms).toISOString();

/** A generated, un-imaged WORLD record (needs an image). Override any field. */
function rec(id: string, over: Partial<ManifestRecord> = {}): ManifestRecord {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Story ${id}`,
    sourceName: "Src",
    firstSeen: iso(NOW),
    lastSeen: iso(NOW),
    headline: `Headline ${id}`,
    description: "A description.",
    imagePrompt: "a scene",
    wrappedPrompt: `W ${id}`,
    category: "WORLD",
    ...over,
  };
}

/** `n` records in `cat`, firstSeen strictly descending by index (index 0 = newest). */
function section(cat: Category, n: number, over: (i: number) => Partial<ManifestRecord> = () => ({})) {
  return Array.from({ length: n }, (_, i) =>
    rec(`${cat}-${i}`, { category: cat, firstSeen: iso(NOW - i * 60_000), ...over(i) }),
  );
}

describe("isOpinionRecord", () => {
  it("is true for an author-bearing record or an OPINION category, false otherwise", () => {
    expect(isOpinionRecord(rec("a", { author: "alice" }))).toBe(true);
    expect(isOpinionRecord(rec("b", { category: "OPINION" }))).toBe(true);
    expect(isOpinionRecord(rec("c"))).toBe(false);
  });
});

describe("sectionRanks", () => {
  it("ranks each non-opinion section independently, newest-first, and omits opinions", () => {
    const w = section("WORLD", 3);
    const b = section("BUSINESS", 2);
    const op = rec("op", { category: "OPINION", author: "alice" });
    const ranks = sectionRanks([...b, op, ...w]); // unordered input is fine

    expect(ranks.get("WORLD-0")).toBe(0);
    expect(ranks.get("WORLD-2")).toBe(2);
    expect(ranks.get("BUSINESS-0")).toBe(0);
    expect(ranks.get("BUSINESS-1")).toBe(1);
    expect(ranks.has("op")).toBe(false);
  });

  it("buckets an undefined category as WORLD (matching the render)", () => {
    const ranks = sectionRanks([
      rec("w", { category: "WORLD", firstSeen: iso(NOW) }),
      rec("u", { category: undefined, firstSeen: iso(NOW - 60_000) }),
    ]);
    expect(ranks.get("w")).toBe(0);
    expect(ranks.get("u")).toBe(1); // same WORLD bucket, older ⇒ rank 1
  });
});

describe("sectionSlotIds", () => {
  it("keeps the top-`limit` per section and always keeps opinions", () => {
    const w = section("WORLD", SECTION_SLOT_LIMIT + 2);
    const op = rec("op", { category: "OPINION", author: "alice", firstSeen: iso(NOW - 9_999_000) });
    const ids = sectionSlotIds([...w, op], SECTION_SLOT_LIMIT);

    expect(ids.size).toBe(SECTION_SLOT_LIMIT + 1); // 30 WORLD + the opinion
    expect(ids.has("op")).toBe(true);
    expect(ids.has(`WORLD-${SECTION_SLOT_LIMIT - 1}`)).toBe(true);
    expect(ids.has(`WORLD-${SECTION_SLOT_LIMIT}`)).toBe(false);
    expect(ids.has(`WORLD-${SECTION_SLOT_LIMIT + 1}`)).toBe(false);
  });

  it("honors a custom limit", () => {
    const ids = sectionSlotIds(section("WORLD", 5), 2);
    expect([...ids].sort()).toEqual(["WORLD-0", "WORLD-1"]);
  });
});

describe("heroEligibility", () => {
  it("returns empty on an empty manifest", () => {
    expect(heroEligibility([], config, NOW)).toEqual({
      eligible: new Set(),
      skipped: 0,
      belowFold: 0,
      nearAgeout: 0,
    });
  });

  it("makes the top-K of a section eligible and cuts the record at rank K (below fold)", () => {
    const d = heroEligibility(section("WORLD", SECTION_SLOT_LIMIT + 1), config, NOW);
    expect(d.eligible.size).toBe(SECTION_SLOT_LIMIT);
    expect(d.belowFold).toBe(1);
    expect(d.nearAgeout).toBe(0);
    expect(d.eligible.has(`WORLD-${SECTION_SLOT_LIMIT - 1}`)).toBe(true); // rank K-1
    expect(d.eligible.has(`WORLD-${SECTION_SLOT_LIMIT}`)).toBe(false); // rank K
  });

  it("lets already-imaged records consume slots (they are skipped, but still rank)", () => {
    // 30 imaged NEWER records fill the slots; one un-imaged OLDER record lands at rank 30.
    const imaged = section("WORLD", SECTION_SLOT_LIMIT).map((r) => ({
      ...r,
      imageUrl: `https://cdn.test/${r.id}.png`,
    }));
    const straggler = rec("straggler", { firstSeen: iso(NOW - 999 * 60_000) });
    const d = heroEligibility([...imaged, straggler], config, NOW);

    expect(d.skipped).toBe(SECTION_SLOT_LIMIT); // the imaged ones
    expect(d.belowFold).toBe(1); // the straggler, pushed out of the top-K
    expect(d.eligible.size).toBe(0);
  });

  it("keeps an un-imaged record in a slot when fewer than K imaged records precede it", () => {
    const imaged = section("WORLD", SECTION_SLOT_LIMIT - 1).map((r) => ({
      ...r,
      imageUrl: `https://cdn.test/${r.id}.png`,
    }));
    const straggler = rec("straggler", { firstSeen: iso(NOW - 999 * 60_000) });
    const d = heroEligibility([...imaged, straggler], config, NOW);

    expect(d.eligible.has("straggler")).toBe(true); // rank K-1 ⇒ in slot
    expect(d.belowFold).toBe(0);
  });

  it("cuts an in-slot record that would age out within HERO_MIN_LIFETIME_HOURS", () => {
    // 72h retention − 65h since lastSeen = 7h left < 12h ⇒ near-ageout.
    const dying = rec("dying", { lastSeen: iso(NOW - 65 * 3_600_000) });
    const d = heroEligibility([dying], config, NOW);
    expect(d.nearAgeout).toBe(1);
    expect(d.belowFold).toBe(0);
    expect(d.eligible.size).toBe(0);
  });

  it("keeps a record with exactly HERO_MIN_LIFETIME_HOURS of life left", () => {
    const hoursSinceSeen = config.maxAgeHours - HERO_MIN_LIFETIME_HOURS; // remaining == 12h
    const edge = rec("edge", { lastSeen: iso(NOW - hoursSinceSeen * 3_600_000) });
    const d = heroEligibility([edge], config, NOW);
    expect(d.eligible.has("edge")).toBe(true);
    expect(d.nearAgeout).toBe(0);
  });

  it("counts a record that is BOTH below-fold and near-ageout once, as below-fold", () => {
    const newer = section("WORLD", SECTION_SLOT_LIMIT); // ranks 0..29, fresh
    const both = rec("both", {
      firstSeen: iso(NOW - 9_999 * 60_000), // rank 30 ⇒ below fold
      lastSeen: iso(NOW - 65 * 3_600_000), // also near ageout
    });
    const d = heroEligibility([...newer, both], config, NOW);
    expect(d.belowFold).toBe(1);
    expect(d.nearAgeout).toBe(0);
  });

  it("exempts opinion pieces — always eligible, ignoring slot and lifetime", () => {
    const worldFull = section("WORLD", SECTION_SLOT_LIMIT + 5); // 5 below fold
    const oldOpinion = rec("opinion-alice", {
      category: "OPINION",
      author: "alice",
      firstSeen: iso(NOW - 9_999 * 60_000), // ancient
      lastSeen: iso(NOW - 200 * 3_600_000), // would be near-ageout for a news story
    });
    const d = heroEligibility([...worldFull, oldOpinion], config, NOW);

    expect(d.eligible.has("opinion-alice")).toBe(true);
    expect(d.eligible.size).toBe(SECTION_SLOT_LIMIT + 1); // 30 WORLD + the opinion
    expect(d.belowFold).toBe(5); // opinions never count against the section fold
  });

  it("skips records that are already imaged or not yet generated", () => {
    const notGenerated = rec("ng", { wrappedPrompt: undefined });
    const alreadyImaged = rec("im", { imageUrl: "https://cdn.test/im.png" });
    const d = heroEligibility([notGenerated, alreadyImaged, rec("ok")], config, NOW);

    expect(d.skipped).toBe(2);
    expect(d.eligible.has("ok")).toBe(true);
    expect(d.eligible.has("ng")).toBe(false);
    expect(d.eligible.has("im")).toBe(false);
  });
});
