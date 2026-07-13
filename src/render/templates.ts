/**
 * HTML partials for the static render (Slice 7), as plain template literals — no framework
 * and no templating dependency (the codebase is deliberately minimal-deps; the design
 * prototype's DSL/React runtime is reference-only). Every record-derived string is escaped
 * via format.ts before interpolation.
 *
 * Section nav + footer sections are built by mapping over CATEGORIES from src/category.ts —
 * the single source of truth — never a re-listed local copy. The wordmark is always
 * "brickfeed"; no trademarked brand name appears anywhere.
 */
import type { AdView } from "../ads.js";
import { CATEGORIES, type Category } from "../category.js";
import {
  buildLinkedInIntentUrl,
  buildXIntentUrl,
  escapeAttr,
  escapeHtml,
  hashString,
  optimizedSrcset,
  optimizedUrl,
  sectionSlug,
  titleCase,
} from "./format.js";
import { AD_ROTATOR_JS } from "./rotator.js";
import { STYLES } from "./styles.js";

/**
 * Cache-buster for the stylesheet link (ADR-0017): a content hash, so a CSS change
 * propagates on the next HTML revalidation instead of waiting out the 24h asset cache,
 * while hourly renders of an unchanged sheet keep the same URL.
 */
const CSS_VERSION = hashString(STYLES).toString(36);

/**
 * Responsive image optimization settings threaded into the story templates (ADR-0012). Present
 * only when `render.imageOptimization.enabled`; absent → images render as today's plain
 * `<img src=blobUrl>` (byte-identical). `widths` seed the srcset; `quality` the `q=` param.
 */
export interface ImageOptimizeRender {
  widths: number[];
  quality: number;
}

/**
 * Options threaded into the per-story templates (figure/lead/rail/card). `imageOptimize` enables
 * the responsive srcset (ADR-0012); `share` drives the per-story X/LinkedIn share row (ADR-0012),
 * reusing the same intent builders as the operator Share page.
 */
export interface StoryRenderOpts {
  imageOptimize?: ImageOptimizeRender;
  share?: { handle?: string; hashtags?: string[] };
}

/** The view model a template consumes — a ManifestRecord already reduced to display fields. */
export interface StoryView {
  /**
   * The story's link target. For a feed story this is the outbound source URL (opens in a new
   * tab); for a local article (`local: true`) it is the internal `s/<id>.html` page (same tab).
   */
  url: string;
  /** Section kicker, e.g. WORLD (already uppercase). */
  kicker: Category;
  headline: string;
  description: string;
  /** Neutral caption; the "/ BRICKFEED STUDIO" credit is appended by the figure template. */
  caption: string;
  /** Decorative byline, e.g. "By the World Desk". */
  byline: string;
  /** Relative time label, e.g. "2 hr ago". Empty for local articles (no timestamp). */
  ago: string;
  /** Durable image URL; absent → the brick placeholder frame is rendered instead. */
  imageUrl?: string;
  /**
   * True for a locally hosted article (ADR-0010): links are internal/same-tab, and the landing
   * page renders `bodyHtml` instead of an outbound "read at source" CTA.
   */
  local?: boolean;
  /** Rendered HTML of the article body (local articles only); shown on the landing page. */
  bodyHtml?: string;
  /**
   * Absolute landing-page URL (`https://…/s/<id>.html`) the per-story X/LinkedIn share buttons
   * point at (ADR-0012). Set by renderSite for every publishable record/article; absent → no
   * share row is drawn.
   */
  shareUrl?: string;
  /**
   * Opinion-piece display info (ADR-0016), set by toStoryView for `author`-bearing records.
   * Presence swaps the desk byline for the avatar byline row, adds the disclosure footers on
   * the piece page, and prefixes the share meta. `bylineBlurb` is "" when the persona file is
   * missing (the blurb footer is then omitted); `avatarUrl` is absent when the headshot
   * manifest has no entry (the row renders without an avatar) — both warned upstream.
   */
  opinion?: {
    displayName: string;
    bylineBlurb: string;
    /** True for a reader-letter column: adds the column title + the letters disclosure. */
    letters: boolean;
    columnTitle?: string;
    avatarUrl?: string;
  };
}

/**
 * The Opinion page disclosure banner (ADR-0013 d.6, ADR-0016 d.6): hand-written,
 * versioned, never model-generated. Changing this wording is an ADR-level decision.
 */
export const OPINION_BANNER =
  "The opinions expressed on this page are nothing more than the collective hallucinations " +
  "of a delusional AI trying to read human news.";

/**
 * The letters-column disclosure line (ADR-0014 d.6) — the ONE versioned definition;
 * rendered under every reader-letter piece in addition to the author's byline_blurb.
 */
export const LETTERS_DISCLOSURE =
  "Reader letters are as fictional as the columnists. Linda does not exist. No one is " +
  "writing to Tom.";

