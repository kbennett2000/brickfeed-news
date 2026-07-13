/**
 * Persona headshot processing (ADR-0013 decision 8 + its 2026-07-13 amendment).
 *
 * Each persona's source portrait lives by convention at `assets/headshots/<name>.png` —
 * a large PNG that exists only on the production box (`assets/` is git-ignored; the repo
 * stays text-only). This module pushes each source through the same optimization + storage
 * path story images use, emitting ONE square 256×256 avatar (~128 px display, 2× for
 * retina) per persona, and records the durable URL in a small derived manifest that the
 * future opinion render resolves persona → avatarUrl from.
 *
 * Idempotency is a sha256 content hash of the SOURCE bytes: a persona whose hash matches
 * its manifest entry is skipped outright — no reprocess, no re-upload — so the steady-state
 * cost of running this at the start of every site write is six hash checks. `force`
 * reprocesses regardless.
 *
 * Everything here is tolerant (ads/articles semantics): a missing PNG, an undecodable
 * source, or a failed upload warns and skips that persona — and PRESERVES any existing
 * manifest entry, so the last-published avatar keeps rendering and the next run retries.
 * A headshot problem must never break a publish cycle.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AVATAR_SIZE_PX, cropSquareAvatar } from "./image/optimize.js";
import { loadPersonas, type Persona } from "./personas.js";
import type { StorageProvider } from "./types.js";

/** The by-convention folder persona source portraits live in (git-ignored, box-only). */
export const HEADSHOTS_DIR = "assets/headshots";

/**
 * Where the derived persona → avatar manifest lives. A module constant (like ADS_DIR /
 * PERSONAS_DIR), not config: it's derived state under the git-ignored `data/`, same
 * family as `data/manifest.json` / `data/published.json`.
 */
export const HEADSHOTS_MANIFEST_PATH = "data/headshots.json";

export const HEADSHOT_MANIFEST_VERSION = 1;

/** One processed headshot: the source it came from and the published avatar it yielded. */
export interface HeadshotEntry {
  /** Persona name (=== persona file basename === headshot basename). */
  persona: string;
  /** sha256 hex of the SOURCE png bytes — the idempotency key. */
  sourceHash: string;
  /** Durable public URL of the published 256×256 avatar. */
  avatarUrl: string;
  /** ISO timestamp of when this entry was (re)processed. */
  processedAt: string;
}

export interface HeadshotManifest {
  version: number;
  /** Keyed by persona name. */
  headshots: Record<string, HeadshotEntry>;
}

export function emptyHeadshotManifest(): HeadshotManifest {
  return { version: HEADSHOT_MANIFEST_VERSION, headshots: {} };
}

/**
 * Read the headshot manifest. Missing file (normal on first run) or corrupt/mis-shaped
 * JSON degrades to an empty manifest rather than throwing — a bad write never bricks
 * future runs (same contract as src/manifest.ts).
 */
export async function readHeadshotManifest(path: string): Promise<HeadshotManifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return emptyHeadshotManifest();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<HeadshotManifest>;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.headshots !== "object") {
      return emptyHeadshotManifest();
    }
    return {
      version: typeof parsed.version === "number" ? parsed.version : HEADSHOT_MANIFEST_VERSION,
      headshots: parsed.headshots as HeadshotManifest["headshots"],
    };
  } catch {
    return emptyHeadshotManifest();
  }
}

