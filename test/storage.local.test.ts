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
