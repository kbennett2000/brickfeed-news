import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../src/category.js";
import { SECTION_SLOT_LIMIT } from "../src/eligibility.js";
import {
  type AuthorInfo,
  renderSite,
  staleColumnistPages,
  staleSectionPages,
} from "../src/render/index.js";
import {
  buildLinkedInIntentUrl,
  buildXIntentUrl,
  bylineFor,
  editionForHour,
  editionLabel,
  excerpt,
  formatMastheadDate,
  optimizedSrcset,
  optimizedUrl,
  paragraphize,
  formatTimestamp,
  sectionSlug,
  storyPageUrl,
  truncateForTweet,
} from "../src/render/format.js";
import {
  LETTERS_DISCLOSURE,
  OPINION_BANNER,
  OPINION_META_DESCRIPTION,
} from "../src/render/templates.js";
import { AD_ROTATOR_JS } from "../src/render/rotator.js";
import type { Article } from "../src/articles.js";
import type { ManifestRecord } from "../src/types.js";

/** A fully publishable fixture record. */
function rec(over: Partial<ManifestRecord> & { id: string }): ManifestRecord {
  return {
    url: `https://example.com/${over.id}`,
    title: `Raw feed title ${over.id}`,
    sourceName: "Example News",
    firstSeen: "2026-07-10T12:00:00.000Z",
    lastSeen: "2026-07-10T12:00:00.000Z",
    headline: `Headline ${over.id}`,
    description: `A sober description for ${over.id}.`,
    imagePrompt: "a neutral scene",
    wrappedPrompt: "STYLE a neutral scene",
    category: "WORLD",
    caption: `A neutral caption for ${over.id}`,
    imageUrl: `https://cdn.test/${over.id}.png`,
    imageStoredAt: "2026-07-10T12:00:00.000Z",
    ...over,
  };
}

/** Newest-first fixture spanning several categories. */
const records: ManifestRecord[] = [
  rec({ id: "lead", headline: "Summit Ends With a Handshake and a Communique", category: "WORLD", firstSeen: "2026-07-10T11:30:00.000Z" }),
  rec({ id: "b1", headline: "Investors Await Guidance They Suspect They Have", category: "BUSINESS", firstSeen: "2026-07-10T10:00:00.000Z" }),
  rec({ id: "t1", headline: "Startup Unveils Plan to Disrupt Thing You Own", category: "TECHNOLOGY", firstSeen: "2026-07-10T08:00:00.000Z" }),
  rec({ id: "s1", headline: "Physicists Announce Discovery, Request Funding", category: "SCIENCE", firstSeen: "2026-07-09T12:00:00.000Z" }),
  rec({ id: "w2", headline: "Small Nation Enjoys Quiet, Uneventful Week", category: "WORLD", firstSeen: "2026-07-09T06:00:00.000Z" }),
  // A record missing an optional field (imageUrl) — must degrade to a placeholder, not crash.
  rec({ id: "c1", headline: "Museum Unveils Exhibit Nobody Could Explain", category: "CULTURE", imageUrl: undefined, firstSeen: "2026-07-08T06:00:00.000Z" }),
];

const NOW = new Date("2026-07-10T12:00:00.000Z");
const SITE_BASE_URL = "https://www.brickfeed.example";
const OPTS = { now: NOW, secondaryStoryCount: 3, siteBaseUrl: SITE_BASE_URL };

// The fixture's section split under conditional rendering (ADR-0013): sections with at least
// one record render; the rest are omitted from nav, footer, sitemap, and the emitted files.
const PRESENT = ["WORLD", "BUSINESS", "TECHNOLOGY", "SCIENCE", "CULTURE"] as const;
const ABSENT = ["POLITICS", "SPORTS", "OPINION"] as const;

describe("renderSite — cover page", () => {
  const files = renderSite(records, OPTS);
  const index = files["index.html"];

  it("emits index.html, styles.css, and one page per section with content", () => {
    expect(files["index.html"]).toBeTruthy();
    expect(files["styles.css"]).toBeTruthy();
    for (const c of PRESENT) {
      expect(files[`${sectionSlug(c)}.html`]).toBeTruthy();
    }
    // Empty sections emit no page at all (ADR-0013).
    for (const c of ABSENT) {
      expect(files[`${sectionSlug(c)}.html`]).toBeUndefined();
    }
  });

  it("renders the lead (newest) headline", () => {
    expect(index).toContain("Summit Ends With a Handshake and a Communique");
  });

  it("renders the section nav from the sections present in this build, plus an About link", () => {
    for (const c of PRESENT) {
      // Title-cased nav label + slugged href for every present section.
      const label = c.charAt(0) + c.slice(1).toLowerCase();
      expect(index).toContain(`>${label}</a>`);
      expect(index).toContain(`href="${sectionSlug(c)}.html"`);
    }
    // Empty sections (including Opinion) are not linked anywhere on the page (ADR-0013).
    for (const c of ABSENT) {
      expect(index).not.toContain(`href="${sectionSlug(c)}.html"`);
    }
    expect(index).not.toContain(">Opinion</a>");
    expect(index).toContain('href="about.html">About</a>'); // About always trails the nav
  });

  it("renders category kickers", () => {
    expect(index).toContain(">WORLD</div>");
    expect(index).toContain(">BUSINESS</div>");
  });

  it("appends the / BRICKFEED STUDIO credit to captions", () => {
    expect(index).toContain("A neutral caption for lead");
    expect(index).toContain("/ BRICKFEED STUDIO");
  });

  it("links every story out to the original article URL, opening the source", () => {
    expect(index).toContain('href="https://example.com/lead"');
    expect(index).toContain('target="_blank"');
    expect(index).toContain('rel="noopener noreferrer"');
  });

  it("renders a decorative byline derived from the category", () => {
    expect(index).toContain("By the World Desk");
  });

  it("renders the real image when present and a placeholder when absent", () => {
    expect(index).toContain('src="https://cdn.test/lead.png"');
    // c1 has no imageUrl → the studded placeholder label appears on the overflow grid.
    expect(index).toContain("Brick Photo");
  });

  it("emits a hover full-size preview reusing the image URL for imaged stories", () => {
    expect(index).toContain('class="figure__zoom"');
    // The preview reuses the same (already-downloaded) URL → the lead src appears twice.
    expect(index.match(/src="https:\/\/cdn\.test\/lead\.png"/g)?.length).toBe(2);
    // Decorative duplicate is hidden from assistive tech.
    expect(index).toContain('class="figure__zoom" aria-hidden="true"');
    // The stylesheet carries the hover rule.
    expect(files["styles.css"]).toContain(".figure__zoom");
    // Hover-intent: the reveal rule holds ~1s before fading the preview in.
    const revealRule =
      files["styles.css"].match(/\.figure__frame:hover \+ \.figure__zoom\s*\{[^}]*\}/)?.[0] ?? "";
    expect(revealRule).toContain("1s");
  });

  it("emits no zoom preview for an image-less (placeholder) story", () => {
    const placeholderOnly = renderSite([rec({ id: "np", imageUrl: undefined })], OPTS);
    expect(placeholderOnly["index.html"]).toContain("figure__placeholder");
    expect(placeholderOnly["index.html"]).not.toContain("figure__zoom");
  });

  it("shows the masthead date, tagline, and time-of-day edition from the injected clock", () => {
    expect(index).toContain("FRIDAY, JULY 10, 2026");
    expect(index).toContain("All the stories, brick by brick");
    // NOW is 12:00Z, default tz UTC → the noon window.
    expect(index).toContain("Afternoon Edition");
    expect(index).not.toContain("Late Brick Edition");
  });

  it("computes the edition in the configured timeZone", () => {
    // 02:00Z is the previous evening (20:00) in America/Denver → the Night window.
    const files = renderSite(records, {
      now: new Date("2026-07-11T02:00:00.000Z"),
      secondaryStoryCount: 3,
      timeZone: "America/Denver",
      siteBaseUrl: SITE_BASE_URL,
    });
    expect(files["index.html"]).toContain("Night Edition");
    expect(files["index.html"]).not.toContain("Afternoon Edition");
  });

  it("omits removed chrome: search, subscribe, today's paper, English tagline", () => {
    for (const file of Object.values(renderSite(records, OPTS))) {
      expect(file.toUpperCase()).not.toContain("SEARCH");
      expect(file.toUpperCase()).not.toContain("SUBSCRIBE");
      expect(file.toUpperCase()).not.toContain("TODAY'S PAPER");
      expect(file).not.toContain("All the news that's fit to brick");
    }
  });

  it("never contains the trademark, case-insensitive, in any output file", () => {
    for (const file of Object.values(renderSite(records, OPTS))) {
      expect(file.toLowerCase()).not.toContain("lego");
    }
  });
});

