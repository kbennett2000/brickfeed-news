import { describe, expect, it } from "vitest";
import { loadArticles, parseArticle } from "../src/articles.js";
import { fakeStorageProvider } from "./helpers.js";

/** JPEG magic bytes so detectImageContentType returns image/jpeg. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0]);

const FULL_MD = `Headline: Testing 1-2-3!

Byline: A test to end all tests until the next test, probably

Description: A brief shakedown of the pipeline.

Section: Technology

Main Page Rank: 2

SubPage Rank: 1

Expires: 07.15.2026

Body:
This is a test. For more information please visit [brickfeed.news](https://brickfeed.news)
`;

describe("parseArticle", () => {
  it("parses every field and keeps the raw markdown body", () => {
    const a = parseArticle(FULL_MD, "article-01");
    expect(a).not.toBeNull();
    expect(a!).toMatchObject({
      id: "article-01",
      headline: "Testing 1-2-3!",
      byline: "A test to end all tests until the next test, probably",
      description: "A brief shakedown of the pipeline.",
      category: "TECHNOLOGY",
      mainRank: 2,
      subRank: 1,
    });
    expect(a!.bodyMarkdown).toBe(
      "This is a test. For more information please visit [brickfeed.news](https://brickfeed.news)",
    );
    // Expires end-of-day UTC on 2026-07-15.
    expect(a!.expires?.toISOString()).toBe("2026-07-15T23:59:59.999Z");
  });

  it("returns null when Headline is missing (skip, like a malformed ad)", () => {
    expect(parseArticle("Byline: nobody\n\nBody:\nhi", "x")).toBeNull();
  });

  it("accepts both 'SubPage Rank' and 'Sub Page Rank' spellings", () => {
    const spaced = parseArticle("Headline: H\nSub Page Rank: 3\n\nBody:\nb", "x");
    expect(spaced!.subRank).toBe(3);
    const jammed = parseArticle("Headline: H\nSubPage Rank: 4\n\nBody:\nb", "x");
    expect(jammed!.subRank).toBe(4);
  });

  it("matches keys case-insensitively and tolerates extra whitespace", () => {
    const a = parseArticle("HEADLINE:  H \n  section :  sports \n\nBody:\nb", "x");
    expect(a!.headline).toBe("H");
    expect(a!.category).toBe("SPORTS");
  });

  it("defaults ranks to 0 and clamps negative/invalid to 0", () => {
    expect(parseArticle("Headline: H\n\nBody:\nb", "x")!.mainRank).toBe(0);
    expect(parseArticle("Headline: H\nMain Page Rank: -3\n\nBody:\nb", "x")!.mainRank).toBe(0);
    expect(parseArticle("Headline: H\nMain Page Rank: nope\n\nBody:\nb", "x")!.mainRank).toBe(0);
  });

  it("normalizes an unknown Section to WORLD", () => {
    expect(parseArticle("Headline: H\nSection: Gossip\n\nBody:\nb", "x")!.category).toBe("WORLD");
  });

  it("leaves expires undefined for a missing or unparseable date", () => {
    expect(parseArticle("Headline: H\n\nBody:\nb", "x")!.expires).toBeUndefined();
    expect(parseArticle("Headline: H\nExpires: soon\n\nBody:\nb", "x")!.expires).toBeUndefined();
    expect(parseArticle("Headline: H\nExpires: 02.30.2026\n\nBody:\nb", "x")!.expires).toBeUndefined();
  });

  it("supports a body that begins on the same line as Body:", () => {
    const a = parseArticle("Headline: H\nBody: one line body", "x");
    expect(a!.bodyMarkdown).toBe("one line body");
  });

  it("treats colons inside the body as body text, not fields", () => {
    const a = parseArticle("Headline: H\n\nBody:\nRatio 3:1 holds.", "x");
    expect(a!.bodyMarkdown).toBe("Ratio 3:1 holds.");
    expect(a!.headline).toBe("H");
  });
});

const DIR = "assets/articles";

function fakeIo(files: Record<string, string | Uint8Array>) {
  const names = Object.keys(files).map((p) => p.slice(DIR.length + 1));
  const logs: string[] = [];
  return {
    logs,
    deps: {
      readdir: async (d: string) => {
        if (d !== DIR) throw new Error(`unexpected dir ${d}`);
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

describe("loadArticles", () => {
  it("uploads a paired image+md under an articles/ key and returns the parsed Article", async () => {
    const storage = fakeStorageProvider({ put: (id) => `https://cdn.test/${id}.jpg` });
    const { deps } = fakeIo({
      "assets/articles/article-01.jpg": JPEG,
      "assets/articles/article-01.md": FULL_MD,
    });

    const articles = await loadArticles(DIR, storage, deps);

    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      id: "article-01",
      headline: "Testing 1-2-3!",
      category: "TECHNOLOGY",
      mainRank: 2,
      subRank: 1,
      imageUrl: "https://cdn.test/articles/article-01.jpg",
    });
    expect(storage.puts[0]).toMatchObject({ id: "articles/article-01", contentType: "image/jpeg" });
  });

  it("returns articles in ascending basename order regardless of readdir order", async () => {
    const storage = fakeStorageProvider();
    const { deps } = fakeIo({
      "assets/articles/article-02.jpg": JPEG,
      "assets/articles/article-02.md": "Headline: Two\n\nBody:\nb",
      "assets/articles/article-01.jpg": JPEG,
      "assets/articles/article-01.md": "Headline: One\n\nBody:\nb",
    });

    const articles = await loadArticles(DIR, storage, deps);
    expect(articles.map((a) => a.headline)).toEqual(["One", "Two"]);
  });

  it("skips a basename with a .md but no image (never publish without an image)", async () => {
    const storage = fakeStorageProvider();
    const { deps } = fakeIo({
      "assets/articles/article-01.jpg": JPEG,
      "assets/articles/article-01.md": "Headline: One\n\nBody:\nb",
      "assets/articles/article-03.md": "Headline: Three\n\nBody:\nb", // md only, image pending
    });

    const articles = await loadArticles(DIR, storage, deps);
    expect(articles.map((a) => a.headline)).toEqual(["One"]);
    expect(storage.puts.map((p) => p.id)).toEqual(["articles/article-01"]);
  });

  it("skips (never uploads) a pair whose .md has no Headline", async () => {
    const storage = fakeStorageProvider();
    const { deps, logs } = fakeIo({
      "assets/articles/article-01.jpg": JPEG,
      "assets/articles/article-01.md": "Byline: nobody\n\nBody:\nb",
    });

    expect(await loadArticles(DIR, storage, deps)).toEqual([]);
    expect(storage.puts).toHaveLength(0);
    expect(logs.join("\n")).toContain("no Headline");
  });

  it("skips an article whose image upload fails (put returns null), never throwing", async () => {
    const storage = fakeStorageProvider({ put: () => null });
    const { deps, logs } = fakeIo({
      "assets/articles/article-01.jpg": JPEG,
      "assets/articles/article-01.md": "Headline: One\n\nBody:\nb",
    });

    expect(await loadArticles(DIR, storage, deps)).toEqual([]);
    expect(logs.join("\n")).toContain("upload failed");
  });

  it("returns [] when the articles folder does not exist", async () => {
    const storage = fakeStorageProvider();
    const deps = {
      readdir: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      readFile: async () => new Uint8Array(),
      readText: async () => "",
      log: () => {},
    };

    expect(await loadArticles(DIR, storage, deps)).toEqual([]);
    expect(storage.puts).toHaveLength(0);
  });
});
