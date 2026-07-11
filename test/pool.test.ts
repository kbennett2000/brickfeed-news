import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/pool.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("returns results in INPUT order even when later items finish first", async () => {
    // Item i resolves after (n - i) ms, so item 0 finishes LAST — a completion-order
    // collection would reverse them; input-order collection must not.
    const items = [0, 1, 2, 3, 4];
    const out = await mapWithConcurrency(items, 5, async (n) => {
      await delay((items.length - n) * 5);
      return n * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
  });

  it("never runs more than `concurrency` tasks at once", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active--;
      return n;
    });
    expect(maxActive).toBe(4);
  });

  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    const items = Array.from({ length: 10 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 3, async (n) => {
      seen.push(n);
      return n;
    });
    expect(out).toEqual(items);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it("passes the correct index to the task", async () => {
    const out = await mapWithConcurrency(["a", "b", "c"], 2, async (item, i) => `${i}:${item}`);
    expect(out).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("clamps concurrency to at least 1 (0 or negative → serial, still completes)", async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6]);
  });

  it("never spawns more workers than items", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2], 10, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active--;
      return n;
    });
    expect(maxActive).toBe(2);
  });

  it("returns [] for empty input", async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });
});
