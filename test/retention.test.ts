import { describe, expect, it } from "vitest";
import { ageOut, retentionHoursFor } from "../src/ageout.js";
import { CATEGORIES } from "../src/category.js";
import { publishableRecords } from "../src/publish.js";
import { renderSite } from "../src/render/index.js";
import type { Manifest, ManifestRecord } from "../src/types.js";
import { fakeStorageProvider, makeConfig } from "./helpers.js";

const NOW = new Date("2026-07-13T00:00:00.000Z");

function hoursAgo(n: number): string {
  return new Date(NOW.getTime() - n * 3600_000).toISOString();
}

/** A fully publishable fixture (headline/description/imageUrl/category/caption per isPublishable). */
function rec(over: Partial<ManifestRecord> & { id: string }): ManifestRecord {
  const seen = over.lastSeen ?? NOW.toISOString();
  return {
    url: `https://example.com/${over.id}`,
    title: `Raw feed title ${over.id}`,
    sourceName: "Example News",
    firstSeen: seen,
    lastSeen: seen,
    headline: `Headline ${over.id}`,
    description: `A sober description for ${over.id}.`,
    imagePrompt: "a neutral scene",
    wrappedPrompt: "STYLE a neutral scene",
    category: "WORLD",
    caption: `A neutral caption for ${over.id}`,
    imageUrl: `https://cdn.test/${over.id}.png`,
    imageStoredAt: seen,
    ...over,
  };
}

function manifestOf(...records: ManifestRecord[]): Manifest {
  const stories: Record<string, ManifestRecord> = {};
  for (const r of records) stories[r.id] = r;
  return { version: 1, stories };
}

describe("retentionHoursFor — the single retention authority (ADR-0013 #5)", () => {
  const config = makeConfig({ maxAgeHours: 48, opinionMaxAgeHours: 168 });

  it("gives OPINION its own window", () => {
    expect(retentionHoursFor("OPINION", config)).toBe(168);
  });

  it("gives every other category — and uncategorized records — the news window", () => {
    for (const category of CATEGORIES.filter((c) => c !== "OPINION")) {
      expect(retentionHoursFor(category, config)).toBe(48);
    }
    expect(retentionHoursFor(undefined, config)).toBe(48);
  });
});

describe("section-branched retention — ageout through render", () => {
  // PINNING TEST — do not weaken. Under steady ~2/day opinion posting, an UNBRANCHED age
  // sweep is SELF-MASKING: there is always at least one opinion piece <48h old keeping the
  // section visible in the nav, while every older piece silently dies — the section never
  // disappears, no error fires, and page depth quietly caps at ~4 items instead of the ~14
  // a 168h window sustains. No smoke check or section-presence assertion can catch that
  // failure mode; this test is the only thing that does. (The fresh WORLD "masker" below
  // reproduces the same shape on the news side: its section stays visible while its 72h
  // sibling is pruned.)
  it("OPINION@72h survives cleanup AND renders; non-opinion@72h is pruned/hidden; OPINION@200h is pruned", async () => {
    const config = makeConfig({ maxAgeHours: 48, opinionMaxAgeHours: 168 });
    const manifest = manifestOf(
      rec({ id: "op-72h", category: "OPINION", lastSeen: hoursAgo(72) }),
      rec({ id: "wd-72h", category: "WORLD", lastSeen: hoursAgo(72) }),
      rec({ id: "op-200h", category: "OPINION", lastSeen: hoursAgo(200) }),
      rec({ id: "wd-10h", category: "WORLD", lastSeen: hoursAgo(10) }), // fresh masker
    );

    const result = await ageOut(config, manifest, {
      storage: fakeStorageProvider(),
      now: () => NOW,
    });

    // Cleanup half: only the over-window records on EACH clock are dropped.
    expect([...result.dropped].sort()).toEqual(["op-200h", "wd-72h"]);
    expect(result.manifest.stories["op-72h"]).toBeDefined();

    // Render half: there is no age gate at render time — "live" IS manifest membership,
    // so the survivors rendering proves the OPINION@72h piece counts as live.
    const survivors = publishableRecords(result.manifest);
    const files = renderSite(survivors, {
      now: NOW,
      secondaryStoryCount: 3,
      siteBaseUrl: "https://test.example",
    });

    expect(files["opinion.html"]).toContain("Headline op-72h"); // OPINION@72h is live on its page
    expect(files["world.html"]).toBeTruthy(); // masker keeps the section present…
    for (const page of Object.values(files)) {
      expect(page).not.toContain("op-200h"); // …but pruned stories are gone everywhere
      expect(page).not.toContain("wd-72h");
    }
  });
});
