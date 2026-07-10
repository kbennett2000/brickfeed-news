import { XMLParser } from "fast-xml-parser";
import type { FeedItem, FetchLike } from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  // Keep values as strings so a title like "123" or an all-digit link stays a
  // string; we coerce explicitly below.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // A real Google News feed (dozens of items, each with several &amp; entities)
  // blows past fast-xml-parser's default 1000 total-expansion cap and would
  // otherwise throw → parseFeed returning [] on a perfectly valid feed. Lift the
  // predefined-entity ceiling well above any real feed, while keeping the DOCTYPE
  // bomb protections (maxEntityCount / maxEntitySize / maxExpansionDepth) at their
  // defaults, since feeds carry no DOCTYPE.
  processEntities: { enabled: true, maxTotalExpansions: 5_000_000 },
});

/** Coerce a fast-xml-parser value (string | number | element object) to string. */
function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    if (text != null) return asText(text);
  }
  return "";
}

/** Always return an array, whether the parser gave us one item or many (or none). */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Parse an RSS feed XML string into FeedItems. Tolerant by design: a malformed
 * document yields [], and any item that can't be mapped (or lacks a usable link)
 * is skipped rather than throwing. Never throws.
 */
export function parseFeed(xml: string): FeedItem[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }

  const channel = (doc as Record<string, any>)?.rss?.channel;
  if (!channel) return [];

  const rawItems = toArray<Record<string, unknown>>(channel.item);
  const items: FeedItem[] = [];

  for (const raw of rawItems) {
    try {
      const link = asText(raw.link).trim();
      if (!link) continue; // no identity possible without a link — skip

      items.push({
        title: asText(raw.title),
        link,
        pubDate: asText(raw.pubDate),
        // Google News: <source url="...">Publisher Name</source>
        sourceName: asText(raw.source),
      });
    } catch {
      // Defensive: a single bad item never sinks the whole feed.
      continue;
    }
  }

  return items;
}

/**
 * Fetch one feed URL and parse it. A dead/erroring feed returns [] rather than
 * throwing, so one bad feed never kills a multi-feed run.
 */
export async function fetchFeed(url: string, fetch: FetchLike): Promise<FeedItem[]> {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const xml = await res.text();
    return parseFeed(xml);
  } catch {
    return [];
  }
}
