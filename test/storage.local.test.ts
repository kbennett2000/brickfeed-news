import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorageProvider } from "../src/storage/local.js";
import { bytes, fakeStorageFs } from "./helpers.js";

const PUBLIC_BASE = "http://storage.test/blob";
const PNG = bytes("\x89PNG...local...");

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "brickfeed-local-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("LocalStorageProvider — real filesystem round-trip", () => {
  it("writes the bytes and returns publicBaseUrl/<id>.png, then deletes them", async () => {
    const dir = await tempDir();
    const provider = new LocalStorageProvider({ dir, publicBaseUrl: PUBLIC_BASE });

    const url = await provider.put("abc", PNG, "image/png");
    expect(url).toBe(`${PUBLIC_BASE}/abc.png`);

    // The file really landed on disk with the right bytes.
    const onDisk = await readFile(join(dir, "abc.png"));
    expect(new Uint8Array(onDisk)).toEqual(PNG);

    await provider.delete("abc");
    await expect(readFile(join(dir, "abc.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("trims a trailing slash on the base URL", async () => {
    const dir = await tempDir();
    const provider = new LocalStorageProvider({ dir, publicBaseUrl: `${PUBLIC_BASE}/` });
    expect(await provider.put("abc", PNG, "image/png")).toBe(`${PUBLIC_BASE}/abc.png`);
  });

  it("stores JPEG bytes under a .jpg name and deletes them (extension follows content-type)", async () => {
    const dir = await tempDir();
    const provider = new LocalStorageProvider({ dir, publicBaseUrl: PUBLIC_BASE });
    const jpeg = bytes("\xff\xd8\xff...jpeg...");

    const url = await provider.put("xyz", jpeg, "image/jpeg");
    expect(url).toBe(`${PUBLIC_BASE}/xyz.jpg`);
    expect(new Uint8Array(await readFile(join(dir, "xyz.jpg")))).toEqual(jpeg);

    // delete only gets the id, yet still removes the real .jpg artifact.
    await provider.delete("xyz");
    await expect(readFile(join(dir, "xyz.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a RELATIVE url when publicBaseUrl is a relative path (resolves under the served site)", async () => {
    // The keyless default: dir inside site/, base "images" → src="images/<id>.jpg" that
    // resolves against the site root when Vercel serves site/ statically.
    const dir = await tempDir();
    const provider = new LocalStorageProvider({ dir, publicBaseUrl: "images" });
    expect(await provider.put("story7", PNG, "image/png")).toBe("images/story7.png");
  });
});

describe("LocalStorageProvider.exists — the file must really be present and non-zero", () => {
  it("returns true for a stored non-zero file (by its imageUrl), false after delete", async () => {
    const dir = await tempDir();
    const provider = new LocalStorageProvider({ dir, publicBaseUrl: "images" });
    const url = await provider.put("abc", PNG, "image/png"); // "images/abc.png"

    expect(await provider.exists("abc", url!)).toBe(true);

    await provider.delete("abc");
    expect(await provider.exists("abc", url!)).toBe(false);
  });

  it("returns false for a missing file and for a zero-length file", async () => {
    const dir = await tempDir();
    const provider = new LocalStorageProvider({ dir, publicBaseUrl: "images" });

    expect(await provider.exists("nope", "images/nope.png")).toBe(false);

    await provider.put("empty", new Uint8Array(0), "image/png");
    expect(await provider.exists("empty", "images/empty.png")).toBe(false); // present but zero bytes
  });

  it("without an imageUrl, probes every candidate extension (finds the real .jpg)", async () => {
    const dir = await tempDir();
    const provider = new LocalStorageProvider({ dir, publicBaseUrl: "images" });
    await provider.put("j", bytes("\xff\xd8\xff...jpeg..."), "image/jpeg"); // → j.jpg
    expect(await provider.exists("j")).toBe(true);
    expect(await provider.exists("absent")).toBe(false);
  });
});

describe("LocalStorageProvider.preflight — deterministic, fail-loud dir check", () => {
  it("is ok when the dir is writable", async () => {
    const dir = await tempDir();
    const provider = new LocalStorageProvider({ dir, publicBaseUrl: "images" });
    expect(await provider.preflight()).toEqual({ ok: true });
  });

  it("fails with an actionable message when the dir is not writable", async () => {
    const fs = fakeStorageFs({ failWrite: true });
    const provider = new LocalStorageProvider({ dir: "/read-only", publicBaseUrl: "images", fs });
    const result = await provider.preflight();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("/read-only");
      expect(result.message).toContain("storage.local.dir");
    }
  });
});

describe("LocalStorageProvider — never-throw failure modes", () => {
  it("returns null when the write fails", async () => {
    const fs = fakeStorageFs({ failWrite: true });
    const provider = new LocalStorageProvider({ dir: "/whatever", publicBaseUrl: PUBLIC_BASE, fs });
    expect(await provider.put("abc", PNG, "image/png")).toBeNull();
  });

  it("delete of a missing file is non-fatal (ENOENT swallowed)", async () => {
    const fs = fakeStorageFs();
    const provider = new LocalStorageProvider({ dir: "/whatever", publicBaseUrl: PUBLIC_BASE, fs });
    await expect(provider.delete("nope")).resolves.toBeUndefined();
  });

  it("delete that throws a non-ENOENT error is still non-fatal", async () => {
    const fs = fakeStorageFs({ failUnlink: true });
    const provider = new LocalStorageProvider({ dir: "/whatever", publicBaseUrl: PUBLIC_BASE, fs });
    await expect(provider.delete("abc")).resolves.toBeUndefined();
  });
});
