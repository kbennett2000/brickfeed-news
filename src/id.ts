import { createHash } from "node:crypto";

/**
 * Normalize a URL so the same article via different tracking params hashes to the
 * same ID. Rules: lowercase host, drop the entire query string and fragment, strip
 * a trailing slash from the path.
 *
 * Dropping the WHOLE query (not just utm_*) is deliberate: it's the simplest rule
 * that guarantees tracking-param variants collapse to one identity, and news
 * article URLs carry their identity in the path, not the query.
 */
export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    // Not a parseable URL — fall back to a best-effort stable string so hashing
    // still works and the story is never dropped.
    return input.trim().toLowerCase();
  }

  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase();
  url.protocol = url.protocol.toLowerCase();

  // Strip a trailing slash from a non-root path (keep the root "/").
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

/** Canonical story ID: sha256 hex of the normalized URL. */
export function storyId(url: string): string {
  return createHash("sha256").update(normalizeUrl(url)).digest("hex");
}
