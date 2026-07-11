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
import { CATEGORIES, type Category } from "../category.js";
import { escapeAttr, escapeHtml, sectionSlug, titleCase } from "./format.js";

/** The view model a template consumes — a ManifestRecord already reduced to display fields. */
export interface StoryView {
  /** Outbound article URL (the real source attribution); links open in a new tab. */
  url: string;
  /** Section kicker, e.g. WORLD (already uppercase). */
  kicker: Category;
  headline: string;
  description: string;
  /** Neutral caption; the "/ BRICKFEED STUDIO" credit is appended by the figure template. */
  caption: string;
  /** Decorative byline, e.g. "By the World Desk". */
  byline: string;
  /** Relative time label, e.g. "2 hr ago". */
  ago: string;
  /** Durable image URL; absent → the brick placeholder frame is rendered instead. */
  imageUrl?: string;
}

/** Italic descriptor shown under a section masthead. Preserves the design's deadpan tone. */
export const SECTION_BLURBS: Record<Category, string> = {
  WORLD: "Dispatches from a planet under construction.",
  POLITICS: "The slow, deliberate business of deciding things.",
  BUSINESS: "Markets, monitored so that you need not be.",
  TECHNOLOGY: "The future, again, and at a premium.",
  SCIENCE: "Findings, offered provisionally.",
  SPORT: "Effort, and its many consequences.",
  CULTURE: "Things, and what they are presumed to mean.",
  OPINION: "Views, firmly and comfortably held.",
};

/** The 2×2 studs brand glyph. `photo` tints all four cells for use inside placeholders. */
function studs(sizeClass: string, photo = false): string {
  const cls = `studs ${sizeClass}${photo ? " studs--photo" : ""}`;
  return `<span class="${cls}"><span class="studs__cell"></span><span class="studs__cell"></span><span class="studs__cell"></span><span class="studs__cell"></span></span>`;
}

type FigureVariant = "lead" | "rail" | "card" | "seclead";

const FIGURE_META: Record<FigureVariant, { frame: string; studs: string; label: string }> = {
  lead: { frame: "figure__frame--lead", studs: "studs--9", label: "Brick Photograph" },
  rail: { frame: "figure__frame--rail", studs: "studs--6", label: "Brick Photograph" },
  card: { frame: "figure__frame--card", studs: "studs--6", label: "Brick Photo" },
  seclead: { frame: "figure__frame--seclead", studs: "studs--9", label: "Brick Photograph" },
};

/**
 * A framed brick photo + caption. Renders the real generated image when `imageUrl` is
 * present, else the design's studded placeholder frame (graceful degrade — the page never
 * shows a publisher's photo, only our art or a placeholder). The caption always carries the
 * static "/ BRICKFEED STUDIO" credit.
 *
 * When an image is present it also emits a decorative, hover-revealed full-size preview
 * (`.figure__zoom`) as a sibling of the cropped frame. The frame crops via `object-fit:cover`,
 * so this CSS-only lightbox lets a reader see the whole image at full resolution on hover. It
 * reuses the same URL (already downloaded for the thumbnail — no extra network) and is
 * `aria-hidden` so screen readers aren't told about the same picture twice.
 */
function figure(view: StoryView, variant: FigureVariant): string {
  const meta = FIGURE_META[variant];
  const inner = view.imageUrl
    ? `<img class="figure__img" src="${escapeAttr(view.imageUrl)}" alt="${escapeAttr(view.headline)}" loading="lazy">`
    : `<div class="figure__placeholder">${studs(meta.studs, true)}<span class="figure__label">${meta.label}</span></div>`;
  const zoom = view.imageUrl
    ? `<span class="figure__zoom" aria-hidden="true"><img class="figure__zoom-img" src="${escapeAttr(view.imageUrl)}" alt=""></span>`
    : "";
  return `<figure class="figure">
        <div class="figure__frame ${meta.frame}">${inner}</div>
        ${zoom}
        <figcaption class="figcaption">${escapeHtml(view.caption)} <span class="figcaption__credit">/ BRICKFEED STUDIO</span></figcaption>
      </figure>`;
}

/** Common attributes for a story link — opens the source article in a new tab. */
function storyLinkAttrs(url: string, className: string): string {
  return `class="${className}" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer"`;
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
 * The sticky section nav. Links are generated from CATEGORIES (imported), so the nav is
 * always in sync with the taxonomy. `active` underlines the current section on its page.
 */
export function sectionNav(active?: Category): string {
  const links = CATEGORIES.map((c) => {
    const cls = c === active ? "nav__link nav__link--active" : "nav__link";
    return `<a class="${cls}" href="${sectionSlug(c)}.html">${escapeHtml(titleCase(c))}</a>`;
  }).join("");
  return `<div class="nav">
    <div class="container nav__inner">
      <a class="nav__brand" href="index.html">${studs("")}brickfeed</a>
      <nav class="nav__links">${links}</nav>
    </div>
  </div>`;
}

/** The single large lead story. */
export function leadStory(view: StoryView): string {
  return `<a ${storyLinkAttrs(view.url, "lead")}>
      ${figure(view, "lead")}
      <div class="lead__body">
        <div class="kicker">${escapeHtml(view.kicker)}</div>
        <h2 class="lead__headline">${escapeHtml(view.headline)}</h2>
        <p class="dek">${escapeHtml(view.description)}</p>
        <div class="byline byline--lead">${escapeHtml(view.byline)} &middot; ${escapeHtml(view.ago)}</div>
      </div>
    </a>`;
}

/** One secondary (rail) story: photo, kicker, headline, dek, byline. */
export function railStory(view: StoryView): string {
  return `<a ${storyLinkAttrs(view.url, "rail__item")}>
        ${figure(view, "rail")}
        <div class="kicker kicker--sm">${escapeHtml(view.kicker)}</div>
        <h3 class="rail__headline">${escapeHtml(view.headline)}</h3>
        <p class="dek">${escapeHtml(view.description)}</p>
        <div class="byline">${escapeHtml(view.byline)}</div>
      </a>`;
}

/** One grid card (home "Across the Brickyard" + section grids). */
export function card(view: StoryView): string {
  return `<a ${storyLinkAttrs(view.url, "card")}>
        ${figure(view, "card")}
        <div class="card__body">
          <div class="kicker kicker--sm">${escapeHtml(view.kicker)}</div>
          <h3 class="card__headline">${escapeHtml(view.headline)}</h3>
          <p class="dek">${escapeHtml(view.description)}</p>
          <div class="byline">${escapeHtml(view.byline)} &middot; ${escapeHtml(view.ago)}</div>
        </div>
      </a>`;
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

/** The footer: wordmark + tagline, the live Sections links, disclaimer. */
export function footer(): string {
  const sectionLinks = CATEGORIES.map(
    (c) => `<a class="footer__link" href="${sectionSlug(c)}.html">${escapeHtml(titleCase(c))}</a>`,
  ).join("");
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
      </div>
      <div class="footer__disclaimer">
        brickfeed.news is a work of moulded fiction. All persons depicted are minifigures. Any resemblance to actual bricks &mdash; living, interlocking, or otherwise &mdash; is purely structural.
        <span class="footer__copy">&copy; MMXXVI Brickfeed Media &middot; Printed on recycled pixels</span>
      </div>
    </div>
  </footer>`;
}

/** The full HTML document shell: fonts via Google Fonts, the linked stylesheet, body. */
export function pageShell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..700;1,6..96,400..600&family=Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400..500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="styles.css">
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}
