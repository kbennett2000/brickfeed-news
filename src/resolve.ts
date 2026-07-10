import type { FetchLike } from "./types.js";

export const DEFAULT_RESOLVE_TIMEOUT_MS = 8000;

/**
 * Resolve a Google News wrapped redirect link to its real destination URL.
 *
 * Google News RSS links are encoded redirect wrappers; the destination is only
 * known after following the redirect. We do a single HTTP request that follows
 * redirects and read the final `response.url`.
 *
 * DEFENSIVE FALLBACK (mandatory): on ANY failure — network error, timeout, a
 * non-ok response, or a missing/blank final URL — return the original wrapped
 * link so dedup still works. This function NEVER throws and NEVER returns "".
 */
export async function resolveUrl(
  link: string,
  fetch: FetchLike,
  timeoutMs = DEFAULT_RESOLVE_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(link, {
      redirect: "follow",
      signal: controller.signal,
    });
    const finalUrl = res?.url;
    if (res?.ok && typeof finalUrl === "string" && finalUrl.length > 0) {
      return finalUrl;
    }
    return link;
  } catch {
    return link;
  } finally {
    clearTimeout(timer);
  }
}
