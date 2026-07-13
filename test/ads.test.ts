import { describe, expect, it } from "vitest";
import { loadAds, parseAdSidecar } from "../src/ads.js";
import { fakeStorageProvider } from "./helpers.js";

/** PNG magic bytes so detectImageContentType returns image/png. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
/** JPEG magic bytes so detectImageContentType returns image/jpeg. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0]);

/**
 * Build injectable IO deps over in-memory maps — no real disk. `files` maps a full path
 * (e.g. "assets/ads/ad-01.md") to its contents (string for .md, bytes for images).
 */
function fakeIo(dir: string, files: Record<string, string | Uint8Array>) {
  const names = Object.keys(files).map((p) => p.slice(dir.length + 1));
  const logs: string[] = [];
  return {
    logs,
    deps: {
      readdir: async (d: string) => {
        if (d !== dir) throw new Error(`unexpected dir ${d}`);
        return names;
      },
      readFile: async (path: string) => {
        const f = files[path];
        if (f === undefined) throw new Error(`ENOENT ${path}`);
        return typeof f === "string" ? new TextEncoder().encode(f) : f;
      },
      readText: async (path: string) => {
        const f = files[path];
        if (f === undefined) throw new Error(`ENOENT ${path}`);
        return typeof f === "string" ? f : new TextDecoder().decode(f);
      },
      log: (m: string) => logs.push(m),
    },
  };
}

const DIR = "assets/ads";

describe("loadAds", () => {
  it("uploads paired image+md and returns an AdView with the stored URL and .md link", async () => {
    const storage = fakeStorageProvider({ put: (id) => `https://cdn.test/${id}.png` });
    const { deps } = fakeIo(DIR, {
      "assets/ads/ad-01.png": PNG,
      "assets/ads/ad-01.md": "https://github.com/kbennett2000/slopify\n",
    });

    const ads = await loadAds(DIR, storage, deps);

    expect(ads).toEqual([
      {
        imageUrl: "https://cdn.test/ads/ad-01.png",
        href: "https://github.com/kbennett2000/slopify",
        alt: "Advertisement — github.com",
        durationMs: 7000,
      },
    ]);
    // Uploaded under an ads/ key (namespaced away from story hashes), with sniffed type.
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]).toMatchObject({ id: "ads/ad-01", contentType: "image/png" });
  });

  it("returns ads in ascending basename order regardless of readdir order", async () => {
    const storage = fakeStorageProvider();
    const { deps } = fakeIo(DIR, {
      "assets/ads/ad-02.jpg": JPEG,
      "assets/ads/ad-02.md": "https://example.com/two",
      "assets/ads/ad-01.png": PNG,
      "assets/ads/ad-01.md": "https://example.com/one",
    });

    const ads = await loadAds(DIR, storage, deps);

    expect(ads.map((a) => a.href)).toEqual(["https://example.com/one", "https://example.com/two"]);
  });

  it("skips a basename with a .md but no image, warning by name (ADR-0017)", async () => {
    const storage = fakeStorageProvider();
    const { deps, logs } = fakeIo(DIR, {
      "assets/ads/ad-01.png": PNG,
      "assets/ads/ad-01.md": "https://example.com/one",
      "assets/ads/ad-03.md": "https://example.com/three", // md only, image pending
    });

    const ads = await loadAds(DIR, storage, deps);

    expect(ads.map((a) => a.href)).toEqual(["https://example.com/one"]);
    expect(storage.puts.map((p) => p.id)).toEqual(["ads/ad-01"]);
    expect(logs.join("\n")).toContain("ad-03 skipped — no image asset");
  });

  it("skips an image with no .md sidecar", async () => {
    const storage = fakeStorageProvider();
    const { deps } = fakeIo(DIR, { "assets/ads/ad-09.png": PNG });

    expect(await loadAds(DIR, storage, deps)).toEqual([]);
    expect(storage.puts).toHaveLength(0);
  });

  it("skips a pair whose .md is not an http(s) link", async () => {
    const storage = fakeStorageProvider();
    const { deps, logs } = fakeIo(DIR, {
      "assets/ads/ad-01.png": PNG,
      "assets/ads/ad-01.md": "not a url",
    });

    expect(await loadAds(DIR, storage, deps)).toEqual([]);
    expect(storage.puts).toHaveLength(0); // never uploaded — link validated first
    expect(logs.join("\n")).toContain("ad-01 skipped");
  });

  it("skips an ad whose image upload fails (put returns null), never throwing", async () => {
    const storage = fakeStorageProvider({ put: () => null }); // e.g. no token
    const { deps, logs } = fakeIo(DIR, {
      "assets/ads/ad-01.png": PNG,
      "assets/ads/ad-01.md": "https://example.com/one",
    });

    expect(await loadAds(DIR, storage, deps)).toEqual([]);
    expect(logs.join("\n")).toContain("upload failed");
  });

  it("returns [] when the ads folder does not exist", async () => {
    const storage = fakeStorageProvider();
    const deps = {
      readdir: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      readFile: async () => new Uint8Array(),
      readText: async () => "",
      log: () => {},
    };

    expect(await loadAds(DIR, storage, deps)).toEqual([]);
    expect(storage.puts).toHaveLength(0);
  });

  it("skips an ad with an invalid duration line, warning by name, and never uploads it", async () => {
    const storage = fakeStorageProvider();
    const { deps, logs } = fakeIo(DIR, {
      "assets/ads/ad-01.png": PNG,
      "assets/ads/ad-01.md": "https://example.com/one\nduration: 0",
      "assets/ads/ad-02.jpg": JPEG,
      "assets/ads/ad-02.md": "https://example.com/two\nduration: 12",
    });

    const ads = await loadAds(DIR, storage, deps);

    expect(ads.map((a) => [a.href, a.durationMs])).toEqual([["https://example.com/two", 12000]]);
    expect(storage.puts.map((p) => p.id)).toEqual(["ads/ad-02"]); // bad ad validated before upload
    expect(logs.join("\n")).toContain('ad-01 skipped — invalid duration "0"');
  });
});

