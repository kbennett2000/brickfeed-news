import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../src/category.js";
import { renderSite } from "../src/render/index.js";
import {
  bylineFor,
  editionForHour,
  editionLabel,
  formatMastheadDate,
  relativeTime,
  sectionSlug,
} from "../src/render/format.js";
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
const OPTS = { now: NOW, secondaryStoryCount: 3 };

describe("renderSite — cover page", () => {
  const files = renderSite(records, OPTS);
  const index = files["index.html"];

  it("emits index.html, styles.css, and one page per section", () => {
    expect(files["index.html"]).toBeTruthy();
    expect(files["styles.css"]).toBeTruthy();
    for (const c of CATEGORIES) {
      expect(files[`${sectionSlug(c)}.html`]).toBeTruthy();
    }
  });

  it("renders the lead (newest) headline", () => {
    expect(index).toContain("Summit Ends With a Handshake and a Communique");
  });

  it("renders the section nav from the CATEGORIES enum (not a hardcoded list)", () => {
    for (const c of CATEGORIES) {
      // Title-cased nav label + slugged href for every enum member.
      const label = c.charAt(0) + c.slice(1).toLowerCase();
      expect(index).toContain(`>${label}</a>`);
      expect(index).toContain(`href="${sectionSlug(c)}.html"`);
    }
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

  it("a section with no stories renders a valid empty state, not a crash", () => {
    const sport = files["sport.html"];
    expect(sport).toContain("All the stories, brick by brick"); // chrome still present
    expect(sport).toContain("Nothing to brick, just now.");
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
      'src="https://7fjkp0rhcwadfro9.public.blob.vercel-storage.com/images/about-portrait.jpg"',
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
    // Nav still renders from the enum even with no stories.
    for (const c of CATEGORIES) {
      expect(index).toContain(`href="${sectionSlug(c)}.html"`);
    }
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

  it("produces deadpan relative-time labels", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(relativeTime("2026-07-10T11:26:00.000Z", now)).toBe("34 min ago");
    expect(relativeTime("2026-07-10T10:00:00.000Z", now)).toBe("2 hr ago");
    expect(relativeTime("2026-07-07T12:00:00.000Z", now)).toBe("3 days ago");
    expect(relativeTime("2026-07-10T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("not-a-date", now)).toBe("just now");
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
};
const AD_B = {
  imageUrl: "https://cdn.test/ads/ad-02.jpg",
  href: 'https://example.com/two?q="x"', // quote must be escaped in the href attribute
  alt: "Advertisement — example.com",
};

describe("renderSite — banner ads", () => {
  it("omits the banner entirely when there are no ads", () => {
    const files = renderSite(records, OPTS);
    expect(files["index.html"]).not.toContain("adbanner");
    expect(files[`${sectionSlug("WORLD")}.html`]).not.toContain("adbanner");
    expect(files["styles.css"]).not.toContain("@keyframes adbannerfade");
  });

  it("also omits the banner when ads is an empty array", () => {
    const files = renderSite(records, { ...OPTS, ads: [] });
    expect(files["index.html"]).not.toContain("adbanner");
  });

  describe("with two ads", () => {
    const files = renderSite(records, { ...OPTS, ads: [AD_A, AD_B] });
    const index = files["index.html"];

    it("renders the banner site-wide (cover + every section)", () => {
      expect(index).toContain('class="adbanner"');
      for (const c of CATEGORIES) {
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

    it("emits the generated crossfade keyframes into styles.css for >1 ad", () => {
      const css = files["styles.css"];
      expect(css).toContain("@keyframes adbannerfade");
      expect(css).toContain(".adbanner__slide:nth-child(2)");
      expect(css).toContain("prefers-reduced-motion");
    });
  });

  it("renders a single ad statically — no crossfade keyframes", () => {
    const files = renderSite(records, { ...OPTS, ads: [AD_A] });
    expect(files["index.html"]).toContain('class="adbanner"');
    expect(files["styles.css"]).not.toContain("@keyframes adbannerfade");
  });
});
