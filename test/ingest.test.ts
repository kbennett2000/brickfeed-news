import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { storyId } from "../src/id.js";
import { ingest } from "../src/ingest.js";
import { emptyManifest } from "../src/manifest.js";
import type { IngestDeps, Manifest } from "../src/types.js";
import { fixedNow, makeConfig, makeFetch } from "./helpers.js";
import { FEED_A, FEED_B, RESOLVED } from "./fixtures.js";

const NOW = "2025-07-07T18:00:00.000Z";

function deps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    fetch: makeFetch({
      feeds: { "feed://a": FEED_A, "feed://b": FEED_B },
      resolve: RESOLVED,
    }),
    now: fixedNow(NOW),
    ...over,
  };
}

const config: Config = makeConfig({ feedUrls: ["feed://a", "feed://b"] });

describe("ingest", () => {
  it("classifies all fresh stories as NEW and records resolved URL + identity", async () => {
    const result = await ingest(config, emptyManifest(), deps());

    // FEED_A yields 2 valid + FEED_B yields 1 = 3 new.
    expect(result.newStories).toHaveLength(3);
    expect(result.knownCount).toBe(0);

    const transit = result.newStories.find((s) => s.sourceName === "The Metro Times")!;
    expect(transit.url).toBe(RESOLVED[
      "https://news.google.com/rss/articles/CBMiAAAA-transit?oc=5"
    ]);
    // ID keys off the RESOLVED destination, not the wrapped link.
    expect(transit.id).toBe(storyId(transit.url));
    expect(transit.firstSeen).toBe(NOW);
    expect(transit.lastSeen).toBe(NOW);
  });

  it("ADR-0032 B: stamps feedTopic from a topic feed; leaves the general feed untagged", async () => {
    const topicConfig = makeConfig({
      feeds: [
        { url: "feed://a", reserve: 0 }, // general — no topic
        { url: "feed://b", topic: "SPORTS", reserve: 2 },
      ],
    });
    const result = await ingest(topicConfig, emptyManifest(), deps());

    // FEED_B is the SPORTS feed → its story carries feedTopic; FEED_A stories do not.
    const sporty = result.newStories.filter((s) => s.feedTopic === "SPORTS");
    const untagged = result.newStories.filter((s) => s.feedTopic === undefined);
    expect(sporty).toHaveLength(1); // FEED_B yields 1
    expect(untagged).toHaveLength(2); // FEED_A yields 2
  });

  it("dedups against a seeded manifest: known stories update lastSeen, not firstSeen", async () => {
    // Seed the manifest with the transit story as already known, at an earlier time.
    const transitUrl =
      RESOLVED["https://news.google.com/rss/articles/CBMiAAAA-transit?oc=5"];
    const transitId = storyId(transitUrl);
    const seeded: Manifest = {
      version: 1,
      stories: {
        [transitId]: {
          id: transitId,
          url: transitUrl,
          title: "old title",
          sourceName: "The Metro Times",
          firstSeen: "2025-07-01T00:00:00.000Z",
          lastSeen: "2025-07-01T00:00:00.000Z",
        },
      },
    };

    const result = await ingest(config, seeded, deps());

    // Transit is KNOWN now; the other 2 are NEW.
    expect(result.knownCount).toBe(1);
    expect(result.newStories).toHaveLength(2);
    expect(result.newStories.map((s) => s.sourceName)).not.toContain("The Metro Times");

    const known = result.manifest.stories[transitId];
    expect(known.firstSeen).toBe("2025-07-01T00:00:00.000Z"); // preserved
    expect(known.lastSeen).toBe(NOW); // refreshed
  });

  it("a second run over the same feeds reports 0 new (all KNOWN) and is stable", async () => {
    const first = await ingest(config, emptyManifest(), deps());
    const second = await ingest(config, first.manifest, deps());

    expect(second.newStories).toHaveLength(0);
    expect(second.knownCount).toBe(3);
    // Manifest identity set is stable across runs.
    expect(Object.keys(second.manifest.stories).sort()).toEqual(
      Object.keys(first.manifest.stories).sort(),
    );
  });

  it("defensive fallback: an unresolvable redirect is ingested using the wrapped link", async () => {
    const wrapped = "https://news.google.com/rss/articles/CBMiAAAA-transit?oc=5";
    // Resolve everything EXCEPT transit, which throws -> falls back to wrapped link.
    const fetch = makeFetch({
      feeds: { "feed://a": FEED_A, "feed://b": FEED_B },
      resolve: RESOLVED,
      throwOn: new Set([wrapped]),
    });

    const result = await ingest(config, emptyManifest(), { ...deps(), fetch });

    expect(result.newStories).toHaveLength(3); // story NOT dropped
    const transit = result.newStories.find((s) => s.sourceName === "The Metro Times")!;
    expect(transit.url).toBe(wrapped); // hashed the wrapped link
    expect(transit.id).toBe(storyId(wrapped));
  });

  it("does not double-count a story duplicated within a single run", async () => {
    // Same feed listed twice -> every story appears twice in the merged list.
    const dupConfig: Config = makeConfig({ feedUrls: ["feed://a", "feed://a"] });
    const result = await ingest(dupConfig, emptyManifest(), deps());

    // FEED_A has 2 valid stories; duplicates collapse to 2 NEW, not 4.
    expect(result.newStories).toHaveLength(2);
    expect(Object.keys(result.manifest.stories)).toHaveLength(2);
  });
});
