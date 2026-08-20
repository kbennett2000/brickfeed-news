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
import {
  OPINION_SECTION_LIMIT,
  SECTION_SLOT_LIMIT,
  recentOpinionIds,
  sectionSlotIds,
} from "../eligibility.js";
import type { HeadshotManifest } from "../headshots.js";
import type { Persona } from "../personas.js";
import type { Comment, ManifestRecord } from "../types.js";
import {
  bylineFor,
  columnistPagePath,
  columnistPageUrl,
  escapeAttr,
  escapeHtml,
  excerpt,
  formatTimestamp,
  formatMastheadDate,
  editionLabel,
  hashString,
  paragraphize,
  sectionSlug,
  storyPageUrl,
  titleCase,
} from "./format.js";
import { renderMarkdown } from "./markdown.js";
import type { Config } from "../config.js";
import {
  blobHostname,
  renderRobotsTxt,
  renderSitemapXml,
  renderVercelJson,
} from "./site-config.js";
import { STYLES } from "./styles.js";
import {
  adBanner,
  type AnalyticsProvider,
  brickyardHead,
  card,
  castStrip,
  type CommentNode,
  emptyState,
  footer,
  type ImageOptimizeRender,
  leadStory,
  masthead,
  OPINION_BANNER,
  OPINION_META_DESCRIPTION,
  pageShell,
  railStory,
  renderAbout,
  renderColumnistPage,
  renderLandingPage,
  renderShareSheet,
  sectionHead,
  sectionNav,
  type ShareRow,
  type StoryRenderOpts,
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
  /**
   * Cookieless web-analytics beacon injected into public pages. Absent/"none" → no beacon (the
   * site stays JS-free and byte-identical). "vercel" → the Vercel Web Analytics snippet. The
   * operator-only share sheet is never tracked. Writers pass `config.render.analytics`.
   */
  analytics?: AnalyticsProvider;
  /**
   * Responsive image optimization (ADR-0012). Present only when `render.imageOptimization` is
   * enabled AND the Blob host resolves (the CLI computes it); absent → images render as plain
   * `<img src=blobUrl>` (byte-identical) and no `images` block is written to `vercel.json`.
   */
  imageOptimize?: ImageOptimizeOptions;
  /**
   * Opinion author directory (ADR-0016): persona name → display info, resolved by the writers
   * via buildAuthorDirectory (personas + data/headshots.json). Absent/missing entries degrade
   * gracefully — the byline row falls back to the record's raw author name, no avatar.
   */
  authors?: Record<string, AuthorInfo>;
  /**
   * Degradation warnings (missing persona / missing headshot entry). Default noop — the core
   * stays pure; the writers pass console.warn / the cycle log.
   */
  log?: (message: string) => void;
}

/** Display info for one opinion author, resolved from personas + the headshot manifest. */
export interface AuthorInfo {
  displayName: string;
  bylineBlurb: string;
  source: "news" | "letters";
  columnTitle?: string;
  avatarUrl?: string;
  /** Human-written bio paragraphs for the columnist page (ADR-0019); absent → bylineBlurb. */
  bio?: string[];
}

/**
 * Resolve the opinion author directory (ADR-0016): every loaded persona keyed by name,
 * with its avatar URL when `data/headshots.json` has an entry. Pure — the writers do the
 * two reads and pass the results in; a persona with no headshot entry simply has no
 * `avatarUrl` (the byline row degrades; toStoryView warns).
 */
export function buildAuthorDirectory(
  personas: Persona[],
  headshots: HeadshotManifest,
): Record<string, AuthorInfo> {
  const directory: Record<string, AuthorInfo> = {};
  for (const p of personas) {
    directory[p.name] = {
      displayName: p.displayName,
      bylineBlurb: p.bylineBlurb,
      source: p.source,
      ...(p.columnTitle !== undefined ? { columnTitle: p.columnTitle } : undefined),
      ...(p.bio !== undefined ? { bio: p.bio } : undefined),
      ...(headshots.headshots[p.name]?.avatarUrl
        ? { avatarUrl: headshots.headshots[p.name].avatarUrl }
        : undefined),
    };
  }
  return directory;
}