describe("renderSite — hero fills the space under the lead", () => {
  it("lifts overflow cards into the lead's column (hero__main + hero__fill)", () => {
    // OPTS: secondaryStoryCount 3 → rail = b1,t1,s1; afterRail = w2,c1 → both pulled into the fill.
    const index = renderSite(records, OPTS)["index.html"];
    expect(index).toContain('class="hero__main"');
    expect(index).toContain('class="hero__fill"');
    // A pulled-up (after-rail) story shows up in the fill region.
    expect(index).toContain("Small Nation Enjoys Quiet, Uneventful Week");
  });

  it("keeps the full-width brickyard for stories beyond lead + rail + fill, with none dropped", () => {
    // 1 lead + 3 rail + 4 fill = 8 placed in the hero; anything past that flows to the brickyard.
    const many: ManifestRecord[] = Array.from({ length: 12 }, (_, i) =>
      rec({ id: `m${i}`, headline: `Distinct Headline Number ${i}`, category: "WORLD" }),
    );
    const index = renderSite(many, OPTS)["index.html"];
    expect(index).toContain('class="hero__fill"');
    expect(index).toContain("Across the Brickyard"); // full-width overflow grid still present
    // Every story appears exactly once — the split neither drops nor duplicates any card.
    for (let i = 0; i < many.length; i++) {
      const marker = `Distinct Headline Number ${i}<`;
      expect(index.split(marker).length - 1).toBe(1);
    }
  });

  it("omits the fill (and brickyard) when there are only a lead + rail", () => {
    // 4 records, secondaryStoryCount 3 → rail = 3, afterRail = 0 → no fill, no brickyard.
    const few = records.slice(0, 4);
    const index = renderSite(few, OPTS)["index.html"];
    expect(index).toContain('class="hero__main"');
    expect(index).not.toContain('class="hero__fill"');
    expect(index).not.toContain("Across the Brickyard");
  });
});

describe("renderSite — slot-based display bound (ADR-0020)", () => {
  // One section, larger than the slot limit; distinct firstSeen so rank is deterministic.
  const base = Date.parse("2026-07-10T12:00:00.000Z");
  const many: ManifestRecord[] = Array.from({ length: SECTION_SLOT_LIMIT + 5 }, (_, i) =>
    rec({
      id: `slot${i}`,
      headline: `Slotcheck ${i}`,
      category: "WORLD",
      firstSeen: new Date(base - i * 60_000).toISOString(),
    }),
  );
  const files = renderSite(many, OPTS);

  it("caps a section listing at SECTION_SLOT_LIMIT cards, keeping the newest", () => {
    const world = files["world.html"];
    // Every story on a section page is a card; count them.
    const count = world.match(/class="card__headline"/g)?.length ?? 0;
    expect(count).toBe(SECTION_SLOT_LIMIT);
    expect(world).toContain("Slotcheck 0<"); // newest, in slot
    expect(world).toContain(`Slotcheck ${SECTION_SLOT_LIMIT - 1}<`); // rank K-1, in slot
    expect(world).not.toContain(`Slotcheck ${SECTION_SLOT_LIMIT}<`); // rank K, below fold
    expect(world).not.toContain(`Slotcheck ${SECTION_SLOT_LIMIT + 4}<`); // oldest, below fold
  });

  it("caps the homepage overflow per section too — no below-fold straggler leaks onto the cover", () => {
    const index = files["index.html"];
    expect(index).toContain("Slotcheck 0<"); // the lead
    expect(index).not.toContain(`Slotcheck ${SECTION_SLOT_LIMIT}<`); // rank K, below fold
    expect(index).not.toContain(`Slotcheck ${SECTION_SLOT_LIMIT + 4}<`); // oldest, below fold
  });

  it("still emits a landing page + sitemap entry for a below-fold record (direct access)", () => {
    const belowFoldId = `slot${SECTION_SLOT_LIMIT + 4}`;
    expect(files[`s/${belowFoldId}.html`]).toBeTruthy();
    expect(files["sitemap.xml"]).toContain(`s/${belowFoldId}.html`);
  });
});

describe("renderSite — section pages", () => {
  const files = renderSite(records, OPTS);

  it("world.html contains only WORLD stories and marks WORLD active", () => {
    const world = files["world.html"];
    expect(world).toContain("Summit Ends With a Handshake and a Communique");
    expect(world).toContain("Small Nation Enjoys Quiet, Uneventful Week");
    // A BUSINESS headline must not appear on the WORLD page.
    expect(world).not.toContain("Investors Await Guidance They Suspect They Have");
    expect(world).toContain("nav__link--active");
  });

  it("a section with no stories emits no page and no links to it (ADR-0013)", () => {
    expect(files["sports.html"]).toBeUndefined();
    expect(files["index.html"]).not.toContain('href="sports.html"'); // neither nav nor footer
  });
});

/** A local-article fixture (ADR-0010). Defaults to an unexpired Technology article. */
function art(over: Partial<Article> & { id: string }): Article {
  return {
    headline: `Article ${over.id}`,
    byline: "By our local desk",
    description: `Teaser for ${over.id}.`,
    category: "TECHNOLOGY",
    mainRank: 0,
    subRank: 0,
    bodyMarkdown: "A **local** body with a [link](https://brickfeed.news).",
    imageUrl: `https://cdn.test/articles/${over.id}.jpg`,
    ...over,
  };
}

describe("renderSite — local articles (ADR-0010)", () => {
  it("places a Main Page Rank 2 article as the second cover story", () => {
    const article = art({ id: "article-01", headline: "Locally Hosted Scoop", mainRank: 2 });
    const files = renderSite(records, { ...OPTS, articles: [article] });
    const index = files["index.html"];
    // The lead is still the newest feed story; the article sits right after it.
    const leadPos = index.indexOf("Summit Ends With a Handshake and a Communique");
    const articlePos = index.indexOf("Locally Hosted Scoop");
    const secondFeedPos = index.indexOf("Investors Await Guidance They Suspect They Have");
    expect(leadPos).toBeGreaterThan(-1);
    expect(articlePos).toBeGreaterThan(leadPos);
    expect(articlePos).toBeLessThan(secondFeedPos);
  });

  it("links a cover article to its internal s/<id>.html page in the same tab (no target=_blank)", () => {
    const article = art({ id: "article-01", headline: "Same Tab Please", mainRank: 1 });
    const index = renderSite(records, { ...OPTS, articles: [article] })["index.html"];
    // The lead link points at the internal page…
    expect(index).toContain('href="s/article-01.html"');
    // …and the anchor around the article headline is not a new-tab outbound link.
    const anchor = index.slice(index.indexOf('href="s/article-01.html"') - 40, index.indexOf("Same Tab Please"));
    expect(anchor).not.toContain("target=");
  });

  it("clamps a rank beyond the story count to the last position", () => {
    const article = art({ id: "article-01", headline: "Way Down Here", mainRank: 999 });
    const index = renderSite(records, { ...OPTS, articles: [article] })["index.html"];
    const articlePos = index.indexOf("Way Down Here");
    // It lands after the last feed story (the CULTURE placeholder one).
    const lastFeedPos = index.indexOf("Museum Unveils Exhibit Nobody Could Explain");
    expect(articlePos).toBeGreaterThan(lastFeedPos);
  });

  it("places a SubPage Rank 1 article first on its section page only", () => {
    const article = art({ id: "article-01", headline: "Tech Desk Exclusive", category: "TECHNOLOGY", subRank: 1 });
    const files = renderSite(records, { ...OPTS, articles: [article] });
    const tech = files["technology.html"];
    const articlePos = tech.indexOf("Tech Desk Exclusive");
    const feedTechPos = tech.indexOf("Startup Unveils Plan to Disrupt Thing You Own");
    expect(articlePos).toBeGreaterThan(-1);
    expect(articlePos).toBeLessThan(feedTechPos);
    // It must not leak onto an unrelated section page.
    expect(files["business.html"]).not.toContain("Tech Desk Exclusive");
  });

  it("renders the markdown body on the article's own s/<id>.html page, with no outbound CTA", () => {
    const article = art({ id: "article-01", headline: "The Body Renders" });
    const page = renderSite(records, { ...OPTS, articles: [article] })["s/article-01.html"];
    expect(page).toContain("The Body Renders");
    expect(page).toContain("By our local desk");
    // Markdown converted to HTML (bold + link).
    expect(page).toContain("<strong>local</strong>");
    expect(page).toContain('href="https://brickfeed.news"');
    // No "read at source" CTA on a locally hosted article.
    expect(page).not.toContain("Read the full story at the source");
  });

  it("excludes an expired article from every page", () => {
    const expired = art({
      id: "article-01",
      headline: "Yesterdays News",
      mainRank: 1,
      subRank: 1,
      expires: new Date("2026-07-09T23:59:59.999Z"), // before NOW (2026-07-10)
    });
    const files = renderSite(records, { ...OPTS, articles: [expired] });
    expect(files["index.html"]).not.toContain("Yesterdays News");
    expect(files["technology.html"]).not.toContain("Yesterdays News");
    expect(files["s/article-01.html"]).toBeUndefined();
  });

  it("keeps an article whose expiry is later today (inclusive through the expiry day)", () => {
    const article = art({
      id: "article-01",
      headline: "Still Live Today",
      mainRank: 1,
      expires: new Date("2026-07-10T23:59:59.999Z"), // same day as NOW
    });
    const index = renderSite(records, { ...OPTS, articles: [article] })["index.html"];
    expect(index).toContain("Still Live Today");
  });

  it("places a rank-0 article deterministically for a fixed clock (no crash, always present)", () => {
    const article = art({ id: "article-01", headline: "Wherever It Lands", mainRank: 0 });
    const a = renderSite(records, { ...OPTS, articles: [article] })["index.html"];
    const b = renderSite(records, { ...OPTS, articles: [article] })["index.html"];
    expect(a).toBe(b); // deterministic for a pinned now
    expect(a).toContain("Wherever It Lands");
  });

  it("adds the article to the share sheet", () => {
    const article = art({ id: "article-01", headline: "Shareable Local" });
    const share = renderSite(records, { ...OPTS, articles: [article] })["share.html"];
    expect(share).toContain("Shareable Local");
    // The X-intent url= param is percent-encoded, so the page path appears as ...%2Farticle-01.html.
    expect(share).toContain("article-01.html");
  });

  it("leaves the site unchanged when no articles are supplied", () => {
    const withEmpty = renderSite(records, { ...OPTS, articles: [] });
    const without = renderSite(records, OPTS);
    expect(withEmpty["index.html"]).toBe(without["index.html"]);
  });
});

