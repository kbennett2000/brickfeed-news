/**
 * Shared types for the ingestion backbone (Slice 1).
 *
 * This slice deliberately does NOT model headline/description/image — those land
 * in later slices per docs/adr/0001-brickfeed-architecture.md.
 */

/** A single item parsed from an RSS feed, before link resolution / identity. */
export interface FeedItem {
  title: string;
  /** The raw link as it appears in the feed (a Google News redirect wrapper). */
  link: string;
  pubDate: string;
  /** From the per-item <source> element Google News includes. May be "". */
  sourceName: string;
}

/** A manifest record — the persisted identity + provenance of a known story. */
export interface ManifestRecord {
  /** sha256 of the normalized (resolved) URL. */
  id: string;
  /** The resolved destination URL (or the wrapped link if resolution failed). */
  url: string;
  title: string;
  sourceName: string;
  /** ISO timestamp first ingested. */
  firstSeen: string;
  /** ISO timestamp most recently seen in a run. */
  lastSeen: string;
}

/** The text-only JSON manifest: the source of truth for known stories. */
export interface Manifest {
  version: number;
  stories: Record<string, ManifestRecord>;
}

/** A minimal fetch signature so callers can inject a hermetic fake in tests. */
export type FetchLike = (
  input: string,
  init?: { redirect?: "follow" | "error" | "manual"; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; url: string; text(): Promise<string> }>;

/** Injectable side-effects, so ingest() runs without live network or wall clock. */
export interface IngestDeps {
  fetch: FetchLike;
  /** Returns "now"; injected so tests can pin timestamps. */
  now: () => Date;
  /** Redirect-resolution timeout in ms. */
  resolveTimeoutMs?: number;
}