/** Image-optimization inputs threaded from config (ADR-0012): srcset widths/quality + Blob host. */
export interface ImageOptimizeOptions {
  widths: number[];
  quality: number;
  /** Hostname of the Blob origin the images are served from — allow-listed in vercel.json. */
  blobHost: string;
}

/** Optional X share settings threaded into the render (ADR-0009), mirroring the config shape. */
export interface ShareOptions {
  /** Site X handle WITHOUT a leading "@" (feeds via= and, as @handle, twitter:site). */
  handle?: string;
  /** Default hashtags, each WITHOUT a leading "#". */
  hashtags?: string[];
}

/** Card/meta excerpt budget for opinion pieces, whose `description` is the full body. */
export const OPINION_EXCERPT_MAX = 240;

/**
 * How many nesting levels of replies the comment thread displays (ADR-0028): level 0 = top-level,
 * 1 = reply, 2 = reply-to-reply. Deeper replies flatten onto the deepest displayed ancestor, so a
 * pathological reply chain can never blow up the page depth.
 */
export const COMMENT_DISPLAY_DEPTH = 3;

/**
 * Reduce the stored flat, append-only `comments[]` into the nested CommentNode tree the landing page
 * renders (ADR-0028). Threading is by `parentId`; top-level comments are ordered NEWEST-FIRST (append
 * order reversed) while replies stay chronological (append order). Display depth is capped
 * (COMMENT_DISPLAY_DEPTH) by attaching an over-deep reply to its nearest ancestor still within the
 * cap. Timestamps are formatted here in the render `timeZone` (like StoryView.timestamp). Pure.
 */
export function buildCommentTree(comments: Comment[], timeZone: string): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  const parentIdOf = new Map<string, string | null>();
  for (const c of comments) {
    nodes.set(c.id, {
      username: c.username,
      body: c.body,
      reactions: c.reactions,
      timestamp: formatTimestamp(c.createdAt, timeZone),
      replies: [],
    });
    parentIdOf.set(c.id, c.parentId);
  }

  const roots: CommentNode[] = [];
  const depthOf = new Map<string, number>();
  for (const c of comments) {
    const node = nodes.get(c.id)!;
    const parent = c.parentId != null ? nodes.get(c.parentId) : undefined;
    if (!parent || c.parentId == null) {
      roots.push(node);
      depthOf.set(c.id, 0);
      continue;
    }
    // Climb from the stated parent to the nearest ancestor whose child would stay within the cap.
    // Parents are always processed before their children (mint only references earlier comments),
    // so every ancestor's depth is already set.
    let targetId = c.parentId;
    while ((depthOf.get(targetId) ?? 0) + 1 > COMMENT_DISPLAY_DEPTH - 1) {
      const up = parentIdOf.get(targetId);
      if (up == null || !nodes.has(up)) break; // reached a root — attach here at the cap
      targetId = up;
    }
    const depth = Math.min((depthOf.get(targetId) ?? 0) + 1, COMMENT_DISPLAY_DEPTH - 1);
    nodes.get(targetId)!.replies.push(node);
    depthOf.set(c.id, depth);
  }

  roots.reverse(); // newest-first top-level
  return roots;
}

/**
 * Reduce a persisted ManifestRecord to the display view a template consumes. Tolerant of
 * missing optional fields (degrade gracefully — a publishable record has them all, but the
 * render never crashes on a partial one): headline falls back to the raw title, category is
 * normalized to a valid enum value, text fields default to empty.
 *
 * An `author`-bearing record is an opinion piece (ADR-0016): it links internally to its
 * own `s/<id>.html` page like a local article (`local: true`, body paragraphized from the
 * stored plain text), its card/meta description is a bounded excerpt of the full body, and
 * `view.opinion` carries the byline-row/disclosure info resolved from `authors`. Missing
 * directory data degrades — raw author name, no avatar, no blurb — with a warning to `log`.
 */