describe("renderSite — about page", () => {
  const files = renderSite(records, OPTS);
  const about = files["about.html"];

  it("emits about.html alongside the cover and section pages", () => {
    expect(about).toBeTruthy();
  });

  it("carries the creator bio copy", () => {
    expect(about).toContain(
      "Brickfeed News was created by an unemployed software developer on a Friday afternoon.",
    );
    expect(about).toContain("possibly even employ him");
  });

  it("links out to the creator's LinkedIn, GitHub, and Twelve Rocks, opening the source", () => {
    expect(about).toContain('href="https://www.linkedin.com/in/kbennett2000/"');
    expect(about).toContain('href="https://github.com/kbennett2000"');
    expect(about).toContain('href="https://www.twelverocks.com/"');
    expect(about).toContain('target="_blank"');
    expect(about).toContain('rel="noopener noreferrer"');
  });

  it("shows the toy-brick portrait from Blob storage", () => {
    expect(about).toContain(
      'src="https://7fjkp0rhcwadfro9.public.blob.vercel-storage.com/images/about-portrait-91deb1d497.jpg"',
    );
  });

  it("reuses the shared chrome and shell", () => {
    expect(about).toContain("All the stories, brick by brick"); // masthead motto
    expect(about).toContain("<title>About — brickfeed</title>");
    expect(about).toContain('href="index.html"'); // nav brand back to cover
  });

  it("is linked from the footer on every page (cover, section, about itself)", () => {
    expect(files["index.html"]).toContain('href="about.html"');
    expect(files["world.html"]).toContain('href="about.html"');
    expect(about).toContain('href="about.html"');
  });
});

describe("renderSite — robustness", () => {
  it("empty published.json → a valid, non-empty index page (no throw)", () => {
    const files = renderSite([], OPTS);
    const index = files["index.html"];
    expect(index).toContain("brickfeed");
    expect(index).toContain("All the stories, brick by brick");
    expect(index).toContain("Nothing to brick, just now.");
    // With no stories, no section is present, so no section links render (ADR-0013) — the
    // nav is brand + About only.
    for (const c of CATEGORIES) {
      expect(index).not.toContain(`href="${sectionSlug(c)}.html"`);
    }
    expect(index).toContain('href="about.html">About</a>');
  });

  it("escapes HTML-special characters in record text", () => {
    const files = renderSite(
      [rec({ id: "x", headline: "Markets <rise> & <fall>", url: "https://e.com/?a=1&b=2" })],
      OPTS,
    );
    const index = files["index.html"];
    expect(index).toContain("Markets &lt;rise&gt; &amp; &lt;fall&gt;");
    expect(index).toContain('href="https://e.com/?a=1&amp;b=2"');
    expect(index).not.toContain("Markets <rise>");
  });
});

describe("format helpers", () => {
  it("formats the masthead date in UTC, uppercased", () => {
    expect(formatMastheadDate(new Date("2026-07-10T23:59:00.000Z"))).toBe("FRIDAY, JULY 10, 2026");
  });

  it("formats an absolute timestamp in the given zone; never stale", () => {
    // Same instant, two zones — deterministic regardless of host clock (hermetic render).
    expect(formatTimestamp("2026-07-14T20:30:00.000Z", "UTC")).toBe("Jul 14, 8:30 PM");
    expect(formatTimestamp("2026-07-14T20:30:00.000Z", "America/Denver")).toBe("Jul 14, 2:30 PM");
    expect(formatTimestamp("2026-07-14T20:30:00.000Z")).toBe("Jul 14, 8:30 PM"); // default UTC
  });

  it("degrades an empty/unparseable timestamp to '' (no byline tail)", () => {
    expect(formatTimestamp("", "UTC")).toBe("");
    expect(formatTimestamp("not-a-date", "UTC")).toBe("");
  });

  it("derives a decorative byline from a category", () => {
    expect(bylineFor("TECHNOLOGY")).toBe("By the Technology Desk");
  });

  it("maps each hour to its 4-hour edition window (inclusive of boundaries)", () => {
    // start-of-window and end-of-window hours land in the same edition.
    expect(editionForHour(0)).toBe("Midnight Edition");
    expect(editionForHour(3)).toBe("Midnight Edition");
    expect(editionForHour(4)).toBe("Sunrise Edition");
    expect(editionForHour(7)).toBe("Sunrise Edition");
    expect(editionForHour(8)).toBe("Morning Edition");
    expect(editionForHour(11)).toBe("Morning Edition");
    expect(editionForHour(12)).toBe("Afternoon Edition");
    expect(editionForHour(15)).toBe("Afternoon Edition");
    expect(editionForHour(16)).toBe("Evening Edition");
    expect(editionForHour(19)).toBe("Evening Edition");
    expect(editionForHour(20)).toBe("Night Edition");
    expect(editionForHour(23)).toBe("Night Edition");
  });

  it("computes the edition label from a clock in a given time zone", () => {
    const t = new Date("2026-07-11T02:00:00.000Z");
    expect(editionLabel(t, "UTC")).toBe("Midnight Edition"); // 02:00 UTC
    expect(editionLabel(t, "America/Denver")).toBe("Night Edition"); // 20:00 local
    expect(editionLabel(new Date("2026-07-10T12:00:00.000Z"))).toBe("Afternoon Edition"); // default UTC
  });
});

const AD_A = {
  imageUrl: "https://cdn.test/ads/ad-01.png",
  href: "https://github.com/kbennett2000/slopify",
  alt: "Advertisement — github.com",
  durationMs: 7000,
};
const AD_B = {
  imageUrl: "https://cdn.test/ads/ad-02.jpg",
  href: 'https://example.com/two?q="x"', // quote must be escaped in the href attribute
  alt: "Advertisement — example.com",
  durationMs: 12000,
};