/** The static meta description on opinion.html (ADR-0016 d.6): the page is AI satire. */
export const OPINION_META_DESCRIPTION =
  "The brickfeed Opinion section: AI-generated satire. Every columnist is a fictional AI " +
  "persona; every opinion is a machine hallucination, not a human view.";

/**
 * The share-meta disclosure prefix for opinion piece pages (ADR-0013 d.6): always the
 * FRONT of og:description/twitter:description, so platform truncation can never remove it.
 */
export function opinionMetaPrefix(displayName: string): string {
  return `Unhinged rantings of a delusional bot named ${displayName}`;
}

/** Italic descriptor shown under a section masthead. Preserves the design's deadpan tone. */
export const SECTION_BLURBS: Record<Category, string> = {
  WORLD: "Dispatches from a planet under construction.",
  POLITICS: "The slow, deliberate business of deciding things.",
  BUSINESS: "Markets, monitored so that you need not be.",
  TECHNOLOGY: "The future, again, and at a premium.",
  SCIENCE: "Findings, offered provisionally.",
  SPORTS: "Effort, and its many consequences.",
  CULTURE: "Things, and what they are presumed to mean.",
  OPINION: "Views, firmly and comfortably held.",
};

/** The 2×2 studs brand glyph. `photo` tints all four cells for use inside placeholders. */
function studs(sizeClass: string, photo = false): string {
  const cls = `studs ${sizeClass}${photo ? " studs--photo" : ""}`;
  return `<span class="${cls}"><span class="studs__cell"></span><span class="studs__cell"></span><span class="studs__cell"></span><span class="studs__cell"></span></span>`;
}

type FigureVariant = "lead" | "rail" | "card" | "seclead";

const FIGURE_META: Record<
  FigureVariant,
  { frame: string; studs: string; label: string; sizes: string }
> = {
  // `sizes` approximates each variant's rendered width across breakpoints so the browser picks
  // the smallest srcset entry that fits (ADR-0012). Values are deliberately generous — a slightly
  // larger pick is fine; the win is not shipping the full 1280 px source to a ~300 px slot.
  lead: {
    frame: "figure__frame--lead",
    studs: "studs--9",
    label: "Brick Photograph",
    sizes: "(max-width: 700px) 92vw, (max-width: 1080px) 60vw, 640px",
  },
  rail: {
    frame: "figure__frame--rail",
    studs: "studs--6",
    label: "Brick Photograph",
    sizes: "(max-width: 700px) 92vw, (max-width: 1080px) 42vw, 320px",
  },
  card: {
    frame: "figure__frame--card",
    studs: "studs--6",
    label: "Brick Photo",
    sizes: "(max-width: 700px) 92vw, (max-width: 1080px) 45vw, 320px",
  },
  seclead: {
    frame: "figure__frame--seclead",
    studs: "studs--9",
    label: "Brick Photograph",
    sizes: "(max-width: 700px) 92vw, (max-width: 1080px) 60vw, 640px",
  },
};

/**
 * A framed brick photo + caption. Renders the real generated image when `imageUrl` is
 * present, else the design's studded placeholder frame (graceful degrade — the page never
 * shows a publisher's photo, only our art or a placeholder). The caption always carries the
 * static "/ BRICKFEED STUDIO" credit.
 *
 * When an image is present it also emits a decorative, hover-revealed full-size preview
 * (`.figure__zoom`) as a sibling of the cropped frame. The frame crops via `object-fit:cover`,
 * so this CSS-only lightbox lets a reader see the whole image at full resolution on hover. Both
 * imgs are `loading="lazy" decoding="async"` — the eager zoom used to defeat the thumbnail's
 * lazy-loading (same URL, fetched immediately), so making it lazy restores real deferral. The
 * zoom is `aria-hidden` so screen readers aren't told about the same picture twice.
 *
 * With `opts.imageOptimize` (ADR-0012) the thumbnail carries a responsive `srcset`/`sizes` of
 * same-origin `/_vercel/image` variants and the zoom loads the largest optimized width; without
 * it, both fall back to the raw Blob URL (byte-identical to the pre-optimization render).
 */
function figure(view: StoryView, variant: FigureVariant, opts: StoryRenderOpts = {}): string {
  const meta = FIGURE_META[variant];
  const io = opts.imageOptimize;
  let inner: string;
  if (view.imageUrl) {
    const responsive = io
      ? ` srcset="${escapeAttr(optimizedSrcset(view.imageUrl, io.widths, io.quality))}" sizes="${meta.sizes}"`
      : "";
    inner = `<img class="figure__img" src="${escapeAttr(view.imageUrl)}"${responsive} alt="${escapeAttr(view.headline)}" loading="lazy" decoding="async">`;
  } else {
    inner = `<div class="figure__placeholder">${studs(meta.studs, true)}<span class="figure__label">${meta.label}</span></div>`;
  }
  let zoom = "";
  if (view.imageUrl) {
    const zoomSrc = io
      ? optimizedUrl(view.imageUrl, Math.max(...io.widths), io.quality)
      : view.imageUrl;
    zoom = `<span class="figure__zoom" aria-hidden="true"><img class="figure__zoom-img" src="${escapeAttr(zoomSrc)}" alt="" loading="lazy" decoding="async"></span>`;
  }
  return `<figure class="figure">
        <div class="figure__frame ${meta.frame}">${inner}</div>
        ${zoom}
        <figcaption class="figcaption">${escapeHtml(view.caption)} <span class="figcaption__credit">/ BRICKFEED STUDIO</span></figcaption>
      </figure>`;
}