export function toStoryView(
  record: ManifestRecord,
  timeZone: string,
  authors?: Record<string, AuthorInfo>,
  log?: (message: string) => void,
): StoryView {
  const kicker = normalizeCategory(record.category);
  const view: StoryView = {
    url: record.url ?? "",
    kicker,
    headline: record.headline ?? record.title ?? "",
    description: record.description ?? "",
    caption: record.caption ?? "",
    byline: bylineFor(kicker),
    timestamp: formatTimestamp(record.firstSeen ?? "", timeZone),
    imageUrl: record.imageUrl,
  };
  if (record.author) {
    const info = authors?.[record.author];
    if (!info) {
      log?.(`render: opinion author "${record.author}" has no loaded persona — degrading byline`);
    } else if (!info.avatarUrl) {
      log?.(
        `render: opinion author "${record.author}" has no headshot manifest entry — ` +
          "rendering without avatar",
      );
    }
    view.url = `s/${record.id}.html`;
    view.local = true;
    view.bodyHtml = paragraphize(record.description ?? "");
    view.description = excerpt(record.description ?? "", OPINION_EXCERPT_MAX);
    view.opinion = {
      displayName: info?.displayName ?? record.author,
      bylineBlurb: info?.bylineBlurb ?? "",
      // The persisted record signal wins over directory lookup: a letters piece stays a
      // letters piece (column title + letters disclosure) even if the persona file moved.
      letters: !!record.columnTitle,
      ...(record.columnTitle !== undefined ? { columnTitle: record.columnTitle } : undefined),
      ...(info?.avatarUrl ? { avatarUrl: info.avatarUrl } : undefined),
      // The byline links to the bio page only for a resolved persona (ADR-0019): an
      // unknown author has no columnist page to point at, so the row stays linkless.
      ...(info ? { profilePath: columnistPagePath(record.author) } : undefined),
    };
    // Parody reader comments (ADR-0028): attach the nested tree so the landing page renders it.
    if (record.comments?.length) {
      view.comments = buildCommentTree(record.comments, timeZone);
    }
  }
  return view;
}

/**
 * Reduce a locally hosted Article to the same StoryView the templates consume (ADR-0010).
 * Unlike a feed story, its `url` is its own internal hosted page (`s/<id>.html`), it carries no
 * timestamp (`timestamp` is ""), its byline is the article's own, and it ships the rendered body HTML
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
    timestamp: "",
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
  sections: readonly Category[],
  banner: string,
  analytics: AnalyticsProvider,
  storyOpts: StoryRenderOpts,
): string {
  const chrome = utilityStrip(dateStr, edition) + masthead() + sectionNav(sections) + banner;

  if (views.length === 0) {
    const body =
      chrome +
      `<main>${emptyState("No stories have been bricked yet. Check back once the presses roll.")}</main>` +
      footer(sections);
    return pageShell("brickfeed", body, { analytics });
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
    ? `<div class="hero__fill">${heroFill.map((v) => card(v, storyOpts)).join("")}</div>`
    : "";
  const hero = rail.length
    ? `<div class="container hero"><div class="hero__main">${leadStory(lead, storyOpts)}${fillGrid}</div><div class="rail">${rail
        .map((v) => railStory(v, storyOpts))
        .join("")}</div></div>`
    : `<div class="container hero hero--solo">${leadStory(lead, storyOpts)}</div>`;

  const brickyard = overflow.length
    ? `<div class="container brickyard">${brickyardHead()}<div class="cards">${overflow
        .map((v) => card(v, storyOpts))
        .join("")}</div></div>`
    : "";

  const body = chrome + `<main>${hero}${brickyard}</main>` + footer(sections);
  return pageShell("brickfeed", body, { analytics });
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
  sections: readonly Category[],
  banner: string,
  analytics: AnalyticsProvider,
  storyOpts: StoryRenderOpts,
  cast = "",
): string {
  const chrome = utilityStrip(dateStr, edition) + masthead() + sectionNav(sections, category) + banner;

  // The Opinion page carries its verbatim disclosure banner (ADR-0016 d.6) right under the
  // section masthead, and — uniquely among section pages — a static meta description naming
  // the page as AI satire. Both fire ONLY for OPINION so every other page stays byte-identical.
  const opinionBanner =
    category === "OPINION"
      ? `<div class="container opinion-banner"><p class="opinion-banner__text">${escapeHtml(OPINION_BANNER)}</p></div>`
      : "";
  const headExtra =
    category === "OPINION"
      ? `<meta name="description" content="${escapeAttr(OPINION_META_DESCRIPTION)}">`
      : undefined;

  // The cast strip (ADR-0019) sits under the disclosure banner, above the card grid.
  // The caller passes it only for OPINION, so every other page stays byte-identical.
  const opinionCast = category === "OPINION" ? cast : "";

  // Defensive only: renderSite never calls this with an empty section (ADR-0013 omits those
  // pages entirely), but the module stays total if a future caller does.
  const content = secViews.length
    ? sectionHead(category, secViews.length) +
      opinionBanner +
      opinionCast +
      `<div class="container section-grid"><div class="cards cards--section">${secViews
        .map((v) => card(v, storyOpts))
        .join("")}</div></div>`
    : sectionHead(category, 0) +
      opinionBanner +
      opinionCast +
      emptyState(`No ${titleCase(category)} stories have been bricked yet.`);

  const body = chrome + `<main>${content}</main>` + footer(sections);
  return pageShell(`${titleCase(category)} — brickfeed`, body, { analytics, headExtra });
}

/**
 * Section pages a previous render may have left in the output dir but this render did not
 * emit (their sections are empty now — ADR-0013). site/ is written incrementally, never
 * wiped, so writers must delete these or the deploy keeps serving a page nothing links to.
 * Pure: derived from the rendered file map only.
 */
