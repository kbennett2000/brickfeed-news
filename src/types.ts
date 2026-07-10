/**
 * Shared types for the ingestion backbone (Slice 1) and the Claude generation
 * layer (Slice 2), per docs/adr/0001-brickfeed-architecture.md.
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

/**
 * A manifest record — the persisted identity + provenance of a known story.
 *
 * The generation fields (headline, description, imagePrompt, wrappedPrompt) are
 * optional: they are absent for a story that has not been generated yet ("pending
 * generation") and written together, all-or-nothing, once generation succeeds.
 * Their PRESENCE is what makes generation idempotent — matching Slice 1's dedup
 * style, there is no separate status flag.
 */
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

  // --- Generation fields (Slice 2). Present only once generation succeeds. ---
  /** Original, rewritten headline (never the feed's verbatim title). */
  headline?: string;
  /** Original 1–2 sentence description (never verbatim feed text). */
  description?: string;
  /** Claude's neutral scene prompt (no brand/trademark, no toy/brick language). */
  imagePrompt?: string;
  /** imagePrompt after brick-style wrapping — the artifact imagegen will consume. */
  wrappedPrompt?: string;
}

/** Normalized output of the generation step, before brick-style wrapping. */
export interface GeneratorOutput {
  headline: string;
  description: string;
  imagePrompt: string;
}

/** The story context handed to a Generator to produce {headline, description, imagePrompt}. */
export interface GenerationInput {
  title: string;
  sourceName: string;
  url: string;
}

/**
 * One generation provider behind a normalized interface (ADR decision #6). Returns
 * a GeneratorOutput on success, or null on failure — the subscription impl never
 * throws, so a single bad story just stays pending.
 */
export interface Generator {
  generate(input: GenerationInput): Promise<GeneratorOutput | null>;
}

/**
 * The subprocess boundary for the subscription generator, injected so tests can
 * feed canned `claude -p` output without spawning a real process. Resolves with
 * the child's stdout and exit code; a spawn error is surfaced as a non-zero code.
 */
export type ClaudeRunner = (args: {
  model: string;
  prompt: string;
}) => Promise<{ stdout: string; code: number }>;

/** Injectable side-effects for the generation orchestrator (same DI pattern as IngestDeps). */
export interface GenerateDeps {
  generator: Generator;
  /** Returns "now"; injected so tests can pin timestamps / logs. */
  now: () => Date;
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
