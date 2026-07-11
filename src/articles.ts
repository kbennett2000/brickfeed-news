/**
 * Locally hosted articles (ADR-0010): first-class stories whose full text lives ON brickfeed
 * instead of linking out to a publisher. Like ads, they are creator-managed local files under
 * `assets/articles/`, paired by basename:
 *   article-01.jpg  +  article-01.md   (image bytes + structured metadata + a markdown body)
 * An article is only real when BOTH halves exist — the same "never publish without an image"
 * rule stories and ads follow, so a `.md` whose image hasn't landed yet is silently skipped.
 *
 * Unlike an ad (a bare click-through URL), an article's `.md` is a small structured document:
 *   Headline / Byline / Description / Section / Main Page Rank / SubPage Rank / Expires / Body
 * The ranks place the article at a chosen slot on the cover (Main Page Rank) and on its
 * section sub-page (SubPage Rank); Expires takes it down; Body is the markdown shown on the
 * article's own hosted page (reusing the `s/<id>.html` landing page — ADR-0009).
 *
 * Like ads and story images, article IMAGES never live in git (the repo stays text-only;
 * `assets/` is git-ignored). This module uploads each image to storage under an `articles/…`
 * key and returns durable, referenceable views. The upload is deterministic/overwrite-in-place,
 * so re-running a cycle re-publishes edits.
 *
 * Everything here is tolerant: a malformed pair, an unreadable file, a body-less/headline-less
 * `.md`, or a failed upload drops that one article — a bad article must never break a cycle.
 * Parsing (`parseArticle`) is a pure, unit-testable seam; IO boundaries are injected.
 */
import { readFile as fsReadFile, readdir as fsReaddir } from "node:fs/promises";
import { normalizeCategory, type Category } from "./category.js";
import { detectImageContentType } from "./image.js";
import type { StorageProvider } from "./types.js";

/** The default folder articles are dropped into (relative to the run's cwd). */
export const ARTICLES_DIR = "assets/articles";

/** Image extensions an article may use; anything else in the folder is ignored. */
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];

/** A locally hosted article, parsed and (once loaded) backed by a durable image URL. */
export interface Article {
  /** Basename of the pair, e.g. "article-01" — the `s/<id>.html` page id and internal link. */
  id: string;
  headline: string;
  /** The article's own byline (shown verbatim, not the decorative "By the … Desk"). */
  byline: string;
  /** Optional short teaser for cards; "" when the `.md` omits Description. */
  description: string;
  /** Section, normalized to one of the fixed CATEGORIES (defaults to WORLD). */
  category: Category;
  /** Cover placement: 1 = first story, 2 = second, … ; 0 = unranked. Clamped to ≥ 0. */
  mainRank: number;
  /** Section-page placement, same semantics as mainRank but within its section. */
  subRank: number;
  /** Take-down date (end of that day); undefined when absent/unparseable → never expires. */
  expires?: Date;
  /** Raw markdown body; rendered to HTML by the render core for the hosted page. */
  bodyMarkdown: string;
  /** Durable image URL (in storage). Absent until loadArticles uploads it. */
  imageUrl: string;
}