/**
 * A per-story share row (ADR-0012): "Share" + an X and a LinkedIn button, each opening that
 * platform's composer prefilled with the story's landing-page URL — the exact intent builders the
 * operator Share page uses, so the public buttons and the worksheet behave identically. Returns ""
 * unless the story has both a `shareUrl` (its absolute landing page) and an image (publishable),
 * so imageless placeholders stay byte-identical.
 *
 * IMPORTANT: these are anchors, so the caller MUST place this OUTSIDE the story's own `<a>` — the
 * card-wide link would otherwise nest anchors (invalid HTML) and swallow the share clicks.
 */
function storyShare(view: StoryView, opts: StoryRenderOpts): string {
  if (!view.shareUrl || !view.imageUrl) return "";
  const share = opts.share ?? {};
  const xHref = buildXIntentUrl({
    headline: view.headline,
    pageUrl: view.shareUrl,
    handle: share.handle,
    hashtags: share.hashtags,
  });
  const liHref = buildLinkedInIntentUrl({ headline: view.headline, pageUrl: view.shareUrl });
  return `<div class="story-share">
        <span class="story-share__label">Share</span>
        <a class="story-share__btn" href="${escapeAttr(xHref)}" target="_blank" rel="noopener noreferrer">X</a>
        <a class="story-share__btn story-share__btn--linkedin" href="${escapeAttr(liHref)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>
      </div>`;
}

/**
 * Wrap a story's clickable `<a>` and its share row as siblings so the anchors never nest. When
 * there's no share row (imageless placeholder), returns the bare link — byte-identical to the
 * pre-share render, so unrelated fixtures don't churn.
 */
function withShare(link: string, share: string): string {
  return share ? `<div class="story">${link}${share}</div>` : link;
}

/**
 * Common attributes for a story link. A feed story opens its source in a new tab; a local
 * article (`local`) links to its own hosted `s/<id>.html` page in the SAME tab (internal
 * navigation), so no `target`/`rel` is emitted.
 */
function storyLinkAttrs(url: string, className: string, local = false): string {
  const target = local ? "" : ` target="_blank" rel="noopener noreferrer"`;
  return `class="${className}" href="${escapeAttr(url)}"${target}`;
}

/**
 * The " · 2 hr ago" tail appended after a byline. Local articles carry no timestamp (`ago`
 * is ""), so the separator + time are omitted entirely rather than rendering a dangling "· ".
 */
function bylineTail(ago: string): string {
  return ago ? ` &middot; ${escapeHtml(ago)}` : "";
}

/**
 * The signed byline row for an opinion piece (ADR-0016 d.7): avatar thumbnail (omitted
 * when the headshot manifest has no entry — degraded upstream with a warning), the
 * persona's display name, and the column title for letters personas. Replaces the
 * decorative desk byline on opinion cards and piece pages. `extraClass` lets the
 * landing page keep its `byline--lead` sizing. The avatar's 48px size is presentational
 * attributes, not just CSS (ADR-0017): it survives a stale stylesheet and reserves layout.
 */
function opinionBylineRow(view: StoryView, extraClass = ""): string {
  const o = view.opinion;
  if (!o) return "";
  const avatar = o.avatarUrl
    ? `<img class="byline-opinion__avatar" src="${escapeAttr(o.avatarUrl)}" width="48" height="48" alt="" loading="lazy" decoding="async">`
    : "";
  const column = o.columnTitle
    ? ` &middot; <span class="byline-opinion__column">${escapeHtml(o.columnTitle)}</span>`
    : "";
  const cls = extraClass ? `byline ${extraClass} byline-opinion` : "byline byline-opinion";
  return `<div class="${cls}">${avatar}<span class="byline-opinion__name">${escapeHtml(o.displayName)}</span>${column}${bylineTail(view.ago)}</div>`;
}

/** The utility strip: dateline + time-of-day edition (no Search / Subscribe / Today's Paper). */
export function utilityStrip(dateStr: string, edition: string): string {
  return `<div class="utility">
    <div class="container utility__inner">
      <div class="utility__date">${escapeHtml(dateStr)}</div>
      <div class="utility__edition">${escapeHtml(edition)}</div>
      <div class="utility__spacer"></div>
    </div>
  </div>`;
}

