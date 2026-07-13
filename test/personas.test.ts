import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../src/category.js";
import { loadPersonas, parsePersona, type PersonasDeps } from "../src/personas.js";

/** A minimal valid persona document; tests below mutate pieces of it. */
const VALID = `---
name: alice
display_name: Alice
byline_blurb: Alice is a test blurb.
selection_bias:
  POLITICS: 3
  WORLD: 2
---

You are Alice. Escalate everything.
`;

describe("parsePersona", () => {
  it("parses a full document: scalars, bias map, and body", () => {
    const p = parsePersona(VALID);
    expect(p).not.toBeNull();
    expect(p!.name).toBe("alice");
    expect(p!.displayName).toBe("Alice");
    expect(p!.bylineBlurb).toBe("Alice is a test blurb.");
    expect(p!.selectionBias).toEqual({ POLITICS: 3, WORLD: 2 });
    expect(p!.body).toBe("You are Alice. Escalate everything.");
  });

  it("returns null when a required scalar is missing", () => {
    expect(parsePersona(VALID.replace("name: alice\n", ""))).toBeNull();
    expect(parsePersona(VALID.replace("display_name: Alice\n", ""))).toBeNull();
    expect(parsePersona(VALID.replace("byline_blurb: Alice is a test blurb.\n", ""))).toBeNull();
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

  it("accepts an absent selection_bias block as an empty map", () => {
    const p = parsePersona(VALID.replace(/selection_bias:\n( {2}.+\n)+/, ""));
    expect(p).not.toBeNull();
    expect(p!.selectionBias).toEqual({});
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
// Schema validation of the REAL committed persona assets (ADR-0013): the six
// authors exist, parse cleanly, and carry every required field.
// ---------------------------------------------------------------------------

const ROSTER = ["alice", "bob", "cynthia", "edgar", "larry", "stryker"] as const;
const personasDir = fileURLToPath(new URL("../personas/", import.meta.url));
const headshotsDir = fileURLToPath(new URL("../assets/headshots/", import.meta.url));

describe("committed persona files", () => {
  it("personas/ holds exactly the six-author roster plus _shared.md", () => {
    const mds = readdirSync(personasDir).filter((f) => f.endsWith(".md"));
    expect(mds.sort()).toEqual(["_shared.md", ...ROSTER.map((n) => `${n}.md`)]);
  });

  it("_shared.md is non-empty and carries the register and guardrail blocks", () => {
    const shared = readFileSync(`${personasDir}_shared.md`, "utf8");
    expect(shared).toContain("REGISTER");
    expect(shared).toContain("GUARDRAILS");
    expect(shared).toContain("300");
  });

  it.each(ROSTER)("%s.md parses with all required fields", (name) => {
    const p = parsePersona(readFileSync(`${personasDir}${name}.md`, "utf8"));
    expect(p).not.toBeNull();
    expect(p!.name).toBe(name);
    expect(p!.displayName.length).toBeGreaterThan(0);
    expect(p!.bylineBlurb.length).toBeGreaterThan(0);
    expect(p!.body.length).toBeGreaterThan(0);
  });

  it.each(ROSTER)("%s.md has a valid, non-empty selection_bias", (name) => {
    const p = parsePersona(readFileSync(`${personasDir}${name}.md`, "utf8"));
    const entries = Object.entries(p!.selectionBias);
    expect(entries.length).toBeGreaterThan(0);
    for (const [section, weight] of entries) {
      expect(CATEGORIES).toContain(section);
      expect(Number.isFinite(weight)).toBe(true);
      expect(weight!).toBeGreaterThanOrEqual(0);
    }
  });
});

// assets/ is git-ignored (repo stays text-only), so the headshots exist only on the
// production box — enforce the by-convention pairing there, skip on a fresh clone/CI.
describe.skipIf(!existsSync(headshotsDir))("persona headshots (production box only)", () => {
  it.each(ROSTER)("assets/headshots/%s.png exists", (name) => {
    expect(existsSync(`${headshotsDir}${name}.png`)).toBe(true);
  });
});
