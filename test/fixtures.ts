/**
 * Google-News-shaped RSS fixtures. Real Google News items wrap the article link
 * in a news.google.com/rss/articles/... redirect and carry a per-item
 * <source url="...">Publisher</source> element. One item below is deliberately
 * malformed (no <link>) to exercise the skip path.
 */
export const FEED_A = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Top stories - Google News</title>
    <item>
      <title>Mayor unveils new transit plan - The Metro Times</title>
      <link>https://news.google.com/rss/articles/CBMiAAAA-transit?oc=5</link>
      <guid isPermaLink="false">CBMiAAAA-transit</guid>
      <pubDate>Mon, 07 Jul 2025 12:00:00 GMT</pubDate>
      <source url="https://www.metrotimes.example">The Metro Times</source>
    </item>
    <item>
      <title>Local team wins championship - Sports Daily</title>
      <link>https://news.google.com/rss/articles/CBMiAAAA-sports?oc=5</link>
      <guid isPermaLink="false">CBMiAAAA-sports</guid>
      <pubDate>Mon, 07 Jul 2025 13:30:00 GMT</pubDate>
      <source url="https://www.sportsdaily.example">Sports Daily</source>
    </item>
    <item>
      <title>Broken item with no link - Ghost Publisher</title>
      <guid isPermaLink="false">CBMiAAAA-broken</guid>
      <pubDate>Mon, 07 Jul 2025 14:00:00 GMT</pubDate>
      <source url="https://www.ghost.example">Ghost Publisher</source>
    </item>
  </channel>
</rss>`;

/** A second feed with one overlapping-topic-but-distinct story, for merge tests. */
export const FEED_B = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Technology - Google News</title>
    <item>
      <title>New chip promises faster laptops - Tech Wire</title>
      <link>https://news.google.com/rss/articles/CBMiAAAA-chip?oc=5</link>
      <guid isPermaLink="false">CBMiAAAA-chip</guid>
      <pubDate>Mon, 07 Jul 2025 15:00:00 GMT</pubDate>
      <source url="https://www.techwire.example">Tech Wire</source>
    </item>
  </channel>
</rss>`;

/** A single-item feed: fast-xml-parser gives a lone object, not an array. */
export const FEED_SINGLE_ITEM = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Solo - Google News</title>
    <item>
      <title>Only story here - Solo Source</title>
      <link>https://news.google.com/rss/articles/CBMiAAAA-solo?oc=5</link>
      <pubDate>Mon, 07 Jul 2025 16:00:00 GMT</pubDate>
      <source url="https://www.solo.example">Solo Source</source>
    </item>
  </channel>
</rss>`;

export const FEED_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Empty - Google News</title>
  </channel>
</rss>`;

/** Maps the wrapped Google News links in FEED_A/FEED_B to their "real" targets. */
export const RESOLVED: Record<string, string> = {
  "https://news.google.com/rss/articles/CBMiAAAA-transit?oc=5":
    "https://www.metrotimes.example/news/transit-plan",
  "https://news.google.com/rss/articles/CBMiAAAA-sports?oc=5":
    "https://www.sportsdaily.example/championship-win",
  "https://news.google.com/rss/articles/CBMiAAAA-chip?oc=5":
    "https://www.techwire.example/new-chip",
  "https://news.google.com/rss/articles/CBMiAAAA-solo?oc=5":
    "https://www.solo.example/only-story",
};