/** The home masthead: nameplate + tagline between hairlines. */
export function masthead(): string {
  return `<div class="container masthead">
    <h1 class="masthead__nameplate">brickfeed</h1>
    <div class="masthead__motto-row">
      <span class="masthead__rule"></span>
      <span class="masthead__motto">All the stories, brick by brick</span>
      <span class="masthead__rule"></span>
    </div>
  </div>`;
}

/**
 * The sticky section nav. Links only the sections present in this build (the caller passes
 * them in CATEGORIES order — ADR-0013: empty sections are omitted site-wide, not special-cased).
 * `active` underlines the current section on its page. About is a standalone page, never a
 * category, so it always trails the section links and never takes the active state.
 */
export function sectionNav(sections: readonly Category[], active?: Category): string {
  const links = sections
    .map((c) => {
      const cls = c === active ? "nav__link nav__link--active" : "nav__link";
      return `<a class="${cls}" href="${sectionSlug(c)}.html">${escapeHtml(titleCase(c))}</a>`;
    })
    .join("");
  const aboutNavLink = `<a class="nav__link" href="about.html">About</a>`;
  return `<div class="nav">
    <div class="container nav__inner">
      <a class="nav__brand" href="index.html">${studs("")}brickfeed</a>
      <nav class="nav__links">${links}${aboutNavLink}</nav>
    </div>
  </div>`;
}

/** The single large lead story. */
export function leadStory(view: StoryView, opts: StoryRenderOpts = {}): string {
  const link = `<a ${storyLinkAttrs(view.url, "lead", view.local)}>
      ${figure(view, "lead", opts)}
      <div class="lead__body">
        <div class="kicker">${escapeHtml(view.kicker)}</div>
        <h2 class="lead__headline">${escapeHtml(view.headline)}</h2>
        <p class="dek">${escapeHtml(view.description)}</p>
        <div class="byline byline--lead">${escapeHtml(view.byline)}${bylineTail(view.ago)}</div>
      </div>
    </a>`;
  return withShare(link, storyShare(view, opts));
}

/** One secondary (rail) story: photo, kicker, headline, dek, byline. */
export function railStory(view: StoryView, opts: StoryRenderOpts = {}): string {
  const link = `<a ${storyLinkAttrs(view.url, "rail__item", view.local)}>
        ${figure(view, "rail", opts)}
        <div class="kicker kicker--sm">${escapeHtml(view.kicker)}</div>
        <h3 class="rail__headline">${escapeHtml(view.headline)}</h3>
        <p class="dek">${escapeHtml(view.description)}</p>
        <div class="byline">${escapeHtml(view.byline)}</div>
      </a>`;
  return withShare(link, storyShare(view, opts));
}

/** One grid card (home "Across the Brickyard" + section grids). */
export function card(view: StoryView, opts: StoryRenderOpts = {}): string {
  // Opinion pieces swap the decorative desk byline for the signed byline row (ADR-0016).
  const byline = view.opinion
    ? opinionBylineRow(view)
    : `<div class="byline">${escapeHtml(view.byline)}${bylineTail(view.ago)}</div>`;
  const link = `<a ${storyLinkAttrs(view.url, "card", view.local)}>
        ${figure(view, "card", opts)}
        <div class="card__body">
          <div class="kicker kicker--sm">${escapeHtml(view.kicker)}</div>
          <h3 class="card__headline">${escapeHtml(view.headline)}</h3>
          <p class="dek">${escapeHtml(view.description)}</p>
          ${byline}
        </div>
      </a>`;
  return withShare(link, storyShare(view, opts));
}

/** The "Across the Brickyard" section header row above the home card grid. */
export function brickyardHead(): string {
  return `<div class="brickyard__head">
      <span class="brickyard__title">Across the Brickyard</span>
      <span class="brickyard__meta">Updated Continuously</span>
    </div>`;
}

/** The section-page masthead: kicker, big section title, italic blurb + story count. */
export function sectionHead(category: Category, count: number): string {
  const stories = count === 1 ? "1 story today" : `${count} stories today`;
  return `<div class="container section-head">
    <div class="kicker">Section</div>
    <div class="section-head__row">
      <h1 class="section-head__title">${escapeHtml(titleCase(category))}</h1>
      <div class="section-head__aside">
        <div class="section-head__blurb">${escapeHtml(SECTION_BLURBS[category])}</div>
        <div class="section-head__meta">${stories} &middot; updated continuously</div>
      </div>
    </div>
  </div>`;
}

/** A deadpan empty-state block for a page with no stories. */
export function emptyState(message: string): string {
  return `<div class="container empty">
    <p class="empty__title">Nothing to brick, just now.</p>
    <p class="empty__note">${escapeHtml(message)}</p>
  </div>`;
}

