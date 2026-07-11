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
import type { AdView } from "../ads.js";
import type { Article } from "../articles.js";
import { CATEGORIES, type Category, normalizeCategory } from "../category.js";
import type { ManifestRecord } from "../types.js";
import {
  bylineFor,
  relativeTime,
  formatMastheadDate,
  editionLabel,
  hashString,
  sectionSlug,
  storyPageUrl,
  titleCase,
} from "./format.js";
import { renderMarkdown } from "./markdown.js";
import { adAnimationCss, STYLES } from "./styles.js";
import {
  adBanner,
  brickyardHead,
  card,
  emptyState,
  footer,
  leadStory,
  masthead,
  pageShell,
  railStory,
  renderAbout,
  renderLandingPage,
  renderShareSheet,
  sectionHead,
  sectionNav,
  type ShareRow,
  utilityStrip,
  type StoryView,
} from "./templates.js";

/**
 * How many overflow cards to lift into the lead's column (beside the rail) on the cover, so the
 * left column fills the space under the lead instead of leaving a large desktop gap. Anything
 * past the lead + rail + this many still flows into the full-width "Across the Brickyard" grid.
 */
const HERO_FILL_COUNT = 4;

/** Injected inputs for a render pass. */
export interface RenderOptions {
  /** "Now" — drives the masthead dateline, edition label, and relative timestamps. */
  now: Date;
  /** How many secondary (rail) stories follow the single lead on the cover. */
  secondaryStoryCount: number;
  /**
   * IANA time zone the dateline + edition label are computed in (default "UTC"). The CLI/cycle
   * pass `render.timeZone` so the edition matches the server's local wall-clock.
   */
  timeZone?: string;
  /**
   * Banner ads to draw below the nav on every page. Absent/empty → no banner is rendered.
   * The writers (cycle.ts / render-cli.ts) supply this via loadAds(); tests inject it directly.
   */
  ads?: AdView[];
  /**
   * Locally hosted articles (ADR-0010) to merge into the story lists. Each is placed on the
   * cover by its Main Page Rank and on its section page by its SubPage Rank; expired ones are
   * dropped here (against `now`). Absent/empty → the site renders exactly as before.
   */
  articles?: Article[];
  /**
   * Absolute site origin (no trailing slash) used to build each landing page's own absolute
   * og:url and the absolute story URLs the X share links point at (ADR-0009).
   */
  siteBaseUrl: string;
  /** X (Twitter) share settings for the share sheet + twitter:site meta. Both fields optional. */
  share?: ShareOptions;
}

