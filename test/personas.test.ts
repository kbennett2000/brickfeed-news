import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../src/category.js";
import { loadPersonas, parsePersona, type PersonasDeps } from "../src/personas.js";

/** A minimal valid news persona document; tests below mutate pieces of it. */
const VALID = `---
name: alice
display_name: Alice
byline_blurb: Alice is a test blurb.
source: news
selection_bias:
  POLITICS: 3
  WORLD: 2
---

You are Alice. Escalate everything.
`;

/** A minimal valid letters persona document (ADR-0014). */
const VALID_LETTERS = `---
name: tammy
display_name: Tammy
byline_blurb: Tammy is a test blurb.
source: letters
schedule: mon/wed/fri/sun
column_title: Tammy's Test Corner
---

You are Tammy. Answer the letter.
`;

describe("parsePersona", () => {
  it("parses a full document: scalars, bias map, and body", () => {
    const p = parsePersona(VALID);
    expect(p).not.toBeNull();
    expect(p!.name).toBe("alice");
    expect(p!.displayName).toBe("Alice");
    expect(p!.bylineBlurb).toBe("Alice is a test blurb.");
    expect(p!.selectionBias).toEqual({ POLITICS: 3, WORLD: 2 });
    expect(p!.sectionsExclusive).toBeUndefined();
    expect(p!.body).toBe("You are Alice. Escalate everything.");
  });

  it("parses sections_exclusive: true (ADR-0032 Layer E) on a news persona", () => {
    const p = parsePersona(VALID.replace("source: news\n", "source: news\nsections_exclusive: true\n"));
    expect(p!.sectionsExclusive).toBe(true);
  });

  it("sections_exclusive only enables on the literal true; anything else is non-exclusive", () => {
    expect(
      parsePersona(VALID.replace("source: news\n", "source: news\nsections_exclusive: false\n"))!
        .sectionsExclusive,
    ).toBeUndefined();
    expect(
      parsePersona(VALID.replace("source: news\n", "source: news\nsections_exclusive: yes\n"))!
        .sectionsExclusive,
    ).toBeUndefined();
  });

  it("returns null when a required scalar is missing", () => {
    expect(parsePersona(VALID.replace("name: alice\n", ""))).toBeNull();
    expect(parsePersona(VALID.replace("display_name: Alice\n", ""))).toBeNull();
    expect(parsePersona(VALID.replace("byline_blurb: Alice is a test blurb.\n", ""))).toBeNull();
    expect(parsePersona(VALID.replace("source: news\n", ""))).toBeNull();
  });

  it("returns null on a source outside news|letters (no normalization)", () => {
    expect(parsePersona(VALID.replace("source: news", "source: espn"))).toBeNull();
    expect(parsePersona(VALID.replace("source: news", "source: NEWS"))).toBeNull();
  });

  it("returns null on an empty body", () => {
    expect(parsePersona(VALID.replace("You are Alice. Escalate everything.\n", "  \n"))).toBeNull();
  });

  it("returns null without an opening fence or with an unterminated one", () => {
    expect(parsePersona("name: alice\ndisplay_name: Alice\n\nBody here.")).toBeNull();
    expect(parsePersona(VALID.replace("---\n\nYou are Alice", "\nYou are Alice"))).toBeNull();
  });

  it("returns null on a selection_bias key outside CATEGORIES (no silent normalization)", () => {
    expect(parsePersona(VALID.replace("  WORLD: 2", "  SPROTS: 2"))).toBeNull();
  });

  it("returns null on a negative or non-numeric weight", () => {
    expect(parsePersona(VALID.replace("  WORLD: 2", "  WORLD: -1"))).toBeNull();
    expect(parsePersona(VALID.replace("  WORLD: 2", "  WORLD: heavy"))).toBeNull();
  });

  it("returns null when a news persona omits selection_bias (required for news)", () => {
    expect(parsePersona(VALID.replace(/selection_bias:\n( {2}.+\n)+/, ""))).toBeNull();
  });

  it("returns null when a news persona carries the letters-only fields", () => {
    expect(parsePersona(VALID.replace("source: news", "source: news\nschedule: mon"))).toBeNull();
    expect(
      parsePersona(VALID.replace("source: news", "source: news\ncolumn_title: Alice's Corner")),
    ).toBeNull();
  });

  it("parses a letters persona: schedule tokens in order, column title, empty bias", () => {
    const p = parsePersona(VALID_LETTERS);
    expect(p).not.toBeNull();
    expect(p!.source).toBe("letters");
    expect(p!.schedule).toEqual(["mon", "wed", "fri", "sun"]);
    expect(p!.columnTitle).toBe("Tammy's Test Corner");
    expect(p!.selectionBias).toEqual({});
  });

  it("returns null when a letters persona carries a selection_bias block", () => {
    expect(
      parsePersona(
        VALID_LETTERS.replace("source: letters", "source: letters\nselection_bias:\n  WORLD: 2"),
      ),
    ).toBeNull();
  });

  it("returns null when a letters persona omits schedule or column_title", () => {
    expect(parsePersona(VALID_LETTERS.replace("schedule: mon/wed/fri/sun\n", ""))).toBeNull();
    expect(parsePersona(VALID_LETTERS.replace("column_title: Tammy's Test Corner\n", ""))).toBeNull();
  });

  it("returns null on an empty, unknown, non-lowercase, or duplicate schedule token", () => {
    const sched = (v: string) => VALID_LETTERS.replace("schedule: mon/wed/fri/sun", `schedule:${v}`);
    expect(parsePersona(sched(""))).toBeNull(); // empty list
    expect(parsePersona(sched(" monday"))).toBeNull(); // long-form token
    expect(parsePersona(sched(" MON"))).toBeNull(); // no case normalization
    expect(parsePersona(sched(" mon/xyz"))).toBeNull(); // unknown token
    expect(parsePersona(sched(" mon/mon"))).toBeNull(); // duplicate
  });

  it("tolerates CRLF line endings", () => {
    const p = parsePersona(VALID.replace(/\n/g, "\r\n"));
    expect(p).not.toBeNull();
    expect(p!.selectionBias).toEqual({ POLITICS: 3, WORLD: 2 });
    expect(p!.body).toBe("You are Alice. Escalate everything.");
  });

  it("ignores unknown scalar keys (forward compatible)", () => {
    const p = parsePersona(VALID.replace("---\n\nYou", "favorite_year: 1982\n---\n\nYou"));
    expect(p).not.toBeNull();
    expect(p!.name).toBe("alice");
  });

  it("closes the bias block at the first non-indented line", () => {
    const doc = VALID.replace("---\n\nYou", "display_extra: x\n---\n\nYou");
    const p = parsePersona(doc);
    expect(p).not.toBeNull();
    // display_extra came after the indented bias entries but is not indented,
    // so it must land in scalars (ignored), not be rejected as a bad section.
    expect(p!.selectionBias).toEqual({ POLITICS: 3, WORLD: 2 });
  });

  it("leaves bio undefined when the field is absent", () => {
    expect(parsePersona(VALID)!.bio).toBeUndefined();
    expect(parsePersona(VALID_LETTERS)!.bio).toBeUndefined();
  });

  it("parses an inline bio scalar as a single paragraph (ADR-0019)", () => {
    const p = parsePersona(VALID.replace("source: news", "source: news\nbio: Alice yells at clouds."));
    expect(p).not.toBeNull();
    expect(p!.bio).toEqual(["Alice yells at clouds."]);
  });

  it("parses a bio block: one indented line per paragraph, colons allowed in prose", () => {
    const doc = VALID_LETTERS.replace(
      "source: letters",
      "source: letters\nbio:\n  Tammy answers letters nobody sent.\n  Her motto: never look back.",
    );
    const p = parsePersona(doc);
    expect(p).not.toBeNull();
    expect(p!.bio).toEqual(["Tammy answers letters nobody sent.", "Her motto: never look back."]);
    // The block closed cleanly — the letters contract still parsed after it.
    expect(p!.columnTitle).toBe("Tammy's Test Corner");
  });

  it("returns null on a bio block with no paragraphs, or a re-declared bio", () => {
    expect(parsePersona(VALID.replace("source: news", "source: news\nbio:"))).toBeNull();
    expect(
      parsePersona(VALID.replace("source: news", "source: news\nbio: one\nbio: two")),
    ).toBeNull();
  });

  it("parses a bio block under CRLF line endings", () => {
    const doc = VALID.replace("source: news", "source: news\nbio:\n  First.\n  Second.");
    const p = parsePersona(doc.replace(/\n/g, "\r\n"));
    expect(p).not.toBeNull();
    expect(p!.bio).toEqual(["First.", "Second."]);
  });
});