/**
 * The rotating leaderboard banner, drawn once per page below the nav. Each ad is a link to
 * its outbound URL wrapping our own image (never a publisher's). With one ad it's static;
 * with several, an inline script (AD_ROTATOR_JS, ADR-0017) shuffles the play order once
 * per page load and crossfades through it, holding each slide for its `data-duration`.
 * Returns "" for an empty list, so a site with no ads simply renders no banner.
 *
 * `rel="noopener sponsored nofollow"` marks these as paid/creator links per web conventions;
 * `target="_blank"` opens them in a new tab like the story links do.
 */
export function adBanner(ads: AdView[]): string {
  if (ads.length === 0) return "";
  const slides = ads
    .map(
      (ad) =>
        `<a class="adbanner__slide" href="${escapeAttr(ad.href)}" data-duration="${ad.durationMs}" target="_blank" rel="noopener sponsored nofollow">` +
        `<img class="adbanner__img" src="${escapeAttr(ad.imageUrl)}" alt="${escapeAttr(ad.alt)}" loading="lazy" decoding="async"></a>`,
    )
    .join("");
  const rotator = ads.length > 1 ? `\n    <script>${AD_ROTATOR_JS}</script>` : "";
  return `<div class="container">
    <aside class="adbanner" aria-label="Advertisement">
      <div class="adbanner__label">Advertisement</div>
      <div class="adbanner__frame">${slides}</div>
    </aside>${rotator}
  </div>`;
}

/**
 * The creator portrait for the About page — our own generated toy-brick art, hosted in Blob
 * alongside the story images (the repo stays text-only; only this URL is committed). Keyed
 * outside the manifest, so age-out never touches it.
 */
export const ABOUT_PORTRAIT_URL =
  "https://7fjkp0rhcwadfro9.public.blob.vercel-storage.com/images/about-portrait-91deb1d497.jpg";

/** One external profile link on the About page — always opens in a new tab. */
function aboutLink(href: string, label: string): string {
  return `<a class="about__link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

/**
 * The standalone About page: the same chrome + shell as every other page, the site-wide
 * banner, a framed toy-brick portrait of the creator, a short deadpan bio, and the outbound
 * profile links. Static copy is written as literal HTML (like the footer disclaimer); only
 * the URLs are escaped.
 */
export function renderAbout(
  dateStr: string,
  edition: string,
  banner: string,
  sections: readonly Category[],
  analytics: AnalyticsProvider = "none",
): string {
  const chrome = utilityStrip(dateStr, edition) + masthead() + sectionNav(sections) + banner;
  const body =
    chrome +
    `<main>
    <div class="container section-head">
      <div class="kicker">Colophon</div>
      <div class="section-head__row">
        <h1 class="section-head__title">About</h1>
        <div class="section-head__aside">
          <div class="section-head__blurb">The mystery man behind the minifigures.</div>
        </div>
      </div>
    </div>
    <div class="container about">
      <figure class="about__portrait">
        <div class="about__frame"><img class="about__img" src="${escapeAttr(ABOUT_PORTRAIT_URL)}" alt="A plastic toy-brick minifigure portrait of Kris Bennett, bearded and in a grey suit on a city street"></div>
        <figcaption class="figcaption">Kris Bennett <span class="figcaption__credit">/ BRICKFEED STUDIO</span></figcaption>
      </figure>
      <div class="about__body">
        <p class="about__lead">Brickfeed News was created by an unemployed software developer on a Friday afternoon. If he can launch a global news outlet before bedtime, think what he could for you! To learn more about this mystery man, and possibly even employ him, check out these links.</p>
        <div class="about__links">
          ${aboutLink("https://www.linkedin.com/in/kbennett2000/", "LinkedIn")}
          ${aboutLink("https://github.com/kbennett2000", "GitHub")}
          ${aboutLink("https://www.twelverocks.com/", "Twelve Rocks")}
        </div>
      </div>
    </div>
  </main>` +
    footer(sections);
  return pageShell("About — brickfeed", body, { analytics });
}

/** The footer: wordmark + tagline, the live Sections links (present sections only), disclaimer. */
export function footer(sections: readonly Category[]): string {
  const sectionLinks = sections
    .map(
      (c) => `<a class="footer__link" href="${sectionSlug(c)}.html">${escapeHtml(titleCase(c))}</a>`,
    )
    .join("");
  return `<footer class="footer">
    <div class="container footer__inner">
      <div class="footer__brandwrap">
        <div class="footer__brand">${studs("studs--7")}<span class="footer__wordmark">brickfeed</span></div>
        <div class="footer__motto">All the stories, brick by brick</div>
      </div>
      <div class="footer__cols">
        <div>
          <div class="footer__col-title">Sections</div>
          ${sectionLinks}
        </div>
        <div>
          <div class="footer__col-title">brickfeed</div>
          <a class="footer__link" href="about.html">About</a>
        </div>
      </div>
      <div class="footer__disclaimer">
        brickfeed.news is a work of moulded fiction. All persons depicted are minifigures. Any resemblance to actual bricks &mdash; living, interlocking, or otherwise &mdash; is purely structural.
        <span class="footer__copy">&copy; MMXXVI Brickfeed Media &middot; Printed on recycled pixels</span>
      </div>
    </div>
  </footer>`;
}

/**
 * The full HTML document shell: fonts via Google Fonts, the linked stylesheet, body.
 *
 * `opts.headExtra` injects extra `<head>` markup (the social-card meta on landing pages, the
 * `robots noindex` on the share sheet); default "" keeps existing pages byte-identical.
 * `opts.assetPrefix` prefixes the local `styles.css` href — landing pages live in the `s/`
 * subdir and pass "../" so `../styles.css` resolves; default "" leaves root pages unchanged.
 */
/** Cookieless web-analytics provider injected into the page shell. "none" emits nothing. */
export type AnalyticsProvider = "vercel" | "none";

/**
 * The cookieless Vercel Web Analytics beacon in its plain-HTML form (no npm package). Injected
 * just before `</body>` on public pages when `render.analytics: "vercel"`. The script only
 * reports once Web Analytics is enabled for the project in the Vercel dashboard, which serves
 * `/_vercel/insights/script.js`; until then it 404s harmlessly.
 */
const VERCEL_ANALYTICS_SNIPPET = `<script>
window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
</script>
<script defer src="/_vercel/insights/script.js"></script>`;

/**
 * The Vercel Speed Insights beacon (ADR-0012) in its plain-HTML form. Real-user Core Web Vitals
 * (LCP/CLS/INP) — a Pro feature — injected alongside Web Analytics whenever `analytics: "vercel"`.
 * Like the analytics beacon it 404s harmlessly until Speed Insights is enabled for the project in
 * the Vercel dashboard, so shipping it early is safe.
 */
const VERCEL_SPEED_INSIGHTS_SNIPPET = `<script>
window.si = window.si || function () { (window.siq = window.siq || []).push(arguments); };
</script>
<script defer src="/_vercel/speed-insights/script.js"></script>`;

/** The analytics + speed-insights markup to append before `</body>`; empty unless "vercel". */
function analyticsSnippet(provider: AnalyticsProvider | undefined): string {
  return provider === "vercel"
    ? `\n${VERCEL_ANALYTICS_SNIPPET}\n${VERCEL_SPEED_INSIGHTS_SNIPPET}`
    : "";
}

export function pageShell(
  title: string,
  bodyHtml: string,
  opts: { headExtra?: string; assetPrefix?: string; analytics?: AnalyticsProvider } = {},
): string {
  const headExtra = opts.headExtra ? `${opts.headExtra}\n` : "";
  const assetPrefix = opts.assetPrefix ?? "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${headExtra}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..700;1,6..96,400..600&family=Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400..500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${assetPrefix}styles.css?v=${CSS_VERSION}">
</head>
<body>
${bodyHtml}${analyticsSnippet(opts.analytics)}
</body>
</html>
`;
}

