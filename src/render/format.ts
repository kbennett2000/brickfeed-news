/**
 * Pure formatting/escaping helpers for the static render (Slice 7). No IO, no clock of
 * their own — every time-dependent helper takes an explicit `now`, so the render stays
 * hermetic and testable. Kept separate from the templates so the string-escaping rules
 * live in one auditable place.
 */
import type { Category } from "../category.js";

/** HTML-escape text for element content (`<`, `>`, `&`). */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape a string for use inside a double-quoted attribute value. Covers `&` and `"`
 * plus `<`/`>` for safety; used for `href`, `src`, `alt`, etc. so a stray quote in a
 * source URL or caption can never break out of the attribute.
 */
export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * The masthead dateline, e.g. `FRIDAY, JULY 10, 2026`. Formatted in an explicit `timeZone`
 * (default UTC) so the output is deterministic for a given clock regardless of the host
 * timezone (the render is hermetic and CI runs anywhere), then uppercased to the broadsheet
 * style. The render passes the configured `render.timeZone` so the date + edition agree.
 */
export function formatMastheadDate(now: Date, timeZone = "UTC"): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  }).format(now);
  return formatted.toUpperCase();
}

/** The six 4-hour edition names, indexed by `floor(hour / 4)`. */
const EDITION_NAMES = [
  "Midnight", // 00:00–03:59
  "Sunrise", //  04:00–07:59
  "Morning", //  08:00–11:59
  "Afternoon", // 12:00–15:59
  "Evening", //  16:00–19:59
  "Night", //    20:00–23:59
] as const;

/**
 * The edition label for a 24-hour hour, e.g. `9` → `Morning Edition`. The day is split into
 * six 4-hour windows so the masthead reflects roughly when the run happened. Pure; the hour is
 * clamped into range so an out-of-band value can never index past the table.
 */
export function editionForHour(hour: number): string {
  const idx = Math.min(EDITION_NAMES.length - 1, Math.max(0, Math.floor(hour / 4)));
  return `${EDITION_NAMES[idx]} Edition`;
}

/**
 * The edition label for a clock, computed in `timeZone` (default UTC) so it matches the
 * wall-clock the cron ran on. Extracts the 0–23 hour via Intl (same mechanism as the dateline),
 * keeping the render deterministic for a given clock + zone.
 */
export function editionLabel(now: Date, timeZone = "UTC"): string {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(now);
  return editionForHour(Number(hourStr) % 24);
}

/**
 * A deadpan relative-time label from an ISO timestamp to `now`, e.g. `34 min ago`,
 * `2 hr ago`, `3 days ago`. This is decorative chrome (the real freshness signal is the
 * live feed), so it degrades to `just now` for future/near/unparseable timestamps rather
 * than throwing.
 */
