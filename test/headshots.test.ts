import { existsSync } from "node:fs";
import { mkdtemp, readFile as fsReadFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  emptyHeadshotManifest,
  hashBytes,
  processHeadshots,
  readHeadshotManifest,
  shouldProcess,
  summarizeHeadshots,
  writeHeadshotManifest,
  type HeadshotEntry,
  type HeadshotManifest,
  type HeadshotsDeps,
} from "../src/headshots.js";
import { AVATAR_SIZE_PX, cropSquareAvatar } from "../src/image/optimize.js";
import { detectImageContentType } from "../src/image.js";
import { loadPersonas, type Persona } from "../src/personas.js";
import { withImageOptimization } from "../src/storage/optimizing.js";
import { fakeStorageProvider } from "./helpers.js";

/** Build a real PNG buffer of the given size (the optimize.test.ts pattern — no fixtures). */
async function makePng(width: number, height: number, r = 200): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

describe("cropSquareAvatar", () => {
  it.each([
    ["landscape", 400, 300],
    ["portrait", 300, 400],
    ["oversized square", 1024, 1024],
    ["too-small (upscaled — avatars must be uniform)", 100, 80],
  ])("center-crops a %s source to exactly 256×256 PNG", async (_label, w, h) => {
    const out = await cropSquareAvatar(await makePng(w, h), AVATAR_SIZE_PX);
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  it("returns null on undecodable bytes (skip, never a multi-MB passthrough)", async () => {
    const junk = new TextEncoder().encode("not an image at all");
    expect(await cropSquareAvatar(junk, AVATAR_SIZE_PX)).toBeNull();
  });
});

describe("headshot manifest store", () => {
  const dirs: string[] = [];
  async function tmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "headshots-test-"));
    dirs.push(dir);
    return dir;
  }
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("missing file → empty manifest", async () => {
    const path = join(await tmpDir(), "nope", "headshots.json");
    expect(await readHeadshotManifest(path)).toEqual(emptyHeadshotManifest());
  });

  it("corrupt or mis-shaped JSON → empty manifest (never throws)", async () => {
    const dir = await tmpDir();
    const corrupt = join(dir, "corrupt.json");
    await writeFile(corrupt, "{ not json", "utf8");
    expect(await readHeadshotManifest(corrupt)).toEqual(emptyHeadshotManifest());

    const misshaped = join(dir, "misshaped.json");
    await writeFile(misshaped, JSON.stringify({ version: 1, stories: {} }), "utf8");
    expect(await readHeadshotManifest(misshaped)).toEqual(emptyHeadshotManifest());
  });

  it("write → read round-trips (atomic temp+rename, no stray .tmp)", async () => {
    const path = join(await tmpDir(), "data", "headshots.json");
    const manifest: HeadshotManifest = {
      version: 1,
      headshots: {
        alice: {
          persona: "alice",
          sourceHash: "abc123",
          avatarUrl: "https://cdn.test/headshots/alice.webp",
          processedAt: "2026-07-13T00:00:00.000Z",
        },
      },
    };
    await writeHeadshotManifest(path, manifest);
    expect(await readHeadshotManifest(path)).toEqual(manifest);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

describe("shouldProcess", () => {
  const entry: HeadshotEntry = {
    persona: "alice",
    sourceHash: "hash-a",
    avatarUrl: "https://cdn.test/x.webp",
    processedAt: "2026-07-13T00:00:00.000Z",
  };

  it("no entry → process", () => {
    expect(shouldProcess(undefined, "hash-a", false)).toBe(true);
  });
  it("matching sourceHash → skip", () => {
    expect(shouldProcess(entry, "hash-a", false)).toBe(false);
  });
  it("changed sourceHash → process", () => {
    expect(shouldProcess(entry, "hash-b", false)).toBe(true);
  });
  it("force → process even on a matching hash", () => {
    expect(shouldProcess(entry, "hash-a", true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// processHeadshots orchestration — all IO injected, upload seam faked.
// ---------------------------------------------------------------------------

function persona(name: string): Persona {
  return { name, displayName: name, bylineBlurb: "blurb", selectionBias: {}, body: "voice" };
}

/** In-memory deps over a name→png map; records manifest writes and log lines. */
async function makeDeps(names: string[], over: Partial<HeadshotsDeps> = {}) {
  const sources = new Map<string, Uint8Array>();
  for (const [i, name] of names.entries()) {
    sources.set(`assets/headshots/${name}.png`, await makePng(300 + i, 300));
  }
  const state = {
    sources,
    saved: [] as HeadshotManifest[],
    logs: [] as string[],
    manifest: emptyHeadshotManifest(),
  };
  const deps: HeadshotsDeps = {
    loadPersonas: async () => names.map(persona),
    readFile: async (path) => {
      const bytes = sources.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return bytes;
    },
    readManifest: async () => state.manifest,
    writeManifest: async (_path, m) => {
      state.saved.push(structuredClone(m));
      state.manifest = m;
    },
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    log: (m) => state.logs.push(m),
    ...over,
  };
  return { deps, state };
}

describe("processHeadshots", () => {
  it("first run processes + uploads every persona and writes one entry each", async () => {
    const { deps, state } = await makeDeps(["alice", "bob"]);
    const storage = fakeStorageProvider();

    const r = await processHeadshots(storage, {}, deps);

    expect(r.processed).toEqual(["alice", "bob"]);
    expect(r.skipped).toEqual([]);
    expect(storage.puts.map((p) => p.id)).toEqual(["headshots/alice", "headshots/bob"]);
    expect(state.saved).toHaveLength(1);
    expect(r.manifest.headshots.alice).toEqual({
      persona: "alice",
      sourceHash: hashBytes(state.sources.get("assets/headshots/alice.png")!),
      avatarUrl: "https://cdn.test/headshots/alice.png",
      processedAt: "2026-07-13T12:00:00.000Z",
    });
    expect(summarizeHeadshots(r)).toBe("2 processed, 0 skipped, 0 missing, 0 failed");
  });

  it("second run over unchanged sources skips all — no puts, no manifest write", async () => {
    const { deps, state } = await makeDeps(["alice", "bob"]);
    await processHeadshots(fakeStorageProvider(), {}, deps);

    const storage = fakeStorageProvider();
    const r = await processHeadshots(storage, {}, deps);

    expect(r.skipped).toEqual(["alice", "bob"]);
    expect(r.processed).toEqual([]);
    expect(storage.puts).toHaveLength(0);
    expect(state.saved).toHaveLength(1); // only the first run wrote
  });

  it("force reprocesses all despite matching hashes", async () => {
    const { deps } = await makeDeps(["alice", "bob"]);
    await processHeadshots(fakeStorageProvider(), {}, deps);

    const storage = fakeStorageProvider();
    const r = await processHeadshots(storage, { force: true }, deps);

    expect(r.processed).toEqual(["alice", "bob"]);
    expect(storage.puts).toHaveLength(2);
  });

  it("editing one source reprocesses exactly that one", async () => {
    const { deps, state } = await makeDeps(["alice", "bob"]);
    await processHeadshots(fakeStorageProvider(), {}, deps);
    const bobHash = state.manifest.headshots.bob.sourceHash;

    state.sources.set("assets/headshots/alice.png", await makePng(500, 500, 10));
    const storage = fakeStorageProvider();
    const r = await processHeadshots(storage, {}, deps);

    expect(r.processed).toEqual(["alice"]);
    expect(r.skipped).toEqual(["bob"]);
    expect(storage.puts.map((p) => p.id)).toEqual(["headshots/alice"]);
    expect(state.manifest.headshots.bob.sourceHash).toBe(bobHash);
  });

  it("missing PNG warns, counts missing, writes no entry, and continues with the rest", async () => {
    const { deps, state } = await makeDeps(["alice", "bob"]);
    state.sources.delete("assets/headshots/alice.png");

    const r = await processHeadshots(fakeStorageProvider(), {}, deps);

    expect(r.missing).toEqual(["alice"]);
    expect(r.processed).toEqual(["bob"]);
    expect(r.manifest.headshots.alice).toBeUndefined();
    expect(state.logs.some((m) => m.includes("alice") && m.includes("not found"))).toBe(true);
  });

  it("missing PNG for a previously-processed persona preserves its existing entry", async () => {
    const { deps, state } = await makeDeps(["alice", "bob"]);
    await processHeadshots(fakeStorageProvider(), {}, deps);
    const before = structuredClone(state.manifest.headshots.alice);

    state.sources.delete("assets/headshots/alice.png");
    const r = await processHeadshots(fakeStorageProvider(), {}, deps);

    expect(r.missing).toEqual(["alice"]);
    expect(state.manifest.headshots.alice).toEqual(before);
  });

  it("put returning null warns, counts failed, and leaves any existing entry untouched", async () => {
    const { deps, state } = await makeDeps(["alice"]);
    await processHeadshots(fakeStorageProvider(), {}, deps);
    const before = structuredClone(state.manifest.headshots.alice);

    state.sources.set("assets/headshots/alice.png", await makePng(500, 500, 10));
    const storage = fakeStorageProvider({ put: () => null });
    const r = await processHeadshots(storage, {}, deps);

    expect(r.failed).toEqual(["alice"]);
    expect(state.manifest.headshots.alice).toEqual(before);
    expect(state.saved).toHaveLength(1); // no second write
    expect(state.logs.some((m) => m.includes("upload failed"))).toBe(true);
  });

  it("undecodable source bytes count failed, with no upload attempted", async () => {
    const { deps, state } = await makeDeps(["alice"]);
    state.sources.set("assets/headshots/alice.png", new TextEncoder().encode("junk"));

    const storage = fakeStorageProvider();
    const r = await processHeadshots(storage, {}, deps);

    expect(r.failed).toEqual(["alice"]);
    expect(storage.puts).toHaveLength(0);
    expect(state.logs.some((m) => m.includes("not a decodable image"))).toBe(true);
  });

  it("never throws: a writeManifest failure is logged and returned, not thrown", async () => {
    const { deps, state } = await makeDeps(["alice"], {
      writeManifest: async () => {
        throw new Error("disk full");
      },
    });

    const r = await processHeadshots(fakeStorageProvider(), {}, deps);

    expect(r.processed).toEqual(["alice"]);
    expect(state.logs.some((m) => m.includes("disk full"))).toBe(true);
  });

  it("empty persona roster is a no-op (no manifest write)", async () => {
    const { deps, state } = await makeDeps([]);
    const storage = fakeStorageProvider();

    const r = await processHeadshots(storage, {}, deps);

    expect(summarizeHeadshots(r)).toBe("0 processed, 0 skipped, 0 missing, 0 failed");
    expect(storage.puts).toHaveLength(0);
    expect(state.saved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end over the REAL source PNGs + the REAL optimization chokepoint.
// assets/ is git-ignored, so this only runs on the production box (fresh
// clone/CI skips it) — the upload seam stays faked, so still no network.
// ---------------------------------------------------------------------------

const realHeadshotsDir = fileURLToPath(new URL("../assets/headshots/", import.meta.url));

describe.skipIf(!existsSync(realHeadshotsDir))("real headshots (production box only)", () => {
  it("processes every real PNG into a 256×256 WebP via the story-image chokepoint, then skips", async () => {
    const inner = fakeStorageProvider();
    const storage = withImageOptimization(inner, { maxEdge: 1280, quality: 80 });
    let manifest = emptyHeadshotManifest();
    const deps: Partial<HeadshotsDeps> = {
      readManifest: async () => manifest,
      writeManifest: async (_path, m) => {
        manifest = m;
      },
      log: () => {},
    };

    const personas = await loadPersonas();
    const first = await processHeadshots(storage, {}, { ...deps, readFile: fsReadFile });

    expect(first.processed).toEqual(personas.map((p) => p.name));
    expect(first.missing).toEqual([]);
    expect(first.failed).toEqual([]);
    for (const put of inner.puts) {
      expect(detectImageContentType(put.bytes)).toBe("image/webp");
      const meta = await sharp(put.bytes).metadata();
      expect(meta.width).toBe(AVATAR_SIZE_PX);
      expect(meta.height).toBe(AVATAR_SIZE_PX);
    }

    const second = await processHeadshots(storage, {}, { ...deps, readFile: fsReadFile });
    expect(second.skipped).toEqual(personas.map((p) => p.name));
    expect(inner.puts).toHaveLength(personas.length); // no new uploads
  }, 30_000);
});