/**
 * The Open Graph / Twitter card `<head>` block for a per-story landing page (ADR-0009), so a
 * shared brickfeed URL renders a large-image card with OUR art. `twitter:card` is always
 * `summary_large_image`; `og:image`/`twitter:image` are emitted only when an image is present
 * (a publishable record always has one, but the core stays tolerant); `twitter:site` only when
 * a handle is configured. Every value is attribute-escaped.
 */
export function cardMeta(args: {
  title: string;
  description: string;
  pageUrl: string;
  imageUrl?: string;
  twitterSite?: string;
}): string {
  const { title, description, pageUrl, imageUrl, twitterSite } = args;
  const lines = [
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="brickfeed">`,
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    `<meta property="og:url" content="${escapeAttr(pageUrl)}">`,
    `<meta name="twitter:title" content="${escapeAttr(title)}">`,
    `<meta name="twitter:description" content="${escapeAttr(description)}">`,
  ];
  if (imageUrl) {
    lines.push(`<meta property="og:image" content="${escapeAttr(imageUrl)}">`);
    lines.push(`<meta name="twitter:image" content="${escapeAttr(imageUrl)}">`);
  }
  if (twitterSite) {
    lines.push(`<meta name="twitter:site" content="${escapeAttr(twitterSite)}">`);
  }
  return lines.join("\n");
}

/** A minimal brand header for the standalone landing / share pages (no root-relative nav). */
function standaloneBrand(homeHref: string): string {
  return `<header class="standalone__brand">
      <a class="standalone__wordmark" href="${escapeAttr(homeHref)}">${studs("")}brickfeed</a>
    </header>`;
}

/**
 * A per-story landing page (ADR-0009): a standalone, social-card-bearing page at
 * `s/<id>.html`. The card (see cardMeta) points at our brick image; the body shows the image,
 * kicker, headline, and byline (via the shared figure). Self-contained on purpose — it lives
 * in the `s/` subdir, so it uses a "../" asset prefix and a brand header instead of the
 * root-relative masthead/nav/footer.
 *
 * Two flavours share this shell (ADR-0010): a FEED story shows its dek and a prominent
 * outbound link to the source article (the card draws readers in with our art, the page sends
 * them on); a LOCAL article (`view.local`) is itself the destination, so it renders the
 * article body HTML in place of the dek + outbound CTA.
 */
export function renderLandingPage(
  view: StoryView,
  opts: {
    pageUrl: string;
    twitterSite?: string;
    analytics?: AnalyticsProvider;
    imageOptimize?: ImageOptimizeRender;
    share?: { handle?: string; hashtags?: string[] };
  },
): string {
  // Opinion pieces prefix the share meta with the bot disclosure (ADR-0013 d.6) — prefix
  // FIRST so platform truncation eats the excerpt tail, never the disclosure.
  const metaDescription = view.opinion
    ? `${opinionMetaPrefix(view.opinion.displayName)} — ${view.description}`
    : view.description;
  const meta = cardMeta({
    title: view.headline,
    description: metaDescription,
    pageUrl: opts.pageUrl,
    imageUrl: view.imageUrl,
    twitterSite: opts.twitterSite,
  });
  // The landing page isn't wrapped in a card-wide anchor, so the share row can live inside the
  // article. Its shareUrl IS this page's own absolute URL (opts.pageUrl).
  const storyOpts: StoryRenderOpts = { imageOptimize: opts.imageOptimize, share: opts.share };
  const shareRow = storyShare({ ...view, shareUrl: opts.pageUrl }, storyOpts);
  // Opinion piece pages footer the author's byline_blurb, plus the letters disclosure
  // for reader-letter columns (ADR-0016 d.6). A missing persona file yields "" for the
  // blurb — that <p> is omitted; the letters line keys off the persisted record signal.
  const disclosure = view.opinion
    ? `<div class="landing__disclosure">` +
      (view.opinion.bylineBlurb
        ? `<p class="landing__blurb">${escapeHtml(view.opinion.bylineBlurb)}</p>`
        : "") +
      (view.opinion.letters
        ? `<p class="landing__letters">${escapeHtml(LETTERS_DISCLOSURE)}</p>`
        : "") +
      `</div>`
    : "";
  const localByline = view.opinion
    ? opinionBylineRow(view, "byline--lead")
    : `<div class="byline byline--lead">${escapeHtml(view.byline)}${bylineTail(view.ago)}</div>`;
  // Local article / opinion piece: byline then its own hosted body, no outbound CTA. Feed
  // story: dek, byline, then a prominent read-at-source link (unchanged from ADR-0009).
  const tail = view.local
    ? `${localByline}
        <div class="landing__body">${view.bodyHtml ?? ""}</div>${disclosure}`
    : `<p class="dek landing__dek">${escapeHtml(view.description)}</p>
        <div class="byline byline--lead">${escapeHtml(view.byline)} &middot; ${escapeHtml(view.ago)}</div>
        <a class="landing__cta" href="${escapeAttr(view.url)}" target="_blank" rel="noopener noreferrer">Read the full story at the source &rarr;</a>`;
  const body = `<div class="standalone landing">
    ${standaloneBrand("../index.html")}
    <main class="container landing__main">
      <article class="landing__article">
        ${figure(view, "lead", storyOpts)}
        <div class="kicker">${escapeHtml(view.kicker)}</div>
        <h1 class="landing__headline">${escapeHtml(view.headline)}</h1>
        ${tail}
        ${shareRow}
      </article>
    </main>
  </div>`;
  return pageShell(`${view.headline} — brickfeed`, body, {
    headExtra: meta,
    assetPrefix: "../",
    analytics: opts.analytics,
  });
}

/** One story on the share sheet: its display view + its absolute landing-page URL. */
export interface ShareRow {
  view: StoryView;
  pageUrl: string;
}

/** One row on the share sheet: image thumb + kicker + headline + a Post-to-X / Post-to-LinkedIn
 * action pair. Carries `data-category` so the client-side filter can show/hide it by section. */
function shareRow(
  view: StoryView,
  pageUrl: string,
  opts: { handle?: string; hashtags?: string[] },
): string {
  const xHref = buildXIntentUrl({
    headline: view.headline,
    pageUrl,
    handle: opts.handle,
    hashtags: opts.hashtags,
  });
  const liHref = buildLinkedInIntentUrl({ headline: view.headline, pageUrl });
  const thumb = view.imageUrl
    ? `<img class="sharesheet__thumb" src="${escapeAttr(view.imageUrl)}" alt="${escapeAttr(view.headline)}" loading="lazy">`
    : `<div class="sharesheet__thumb sharesheet__thumb--empty">${studs("studs--6", true)}</div>`;
  return `<li class="sharesheet__row" data-category="${escapeAttr(view.kicker)}">
        <div class="sharesheet__thumbwrap">${thumb}</div>
        <div class="sharesheet__body">
          <div class="kicker kicker--sm">${escapeHtml(view.kicker)}</div>
          <h2 class="sharesheet__headline">${escapeHtml(view.headline)}</h2>
        </div>
        <div class="sharesheet__actions">
          <a class="sharesheet__post" href="${escapeAttr(xHref)}" target="_blank" rel="noopener noreferrer">Post to X</a>
          <a class="sharesheet__post sharesheet__post--linkedin" href="${escapeAttr(liHref)}" target="_blank" rel="noopener noreferrer">Post to LinkedIn</a>
        </div>
      </li>`;
}

/** A titled group of share rows (e.g. "Local articles", "From the feed"). The `data-section`
 * wrapper lets the filter script hide the whole group — heading included — when no visible row
 * remains under the active filter. Returns "" when the group is empty so no stray heading shows. */
function shareSection(title: string, rows: ShareRow[], opts: { handle?: string; hashtags?: string[] }): string {
  if (!rows.length) return "";
  const items = rows.map(({ view, pageUrl }) => shareRow(view, pageUrl, opts)).join("");
  return `<section class="sharesheet__section" data-section>
      <h2 class="sharesheet__section-title">${escapeHtml(title)}</h2>
      <ul class="sharesheet__list">${items}</ul>
    </section>`;
}

/**
 * The assisted-manual share sheet (ADR-0009 + ADR-0010): one row per publishable story — image
 * thumb + headline + "Post to X" and "Post to LinkedIn" buttons, each linking to that platform's
 * composer prefilled with the story's landing-page URL (whose OG tags carry the brick image). A
 * human opens this private page and clicks to post; there is no API, key, or scheduler.
 *
 * Locally hosted articles (`view.local`) are pulled into their own section pinned to the top,
 * ahead of the feed stories, regardless of the order rows arrive in. A client-side filter bar
 * lets the operator narrow the sheet to a single section. The page carries `robots noindex` (via
 * pageShell) and is NOT linked from the site nav/footer, so it stays an unindexed operator tool.
 * Root page, so it needs no asset prefix.
 */
export function renderShareSheet(
  rows: ShareRow[],
  opts: { handle?: string; hashtags?: string[] } = {},
): string {
  const localRows = rows.filter((r) => r.view.local);
  const feedRows = rows.filter((r) => !r.view.local);

  // Filter chips: "All" plus each category actually present, in the canonical CATEGORIES order.
  const present = new Set(rows.map((r) => r.view.kicker));
  const chips = [
    `<button type="button" class="sharesheet__chip is-active" data-filter="ALL">All</button>`,
    ...CATEGORIES.filter((c) => present.has(c)).map(
      (c) => `<button type="button" class="sharesheet__chip" data-filter="${escapeAttr(c)}">${escapeHtml(titleCase(c))}</button>`,
    ),
  ].join("");

  const sections =
    shareSection("Local articles", localRows, opts) + shareSection("From the feed", feedRows, opts);

  const content = rows.length
    ? `<div class="sharesheet__filters" role="group" aria-label="Filter by section">${chips}</div>${sections}`
    : emptyState("No stories are ready to post yet. Check back once the presses roll.");

  const body = `<div class="standalone sharesheet">
    ${standaloneBrand("index.html")}
    <main class="container sharesheet__main">
      <h1 class="sharesheet__title">Post to X or LinkedIn</h1>
      <p class="sharesheet__note">A private worksheet: click a button to open X or LinkedIn with a story prefilled, then post it by hand. ${rows.length} ${rows.length === 1 ? "story" : "stories"} ready.</p>
      ${content}
    </main>
  </div>
  <script>${SHARESHEET_FILTER_JS}</script>`;
  return pageShell("Post to X or LinkedIn — brickfeed", body, {
    headExtra: `<meta name="robots" content="noindex">`,
  });
}

/** Client-side section filter for the share sheet: clicking a chip shows only rows whose
 * `data-category` matches (or all rows for "ALL"), then hides any section left with no visible
 * row so its heading doesn't linger. Vanilla JS, no deps; runs only on this noindex operator page. */
const SHARESHEET_FILTER_JS = `(function(){
  var chips = document.querySelectorAll('.sharesheet__chip');
  var rows = document.querySelectorAll('.sharesheet__row');
  var sections = document.querySelectorAll('[data-section]');
  function apply(filter){
    rows.forEach(function(row){
      var show = filter === 'ALL' || row.getAttribute('data-category') === filter;
      row.hidden = !show;
    });
    sections.forEach(function(sec){
      var any = sec.querySelector('.sharesheet__row:not([hidden])');
      sec.hidden = !any;
    });
  }
  chips.forEach(function(chip){
    chip.addEventListener('click', function(){
      chips.forEach(function(c){ c.classList.remove('is-active'); });
      chip.classList.add('is-active');
      apply(chip.getAttribute('data-filter'));
    });
  });
})();`;