export function relativeTime(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "just now";
  const seconds = Math.floor((now.getTime() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** The URL slug for a section page, e.g. WORLD → `world`. Lowercased category name. */
export function sectionSlug(category: Category): string {
  return category.toLowerCase();
}

/** Title-case a single UPPERCASE category token, e.g. TECHNOLOGY → `Technology`. */
export function titleCase(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * The decorative byline for a card, e.g. `By the Technology Desk`. This is chrome, not a
 * real author credit — the actual source attribution is the outbound link to the article.
 */
export function bylineFor(category: Category): string {
  return `By the ${titleCase(category)} Desk`;
}

/**
 * The rendered caption text with the static studio credit appended. The generator's
 * `caption` is a bare neutral description (no credit — see prompt.ts); the
 * `/ BRICKFEED STUDIO` credit is a render-side concern, added here.
 */
export function captionWithCredit(caption: string): string {
  return `${caption} / BRICKFEED STUDIO`;
}

/**
 * The absolute URL of a story's landing page (ADR-0009), e.g.
 * `https://www.brickfeed.news/s/<id>.html`. Built from the configured `siteBaseUrl` (an
 * absolute origin with no trailing slash) and the story id. This is both the file's own
 * `og:url` and the `url` the X share link points at, so both agree by construction.
 */
export function storyPageUrl(siteBaseUrl: string, id: string): string {
  return `${siteBaseUrl}/s/${id}.html`;
}

/**
 * A tiny, stable string hash (FNV-1a, 32-bit) returning a non-negative integer. Used to place
 * unranked (Main/Sub Page Rank 0) local articles at a pseudo-random-but-deterministic slot: the
 * render seeds it with the article id + the current edition, so the slot shifts across cycles
 * yet is fully reproducible for a pinned clock — the render stays hermetic and testable.
 */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** X (Twitter) tweet character ceiling. */
const TWEET_MAX = 280;
/** Every URL in a tweet is wrapped to a fixed-width t.co link, so it always costs this much. */
const TCO_URL_LENGTH = 23;

/**
 * Build an X Web Intent URL (ADR-0009) that opens X's composer prefilled with a story:
 * `https://x.com/intent/tweet?text=…&url=…[&hashtags=…][&via=…]`. Encoded via URLSearchParams
 * so spaces/punctuation are correct. `hashtags` (bare, no "#") and `via` (handle, no "@") are
 * omitted entirely when unset.
 *
 * The headline is length-budgeted so the composed tweet — `text` + the t.co-wrapped `url`
 * (fixed 23 chars) + the rendered hashtags — stays within 280, truncating with a trailing "…"
 * when needed. The `url` and `hashtags` params never count against the text budget beyond
 * their in-tweet rendering, which is what we reserve for here.
 */
export function buildXIntentUrl(args: {
  headline: string;
  pageUrl: string;
  handle?: string;
  hashtags?: string[];
}): string {
  const { pageUrl, handle, hashtags } = args;

  // What the hashtags render as inside the tweet (`#a #b`), and their whole cost incl. a
  // leading space separating them from the text. Empty/absent → no reservation.
  const tags = (hashtags ?? []).filter((h) => h.length > 0);
  const hashtagsCost = tags.length ? 1 + tags.map((t) => `#${t}`).join(" ").length : 0;

  // Budget for the text: total minus the wrapped url (+ a space) minus the hashtags.
  const textBudget = TWEET_MAX - TCO_URL_LENGTH - 1 - hashtagsCost;
  const text = truncateForTweet(args.headline, Math.max(0, textBudget));

  const params = new URLSearchParams();
  params.set("text", text);
  params.set("url", pageUrl);
  if (tags.length) params.set("hashtags", tags.join(","));
  if (handle) params.set("via", handle);

  return `https://x.com/intent/tweet?${params.toString()}`;
}

/**
 * Build a LinkedIn share URL (companion to buildXIntentUrl) that opens LinkedIn's composer
 * prefilled with a story: `https://www.linkedin.com/feed/?shareActive=true&text=…`. The text
 * is the headline followed by the story's absolute landing-page URL on its own line; because
 * that URL is present in the body, LinkedIn resolves the page's OG tags and auto-attaches the
 * brick-image card — the same landing page X reads, so both platforms show our art.
 *
 * Unlike X there is no 280-char budget (LinkedIn posts are long-form) and no `via`/`hashtags`
 * params, so this stays deliberately simpler: no truncation. Encoded via URLSearchParams so the
 * newline and any punctuation in the headline are escaped correctly.
 */
export function buildLinkedInIntentUrl(args: { headline: string; pageUrl: string }): string {
  const params = new URLSearchParams();
  params.set("shareActive", "true");
  params.set("text", `${args.headline}\n\n${args.pageUrl}`);
  return `https://www.linkedin.com/feed/?${params.toString()}`;
}

/**
 * Truncate a headline to fit `max` characters, appending a single "…" when it was cut (the
 * ellipsis counts toward `max`). Never throws; a `max` of 0 yields "".
 */
export function truncateForTweet(headline: string, max: number): string {
  if (headline.length <= max) return headline;
  if (max <= 1) return max <= 0 ? "" : "…";
  return `${headline.slice(0, max - 1).trimEnd()}…`;
}