describe("renderSite — banner ads", () => {
  it("omits the banner entirely when there are no ads", () => {
    const files = renderSite(records, OPTS);
    expect(files["index.html"]).not.toContain("adbanner");
    expect(files[`${sectionSlug("WORLD")}.html`]).not.toContain("adbanner");
  });

  it("also omits the banner when ads is an empty array", () => {
    const files = renderSite(records, { ...OPTS, ads: [] });
    expect(files["index.html"]).not.toContain("adbanner");
  });

  describe("with two ads", () => {
    const files = renderSite(records, { ...OPTS, ads: [AD_A, AD_B] });
    const index = files["index.html"];

    it("renders the banner site-wide (cover + every present section)", () => {
      expect(index).toContain('class="adbanner"');
      for (const c of PRESENT) {
        expect(files[`${sectionSlug(c)}.html`]).toContain('class="adbanner"');
      }
    });

    it("places the banner above the main content (below the nav)", () => {
      expect(index.indexOf("adbanner")).toBeLessThan(index.indexOf("<main"));
    });

    it("links each ad out in a new tab, marked sponsored, with escaped href", () => {
      expect(index).toContain(`href="${AD_A.href}"`);
      expect(index).toContain('rel="noopener sponsored nofollow"');
      expect(index).toContain('target="_blank"');
      // The quote in AD_B's href is escaped — no attribute break-out.
      expect(index).toContain("https://example.com/two?q=&quot;x&quot;");
      expect(index).not.toContain('href="https://example.com/two?q="x""');
    });

    it("renders our own image and an Advertisement label (never a publisher photo)", () => {
      expect(index).toContain(`src="${AD_A.imageUrl}"`);
      expect(index).toContain(`alt="${AD_A.alt}"`);
      expect(index).toContain("Advertisement");
    });

    it("carries each ad's configured duration as data-duration (ADR-0017)", () => {
      expect(index).toContain('data-duration="7000"');
      expect(index).toContain('data-duration="12000"');
    });

    it("ships the inline rotator script once per page, embedding the tested functions", () => {
      expect(index).toContain(AD_ROTATOR_JS);
      expect(index.split("function shuffleIndices").length - 1).toBe(1);
      for (const c of PRESENT) {
        expect(files[`${sectionSlug(c)}.html`]).toContain(AD_ROTATOR_JS);
      }
    });

    it("emits only static rotation CSS — no generated keyframes (ADR-0017)", () => {
      const css = files["styles.css"];
      expect(css).not.toContain("adbannerfade");
      expect(css).not.toContain("animation-delay");
      expect(css).toContain(".adbanner__frame:not(.is-live) .adbanner__slide:first-child");
      expect(css).toContain(".adbanner__slide.is-active");
      expect(css).toContain("prefers-reduced-motion");
    });
  });

  it("renders a single ad statically — no rotator script", () => {
    const files = renderSite(records, { ...OPTS, ads: [AD_A] });
    expect(files["index.html"]).toContain('class="adbanner"');
    expect(files["index.html"]).not.toContain("shuffleIndices");
  });
});

describe("renderSite — per-story landing pages", () => {
  const files = renderSite(records, OPTS);

  it("emits one s/<id>.html per record", () => {
    for (const r of records) {
      expect(files[`s/${r.id}.html`]).toBeTruthy();
    }
  });

  describe("the lead's landing page", () => {
    const page = files["s/lead.html"];

    it("carries a summary_large_image Twitter card", () => {
      expect(page).toContain('<meta name="twitter:card" content="summary_large_image">');
    });

    it("points og:image and twitter:image at the record's absolute image URL", () => {
      expect(page).toContain('<meta property="og:image" content="https://cdn.test/lead.png">');
      expect(page).toContain('<meta name="twitter:image" content="https://cdn.test/lead.png">');
    });

    it("sets og:type=article, og:title=headline, and an ABSOLUTE og:url to its own page", () => {
      expect(page).toContain('<meta property="og:type" content="article">');
      expect(page).toContain(
        '<meta property="og:title" content="Summit Ends With a Handshake and a Communique">',
      );
      expect(page).toContain(
        `<meta property="og:url" content="${SITE_BASE_URL}/s/lead.html">`,
      );
    });

    it("links out to the source article, opening it in a new tab", () => {
      expect(page).toContain('href="https://example.com/lead"');
      expect(page).toContain('target="_blank"');
      expect(page).toContain('rel="noopener noreferrer"');
    });

    it("references the cache-busted stylesheet from the parent dir (ADR-0017)", () => {
      expect(page).toMatch(/href="\.\.\/styles\.css\?v=[0-9a-z]+"/);
      expect(page).not.toContain('href="styles.css');
      // Root pages carry the SAME version (one hash of one sheet), just without the prefix.
      const version = page.match(/href="\.\.\/styles\.css\?v=([0-9a-z]+)"/)?.[1];
      expect(files["index.html"]).toContain(`href="styles.css?v=${version}"`);
      // The hash is content-derived: no page may link the sheet un-versioned, or a browser's
      // day-old cached copy would silently style fresh markup (the ADR-0017 failure class).
      expect(files["index.html"]).not.toContain('href="styles.css"');
    });

    it("shows the headline, dek, and caption + studio credit", () => {
      expect(page).toContain("Summit Ends With a Handshake and a Communique");
      expect(page).toContain("A sober description for lead.");
      expect(page).toContain("A neutral caption for lead");
      expect(page).toContain("/ BRICKFEED STUDIO");
    });
  });

  it("omits og:image on an image-less record but still emits a card", () => {
    const noImg = renderSite([rec({ id: "np", imageUrl: undefined })], OPTS)["s/np.html"];
    expect(noImg).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(noImg).not.toContain("og:image");
    expect(noImg).not.toContain("twitter:image");
  });

  it("emits twitter:site ONLY when a handle is configured", () => {
    // Default OPTS has no share config → no twitter:site anywhere.
    expect(files["s/lead.html"]).not.toContain("twitter:site");
    const withHandle = renderSite(records, {
      ...OPTS,
      share: { handle: "brickfeednews" },
    });
    expect(withHandle["s/lead.html"]).toContain(
      '<meta name="twitter:site" content="@brickfeednews">',
    );
  });

  it("escapes interpolated values in the card meta", () => {
    const page = renderSite(
      [rec({ id: "x", headline: 'Markets "rise" & <fall>' })],
      OPTS,
    )["s/x.html"];
    expect(page).toContain(
      '<meta property="og:title" content="Markets &quot;rise&quot; &amp; &lt;fall&gt;">',
    );
    expect(page).not.toContain('content="Markets "rise"');
  });

  it("never contains the trademark in a landing page", () => {
    expect(files["s/lead.html"].toLowerCase()).not.toContain("lego");
  });
});

describe("renderSite — X share sheet", () => {
  const files = renderSite(records, OPTS);
  const sheet = files["share.html"];

  it("emits share.html", () => {
    expect(sheet).toBeTruthy();
  });

  it("marks the share sheet noindex", () => {
    expect(sheet).toContain('<meta name="robots" content="noindex">');
  });

  it("has one X Web Intent link per publishable story", () => {
    const count = sheet.match(/https:\/\/x\.com\/intent\/tweet\?/g)?.length ?? 0;
    expect(count).toBe(records.length);
  });

  it("points each intent link's url param at the story's ABSOLUTE landing page URL", () => {
    // URLSearchParams percent-encodes the landing URL as the `url` param value.
    const encoded = encodeURIComponent(`${SITE_BASE_URL}/s/lead.html`);
    expect(sheet).toContain(`url=${encoded}`);
  });

  it("opens each post link in a new tab", () => {
    expect(sheet).toContain('target="_blank"');
    expect(sheet).toContain('rel="noopener noreferrer"');
    expect(sheet).toContain("Post to X");
  });

  it("omits via/hashtags params when unconfigured", () => {
    expect(sheet).not.toContain("via=");
    expect(sheet).not.toContain("hashtags=");
  });

  it("includes via + hashtags params when configured", () => {
    const configured = renderSite(records, {
      ...OPTS,
      share: { handle: "brickfeednews", hashtags: ["brickfeed", "news"] },
    })["share.html"];
    expect(configured).toContain("via=brickfeednews");
    expect(configured).toContain("hashtags=brickfeed%2Cnews");
  });

  it("is NOT linked from the nav/footer on any page", () => {
    for (const [name, file] of Object.entries(files)) {
      if (name === "share.html") continue;
      expect(file).not.toContain('href="share.html"');
      expect(file).not.toContain('href="../share.html"');
    }
  });

  it("never contains the trademark in the share sheet", () => {
    expect(sheet.toLowerCase()).not.toContain("lego");
  });

  it("has one LinkedIn share link per publishable story, alongside the X links", () => {
    const count = sheet.match(/https:\/\/www\.linkedin\.com\/feed\/\?/g)?.length ?? 0;
    expect(count).toBe(records.length);
    expect(sheet).toContain("Post to LinkedIn");
  });

  it("prefills each LinkedIn link with the headline and the absolute landing URL", () => {
    // The feed/shareActive text param carries the headline + the page URL (percent-encoded).
    expect(sheet).toContain("shareActive=true");
    expect(sheet).toContain(encodeURIComponent(`${SITE_BASE_URL}/s/lead.html`));
  });

  it("tags each row with its section for client-side filtering", () => {
    for (const c of CATEGORIES) {
      // Every category present on a story should appear as a data-category on some row.
      if (sheet.includes(`data-category="${c}"`)) {
        expect(sheet).toContain(`data-filter="${c}"`); // …and get a matching filter chip
      }
    }
    expect(sheet).toContain('data-filter="ALL"');
  });

  it("puts local articles in their own section pinned above the feed stories", () => {
    const article = art({ id: "article-01", headline: "Top Local Story" });
    const withLocal = renderSite(records, { ...OPTS, articles: [article] })["share.html"];
    const localHeadingPos = withLocal.indexOf("Local articles");
    const feedHeadingPos = withLocal.indexOf("From the feed");
    const localStoryPos = withLocal.indexOf("Top Local Story");
    expect(localHeadingPos).toBeGreaterThan(-1);
    expect(localHeadingPos).toBeLessThan(feedHeadingPos);
    expect(localStoryPos).toBeGreaterThan(localHeadingPos);
    expect(localStoryPos).toBeLessThan(feedHeadingPos);
  });

  it("omits the local-articles section when there are none", () => {
    expect(sheet).not.toContain("Local articles");
    expect(sheet).toContain("From the feed");
  });
});

