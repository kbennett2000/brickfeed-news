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

  // --- Storage fields (Slice 4). Present only once the image is durably stored. ---
  /**
   * Durable public URL of the stored brick image. Its PRESENCE is the idempotency
   * signal for the image pass (a record with an imageUrl is never re-generated or
   * re-uploaded) AND the third gate for publishability — same presence-based,
   * all-or-nothing style as the generation fields.
   */
  imageUrl?: string;
  /** ISO timestamp the image was stored (written together with imageUrl). */
  imageStoredAt?: string;
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

/**
 * The HTTP boundary for the Grok generator, injected so tests can feed a canned
 * chat-completions response body without a real network call or an API key.
 * Resolves with whether the request was OK, the status, and the raw response body
 * (the JSON envelope, parsed by the generator). A transport error is surfaced as
 * ok:false rather than a rejection so generate() degrades to null.
 */
export type GrokChatRunner = (args: {
  baseUrl: string;
  model: string;
  prompt: string;
}) => Promise<{ ok: boolean; status: number; body: string }>;

/** Injectable side-effects for the generation orchestrator (same DI pattern as IngestDeps). */
export interface GenerateDeps {
  generator: Generator;
  /** Returns "now"; injected so tests can pin timestamps / logs. */
  now: () => Date;
}

/**
 * One image provider behind a normalized interface (Slice 3). Consumes the stored
 * `wrappedPrompt` (already brick-styled by wrapBrickStyle — the single styling
 * chokepoint) and returns the raw image bytes, or null on ANY failure. Like
 * Generator, it NEVER throws: a bad story just gets skipped and retried next run.
 */
export interface ImageProvider {
  generate(wrappedPrompt: string): Promise<Uint8Array | null>;
}

/**
 * The low-level HTTP boundary for the image providers, injected so tests can feed
 * canned responses without a real network call, a running imagegen service, or a
 * key. Returns whether the request was OK, the status, and the raw response bytes
 * (JSON envelope or binary image, decoded by the provider). A transport error is
 * surfaced as ok:false rather than a rejection so generate() degrades to null.
 */
export type ImageHttpRunner = (args: {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ ok: boolean; status: number; bytes: Uint8Array }>;

/**
 * One durable-storage provider behind a normalized interface (Slice 4), selected by
 * config: Vercel Blob (default) or a local dir (alt). Both are NEVER-THROW, like the
 * Generator/ImageProvider layers:
 *  - `put` persists the image bytes under a deterministic key derived from the story
 *    id and returns a durable public URL, or `null` on ANY failure (missing token,
 *    transport error, non-2xx, write error) so the story stays unpublished and is
 *    retried next run.
 *  - `delete` removes a stored artifact for real (age-out). Failure is non-fatal and
 *    logged; it never throws, so a failed delete never blocks dropping the record.
 */
export interface StorageProvider {
  put(id: string, bytes: Uint8Array, contentType: string): Promise<string | null>;
  delete(id: string): Promise<void>;
}

/**
 * The low-level HTTP boundary for the Blob storage provider, injected so tests can
 * feed canned responses without a real network call or a token (parallels
 * ImageHttpRunner). Returns whether the request was OK, the status, and the response
 * body text. A transport error is surfaced as ok:false rather than a rejection so the
 * provider degrades to null / non-fatal.
 */
export type StorageHttpRunner = (args: {
  url: string;
  method: "PUT" | "POST";
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}) => Promise<{ ok: boolean; status: number; body: string }>;

/**
 * The filesystem boundary for the local storage provider, injected so tests can drive
 * failure paths without touching a real disk. Defaults to node:fs/promises in prod.
 */
export interface StorageFs {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/**
 * Injectable side-effects for the image orchestrator (mirrors GenerateDeps). Slice 4
 * replaces the temporary out/ sink with a StorageProvider: bytes from the provider are
 * persisted durably and the returned URL is written back onto the manifest record.
 */
export interface ImageDeps {
  provider: ImageProvider;
  storage: StorageProvider;
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
