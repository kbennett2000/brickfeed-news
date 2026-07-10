import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Manifest } from "./types.js";

export const MANIFEST_VERSION = 1;

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, stories: {} };
}

/**
 * Read the manifest from disk. A missing file is normal on first run and yields
 * an empty manifest. A present-but-corrupt file also degrades to empty rather
 * than throwing, so a bad write never bricks all future runs.
 */
export async function readManifest(path: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return emptyManifest();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.stories !== "object") {
      return emptyManifest();
    }
    return {
      version: typeof parsed.version === "number" ? parsed.version : MANIFEST_VERSION,
      stories: parsed.stories as Manifest["stories"],
    };
  } catch {
    return emptyManifest();
  }
}

/**
 * Write the manifest atomically: write a temp file then rename over the target,
 * so a crash mid-write can't leave a half-written (corrupt) manifest.
 */
export async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}