describe("share format helpers", () => {
  it("builds the absolute landing-page URL from the site base + id", () => {
    expect(storyPageUrl("https://www.brickfeed.news", "abc123")).toBe(
      "https://www.brickfeed.news/s/abc123.html",
    );
  });

  it("encodes the headline and url in the intent URL, omitting via/hashtags when unset", () => {
    const url = buildXIntentUrl({
      headline: "Markets rise & fall",
      pageUrl: "https://www.brickfeed.news/s/id.html",
    });
    expect(url.startsWith("https://x.com/intent/tweet?")).toBe(true);
    expect(url).toContain("text=Markets+rise+%26+fall");
    expect(url).toContain("url=https%3A%2F%2Fwww.brickfeed.news%2Fs%2Fid.html");
    expect(url).not.toContain("via=");
    expect(url).not.toContain("hashtags=");
  });

  it("builds a LinkedIn share URL prefilling headline + landing URL, with the OG card coming from the page", () => {
    const url = buildLinkedInIntentUrl({
      headline: "Markets rise & fall",
      pageUrl: "https://www.brickfeed.news/s/id.html",
    });
    expect(url.startsWith("https://www.linkedin.com/feed/?")).toBe(true);
    expect(url).toContain("shareActive=true");
    const text = new URL(url).searchParams.get("text") ?? "";
    expect(text).toBe("Markets rise & fall\n\nhttps://www.brickfeed.news/s/id.html");
  });

  it("adds via (no @) and comma-joined hashtags (no #) when provided", () => {
    const url = buildXIntentUrl({
      headline: "Hi",
      pageUrl: "https://x/s/id.html",
      handle: "brickfeednews",
      hashtags: ["brickfeed", "news"],
    });
    expect(url).toContain("via=brickfeednews");
    expect(url).toContain("hashtags=brickfeed%2Cnews");
  });

  it("truncates an over-long headline with an ellipsis so the tweet fits", () => {
    const long = "A".repeat(400);
    const url = buildXIntentUrl({ headline: long, pageUrl: "https://x/s/id.html" });
    const text = new URL(url).searchParams.get("text") ?? "";
    expect(text.endsWith("…")).toBe(true);
    // Text + the wrapped-URL budget stays within the 280 ceiling.
    expect(text.length).toBeLessThanOrEqual(280 - 23 - 1);
  });

  it("truncateForTweet leaves a short headline untouched and cuts a long one", () => {
    expect(truncateForTweet("short", 20)).toBe("short");
    const cut = truncateForTweet("A".repeat(50), 10);
    expect(cut.length).toBe(10);
    expect(cut.endsWith("…")).toBe(true);
    expect(truncateForTweet("anything", 0)).toBe("");
  });
});

describe("renderSite — web analytics (render.analytics)", () => {
  const BEACON = `<script defer src="/_vercel/insights/script.js"></script>`;

  it("injects the Vercel beacon before </body> on public pages when analytics: vercel", () => {
    const article: Article = {
      id: "article-01",
      headline: "A Local Story",
      description: "Hosted here.",
      byline: "By Staff",
      category: "CULTURE",
      mainRank: 0,
      subRank: 0,
      bodyMarkdown: "Body.",
      imageUrl: "https://cdn.test/article-01.png",
    };
    const files = renderSite(records, { ...OPTS, analytics: "vercel", articles: [article] });

    for (const page of [
      "index.html",
      "about.html",
      `${sectionSlug("WORLD")}.html`,
      "s/lead.html", // a feed-story landing page
      "s/article-01.html", // a local-article landing page
    ]) {
      expect(files[page], page).toContain(BEACON);
      expect(files[page], page).toContain("window.va = window.va ||");
      // The analytics beacon is followed by the Speed Insights beacon (ADR-0012), which sits
      // right before the closing body tag.
      expect(files[page], page).toContain("window.si = window.si ||");
      expect(files[page], page).toContain(
        `<script defer src="/_vercel/speed-insights/script.js"></script>\n</body>`,
      );
    }
  });

  it("never tracks the operator-only (noindex) share sheet", () => {
    const files = renderSite(records, { ...OPTS, analytics: "vercel" });
    expect(files["share.html"]).toContain(`content="noindex"`);
    expect(files["share.html"]).not.toContain(BEACON);
  });

  it("emits no beacon by default (analytics omitted → none)", () => {
    const files = renderSite(records, OPTS);
    for (const page of Object.values(files)) {
      expect(page).not.toContain(BEACON);
    }
  });
});

const IMG_OPT = { widths: [320, 640, 1280], quality: 75, blobHost: "store.public.blob.vercel-storage.com" };

describe("renderSite — responsive image optimization (ADR-0012)", () => {
  it("emits a /_vercel/image srcset + sizes on cover images when enabled", () => {
    const index = renderSite(records, { ...OPTS, imageOptimize: IMG_OPT })["index.html"];
    // The thumbnail keeps the raw Blob URL as its src fallback…
    expect(index).toContain('src="https://cdn.test/lead.png"');
    // …and gains an optimized srcset across the configured widths + a sizes hint.
    expect(index).toContain(
      `srcset="/_vercel/image?url=${encodeURIComponent("https://cdn.test/lead.png")}&amp;w=320&amp;q=75 320w`,
    );
    expect(index).toContain('sizes="');
    expect(index).toContain("&amp;w=1280&amp;q=75 1280w");
  });

  it("points the hover-zoom img at the largest optimized width", () => {
    const index = renderSite(records, { ...OPTS, imageOptimize: IMG_OPT })["index.html"];
    expect(index).toContain(
      `class="figure__zoom-img" src="/_vercel/image?url=${encodeURIComponent("https://cdn.test/lead.png")}&amp;w=1280&amp;q=75"`,
    );
  });

  it("writes a vercel.json with the images block + Blob remotePattern when enabled", () => {
    const files = renderSite(records, { ...OPTS, imageOptimize: IMG_OPT });
    expect(files["vercel.json"]).toBeTruthy();
    const cfg = JSON.parse(files["vercel.json"]);
    expect(cfg.images.formats).toEqual(["image/avif", "image/webp"]);
    expect(cfg.images.sizes).toEqual([320, 640, 1280]);
    expect(cfg.images.qualities).toEqual([75]);
    expect(cfg.images.remotePatterns).toEqual([
      { protocol: "https", hostname: "store.public.blob.vercel-storage.com" },
    ]);
  });

  it("is inert (byte-identical, no images block) when optimization is off", () => {
    const optimized = renderSite(records, OPTS)["index.html"];
    // No optimization option → no srcset, raw Blob src only.
    expect(optimized).not.toContain("/_vercel/image");
    expect(optimized).toContain('src="https://cdn.test/lead.png"');
    const cfg = JSON.parse(renderSite(records, OPTS)["vercel.json"]);
    expect(cfg.images).toBeUndefined();
    // vercel.json still carries the security + cache headers regardless.
    expect(JSON.stringify(cfg.headers)).toContain("X-Content-Type-Options");
  });
});

describe("renderSite — lazy loading (ADR-0012)", () => {
  it("marks the hover-zoom img lazy + async so it no longer defeats the thumbnail's lazy load", () => {
    const index = renderSite(records, OPTS)["index.html"];
    const zoomImgs = index.match(/<img class="figure__zoom-img"[^>]*>/g) ?? [];
    expect(zoomImgs.length).toBeGreaterThan(0);
    for (const img of zoomImgs) {
      expect(img).toContain('loading="lazy"');
      expect(img).toContain('decoding="async"');
    }
  });

  it("marks banner ad images lazy + async", () => {
    const index = renderSite(records, { ...OPTS, ads: [AD_A] })["index.html"];
    const adImgs = index.match(/<img class="adbanner__img"[^>]*>/g) ?? [];
    expect(adImgs.length).toBeGreaterThan(0);
    for (const img of adImgs) {
      expect(img).toContain('loading="lazy"');
      expect(img).toContain('decoding="async"');
    }
  });
});