describe("loadPersonas", () => {
  const files: Record<string, string> = {
    "alice.md": VALID,
    "_shared.md": "REGISTER: shared block, not a persona.",
    "notes.txt": "not markdown",
    "bob.md": VALID.replace(/alice/g, "bob").replace("Alice", "Bob"),
  };
  const deps = (over: Partial<PersonasDeps> = {}): Partial<PersonasDeps> => ({
    readdir: async () => Object.keys(files),
    readText: async (path) => {
      const name = path.split("/").pop()!;
      if (!(name in files)) throw new Error(`no such file: ${path}`);
      return files[name];
    },
    log: () => {},
    ...over,
  });

  it("loads personas, excluding _-prefixed and non-.md files, sorted by name", async () => {
    const personas = await loadPersonas("personas", deps());
    expect(personas.map((p) => p.name)).toEqual(["alice", "bob"]);
  });

  it("returns [] when the directory is missing", async () => {
    const personas = await loadPersonas("personas", {
      readdir: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(personas).toEqual([]);
  });

  it("skips and logs an invalid file; siblings survive", async () => {
    const logs: string[] = [];
    const personas = await loadPersonas(
      "personas",
      deps({
        readText: async (path) =>
          path.endsWith("bob.md") ? "not a persona document" : files[path.split("/").pop()!],
        log: (m) => logs.push(m),
      }),
    );
    expect(personas.map((p) => p.name)).toEqual(["alice"]);
    expect(logs.some((m) => m.includes("bob skipped"))).toBe(true);
  });

  it("skips a persona whose front-matter name differs from its basename", async () => {
    const logs: string[] = [];
    const personas = await loadPersonas(
      "personas",
      deps({
        // bob.md claims to be "alice" — would desync headshot + idempotency keys.
        readText: async (path) =>
          path.endsWith("bob.md") ? VALID : files[path.split("/").pop()!],
        log: (m) => logs.push(m),
      }),
    );
    expect(personas.map((p) => p.name)).toEqual(["alice"]);
    expect(logs.some((m) => m.includes('"alice" must equal'))).toBe(true);
  });

  it("skips a file whose read throws; siblings survive", async () => {
    const personas = await loadPersonas(
      "personas",
      deps({
        readText: async (path) => {
          if (path.endsWith("alice.md")) throw new Error("EACCES");
          return files[path.split("/").pop()!];
        },
      }),
    );
    expect(personas.map((p) => p.name)).toEqual(["bob"]);
  });
});

// ---------------------------------------------------------------------------
// Schema validation of the REAL committed persona assets (ADR-0013, ADR-0014):
// the nine authors exist, parse cleanly, and carry every required field for
// their source.
// ---------------------------------------------------------------------------

const NEWS_ROSTER = ["alice", "bob", "cynthia", "edgar", "hodge", "larry", "stryker"] as const;
const LETTERS_ROSTER = ["priscilla", "tom"] as const;
const ROSTER = [...NEWS_ROSTER, ...LETTERS_ROSTER].sort();
const personasDir = fileURLToPath(new URL("../personas/", import.meta.url));
const headshotsDir = fileURLToPath(new URL("../assets/headshots/", import.meta.url));

describe("committed persona files", () => {
  it("personas/ holds exactly the nine-author roster plus the four _ support blocks", () => {
    const mds = readdirSync(personasDir).filter((f) => f.endsWith(".md"));
    expect(mds.sort()).toEqual([
      "_comments.md",
      "_evergreen.md",
      "_letters.md",
      "_shared.md",
      ...ROSTER.map((n) => `${n}.md`),
    ]);
  });

  it("_evergreen.md carries the no-source fallback contract (ADR-0032)", () => {
    const evergreen = readFileSync(`${personasDir}_evergreen.md`, "utf8");
    expect(evergreen).toContain("Invent NO news");
    expect(evergreen).toContain("You have no news story today");
  });

  it("_shared.md is non-empty and carries the register and guardrail blocks", () => {
    const shared = readFileSync(`${personasDir}_shared.md`, "utf8");
    expect(shared).toContain("REGISTER");
    expect(shared).toContain("GUARDRAILS");
    expect(shared).toContain("1200");
  });

  it("_letters.md carries the letter-invention guardrails (ADR-0014)", () => {
    const letters = readFileSync(`${personasDir}_letters.md`, "utf8");
    expect(letters).toContain("exactly one letter-writer");
    expect(letters).toContain("FIRST name");
    expect(letters).toContain("never a public figure");
    expect(letters).toContain("everyday and PG");
    expect(letters).toContain("no real-world facts");
  });

  it.each(ROSTER)("%s.md parses with all required fields", (name) => {
    const p = parsePersona(readFileSync(`${personasDir}${name}.md`, "utf8"));
    expect(p).not.toBeNull();
    expect(p!.name).toBe(name);
    expect(p!.displayName.length).toBeGreaterThan(0);
    expect(p!.bylineBlurb.length).toBeGreaterThan(0);
    expect(p!.body.length).toBeGreaterThan(0);
  });

  it.each(NEWS_ROSTER)("%s.md is source news with a valid, non-empty selection_bias", (name) => {
    const p = parsePersona(readFileSync(`${personasDir}${name}.md`, "utf8"));
    expect(p!.source).toBe("news");
    expect(p!.schedule).toBeUndefined();
    expect(p!.columnTitle).toBeUndefined();
    const entries = Object.entries(p!.selectionBias);
    expect(entries.length).toBeGreaterThan(0);
    for (const [section, weight] of entries) {
      expect(CATEGORIES).toContain(section);
      expect(Number.isFinite(weight)).toBe(true);
      expect(weight!).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(LETTERS_ROSTER)("%s.md is source letters with schedule and column title", (name) => {
    const p = parsePersona(readFileSync(`${personasDir}${name}.md`, "utf8"));
    expect(p!.source).toBe("letters");
    expect(p!.columnTitle!.length).toBeGreaterThan(0);
    expect(p!.selectionBias).toEqual({});
  });

  it("pins the ADR-0014 cadence: tom mon/wed/fri/sun, priscilla tue/thu/sat/sun", () => {
    const tom = parsePersona(readFileSync(`${personasDir}tom.md`, "utf8"));
    const priscilla = parsePersona(readFileSync(`${personasDir}priscilla.md`, "utf8"));
    expect(tom!.schedule).toEqual(["mon", "wed", "fri", "sun"]);
    expect(priscilla!.schedule).toEqual(["tue", "thu", "sat", "sun"]);
    // The Sunday double is intentional (ADR-0014 decision 3).
    expect(tom!.schedule).toContain("sun");
    expect(priscilla!.schedule).toContain("sun");
  });
});

// assets/ is git-ignored (repo stays text-only), so the headshots exist only on the
// production box — enforce the by-convention pairing there, skip on a fresh clone/CI.
describe.skipIf(!existsSync(headshotsDir))("persona headshots (production box only)", () => {
  it.each(ROSTER)("assets/headshots/%s.png exists", (name) => {
    expect(existsSync(`${headshotsDir}${name}.png`)).toBe(true);
  });
});