/** Write the manifest atomically (temp file + rename), mirroring writeManifest. */
export async function writeHeadshotManifest(
  path: string,
  manifest: HeadshotManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

/** sha256 hex of raw bytes (src/id.ts hashes URLs the same way). */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The skip/process decision: process when forced, new, or the source bytes changed. */
export function shouldProcess(
  entry: HeadshotEntry | undefined,
  sourceHash: string,
  force: boolean,
): boolean {
  return force || !entry || entry.sourceHash !== sourceHash;
}

/** Injectable IO boundaries (default to the real fs/store); tests pass in-memory fakes. */
export interface HeadshotsDeps {
  loadPersonas: () => Promise<Persona[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  readManifest: (path: string) => Promise<HeadshotManifest>;
  writeManifest: (path: string, manifest: HeadshotManifest) => Promise<void>;
  now: () => Date;
  log: (message: string) => void;
}

const defaultDeps: HeadshotsDeps = {
  loadPersonas: () => loadPersonas(),
  readFile: (path) => readFile(path),
  readManifest: readHeadshotManifest,
  writeManifest: writeHeadshotManifest,
  now: () => new Date(),
  log: (message) => console.warn(message),
};

/** Per-persona outcomes of one run, plus the (possibly updated) manifest. */
export interface HeadshotsResult {
  processed: string[];
  skipped: string[];
  missing: string[];
  failed: string[];
  manifest: HeadshotManifest;
}

/** One-line summary shared by the CLI and the cycle stage line. */
export function summarizeHeadshots(r: HeadshotsResult): string {
  return (
    `${r.processed.length} processed, ${r.skipped.length} skipped, ` +
    `${r.missing.length} missing, ${r.failed.length} failed`
  );
}

/**
 * Process every persona's headshot: hash-gate against the manifest, square-crop changed
 * sources to 256×256 (lossless intermediate — `storage.put` runs the same WebP-encoding
 * chokepoint story images use), publish under `headshots/<name>` (deterministic
 * overwrite), and persist updated entries. NEVER THROWS — on any unexpected failure it
 * logs and returns the partial result, so both site writers can call it bare.
 */
export async function processHeadshots(
  storage: StorageProvider,
  opts: { manifestPath?: string; dir?: string; force?: boolean } = {},
  deps: Partial<HeadshotsDeps> = {},
): Promise<HeadshotsResult> {
  const io: HeadshotsDeps = { ...defaultDeps, ...deps };
  const manifestPath = opts.manifestPath ?? HEADSHOTS_MANIFEST_PATH;
  const dir = opts.dir ?? HEADSHOTS_DIR;
  const force = opts.force ?? false;

  const result: HeadshotsResult = {
    processed: [],
    skipped: [],
    missing: [],
    failed: [],
    manifest: emptyHeadshotManifest(),
  };

  try {
    const personas = await io.loadPersonas();
    if (personas.length === 0) return result; // no roster → nothing to do, no manifest write

    const manifest = await io.readManifest(manifestPath);
    result.manifest = manifest;

    for (const { name } of personas) {
      const sourcePath = `${dir}/${name}.png`;

      let source: Uint8Array;
      try {
        source = await io.readFile(sourcePath);
      } catch {
        // Normal on a box without the assets (fresh clone / CI); the existing entry —
        // and its live avatar — is preserved.
        io.log(`headshots: ${name} skipped — ${sourcePath} not found`);
        result.missing.push(name);
        continue;
      }

      const sourceHash = hashBytes(source);
      if (!shouldProcess(manifest.headshots[name], sourceHash, force)) {
        result.skipped.push(name);
        continue;
      }

      const avatar = await cropSquareAvatar(source, AVATAR_SIZE_PX);
      if (!avatar) {
        io.log(`headshots: ${name} failed — source is not a decodable image`);
        result.failed.push(name);
        continue;
      }

      const url = await storage.put(`headshots/${name}`, avatar, "image/png");
      if (!url) {
        // Entry untouched: the old avatar keeps rendering; the hash mismatch persists,
        // so the next run retries the upload.
        io.log(`headshots: ${name} failed — avatar upload failed (no URL)`);
        result.failed.push(name);
        continue;
      }

      manifest.headshots[name] = {
        persona: name,
        sourceHash,
        avatarUrl: url,
        processedAt: io.now().toISOString(),
      };
      result.processed.push(name);
    }

    if (result.processed.length > 0) {
      await io.writeManifest(manifestPath, manifest);
    }
  } catch (err) {
    io.log(`headshots: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
