import { describe, expect, it, vi } from "vitest";
import { TtsClient } from "../src/generator/tts.js";
import { buildGateInput, ttsGateVerdicts } from "../src/opinions-tts.js";
import type { ManifestRecord } from "../src/types.js";
import { fakeTtsRunner, ttsErr, ttsOk } from "./helpers.js";

/** A minimal candidate ManifestRecord (only id/headline/description are read by the gate). */
function rec(id: string, headline: string, description: string): ManifestRecord {
  return {
    id,
    url: `https://x/${id}`,
    title: headline,
    sourceName: "Src",
    firstSeen: "2026-07-13T00:00:00.000Z",
    lastSeen: "2026-07-13T00:00:00.000Z",
    headline,
    description,
    category: "WORLD",
  };
}

const A = rec("a1", "Giant pumpkin breaks record", "A grower's pumpkin took the fair title.");
const B = rec("b2", "Fatal crash closes interstate", "Several died in a pileup.");
const CANDIDATES = [A, B];

/** Build a client whose opinion-gate route returns the given verdicts array. */
function gateClient(verdicts: unknown): TtsClient {
  const runner = fakeTtsRunner({ routes: { "opinion-gate": { body: ttsOk({ verdicts }) } } });
  return new TtsClient("http://tts.test", runner);
}

describe("opinion-gate TTS input", () => {
  it("serializes candidates as a JSON [{id,title,summary}] array", () => {
    expect(JSON.parse(buildGateInput(CANDIDATES))).toEqual([
      { id: "a1", title: "Giant pumpkin breaks record", summary: "A grower's pumpkin took the fair title." },
      { id: "b2", title: "Fatal crash closes interstate", summary: "Several died in a pileup." },
    ]);
  });
});

describe("ttsGateVerdicts — fail-closed matrix (ADR-0022 / RESPONSE §2)", () => {
  it("maps a clean 200 verdict list through (eligible stays eligible, excluded stays excluded)", async () => {
    const client = gateClient([
      { id: "a1", verdict: "eligible", reason: "harmless" },
      { id: "b2", verdict: "excluded", reason: "deaths" },
    ]);
    const out = await ttsGateVerdicts(client, CANDIDATES);
    expect(out?.get("a1")?.verdict).toBe("eligible");
    expect(out?.get("b2")?.verdict).toBe("excluded");
    expect(out?.size).toBe(2);
  });

  it("maps an 'uncertain' verdict to excluded", async () => {
    const client = gateClient([
      { id: "a1", verdict: "uncertain", reason: "not sure" },
      { id: "b2", verdict: "excluded", reason: "deaths" },
    ]);
    const out = await ttsGateVerdicts(client, CANDIDATES);
    expect(out?.get("a1")?.verdict).toBe("excluded");
  });

  it("excludes an id that is MISSING from the response (map still complete)", async () => {
    const client = gateClient([{ id: "a1", verdict: "eligible", reason: "ok" }]); // b2 missing
    const out = await ttsGateVerdicts(client, CANDIDATES);
    expect(out?.size).toBe(2);
    expect(out?.get("a1")?.verdict).toBe("eligible");
    expect(out?.get("b2")?.verdict).toBe("excluded");
  });

  it("excludes an id that appears MORE THAN ONCE, even if a copy says eligible", async () => {
    const client = gateClient([
      { id: "a1", verdict: "eligible", reason: "ok" },
      { id: "a1", verdict: "eligible", reason: "dup" },
      { id: "b2", verdict: "eligible", reason: "ok" },
    ]);
    const out = await ttsGateVerdicts(client, CANDIDATES);
    expect(out?.get("a1")?.verdict).toBe("excluded"); // duplicate → fail-closed
    expect(out?.get("b2")?.verdict).toBe("eligible");
  });

  it.each([400, 413, 422, 500, 503])(
    "returns null (fail-closed) on HTTP %i",
    async (status) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const runner = fakeTtsRunner({ routes: { "opinion-gate": { ok: false, status, body: ttsErr("x") } } });
      const out = await ttsGateVerdicts(new TtsClient("http://tts.test", runner), CANDIDATES);
      expect(out).toBeNull();
    },
  );

  it("returns null (fail-closed) when TTS is unreachable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = fakeTtsRunner({ throws: true });
    const out = await ttsGateVerdicts(new TtsClient("http://tts.test", runner), CANDIDATES);
    expect(out).toBeNull();
  });
});