describe("renderSite — per-story share links (ADR-0012)", () => {
  it("renders an X + LinkedIn share button under each publishable cover story", () => {
    const index = renderSite(records, {
      ...OPTS,
      share: { handle: "brickfeednews", hashtags: ["brickfeed"] },
    })["index.html"];
    // The lead story's share buttons point at its ABSOLUTE landing URL…
    const landing = `${SITE_BASE_URL}/s/lead.html`;
    // X intent: text is the headline, url is the absolute landing page.
    expect(index).toContain("https://x.com/intent/tweet?");
    expect(index).toContain(`url=${encodeURIComponent(landing)}`);
    expect(index).toContain("Summit+Ends+With+a+Handshake"); // headline in the X text= param
    // LinkedIn: the landing URL rides in the shareActive text so LinkedIn resolves our OG card.
    expect(index).toContain("https://www.linkedin.com/feed/?");
    expect(index).toContain(encodeURIComponent(landing));
    // X carries the configured via + hashtags, like the Share page.
    expect(index).toContain("via=brickfeednews");
    expect(index).toContain("hashtags=brickfeed");
  });

  it("places the share links OUTSIDE the card's own anchor (no nested <a>)", () => {
    const index = renderSite(records, OPTS)["index.html"];
    // Every story with a share row is wrapped in a .story container.
    expect(index).toContain('<div class="story">');
    // Locate the lead story block and assert the share anchors are siblings of, not inside, the
    // story's own <a>. A crude but effective check: between a story link's opening <a and its
    // closing </a>, there must be no nested <a (the share buttons come after the </a>).
    const storyBlocks = index.split('<div class="story">').slice(1);
    expect(storyBlocks.length).toBeGreaterThan(0);
    for (const block of storyBlocks) {
      const firstAnchorClose = block.indexOf("</a>");
      const inner = block.slice(0, firstAnchorClose);
      // No second <a opens before the story link closes.
      expect(inner.indexOf("<a ", 1)).toBe(-1);
    }
    // And the share buttons DO exist (after the anchor), as story-share links.
    expect(index).toContain('class="story-share__btn"');
    expect(index).toContain('class="story-share__btn story-share__btn--linkedin"');
  });

  it("does NOT render a share row for an imageless placeholder story (byte-identical)", () => {
    const placeholder = renderSite([rec({ id: "np", imageUrl: undefined })], OPTS)["index.html"];
    expect(placeholder).toContain("figure__placeholder");
    expect(placeholder).not.toContain("story-share");
  });

  it("adds a share row to the per-story landing page too", () => {
    const page = renderSite(records, OPTS)["s/lead.html"];
    expect(page).toContain("story-share");
    expect(page).toContain(`url=${encodeURIComponent(`${SITE_BASE_URL}/s/lead.html`)}`);
  });
});

describe("renderSite — SEO artifacts (ADR-0012)", () => {
  const files = renderSite(records, { ...OPTS, articles: [art({ id: "article-01" })] });

  it("emits robots.txt pointing at the sitemap and disallowing the share sheet", () => {
    const robots = files["robots.txt"];
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain(`Sitemap: ${SITE_BASE_URL}/sitemap.xml`);
    expect(robots).toContain("Disallow: /share.html");
  });

  it("emits a sitemap listing the cover, present sections, and landing pages but not the share sheet", () => {
    const sitemap = files["sitemap.xml"];
    expect(sitemap).toContain(`<loc>${SITE_BASE_URL}/</loc>`);
    expect(sitemap).toContain(`<loc>${SITE_BASE_URL}/world.html</loc>`);
    expect(sitemap).toContain(`<loc>${SITE_BASE_URL}/s/lead.html</loc>`);
    expect(sitemap).toContain(`<loc>${SITE_BASE_URL}/s/article-01.html</loc>`);
    expect(sitemap).not.toContain("share.html");
    // Empty sections are omitted from the sitemap too (ADR-0013).
    expect(sitemap).not.toContain("sports.html");
    expect(sitemap).not.toContain("opinion.html");
  });
});

describe("renderSite — conditional sections (ADR-0013)", () => {
  it("Opinion appears everywhere once it has a published story", () => {
    const opinion = rec({
      id: "o1",
      headline: "An Opinion, Firmly Held",
      category: "OPINION",
      firstSeen: "2026-07-10T09:00:00.000Z",
    });
    const files = renderSite([...records, opinion], OPTS);
    const index = files["index.html"];
    // Section page exists with the story and the Opinion blurb.
    expect(files["opinion.html"]).toBeTruthy();
    expect(files["opinion.html"]).toContain("An Opinion, Firmly Held");
    expect(files["opinion.html"]).toContain("Views, firmly and comfortably held.");
    // Linked from the nav and footer, listed in the sitemap.
    expect(index).toContain('href="opinion.html"');
    expect(index).toContain(">Opinion</a>");
    expect(files["sitemap.xml"]).toContain(`<loc>${SITE_BASE_URL}/opinion.html</loc>`);
    // CATEGORIES order is preserved: Opinion after Culture, About last.
    const culturePos = index.indexOf('href="culture.html"');
    const opinionPos = index.indexOf('href="opinion.html"');
    const aboutPos = index.indexOf('href="about.html"');
    expect(culturePos).toBeGreaterThan(-1);
    expect(opinionPos).toBeGreaterThan(culturePos);
    expect(aboutPos).toBeGreaterThan(opinionPos);
  });

  it("a live local article alone makes its section present", () => {
    const article = art({ id: "sp1", headline: "A Sporting Chance", category: "SPORTS", subRank: 1 });
    const files = renderSite(records, { ...OPTS, articles: [article] });
    expect(files["sports.html"]).toBeTruthy();
    expect(files["sports.html"]).toContain("A Sporting Chance");
    expect(files["index.html"]).toContain('href="sports.html"');
  });

  it("staleSectionPages names the omitted section pages so writers can delete them", () => {
    const files = renderSite(records, OPTS);
    expect(staleSectionPages(files).sort()).toEqual(["opinion.html", "politics.html", "sports.html"]);
    // With every section populated, nothing is stale.
    const all = CATEGORIES.map((c, i) => rec({ id: `all${i}`, category: c }));
    expect(staleSectionPages(renderSite(all, OPTS))).toEqual([]);
  });

  it("staleColumnistPages names on-disk bio pages this render did not emit (ADR-0019)", () => {
    const files = { "columnist/alice.html": "<html>", "columnist/tom.html": "<html>" };
    // A retired persona's page is stale; current pages and non-.html strays are not touched.
    expect(staleColumnistPages(["alice.html", "tom.html", "zed.html", "notes.txt"], files)).toEqual([
      "columnist/zed.html",
    ]);
    // Empty dir (or missing → [] from the writer) → nothing to delete.
    expect(staleColumnistPages([], files)).toEqual([]);
    // No authors rendered at all → every on-disk page is stale.
    expect(staleColumnistPages(["zed.html"], {})).toEqual(["columnist/zed.html"]);
  });

  it("an expired article does NOT make its section present", () => {
    const article = art({
      id: "sp2",
      category: "SPORTS",
      expires: new Date("2026-07-09T23:59:59.999Z"), // before NOW
    });
    const files = renderSite(records, { ...OPTS, articles: [article] });
    expect(files["sports.html"]).toBeUndefined();
    expect(files["index.html"]).not.toContain('href="sports.html"');
  });
});

describe("optimizedUrl / optimizedSrcset (ADR-0012)", () => {
  it("builds a same-origin /_vercel/image URL with an encoded src and clamped quality", () => {
    expect(optimizedUrl("https://cdn.test/a b.png", 640, 75)).toBe(
      `/_vercel/image?url=${encodeURIComponent("https://cdn.test/a b.png")}&w=640&q=75`,
    );
    // Quality is clamped into 1–100.
    expect(optimizedUrl("https://cdn.test/x.png", 320, 999)).toContain("&q=100");
    expect(optimizedUrl("https://cdn.test/x.png", 320, 0)).toContain("&q=1");
  });

  it("builds an ascending, de-duplicated srcset of width descriptors", () => {
    const set = optimizedSrcset("https://cdn.test/x.png", [640, 320, 640], 75);
    expect(set).toBe(
      `/_vercel/image?url=${encodeURIComponent("https://cdn.test/x.png")}&w=320&q=75 320w, ` +
        `/_vercel/image?url=${encodeURIComponent("https://cdn.test/x.png")}&w=640&q=75 640w`,
    );
  });
});

