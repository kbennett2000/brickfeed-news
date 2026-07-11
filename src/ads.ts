/**
 * Banner-ad ingestion (the leaderboard the render draws above the news).
 *
 * Ads are creator-managed local files under `assets/ads/`, paired by basename:
 *   ad-01.png  +  ad-01.md   (image bytes + a single click-through URL)
 * An ad is only real when BOTH halves exist — the same "never publish without an image"
 * rule stories follow, so a `.md` whose image hasn't landed yet is silently skipped.
 *
 * Like story images and the About portrait, ad IMAGES never live in git (the repo stays
 * text-only; `assets/` is git-ignored). This module uploads each image to storage (Blob in
 * production) under an `ads/…` key and returns only durable, referenceable ad views. The
 * upload is deterministic/overwrite-in-place, so re-running a cycle re-publishes edits.
 *
 * Everything here is tolerant: a malformed pair, an unreadable file, or a failed upload
 * drops that one ad — a bad ad must never break a cycle. IO boundaries (readdir/readFile)
 * are injected so the pairing/skip logic is unit-testable with no real disk.
 */
import { readFile as fsReadFile, readdir as fsReaddir } from "node:fs/promises";
import { detectImageContentType } from "./image.js";
import type { StorageProvider } from "./types.js";

/** The default folder ads are dropped into (relative to the run's cwd). */
export const ADS_DIR = "assets/ads";

/** Image extensions an ad may use; anything else in the folder is ignored. */
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];

/** A publishable ad, reduced to what the banner template needs. */
export interface AdView {
  /** Durable image URL (in storage), the banner `<img src>`. */
  imageUrl: string;
  /** Outbound click-through URL from the sibling `.md`; opens in a new tab. */
  href: string;
  /** Accessible label, e.g. "Advertisement — github.com". */
  alt: string;
}

/** Injectable IO boundaries (default to node:fs/promises); tests pass in-memory fakes. */
export interface AdsDeps {
  readdir: (dir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  readText: (path: string) => Promise<string>;
  log: (message: string) => void;
}

const defaultDeps: AdsDeps = {
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

/** Derive a friendly host for alt text; falls back to a generic label on a bad URL. */
function hostOf(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return "";
  }
}

/**
 * Read `dir`, pair image+`.md` files by basename, upload each image to `storage` under an
 * `ads/<basename>` key, and return the publishable ads in ascending basename order. A
 * missing folder, an unpaired file, a non-http link, or a failed upload each drop that ad
 * (or yield an empty list) rather than throwing.
 */
export async function loadAds(
  dir: string = ADS_DIR,
  storage: StorageProvider,
  deps: Partial<AdsDeps> = {},
): Promise<AdView[]> {
  const io: AdsDeps = { ...defaultDeps, ...deps };

  let entries: string[];
  try {
    entries = await io.readdir(dir);
  } catch {
    // No ads folder (or unreadable) → no banner. Not an error.
    return [];
  }

  // Group by basename: which basenames have an image, and which have a .md.
  const images = new Map<string, string>(); // basename → image filename
  const links = new Set<string>(); // basenames that have a .md
  for (const name of entries) {
    const ext = extname(name);
    if (ext === ".md") {
      links.add(basenameNoExt(name));
    } else if (IMAGE_EXTS.includes(ext)) {
      images.set(basenameNoExt(name), name);
    }
  }

  const basenames = [...images.keys()].filter((b) => links.has(b)).sort();

  const ads: AdView[] = [];
  for (const base of basenames) {
    const imageFile = images.get(base)!;
    try {
      const raw = await io.readText(`${dir}/${base}.md`);
      const href = raw
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (!href || !/^https?:\/\//i.test(href)) {
        io.log(`ads: ${base} skipped — .md has no http(s) link`);
        continue;
      }

      const bytes = await io.readFile(`${dir}/${imageFile}`);
      const contentType = detectImageContentType(bytes);
      const url = await storage.put(`ads/${base}`, bytes, contentType);
      if (!url) {
        io.log(`ads: ${base} skipped — image upload failed (no URL)`);
        continue;
      }

      const host = hostOf(href);
      ads.push({ imageUrl: url, href, alt: host ? `Advertisement — ${host}` : "Advertisement" });
    } catch (err) {
      io.log(`ads: ${base} skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return ads;
}
