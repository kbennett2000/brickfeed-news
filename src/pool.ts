/**
 * A tiny bounded-concurrency map. The pipeline's generate + image stages each make one
 * grok CLI call per story, and those calls are ~90% idle waiting on the xAI server — so
 * running a few at once collapses the total wall-clock (measured: 3 concurrent image gens
 * finish in the time of one) without needing a faster per-call path.
 *
 * Runs at most `concurrency` tasks at a time and returns results in INPUT order (not
 * completion order), so callers that build ordered output from the results stay
 * deterministic regardless of which task finishes first. No external deps.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // At least 1 worker; never more workers than items.
  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  let next = 0;

  async function work(): Promise<void> {
    // Each worker pulls the next index until the queue drains. `next++` is safe: the
    // read-modify-write happens synchronously between awaits (single-threaded event loop).
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => work()));
  return results;
}
