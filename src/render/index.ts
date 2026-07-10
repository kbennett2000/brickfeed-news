/**
 * The pure render core (Slice 7): publishable records + a clock in, static site files out.
 * No filesystem, no wall clock of its own — the CLI (src/render-cli.ts) does the IO and
 * passes a real `now`; tests pass a fixed one. This keeps the render hermetic and lets the
 * whole page be asserted as strings.
 *
 * Input is `published.json` — a newest-first array of whole ManifestRecords (the seam
 * publish.ts writes). Output is a map of relative path → contents: `index.html` (the cover
 * page), one `<slug>.html` per section so the nav works without client JS, and `styles.css`.
 */
import { CATEGORIES, type Category, normalizeCategory } from "../category.js";
import type { ManifestRecord } from "../types.js";
import { bylineFor, relativeTime, formatMastheadDate, sectionSlug, titleCase } from "./format.js";
import { STYLES } from "./styles.js";
import {
  brickyardHead,
  card,
  emptyState,
  footer,
  leadStory,
  masthead,
  pageShell,
  railStory,
  sectionHead,
  sectionNav,
  utilityStrip,
  type StoryView,
} from "./templates.js";

/** Injected inputs for a render pass. */
export interface RenderOptions {
  /** "Now" — drives the masthead dateline and relative timestamps. */
  now: Date;
  /** How many secondary (rail) stories follow the single lead on the cover. */
  secondaryStoryCount: number;
}

/**
 * Reduce a persisted ManifestRecord to the display view a template consumes. Tolerant of
 * missing optional fields (degrade gracefully — a publishable record has them all, but the
 * render never crashes on a partial one): headline falls back to the raw title, category is
 * normalized to a valid enum value, text fields default to empty.
 */
export function toStoryView(record: ManifestRecord, now: Date): StoryView {
  const kicker = normalizeCategory(record.category);
  return {
    url: record.url ?? "",
    kicker,
    headline: record.headline ?? record.title ?? "",
    description: record.description ?? "",
    caption: record.caption ?? "",
    byline: bylineFor(kicker),
    ago: relativeTime(record.firstSeen ?? "", now),
    imageUrl: record.imageUrl,
  };
}

/** The cover page body: masthead + nav + hero (lead + rail) + overflow card grid + footer. */
function renderCover(views: StoryView[], dateStr: string, secondaryStoryCount: number): string {
  const chrome = utilityStrip(dateStr) + masthead() + sectionNav();

  if (views.length === 0) {
    const body =
      chrome +
      `<main>${emptyState("No stories have been bricked yet. Check back once the presses roll.")}</main>` +
      footer();
    return pageShell("brickfeed", body);
  }

  const [lead, ...rest] = views;
  const rail = rest.slice(0, secondaryStoryCount);
  const overflow = rest.slice(secondaryStoryCount);

  const hero = rail.length
    ? `<div class="container hero">${leadStory(lead)}<div class="rail">${rail
        .map(railStory)
        .join("")}</div></div>`
    : `<div class="container hero hero--solo">${leadStory(lead)}</div>`;

  const brickyard = overflow.length
    ? `<div class="container brickyard">${brickyardHead()}<div class="cards">${overflow
        .map(card)
        .join("")}</div></div>`
    : "";

  const body = chrome + `<main>${hero}${brickyard}</main>` + footer();
  return pageShell("brickfeed", body);
}

/** A single section page: masthead + nav (this section active) + filtered card grid + footer. */
function renderSection(category: Category, views: StoryView[], dateStr: string): string {
  const secViews = views.filter((v) => v.kicker === category);
  const chrome = utilityStrip(dateStr) + masthead() + sectionNav(category);

  const content = secViews.length
    ? sectionHead(category, secViews.length) +
      `<div class="container section-grid"><div class="cards cards--section">${secViews
        .map(card)
        .join("")}</div></div>`
    : sectionHead(category, 0) +
      emptyState(`No ${titleCase(category)} stories have been bricked yet.`);

  const body = chrome + `<main>${content}</main>` + footer();
  return pageShell(`${titleCase(category)} — brickfeed`, body);
}

/**
 * Render the whole static site. Returns relative-path → file-contents for the cover page,
 * every section page, and the stylesheet. Pure and total: empty input yields valid pages,
 * never a throw.
 */
export function renderSite(
  records: ManifestRecord[],
  opts: RenderOptions,
): Record<string, string> {
  const dateStr = formatMastheadDate(opts.now);
  const views = records.map((r) => toStoryView(r, opts.now));

  const files: Record<string, string> = {
    "index.html": renderCover(views, dateStr, opts.secondaryStoryCount),
    "styles.css": STYLES,
  };
  for (const category of CATEGORIES) {
    files[`${sectionSlug(category)}.html`] = renderSection(category, views, dateStr);
  }
  return files;
}
