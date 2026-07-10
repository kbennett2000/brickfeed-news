import type { FetchLike } from "../src/types.js";

interface FakeResponse {
  ok: boolean;
  status: number;
  url: string;
  text(): Promise<string>;
}

function res(url: string, body: string, ok = true, status = 200): FakeResponse {
  return { ok, status, url, text: async () => body };
}

/**
 * Build a hermetic FetchLike from:
 *  - feeds:   feed URL -> XML body (returned as-is, response.url == the feed URL)
 *  - resolve: wrapped link -> final destination URL (response.url == destination)
 *  - throwOn: any input in this set makes fetch reject (redirect failure / timeout)
 *
 * An input not covered anywhere resolves to a response whose url == the input
 * (i.e. "no redirect happened").
 */
export function makeFetch(opts: {
  feeds?: Record<string, string>;
  resolve?: Record<string, string>;
  throwOn?: Set<string>;
}): FetchLike {
  const feeds = opts.feeds ?? {};
  const resolve = opts.resolve ?? {};
  const throwOn = opts.throwOn ?? new Set<string>();

  return async (input: string) => {
    if (throwOn.has(input)) {
      throw new Error(`simulated fetch failure for ${input}`);
    }
    if (input in feeds) {
      return res(input, feeds[input]);
    }
    if (input in resolve) {
      return res(resolve[input], "");
    }
    return res(input, "");
  };
}

/** A fixed clock for deterministic timestamps. */
export function fixedNow(iso: string): () => Date {
  const d = new Date(iso);
  return () => d;
}
