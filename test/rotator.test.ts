import { describe, expect, it } from "vitest";
import { AD_ROTATOR_JS, buildAdQueue, shuffleIndices } from "../src/render/rotator.js";

/** A deterministic "rand": walks a fixed sequence, repeating the last value when exhausted. */
function seeded(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe("shuffleIndices (Fisher-Yates, ADR-0017)", () => {
  it("is a permutation: every index appears exactly once, for a range of sizes", () => {
    for (const n of [2, 3, 5, 8, 26]) {
      const out = shuffleIndices(n, Math.random);
      expect([...out].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it("produces the exact permutation its rand sequence dictates (seeded)", () => {
    // n=4, rand always 0 → each step swaps position i with position 0:
    // [0,1,2,3] → swap(3,0)=[3,1,2,0] → swap(2,0)=[2,1,3,0] → swap(1,0)=[1,2,3,0]
    expect(shuffleIndices(4, () => 0)).toEqual([1, 2, 3, 0]);
    // rand just under 1 → j === i every step: the identity permutation.
    expect(shuffleIndices(4, () => 0.999999)).toEqual([0, 1, 2, 3]);
    // A mixed sequence, hand-traced: i=3: j=floor(0.5*4)=2 → [0,1,3,2];
    // i=2: j=floor(0*3)=0 → [3,1,0,2]; i=1: j=floor(0.9*2)=1 → no move.
    expect(shuffleIndices(4, seeded([0.5, 0, 0.9]))).toEqual([3, 1, 0, 2]);
  });

  it("different rand sequences give different orders (the whole point)", () => {
    expect(shuffleIndices(6, () => 0)).not.toEqual(shuffleIndices(6, () => 0.4));
  });

  it("handles the degenerate sizes the driver never reaches", () => {
    expect(shuffleIndices(0, Math.random)).toEqual([]);
    expect(shuffleIndices(1, Math.random)).toEqual([0]);
  });
});

describe("buildAdQueue (ADR-0017)", () => {
  const DURATIONS = [7000, 12000, 3000, 7000];

  it("every ad appears exactly once per pass, carrying its own configured duration", () => {
    const queue = buildAdQueue(DURATIONS, Math.random);
    expect(queue).toHaveLength(DURATIONS.length);
    const seen = queue.map((e) => e.index).sort((a, b) => a - b);
    expect(seen).toEqual([0, 1, 2, 3]);
    for (const entry of queue) {
      expect(entry.durationMs).toBe(DURATIONS[entry.index]);
    }
  });

  it("orders the pass by the seeded shuffle", () => {
    expect(buildAdQueue(DURATIONS, () => 0)).toEqual([
      { index: 1, durationMs: 12000 },
      { index: 2, durationMs: 3000 },
      { index: 3, durationMs: 7000 },
      { index: 0, durationMs: 7000 },
    ]);
  });
});

describe("AD_ROTATOR_JS (the shipped inline script)", () => {
  it("embeds the SAME tested functions via toString — no drift", () => {
    // The compiled source of each pure function must appear verbatim in the script.
    expect(AD_ROTATOR_JS).toContain(shuffleIndices.toString());
    expect(AD_ROTATOR_JS).toContain(buildAdQueue.toString());
  });

  it("reads per-slide data-duration, marks the frame live, and toggles is-active", () => {
    expect(AD_ROTATOR_JS).toContain('getAttribute("data-duration")');
    expect(AD_ROTATOR_JS).toContain('classList.add("is-live")');
    expect(AD_ROTATOR_JS).toContain('classList.add("is-active")');
    expect(AD_ROTATOR_JS).toContain('classList.remove("is-active")');
    expect(AD_ROTATOR_JS).toContain("setTimeout");
  });

  it("bails for reduced motion and for fewer than two slides (static fallback)", () => {
    expect(AD_ROTATOR_JS).toContain("prefers-reduced-motion");
    expect(AD_ROTATOR_JS).toContain("slides.length < 2");
  });

  it("shuffles with the real entropy source in production", () => {
    expect(AD_ROTATOR_JS).toContain("Math.random");
  });
});
