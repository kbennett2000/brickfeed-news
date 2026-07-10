import { describe, expect, it } from "vitest";
import { fetchFeed, parseFeed } from "../src/rss.js";
import { makeFetch } from "./helpers.js";
import { FEED_A, FEED_B, FEED_EMPTY, FEED_SINGLE_ITEM } from "./fixtures.js";

describe("parseFeed", () => {
  it("parses items with title, link, pubDate and per-item source name", () => {
    const items = parseFeed(FEED_A);
    // FEED_A has 3 items but one is malformed (no link) and is skipped.
    expect(items).toHaveLength(2);

    const transit = items[0];
    expect(transit.title).toBe("Mayor unveils new transit plan - The Metro Times");
    expect(transit.link).toBe(
      "https://news.google.com/rss/articles/CBMiAAAA-transit?oc=5",
    );
    expect(transit.pubDate).toBe("Mon, 07 Jul 2025 12:00:00 GMT");
    // sourceName comes from <source url="...">The Metro Times</source>
    expect(transit.sourceName).toBe("The Metro Times");
  });

  it("skips a malformed item (no link) without throwing", () => {
    const items = parseFeed(FEED_A);
    expect(items.map((i) => i.sourceName)).not.toContain("Ghost Publisher");
  });

  it("handles a single-item feed (parser returns a lone object, not array)", () => {
    const items = parseFeed(FEED_SINGLE_ITEM);
    expect(items).toHaveLength(1);
    expect(items[0].sourceName).toBe("Solo Source");
  });

  it("returns [] for an empty feed", () => {
    expect(parseFeed(FEED_EMPTY)).toEqual([]);
  });

  it("returns [] for malformed XML rather than throwing", () => {
    expect(parseFeed("<rss><channel><item></broken")).toEqual([]);
    expect(parseFeed("not xml at all")).toEqual([]);
    expect(parseFeed("")).toEqual([]);
  });

  it("parses a large feed with thousands of &amp; entities (real-feed regression)", () => {
    // Real Google News feeds carry dozens of items, each with several &amp; in
    // links/titles — collectively past fast-xml-parser's default 1000-expansion
    // cap. This guards the parser config that lifts that ceiling.
    const items = Array.from({ length: 60 }, (_, i) => {
      const amps = "&amp;".repeat(30); // 30 predefined-entity expansions per item
      return `<item>
        <title>Story ${i} ${amps} tail</title>
        <link>https://news.google.com/rss/articles/CBMi-${i}?oc=5${amps}</link>
        <pubDate>Mon, 07 Jul 2025 12:00:00 GMT</pubDate>
        <source url="https://pub-${i}.example">Publisher ${i}</source>
      </item>`;
    }).join("\n");
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;

    const parsed = parseFeed(xml); // 60 * 30 = 1800 expansions > default 1000
    expect(parsed).toHaveLength(60);
    expect(parsed[0].sourceName).toBe("Publisher 0");
  });
});

describe("fetchFeed + multi-feed merge", () => {
  it("merges items across feeds into one list", async () => {
    const fetch = makeFetch({
      feeds: {
        "https://feeds.example/a": FEED_A,
        "https://feeds.example/b": FEED_B,
      },
    });

    const a = await fetchFeed("https://feeds.example/a", fetch);
    const b = await fetchFeed("https://feeds.example/b", fetch);
    const merged = [...a, ...b];

    expect(merged).toHaveLength(3); // 2 valid from A + 1 from B
    expect(merged.map((i) => i.sourceName)).toEqual([
      "The Metro Times",
      "Sports Daily",
      "Tech Wire",
    ]);
  });

  it("returns [] when the feed fetch fails (dead feed doesn't kill the run)", async () => {
    const fetch = makeFetch({ throwOn: new Set(["https://feeds.example/dead"]) });
    expect(await fetchFeed("https://feeds.example/dead", fetch)).toEqual([]);
  });
});