/** Optional X share settings threaded into the render (ADR-0009), mirroring the config shape. */
export interface ShareOptions {
  /** Site X handle WITHOUT a leading "@" (feeds via= and, as @handle, twitter:site). */
  handle?: string;
  /** Default hashtags, each WITHOUT a leading "#". */
  hashtags?: string[];
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

/**
 * Reduce a locally hosted Article to the same StoryView the templates consume (ADR-0010).
 * Unlike a feed story, its `url` is its own internal hosted page (`s/<id>.html`), it carries no
 * timestamp (`ago` is ""), its byline is the article's own, and it ships the rendered body HTML
 * for the landing page. `local: true` flips links to same-tab/internal and swaps the landing
 * page's outbound CTA for the body.
 */
export function articleToStoryView(article: Article): StoryView {
  return {
    url: `s/${article.id}.html`,
    kicker: article.category,
    headline: article.headline,
    description: article.description,
    caption: "",
    byline: article.byline,
    ago: "",
    imageUrl: article.imageUrl,
    local: true,
    bodyHtml: renderMarkdown(article.bodyMarkdown),
  };
}

/** True when an article has a valid expiry and `now` is past it (end of the expiry day). */
function isExpired(article: Article, now: Date): boolean {
  return article.expires !== undefined && now.getTime() > article.expires.getTime();
}

/** A local article paired with the StoryView + the rank relevant to the page being built. */
interface RankedArticle {
  id: string;
  rank: number;
  view: StoryView;
}

/**
 * Merge local articles into an ordered list of feed views (ADR-0010). Ranked articles (rank ≥ 1)
 * land at their exact 1-based slot — rank 1 first, a rank past the list length last — inserted
 * AFTER the unranked ones so those positions hold on the final list. Unranked articles (rank 0,
 * "position doesn't matter") go to a pseudo-random slot derived from their id + `seed`, so the
 * placement varies across cycles but is deterministic for a pinned clock. Pure; returns a fresh
 * array.
 */
function insertRanked(base: StoryView[], articles: RankedArticle[], seed: string): StoryView[] {
  const result = [...base];
  const unranked = articles.filter((a) => a.rank <= 0);
  const ranked = articles.filter((a) => a.rank >= 1).sort((a, b) => a.rank - b.rank);

  for (const a of unranked) {
    const idx = hashString(`${a.id}|${seed}`) % (result.length + 1);
    result.splice(idx, 0, a.view);
  }
  for (const a of ranked) {
    const idx = Math.min(a.rank - 1, result.length);
    result.splice(idx, 0, a.view);
  }
  return result;
}

/** The cover page body: masthead + nav + banner + hero (lead + rail) + overflow card grid + footer. */
function renderCover(
  views: StoryView[],
  dateStr: string,
  edition: string,
  secondaryStoryCount: number,
  banner: string,
): string {
  const chrome = utilityStrip(dateStr, edition) + masthead() + sectionNav() + banner;

  if (views.length === 0) {
    const body =
      chrome +
      `<main>${emptyState("No stories have been bricked yet. Check back once the presses roll.")}</main>` +
      footer();
    return pageShell("brickfeed", body);
  }

  const [lead, ...rest] = views;
  const rail = rest.slice(0, secondaryStoryCount);
  const afterRail = rest.slice(secondaryStoryCount);
  // Pull a few overflow cards up into the lead's column so they fill the empty space beside the
  // taller rail on desktop (no cavernous gap under the lead). The rest flow to the full-width
  // "Across the Brickyard" grid below. HERO_FILL_COUNT is tuned to roughly balance the ~4-story rail.
  const heroFill = afterRail.slice(0, HERO_FILL_COUNT);
  const overflow = afterRail.slice(HERO_FILL_COUNT);

  const fillGrid = heroFill.length
    ? `<div class="hero__fill">${heroFill.map(card).join("")}</div>`
    : "";
  const hero = rail.length
    ? `<div class="container hero"><div class="hero__main">${leadStory(lead)}${fillGrid}</div><div class="rail">${rail
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

/**
 * A single section page: masthead + nav (this section active) + banner + card grid + footer.
 * `secViews` is the already-filtered, article-merged list of stories for this section (built by
 * the caller so local articles land at their SubPage Rank).
 */
function renderSection(
  category: Category,
  secViews: StoryView[],
  dateStr: string,
  edition: string,
  banner: string,
): string {
  const chrome = utilityStrip(dateStr, edition) + masthead() + sectionNav(category) + banner;

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
  const tz = opts.timeZone ?? "UTC";
  const dateStr = formatMastheadDate(opts.now, tz);
  const edition = editionLabel(opts.now, tz);
  const views = records.map((r) => toStoryView(r, opts.now));

  const ads = opts.ads ?? [];
  const banner = adBanner(ads);

  const share = opts.share ?? {};
  const twitterSite = share.handle ? `@${share.handle}` : undefined;

  // Locally hosted articles (ADR-0010): drop expired ones, then build a StoryView per live
  // article once (shared across the cover, its section page, and its own landing page). The
  // rank-0 placement seed shifts each edition so unranked articles wander across cycles.
  const liveArticles = (opts.articles ?? []).filter((a) => !isExpired(a, opts.now));
  const articleViews = liveArticles.map((article) => ({ article, view: articleToStoryView(article) }));
  const seed = `${dateStr}|${edition}`;

  const coverViews = insertRanked(
    views,
    articleViews.map(({ article, view }) => ({ id: article.id, rank: article.mainRank, view })),
    seed,
  );

  const files: Record<string, string> = {
    "index.html": renderCover(coverViews, dateStr, edition, opts.secondaryStoryCount, banner),
    "about.html": renderAbout(dateStr, edition, banner),
    "styles.css": STYLES + adAnimationCss(ads.length),
  };
  for (const category of CATEGORIES) {
    const base = views.filter((v) => v.kicker === category);
    const sectionArticles = articleViews
      .filter(({ article }) => article.category === category)
      .map(({ article, view }) => ({ id: article.id, rank: article.subRank, view }));
    const secViews = insertRanked(base, sectionArticles, seed);
    files[`${sectionSlug(category)}.html`] = renderSection(
      category,
      secViews,
      dateStr,
      edition,
      banner,
    );
  }

  // Per-story landing pages (ADR-0009): one social-card-bearing page per record at
  // s/<id>.html, plus the assisted-manual share sheet. `records` and `views` are aligned by
  // index; the landing/share URL is this record's own absolute URL.
  const shareRows: ShareRow[] = [];
  records.forEach((record, i) => {
    const view = views[i];
    const pageUrl = storyPageUrl(opts.siteBaseUrl, record.id);
    files[`s/${record.id}.html`] = renderLandingPage(view, { pageUrl, twitterSite });
    shareRows.push({ view, pageUrl });
  });
  // Local articles get the same s/<id>.html page — but it IS the article (body rendered inline),
  // and it's shareable too, so it joins the share sheet.
  for (const { article, view } of articleViews) {
    const pageUrl = storyPageUrl(opts.siteBaseUrl, article.id);
    files[`s/${article.id}.html`] = renderLandingPage(view, { pageUrl, twitterSite });
    shareRows.push({ view, pageUrl });
  }
  files["share.html"] = renderShareSheet(shareRows, share);

  return files;
}
