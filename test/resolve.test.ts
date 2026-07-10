import { describe, expect, it } from "vitest";
import { resolveUrl } from "../src/resolve.js";
import { makeFetch } from "./helpers.js";

const WRAPPED = "https://news.google.com/rss/articles/CBMiAAAA-transit?oc=5";
const REAL = "https://www.metrotimes.example/news/transit-plan";

describe("resolveUrl", () => {
  it("resolves a wrapped redirect to its real destination", async () => {
    const fetch = makeFetch({ resolve: { [WRAPPED]: REAL } });
    expect(await resolveUrl(WRAPPED, fetch)).toBe(REAL);
  });

  it("falls back to the wrapped link when the redirect fails", async () => {
    const fetch = makeFetch({ throwOn: new Set([WRAPPED]) });
    expect(await resolveUrl(WRAPPED, fetch)).toBe(WRAPPED);
  });

  it("falls back when the response is not ok", async () => {
    const fetch = makeFetch({}); // uncovered input => ok response whose url == input
    const notOk = async () => ({
      ok: false,
      status: 503,
      url: "",
      text: async () => "",
    });
    expect(await resolveUrl(WRAPPED, notOk)).toBe(WRAPPED);
    // sanity: the plain makeFetch echoes the input url, which equals the wrapped link
    expect(await resolveUrl(WRAPPED, fetch)).toBe(WRAPPED);
  });

  it("falls back on timeout (abort) rather than throwing", async () => {
    // A fetch that rejects when its signal aborts; timeout is tiny so it fires.
    const hangThenAbort = (_input: string, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    expect(await resolveUrl(WRAPPED, hangThenAbort, 5)).toBe(WRAPPED);
  });
});
