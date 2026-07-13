/**
 * Banner-ad ingestion (the leaderboard the render draws above the news).
 *
 * Ads are creator-managed local files under `assets/ads/`, paired by basename:
 *   ad-01.png  +  ad-01.md   (image bytes + a click-through URL, optionally a duration)
 * An ad is only real when BOTH halves exist — the same "never publish without an image"
 * rule stories follow. A `.md` whose image hasn't landed yet is skipped with a named
 * warning (the operator should hear about a half-delivered ad); an image without a `.md`
 * stays a silent skip — that's the documented "parked creative, not yet live" state.
 *
 * Sidecar parsing is strict in the personas.ts sense (ADR-0017): the optional
 * `duration: <seconds>` line must be a finite number within sane bounds, or the ad is
 * DISQUALIFIED with a named warning — an invalid value is never laundered into the
 * default, and a malformed ad can never enter the rotation with a zero-duration slot.
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

/** Seconds an ad holds on screen when its sidecar doesn't say otherwise. */
export const DEFAULT_AD_SECONDS = 7;

/** Sane bounds for a sidecar-configured duration; outside them the ad is disqualified. */
const MIN_AD_SECONDS = 2;
const MAX_AD_SECONDS = 60;

/** A publishable ad, reduced to what the banner template needs. */
export interface AdView {
  /** Durable image URL (in storage), the banner `<img src>`. */
  imageUrl: string;
  /** Outbound click-through URL from the sibling `.md`; opens in a new tab. */
  href: string;
  /** Accessible label, e.g. "Advertisement — github.com". */
  alt: string;
  /** How long the rotator holds this ad on screen, in milliseconds. */
  durationMs: number;
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

/** What `parseAdSidecar` yields: a valid sidecar, or the named reason it was rejected. */
export type AdSidecar = { href: string; durationMs: number } | { error: string };

/**
 * Parse a `.md` sidecar strictly (never throws). The first non-empty trimmed line must
 * be the http(s) click-through URL. A later non-empty line of the form
 * `duration: <seconds>` sets the hold time, bounded to 2–60 seconds — present-but-invalid
 * is a rejection, not a fallback. Any other extra line is ignored (documented contract:
 * "anything after the first line is ignored"), so notes stay legal.
 */
export function parseAdSidecar(text: string): AdSidecar {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const href = lines[0];
  if (!href || !/^https?:\/\//i.test(href)) {
    return { error: ".md has no http(s) link" };
  }

  let durationMs = DEFAULT_AD_SECONDS * 1000;
  for (const line of lines.slice(1)) {
    const match = /^duration:(.*)$/i.exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    const seconds = Number(raw);
    if (
      raw.length === 0 ||
      !Number.isFinite(seconds) ||
      seconds < MIN_AD_SECONDS ||
      seconds > MAX_AD_SECONDS
    ) {
      return {
        error: `invalid duration "${raw}" (want ${MIN_AD_SECONDS}-${MAX_AD_SECONDS} seconds)`,
      };
    }
    durationMs = Math.round(seconds * 1000);
  }

  return { href, durationMs };
}

/**
 * Read `dir`, pair image+`.md` files by basename, upload each image to `storage` under an
 * `ads/<basename>` key, and return the publishable ads in ascending basename order. A
 * missing folder, an unpaired file, an invalid sidecar, or a failed upload each drop that
 * ad (or yield an empty list) rather than throwing; every disqualified ad that has a
 * sidecar is named in a warning.
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

  for (const base of [...links].sort()) {
    if (!images.has(base)) {
      io.log(`ads: ${base} skipped — no image asset (${IMAGE_EXTS.join("/")})`);
    }
  }

  const basenames = [...images.keys()].filter((b) => links.has(b)).sort();

  const ads: AdView[] = [];
  for (const base of basenames) {
    const imageFile = images.get(base)!;
    try {
      const parsed = parseAdSidecar(await io.readText(`${dir}/${base}.md`));
      if ("error" in parsed) {
        io.log(`ads: ${base} skipped — ${parsed.error}`);
        continue;
      }

      const bytes = await io.readFile(`${dir}/${imageFile}`);
      const contentType = detectImageContentType(bytes);
      const url = await storage.put(`ads/${base}`, bytes, contentType);
      if (!url) {
        io.log(`ads: ${base} skipped — image upload failed (no URL)`);
        continue;
      }

      const host = hostOf(parsed.href);
      ads.push({
        imageUrl: url,
        href: parsed.href,
        alt: host ? `Advertisement — ${host}` : "Advertisement",
        durationMs: parsed.durationMs,
      });
    } catch (err) {
      io.log(`ads: ${base} skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return ads;
}