/** Injectable IO boundaries (default to node:fs/promises); tests pass in-memory fakes. */
export interface ArticlesDeps {
  readdir: (dir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  readText: (path: string) => Promise<string>;
  log: (message: string) => void;
}

const defaultDeps: ArticlesDeps = {
  readdir: (dir) => fsReaddir(dir),
  readFile: (path) => fsReadFile(path),
  readText: (path) => fsReadFile(path, "utf8"),
  log: (message) => console.warn(message),
};

function extname(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function basenameNoExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
}

/** Normalize a field key for tolerant matching: lowercase, collapse internal whitespace. */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Parse a rank value: a non-negative integer, defaulting to 0 on absent/invalid/negative. */
function parseRank(value: string | undefined): number {
  if (value === undefined) return 0;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Parse an `Expires` value in `MM.DD.YYYY` form to a Date at the END of that day (23:59:59.999
 * UTC), so an article shows through its whole expiry day. Returns undefined for a missing or
 * unparseable value — an article with no valid expiry never comes down on its own.
 */
function parseExpires(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const m = value.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return undefined;
  const [, mm, dd, yyyy] = m;
  const month = Number(mm);
  const day = Number(dd);
  const year = Number(yyyy);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  const d = new Date(ms);
  // Reject overflow (e.g. 02.30) — Date.UTC rolls it into the next month.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  return d;
}

/**
 * Parse an article `.md` into everything but its (yet-to-be-uploaded) image URL. Pure and
 * unit-testable. The document is split at the first line whose key is `Body`: the lines above
 * are `Key: value` metadata (keys matched case-insensitively and whitespace-tolerantly, so
 * both `SubPage Rank` and `Sub Page Rank` work), and everything after that line is the raw
 * markdown body. Returns null (skip this article) when the required `Headline` is missing.
 */
export function parseArticle(text: string, id: string): Omit<Article, "imageUrl"> | null {
  const lines = text.split(/\r?\n/);
  const fields = new Map<string, string>();
  const bodyLines: string[] = [];
  let inBody = false;

  for (const line of lines) {
    if (inBody) {
      bodyLines.push(line);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      // A non-field line before Body: (e.g. a blank separator) — ignore it.
      continue;
    }
    const key = normalizeKey(line.slice(0, colon));
    const value = line.slice(colon + 1).trim();
    if (key === "body") {
      inBody = true;
      // Anything on the same line after "Body:" starts the body.
      if (value.length > 0) bodyLines.push(value);
      continue;
    }
    if (key.length > 0) fields.set(key, value);
  }

  const headline = fields.get("headline")?.trim() ?? "";
  if (headline.length === 0) return null;

  return {
    id,
    headline,
    byline: fields.get("byline") ?? "",
    description: fields.get("description") ?? "",
    category: normalizeCategory(fields.get("section")),
    mainRank: parseRank(fields.get("main page rank")),
    // Accept both the file's "SubPage Rank" and the spec's "Sub Page Rank".
    subRank: parseRank(fields.get("subpage rank") ?? fields.get("sub page rank")),
    expires: parseExpires(fields.get("expires")),
    bodyMarkdown: bodyLines.join("\n").trim(),
  };
}

/**
 * Read `dir`, pair image+`.md` files by basename, parse each `.md`, upload each image to
 * `storage` under an `articles/<basename>` key, and return the loaded articles in ascending
 * basename order. A missing folder, an unpaired file, an unparseable/headline-less `.md`, or a
 * failed upload each drop that one article (or yield an empty list) rather than throwing.
 * Expiry is intentionally NOT applied here — the pure render core filters expired articles
 * against its injected `now`.
 */
export async function loadArticles(
  dir: string = ARTICLES_DIR,
  storage: StorageProvider,
  deps: Partial<ArticlesDeps> = {},
): Promise<Article[]> {
  const io: ArticlesDeps = { ...defaultDeps, ...deps };

  let entries: string[];
  try {
    entries = await io.readdir(dir);
  } catch {
    // No articles folder (or unreadable) → no local articles. Not an error.
    return [];
  }

  // Group by basename: which basenames have an image, and which have a .md.
  const images = new Map<string, string>(); // basename → image filename
  const metas = new Set<string>(); // basenames that have a .md
  for (const name of entries) {
    const ext = extname(name);
    if (ext === ".md") {
      metas.add(basenameNoExt(name));
    } else if (IMAGE_EXTS.includes(ext)) {
      images.set(basenameNoExt(name), name);
    }
  }

  const basenames = [...images.keys()].filter((b) => metas.has(b)).sort();

  const articles: Article[] = [];
  for (const base of basenames) {
    const imageFile = images.get(base)!;
    try {
      const raw = await io.readText(`${dir}/${base}.md`);
      const parsed = parseArticle(raw, base);
      if (!parsed) {
        io.log(`articles: ${base} skipped — .md has no Headline`);
        continue;
      }

      const bytes = await io.readFile(`${dir}/${imageFile}`);
      const contentType = detectImageContentType(bytes);
      const url = await storage.put(`articles/${base}`, bytes, contentType);
      if (!url) {
        io.log(`articles: ${base} skipped — image upload failed (no URL)`);
        continue;
      }

      articles.push({ ...parsed, imageUrl: url });
    } catch (err) {
      io.log(`articles: ${base} skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return articles;
}