describe("parseAdSidecar (ADR-0017 strict contract)", () => {
  it("accepts a bare URL with the 7s default duration", () => {
    expect(parseAdSidecar("https://example.com/x\n")).toEqual({
      href: "https://example.com/x",
      durationMs: 7000,
    });
  });

  it("accepts a duration line, case-insensitively, with surrounding blank lines and notes", () => {
    expect(parseAdSidecar("\n https://example.com/x \n\nnote to self\nDuration: 12.5\n")).toEqual({
      href: "https://example.com/x",
      durationMs: 12500,
    });
  });

  it("accepts the bounds exactly (2 and 60 seconds)", () => {
    expect(parseAdSidecar("https://e.com\nduration: 2")).toEqual({
      href: "https://e.com",
      durationMs: 2000,
    });
    expect(parseAdSidecar("https://e.com\nduration: 60")).toEqual({
      href: "https://e.com",
      durationMs: 60000,
    });
  });

  const rejects: Array<[string, string, string]> = [
    ["empty file", "", "no http(s) link"],
    ["non-http first line", "ftp://example.com/x", "no http(s) link"],
    ["zero duration", "https://e.com\nduration: 0", 'invalid duration "0"'],
    ["negative duration", "https://e.com\nduration: -3", 'invalid duration "-3"'],
    ["non-numeric duration", "https://e.com\nduration: abc", 'invalid duration "abc"'],
    ["empty duration", "https://e.com\nduration:", 'invalid duration ""'],
    ["below bounds", "https://e.com\nduration: 1.9", 'invalid duration "1.9"'],
    ["above bounds", "https://e.com\nduration: 999", 'invalid duration "999"'],
    ["Infinity", "https://e.com\nduration: Infinity", 'invalid duration "Infinity"'],
  ];
  for (const [name, text, reason] of rejects) {
    it(`rejects ${name} with a named reason`, () => {
      const parsed = parseAdSidecar(text);
      expect("error" in parsed).toBe(true);
      if ("error" in parsed) expect(parsed.error).toContain(reason);
    });
  }

  it("ignores non-duration extra lines (documented back-compat)", () => {
    expect(parseAdSidecar("https://e.com\nsome note\nanother note")).toEqual({
      href: "https://e.com",
      durationMs: 7000,
    });
  });
});