export function staleSectionPages(files: Record<string, string>): string[] {
  return CATEGORIES.map((c) => `${sectionSlug(c)}.html`).filter((page) => !(page in files));
}

/**
 * Columnist pages in the output dir this render did not emit — their personas were
 * retired (ADR-0019). Unlike sections, the roster is open-ended, so the file map alone
 * can't see a removal: writers LIST the columnist/ subdir (missing dir → []) and pass the
 * entries here; the decision stays pure. Returns `columnist/<file>` paths to delete.
 */
export function staleColumnistPages(
  existing: string[],
  files: Record<string, string>,
): string[] {
  return existing
    .filter((f) => f.endsWith(".html"))
    .map((f) => `columnist/${f}`)
    .filter((page) => !(page in files));
}

/**
 * Per-story landing pages (`s/<id>.html`) in the output dir this render did not emit — their
 * record was removed from published.json (age-out, or a manual takedown of a bad piece). Like
 * columnist pages, the file map alone can't see a removal, so writers LIST the s/ subdir
 * (missing dir → []) and pass the entries here. Without this, `site/` — written incrementally,
 * never wiped — keeps serving the orphaned landing page even after the story is gone. Returns
 * `s/<file>` paths to delete.
 */
export function stalePerStoryPages(
  existing: string[],
  files: Record<string, string>,
): string[] {
  return existing
    .filter((f) => f.endsWith(".html"))
    .map((f) => `s/${f}`)
    .filter((page) => !(page in files));
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
  const views = records.map((r) => toStoryView(r, tz, opts.authors, opts.log));
  // Attach each story's absolute landing URL so the per-story share buttons (ADR-0012) can be
  // drawn wherever the view is rendered (cover, section, landing). Same value the share sheet uses.
  records.forEach((r, i) => {
    views[i].shareUrl = storyPageUrl(opts.siteBaseUrl, r.id);
  });

  const ads = opts.ads ?? [];
  const banner = adBanner(ads);

  const share = opts.share ?? {};
  const twitterSite = share.handle ? `@${share.handle}` : undefined;
  const analytics = opts.analytics ?? "none";

  // Responsive image optimization (ADR-0012): the srcset inputs the story templates need. Present
  // only when the CLI resolved a Blob host + enabled flag; absent → plain <img src> (byte-identical).
  const imageOptimizeRender: ImageOptimizeRender | undefined = opts.imageOptimize
    ? { widths: opts.imageOptimize.widths, quality: opts.imageOptimize.quality }
    : undefined;
  const storyOpts: StoryRenderOpts = { imageOptimize: imageOptimizeRender, share };

  // Locally hosted articles (ADR-0010): drop expired ones, then build a StoryView per live
  // article once (shared across the cover, its section page, and its own landing page). The
  // rank-0 placement seed shifts each edition so unranked articles wander across cycles.
  const liveArticles = (opts.articles ?? []).filter((a) => !isExpired(a, opts.now));
  const articleViews = liveArticles.map((article) => {
    const view = articleToStoryView(article);
    view.shareUrl = storyPageUrl(opts.siteBaseUrl, article.id);
    return { article, view };
  });
  const seed = `${dateStr}|${edition}`;

  // Sections with at least one published item this build — feed records plus live (non-expired)
  // local articles — in canonical CATEGORIES order. Only these render, get linked from the
  // nav/footer, or appear in the sitemap; empty sections vanish site-wide (ADR-0013).
  const presentSet = new Set<Category>([
    ...views.map((v) => v.kicker),
    ...liveArticles.map((a) => a.category),
  ]);
  const presentSections: Category[] = CATEGORIES.filter((c) => presentSet.has(c));

  // Slot-based display bound (ADR-0020): a story is LISTED on the cover / section pages only when
  // it's within the top-SECTION_SLOT_LIMIT of its section (newest-first) — the SAME constant that
  // caps the image budget, so display and imaging can never drift. OPINION is never capped. This
  // filters LISTINGS only; landing pages, the sitemap, and columnist archives keep the full
  // `records` (direct access, not a browsable slot). With a generous K it's tail-only — nothing
  // above the fold changes. `records`/`views` are index-aligned, so filter by the record's id.
  const listed = sectionSlotIds(records, SECTION_SLOT_LIMIT);

  // Opinion SECTION feed bound (ADR-0025): opinion pieces are retained ~90 days so columnist
  // bio pages accumulate a real archive, but the `opinion.html` section must not list that whole
  // backlog — cap it to the most-recent OPINION_SECTION_LIMIT. Columnist pages (built from the
  // unfiltered `views` below) are deliberately NOT bounded and keep the full retained history.
  const recentOpinions = recentOpinionIds(records, OPINION_SECTION_LIMIT);

  // Homepage exclusion (ADR-0016 d.4): opinion pieces render ONLY in the Opinion section —
  // never on the cover. The kicker check is belt-and-braces for a hypothetical authorless
  // OPINION record. Landing pages + sitemap use the unfiltered `views`/`records`.
  const coverBase = views.filter(
    (v, i) => !v.opinion && v.kicker !== "OPINION" && listed.has(records[i].id),
  );
  const coverViews = insertRanked(
    coverBase,
    articleViews.map(({ article, view }) => ({ id: article.id, rank: article.mainRank, view })),
    seed,
  );

  const files: Record<string, string> = {
    "index.html": renderCover(coverViews, dateStr, edition, opts.secondaryStoryCount, presentSections, banner, analytics, storyOpts),
    "about.html": renderAbout(dateStr, edition, banner, presentSections, analytics),
    "styles.css": STYLES,
  };
  const cast = castStrip(opts.authors ?? {});
  for (const category of presentSections) {
    // Same slot bound as the cover (ADR-0020): list only the section's top-K. OPINION is in
    // `listed` unconditionally (its image budget parity), so it's additionally bounded here to
    // the most-recent OPINION_SECTION_LIMIT (ADR-0025) — the columnist archive pages stay full.
    const base = views.filter(
      (v, i) =>
        v.kicker === category &&
        listed.has(records[i].id) &&
        // OPINION lists ONLY authored columns. A real news story the generator mis-tagged
        // `category: OPINION` (authorless → "BY THE OPINION DESK") must NEVER surface on the
        // opinion page: it bypasses the taste gate and can carry real names/tragedies. The cover
        // already guards this (`v.kicker !== "OPINION"` above); the section page must too.
        (category !== "OPINION" || (!!records[i].author && recentOpinions.has(records[i].id))),
    );
    const sectionArticles = articleViews
      .filter(({ article }) => article.category === category)
      .map(({ article, view }) => ({ id: article.id, rank: article.subRank, view }));
    const secViews = insertRanked(base, sectionArticles, seed);
    files[`${sectionSlug(category)}.html`] = renderSection(
      category,
      secViews,
      dateStr,
      edition,
      presentSections,
      banner,
      analytics,
      storyOpts,
      cast,
    );
  }

  // Columnist bio pages (ADR-0019): one per loaded persona, ALWAYS rendered — static
  // content with no retention; an empty archive shows a note, never hides the page. The
  // archive is the persona's currently-live pieces (`records`/`views` are index-aligned),
  // its cards rendered with a "../" prefix since the page lives in the columnist/ subdir.
  const authorNames = Object.keys(opts.authors ?? {}).sort();
  const bioCardOpts: StoryRenderOpts = { ...storyOpts, pathPrefix: "../" };
  for (const name of authorNames) {
    const info = (opts.authors ?? {})[name];
    if (!info.avatarUrl) {
      opts.log?.(
        `render: columnist "${name}" has no headshot manifest entry — bio page og:image omitted`,
      );
    }
    const archiveCards = views
      .filter((v, i) => records[i].author === name && v.kicker === "OPINION")
      .map((v) => card(v, bioCardOpts))
      .join("");
    files[columnistPagePath(name)] = renderColumnistPage({
      displayName: info.displayName,
      bylineBlurb: info.bylineBlurb,
      ...(info.columnTitle !== undefined ? { columnTitle: info.columnTitle } : undefined),
      ...(info.avatarUrl ? { avatarUrl: info.avatarUrl } : undefined),
      ...(info.bio !== undefined ? { bio: info.bio } : undefined),
      archiveCards,
      pageUrl: columnistPageUrl(opts.siteBaseUrl, name),
      twitterSite,
      analytics,
    });
  }

  // Per-story landing pages (ADR-0009): one social-card-bearing page per record at
  // s/<id>.html, plus the assisted-manual share sheet. `records` and `views` are aligned by
  // index; the landing/share URL is this record's own absolute URL.
  const landingOpts = { twitterSite, analytics, imageOptimize: imageOptimizeRender, share };
  const shareRows: ShareRow[] = [];
  records.forEach((record, i) => {
    const view = views[i];
    const pageUrl = storyPageUrl(opts.siteBaseUrl, record.id);
    files[`s/${record.id}.html`] = renderLandingPage(view, { pageUrl, ...landingOpts });
    shareRows.push({ view, pageUrl });
  });
  // Local articles get the same s/<id>.html page — but it IS the article (body rendered inline),
  // and it's shareable too, so it joins the share sheet.
  for (const { article, view } of articleViews) {
    const pageUrl = storyPageUrl(opts.siteBaseUrl, article.id);
    files[`s/${article.id}.html`] = renderLandingPage(view, { pageUrl, ...landingOpts });
    shareRows.push({ view, pageUrl });
  }
  files["share.html"] = renderShareSheet(shareRows, share);

  // Deploy-root artifacts (ADR-0012). site/ is git-ignored + rebuilt every render, then deployed
  // as-is, so these must be produced here alongside the HTML — not committed. robots + sitemap
  // are always useful; vercel.json always carries security + cache headers, and gains an `images`
  // block only when optimization is on.
  const sitemapPaths = [
    "",
    "about.html",
    ...presentSections.map((c) => `${sectionSlug(c)}.html`),
    ...authorNames.map((name) => columnistPagePath(name)),
    ...records.map((r) => `s/${r.id}.html`),
    ...articleViews.map(({ article }) => `s/${article.id}.html`),
  ];
  files["robots.txt"] = renderRobotsTxt(opts.siteBaseUrl);
  files["sitemap.xml"] = renderSitemapXml(opts.siteBaseUrl, sitemapPaths);
  files["vercel.json"] = renderVercelJson({
    imageOptimize: opts.imageOptimize
      ? {
          widths: opts.imageOptimize.widths,
          quality: opts.imageOptimize.quality,
          blobHost: opts.imageOptimize.blobHost,
        }
      : undefined,
  });

  return files;
}

/**
 * Resolve the render's `imageOptimize` option from config (ADR-0012). Returns undefined — meaning
 * "render plain <img>, write no images block" — when optimization is disabled OR when the Blob
 * `publicBaseUrl` isn't an absolute origin (e.g. a `local` provider serving from a relative path),
 * since Vercel's `/_vercel/image` needs a real remote host to allow-list. The CLIs call this and
 * pass the result to renderSite, so both the cycle and the standalone render behave identically.
 */
export function imageOptimizeOptionFromConfig(config: Config): ImageOptimizeOptions | undefined {
  const io = config.render.imageOptimization;
  if (!io.enabled) return undefined;
  const blobHost = blobHostname(config.storage.blob.publicBaseUrl);
  if (!blobHost) return undefined;
  return { widths: io.widths, quality: io.quality, blobHost };
}