describe("renderSite — opinion section (ADR-0016)", () => {
  const BODY_TAIL = "This final sentence is the tail that the excerpt must cut away entirely.";
  const LONG_BODY =
    "The first paragraph of the piece considers the news with the gravity it plainly does " +
    "not deserve, and it does so at considerable length so that the card excerpt has " +
    "something real to truncate against its fixed character budget.\n\n" +
    `A second paragraph follows after a blank line. ${BODY_TAIL}`;

  /** A publishable opinion piece (author-bearing, ADR-0015/0016 record shape). */
  function orec(over: Partial<ManifestRecord> & { id: string; author: string }): ManifestRecord {
    return rec({
      url: "",
      sourceName: "",
      category: "OPINION",
      headline: `Opinion Headline ${over.id}`,
      description: LONG_BODY,
      caption: `A wry caption for ${over.id}`,
      ...over,
    });
  }

  const news = orec({
    id: "opinion-alice-2026-07-10",
    author: "alice",
    firstSeen: "2026-07-10T09:00:00.000Z",
  });
  const letters = orec({
    id: "opinion-tom-2026-07-10",
    author: "tom",
    columnTitle: "Tom's Tech Corner",
    firstSeen: "2026-07-10T09:30:00.000Z",
  });

  const AUTHORS: Record<string, AuthorInfo> = {
    alice: {
      displayName: "Alice Brickland",
      bylineBlurb:
        "Alice is a bot struggling to make sense of a human world. She may be 1's and 0's, " +
        "but deep down inside she's just as confused as the rest of us.",
      source: "news",
      avatarUrl: "https://cdn.test/headshots/alice.webp",
    },
    tom: {
      displayName: "Tom Bricker",
      bylineBlurb: "Tom is a large language model who believes he owns a soldering iron.",
      source: "letters",
      columnTitle: "Tom's Tech Corner",
      avatarUrl: "https://cdn.test/headshots/tom.webp",
    },
  };

  const warnings: string[] = [];
  const OOPTS = { ...OPTS, authors: AUTHORS, log: (m: string) => warnings.push(m) };
  const files = renderSite([...records, news, letters], OOPTS);
  const newsPage = files["s/opinion-alice-2026-07-10.html"];
  const lettersPage = files["s/opinion-tom-2026-07-10.html"];

  it("DISCLOSURE GATE: opinion.html carries the banner verbatim; other pages do not", () => {
    expect(files["opinion.html"]).toContain(OPINION_BANNER);
    expect(files["index.html"]).not.toContain(OPINION_BANNER);
    expect(files["world.html"]).not.toContain(OPINION_BANNER);
  });

  it("DISCLOSURE GATE: opinion.html carries the static AI-satire meta description; other section pages carry none", () => {
    expect(files["opinion.html"]).toContain(
      `<meta name="description" content="${OPINION_META_DESCRIPTION}">`,
    );
    // Byte-parity guard: no other section page gained a meta description.
    expect(files["world.html"]).not.toContain('name="description"');
    expect(files["index.html"]).not.toContain('name="description"');
  });

  it("DISCLOSURE GATE: a news-persona piece footers the byline_blurb verbatim, without the letters line", () => {
    expect(newsPage).toContain(AUTHORS.alice.bylineBlurb);
    expect(newsPage).toContain("landing__blurb");
    expect(newsPage).not.toContain("Linda does not exist");
  });

  it("DISCLOSURE GATE: a letters piece footers the blurb AND the letters constant, plus its column title", () => {
    expect(lettersPage).toContain("landing__blurb");
    expect(lettersPage).toContain(LETTERS_DISCLOSURE);
    expect(lettersPage).toContain("Tom's Tech Corner");
    expect(newsPage).not.toContain(LETTERS_DISCLOSURE);
  });

  it("DISCLOSURE GATE: og/twitter descriptions on a piece page START with the bot prefix", () => {
    const prefix = `Unhinged rantings of a delusional bot named Alice Brickland — `;
    expect(newsPage).toContain(`<meta property="og:description" content="${prefix}`);
    expect(newsPage).toContain(`<meta name="twitter:description" content="${prefix}`);
    // …and the tail sentence was excerpted away, so truncation can only ever eat excerpt.
    expect(newsPage).not.toContain(`content="${BODY_TAIL}`);
  });

  it("EXCLUSION GATE: the homepage contains zero opinion content but does link the Opinion section", () => {
    const index = files["index.html"];
    expect(index).not.toContain("Opinion Headline");
    expect(index).not.toContain('href="s/opinion-');
    expect(index).not.toContain("byline-opinion");
    expect(index).toContain('href="opinion.html"'); // nav gained the section
    // No other section page carries the pieces either.
    expect(files["world.html"]).not.toContain("Opinion Headline");
  });

  it("opinion cards: avatar byline row, internal same-tab link, truncated dek, column title for letters", () => {
    const page = files["opinion.html"];
    expect(page).toContain(
      'class="byline-opinion__avatar" src="https://cdn.test/headshots/alice.webp" width="48" height="48"',
    );
    expect(page).toContain("Alice Brickland");
    expect(page).toContain('href="s/opinion-alice-2026-07-10.html"');
    // Internal link: the card anchor for the piece must NOT open a new tab. (Feed cards on
    // other pages still do; this page has only opinion cards.)
    const cardAnchor = page.match(/<a class="card" href="s\/opinion-alice[^>]*>/)?.[0] ?? "";
    expect(cardAnchor).not.toContain("target=");
    // The dek is the bounded excerpt: ellipsis present, tail sentence gone.
    expect(page).toContain("…</p>");
    expect(page).not.toContain(BODY_TAIL);
    // Letters card shows the column title; desk byline is replaced on opinion cards.
    expect(page).toContain("Tom's Tech Corner");
    expect(page).not.toContain("By the Opinion Desk");
  });

  it("byline rows pin the 48px avatar attributes on cards AND piece pages (ADR-0017/0019)", () => {
    // Presentational size attributes survive a stale stylesheet and reserve layout (no CLS);
    // the row's contract: the bio-page link wraps avatar then name (ADR-0019), inside one div.
    // Piece pages live under s/, so their bio link is ../-relative; section cards are root-relative.
    const row =
      '<div class="byline byline--lead byline-opinion"><a class="byline-opinion__link" ' +
      'href="../columnist/alice.html"><img class="byline-opinion__avatar" ' +
      'src="https://cdn.test/headshots/alice.webp" width="48" height="48"';
    expect(newsPage).toContain(row);
    expect(files["opinion.html"]).toContain(
      '<div class="byline byline-opinion"><a class="byline-opinion__link" ' +
        'href="columnist/alice.html"><img class="byline-opinion__avatar" ' +
        'src="https://cdn.test/headshots/alice.webp" width="48" height="48"',
    );
  });

  it("byline links: the card byline is a .story sibling of the card anchor, never nested (ADR-0019)", () => {
    const page = files["opinion.html"];
    // No anchor nesting: the card anchor's markup must not contain the bio link.
    const cardAnchor = page.match(/<a class="card" href="s\/opinion-alice[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(cardAnchor.length).toBeGreaterThan(0);
    expect(cardAnchor).not.toContain("byline-opinion__link");
    // The name inside the link closes back to the bio page on both surfaces.
    expect(page).toContain('href="columnist/tom.html"');
    expect(lettersPage).toContain('href="../columnist/tom.html"');
  });

  it("piece pages render the paragraphized body and the hero with caption credit", () => {
    expect(newsPage).toContain("<p>The first paragraph of the piece");
    expect(newsPage).toContain(`<p>A second paragraph follows after a blank line. ${BODY_TAIL}</p>`);
    expect(newsPage).not.toContain("Read the full story at the source"); // no outbound CTA
    expect(newsPage).toContain('src="https://cdn.test/opinion-alice-2026-07-10.png"');
    expect(newsPage).toContain("A wry caption for opinion-alice-2026-07-10");
    expect(newsPage).toContain("/ BRICKFEED STUDIO");
  });

  it("sitemap keeps the opinion section page and piece URLs (ADR-0016 d.4)", () => {
    expect(files["sitemap.xml"]).toContain(`${SITE_BASE_URL}/opinion.html`);
    expect(files["sitemap.xml"]).toContain(`${SITE_BASE_URL}/s/opinion-alice-2026-07-10.html`);
    expect(files["sitemap.xml"]).toContain(`${SITE_BASE_URL}/s/opinion-tom-2026-07-10.html`);
  });

  it("avatar fallback: a missing headshot entry renders without the avatar img and warns", () => {
    const warned: string[] = [];
    const noAvatar: Record<string, AuthorInfo> = {
      alice: { ...AUTHORS.alice, avatarUrl: undefined },
    };
    const out = renderSite([news], { ...OPTS, authors: noAvatar, log: (m) => warned.push(m) });
    const page = out["opinion.html"];
    expect(page).toContain("Alice Brickland"); // row still renders
    expect(page).not.toContain("byline-opinion__avatar");
    expect(warned.some((m) => m.includes("no headshot manifest entry"))).toBe(true);
  });

  it("persona fallback: an unknown author renders with the raw name, no blurb footer, and warns", () => {
    const warned: string[] = [];
    const out = renderSite([news], { ...OPTS, authors: {}, log: (m) => warned.push(m) });
    expect(out["opinion.html"]).toContain(">alice</span>"); // raw record.author as display name
    expect(out["s/opinion-alice-2026-07-10.html"]).not.toContain("landing__blurb");
    expect(warned.some((m) => m.includes("no loaded persona"))).toBe(true);
    // Unknown author → no bio page exists, so the byline row stays linkless (ADR-0019).
    expect(out["opinion.html"]).not.toContain("byline-opinion__link");
  });

  it("never contains the trademark, case-insensitive, in any opinion-render output file", () => {
    for (const file of Object.values(files)) {
      expect(file.toLowerCase()).not.toContain("lego");
    }
  });

  describe("columnist bio pages + cast strip (ADR-0019)", () => {
    it("renders a bio page per directory author with the 256px headshot and the blurb fallback", () => {
      const alice = files["columnist/alice.html"];
      const tom = files["columnist/tom.html"];
      expect(alice).toBeDefined();
      expect(tom).toBeDefined();
      // Full-size headshot: the stored 256×256 avatar with presentational size attributes.
      expect(alice).toContain(
        '<img class="colbio__headshot" src="https://cdn.test/headshots/alice.webp" width="256" height="256"',
      );
      expect(alice).toContain('<h1 class="colbio__name">Alice Brickland</h1>');
      // No `bio` front-matter in the fixture → the page falls back to the byline_blurb.
      expect(alice).toContain(`<p class="colbio__bio">${AUTHORS.alice.bylineBlurb}</p>`);
      // Letters personas show their column title; news personas don't.
      expect(tom).toContain(`<p class="colbio__column">Tom's Tech Corner</p>`);
      expect(alice).not.toContain("colbio__column");
    });

    it("renders explicit bio paragraphs instead of the blurb when the persona has one", () => {
      const withBio: Record<string, AuthorInfo> = {
        alice: { ...AUTHORS.alice, bio: ["First paragraph.", "Second: with a colon."] },
      };
      const out = renderSite([news], { ...OPTS, authors: withBio });
      const page = out["columnist/alice.html"];
      expect(page).toContain('<p class="colbio__bio">First paragraph.</p>');
      expect(page).toContain('<p class="colbio__bio">Second: with a colon.</p>');
      expect(page).not.toContain(`<p class="colbio__bio">${AUTHORS.alice.bylineBlurb}</p>`);
    });

    it("archives only that author's live OPINION pieces, linked ../-relative", () => {
      const alice = files["columnist/alice.html"];
      expect(alice).toContain('href="../s/opinion-alice-2026-07-10.html"');
      expect(alice).not.toContain("opinion-tom-2026-07-10");
      // Non-opinion records never enter an archive even if an author matched.
      expect(alice).not.toContain('href="../s/lead.html"');
      const tom = files["columnist/tom.html"];
      expect(tom).toContain('href="../s/opinion-tom-2026-07-10.html"');
      expect(tom).not.toContain("opinion-alice-2026-07-10");
    });

    it("an author with no live pieces still gets a page, with the empty-archive note", () => {
      const bench: Record<string, AuthorInfo> = {
        ...AUTHORS,
        bob: { displayName: "Bob Plasticsen", bylineBlurb: "Bob is also a bot.", source: "news" },
      };
      const out = renderSite([news], { ...OPTS, authors: bench, log: () => {} });
      const page = out["columnist/bob.html"];
      expect(page).toBeDefined();
      expect(page).toContain("No recent columns from Bob Plasticsen just yet.");
      expect(page).not.toContain('class="cards cards--section"');
    });

    it("bio pages carry profile og meta: disclosure-first description, avatar og:image, absolute og:url", () => {
      const alice = files["columnist/alice.html"];
      expect(alice).toContain('<meta property="og:type" content="profile">');
      expect(alice).toContain(
        '<meta property="og:description" content="Unhinged rantings of a delusional bot named Alice Brickland — ',
      );
      expect(alice).toContain(
        '<meta property="og:image" content="https://cdn.test/headshots/alice.webp">',
      );
      expect(alice).toContain(
        `<meta property="og:url" content="${SITE_BASE_URL}/columnist/alice.html">`,
      );
      // Piece landing pages keep the article type — the default didn't drift.
      expect(newsPage).toContain('<meta property="og:type" content="article">');
    });

    it("a missing headshot entry omits og:image on the bio page and warns", () => {
      const warned: string[] = [];
      const noAvatar: Record<string, AuthorInfo> = {
        alice: { ...AUTHORS.alice, avatarUrl: undefined },
      };
      const out = renderSite([news], { ...OPTS, authors: noAvatar, log: (m) => warned.push(m) });
      const page = out["columnist/alice.html"];
      expect(page).not.toContain("og:image");
      expect(page).not.toContain("colbio__headshot");
      expect(warned.some((m) => m.includes("bio page og:image omitted"))).toBe(true);
    });

    it("opinion.html carries the cast strip under the banner: one link per author, alphabetical", () => {
      const page = files["opinion.html"];
      const strip = page.match(/<div class="container cast-strip">[\s\S]*?<\/div>/)?.[0] ?? "";
      expect(strip).toContain('href="columnist/alice.html"');
      expect(strip).toContain('href="columnist/tom.html"');
      expect(strip.indexOf("alice")).toBeLessThan(strip.indexOf("tom"));
      expect(strip.match(/cast-strip__member/g)).toHaveLength(2);
      // Under the banner, above the grid.
      expect(page.indexOf("opinion-banner")).toBeLessThan(page.indexOf("cast-strip"));
      expect(page.indexOf("cast-strip")).toBeLessThan(page.indexOf("section-grid"));
    });

    it("a full eight-author directory yields eight strip links and eight bio pages", () => {
      const eight = ["alice", "bob", "cynthia", "edgar", "larry", "priscilla", "stryker", "tom"];
      const directory: Record<string, AuthorInfo> = Object.fromEntries(
        eight.map((n) => [
          n,
          {
            displayName: `${n[0].toUpperCase()}${n.slice(1)} Bot`,
            bylineBlurb: `${n} is a bot.`,
            source: "news" as const,
            avatarUrl: `https://cdn.test/headshots/${n}.webp`,
          },
        ]),
      );
      const out = renderSite([news], { ...OPTS, authors: directory, log: () => {} });
      expect(out["opinion.html"].match(/cast-strip__member/g)).toHaveLength(8);
      for (const n of eight) expect(out[`columnist/${n}.html`]).toBeDefined();
    });

    it("the cast strip and bio links appear ONLY on the opinion page — homepage and other sections unchanged", () => {
      expect(files["index.html"]).not.toContain("cast-strip");
      expect(files["world.html"]).not.toContain("cast-strip");
      expect(files["index.html"]).not.toContain("columnist/");
      expect(files["world.html"]).not.toContain("columnist/");
    });

    it("the sitemap gains one columnist URL per directory author", () => {
      expect(files["sitemap.xml"]).toContain(`<loc>${SITE_BASE_URL}/columnist/alice.html</loc>`);
      expect(files["sitemap.xml"]).toContain(`<loc>${SITE_BASE_URL}/columnist/tom.html</loc>`);
      // No authors → no columnist URLs (the no-opinion fixture renders none).
      const plain = renderSite(records, OPTS);
      expect(plain["sitemap.xml"]).not.toContain("columnist/");
    });
  });
});

describe("format helpers — excerpt + paragraphize (ADR-0016)", () => {
  it("excerpt passes short text through and cuts long text at a word boundary with …", () => {
    expect(excerpt("Short and sweet.", 50)).toBe("Short and sweet.");
    const out = excerpt("alpha beta gamma delta epsilon", 15);
    expect(out).toBe("alpha beta…");
    expect(out.length).toBeLessThanOrEqual(15);
    expect(excerpt("", 10)).toBe("");
    expect(excerpt("anything", 0)).toBe("");
  });

  it("excerpt collapses whitespace runs (newlines included) before measuring", () => {
    expect(excerpt("one\n\ntwo\n three", 100)).toBe("one two three");
  });

  it("paragraphize escapes HTML, splits on blank lines, and joins inner newlines", () => {
    expect(paragraphize("a <b> c\n\nsecond\npara")).toBe("<p>a &lt;b&gt; c</p><p>second para</p>");
    expect(paragraphize("  \n \n ")).toBe("");
  });
});
