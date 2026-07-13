import type { AdView } from "../src/ads.js";
import type { Article } from "../src/articles.js";
import type { Config } from "../src/config.js";
import type { HeadshotsResult } from "../src/headshots.js";
import type {
  ClaudeRunner,
  CycleIo,
  DeployRunner,
  GenerationInput,
  Generator,
  GeneratorOutput,
  GrokChatRunner,
  ImageHttpRunner,
  ImageProvider,
  Manifest,
  StorageFs,
  StorageHttpRunner,
  StorageProvider,
  TerminalImageRunner,
  TerminalTextRunner,
} from "../src/types.js";
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

/** A complete, valid Config for tests; override any field via `over`. */
export function makeConfig(over: Partial<Config> = {}): Config {
  return {
    feedUrls: ["feed://a"],
    manifestPath: "unused-in-these-tests.json",
    generator: {
      provider: "grok",
      model: "test-model",
      grok: { baseUrl: "https://grok.test/v1", model: "grok-test" },
      grokTerminal: { command: "grok-test", args: [] },
    },
    brickStyle: { styleLanguage: "TEST-STYLE plastic building-block diorama" },
    image: {
      provider: "grok",
      grok: {
        baseUrl: "https://img.test/v1",
        model: "img-test",
        aspectRatio: "1:1",
        resolution: "1k",
      },
      local: { url: "http://imagegen.test", style: "test-base" },
      grokTerminal: { command: "grok-test", args: [] },
      // Off by default in the fixture so createStorageProvider returns the raw provider —
      // keeps existing storage/cycle tests byte-identical. Optimization is covered by its
      // own dedicated tests (optimize + optimizing decorator + factory).
      optimize: { enabled: false, maxEdge: 1280, quality: 80 },
    },
    storage: {
      provider: "blob",
      blob: {
        pathPrefix: "images/",
        publicBaseUrl: "https://store.test.public.blob.vercel-storage.com",
      },
      local: { dir: "/tmp/unused-storage", publicBaseUrl: "http://storage.test/blob" },
    },
    maxAgeHours: 72,
    publishedPath: "unused-published.json",
    concurrency: 4,
    maxStoriesPerCycle: 20,
    render: {
      outputDir: "site",
      secondaryStoryCount: 4,
      timeZone: "UTC",
      siteBaseUrl: "https://test.brickfeed.example",
      analytics: "none",
      share: {},
      // Off by default so config-driven renders (cycle/render-cli tests) stay byte-identical.
      // The srcset/vercel.json behavior is covered by dedicated render tests that opt in.
      imageOptimization: { enabled: false, widths: [320, 480, 640, 960, 1280], quality: 75 },
    },
    deploy: { command: "vercel --prod --yes", cwd: "site", enabled: true },
    ...over,
  };
}

/** Encode a string to bytes — canned response bodies / image payloads for image tests. */
export function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * A fake ImageProvider for orchestrator tests. `impl` maps a wrappedPrompt to bytes;
 * return null to simulate a never-throw failure, or set `throwOn` to a wrappedPrompt
 * to make generate() throw. Records every prompt it was called with.
 */
export function fakeImageProvider(opts: {
  impl?: (wrappedPrompt: string) => Uint8Array | null;
  throwOn?: Set<string>;
}): ImageProvider & { calls: string[] } {
  const calls: string[] = [];
  const impl = opts.impl ?? ((wrappedPrompt) => bytes(`img:${wrappedPrompt}`));
  const throwOn = opts.throwOn ?? new Set<string>();

  return {
    calls,
    async generate(wrappedPrompt: string): Promise<Uint8Array | null> {
      calls.push(wrappedPrompt);
      if (throwOn.has(wrappedPrompt)) {
        throw new Error(`simulated image failure for ${wrappedPrompt}`);
      }
      return impl(wrappedPrompt);
    },
  };
}

/** A single recorded outbound request from a fakeImageRunner. */
export interface RecordedImageCall {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

/**
 * A fake ImageHttpRunner routing `${method} ${url}` to a canned {ok,status,bytes},
 * for image-provider tests. Records every call for request-shape assertions. An
 * unmatched route resolves to a 404 with empty bytes; set `throws` to simulate a
 * transport failure on every call.
 */
export function fakeImageRunner(opts: {
  routes?: Record<string, { ok?: boolean; status?: number; bytes?: Uint8Array }>;
  throws?: boolean;
}): ImageHttpRunner & { calls: RecordedImageCall[] } {
  const routes = opts.routes ?? {};
  const calls: RecordedImageCall[] = [];

  const runner = async (args: {
    url: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ ok: boolean; status: number; bytes: Uint8Array }> => {
    calls.push({ url: args.url, method: args.method, headers: args.headers, body: args.body });
    if (opts.throws) throw new Error("simulated transport failure");
    const route = routes[`${args.method} ${args.url}`];
    if (!route) return { ok: false, status: 404, bytes: new Uint8Array(0) };
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      bytes: route.bytes ?? new Uint8Array(0),
    };
  };

  return Object.assign(runner, { calls });
}

/**
 * A fake Generator for orchestrator tests. `impl` maps a story title to an output;
 * return null to simulate a never-throw failure, or set `throwOn` to a title to
 * make generate() throw. Records every input it was called with (for idempotency
 * assertions).
 */
export function fakeGenerator(opts: {
  impl?: (input: GenerationInput) => GeneratorOutput | null;
  throwOn?: Set<string>;
}): Generator & { calls: GenerationInput[] } {
  const calls: GenerationInput[] = [];
  const impl =
    opts.impl ??
    ((input) => ({
      headline: `Rewritten: ${input.title}`,
      description: `An original two-sentence take on ${input.title}. It links out.`,
      imagePrompt: `A neutral photographic scene evoking ${input.title}.`,
      category: "WORLD",
      caption: `A neutral scene evoking ${input.title}.`,
    }));
  const throwOn = opts.throwOn ?? new Set<string>();

  return {
    calls,
    async generate(input: GenerationInput): Promise<GeneratorOutput | null> {
      calls.push(input);
      if (throwOn.has(input.title)) {
        throw new Error(`simulated generation failure for ${input.title}`);
      }
      return impl(input);
    },
  };
}

/** A single recorded put() call on a fakeStorageProvider. */
export interface RecordedPut {
  id: string;
  bytes: Uint8Array;
  contentType: string;
}

/**
 * A fake StorageProvider for orchestrator tests. `put` maps a story id to a durable URL
 * (default `https://cdn.test/<id>.png`); return null to simulate a never-throw failure,
 * or set `throwOnPut` to make put() throw. `delete` records ids; set `throwOnDelete` to
 * make delete() throw (used to assert non-fatal handling by the caller). Records all
 * calls for idempotency / all-or-nothing assertions.
 */
export function fakeStorageProvider(opts: {
  put?: (id: string, bytes: Uint8Array, contentType: string) => string | null;
  throwOnPut?: Set<string>;
  throwOnDelete?: Set<string>;
  /** Whether a stored image "exists" for the gate/reconcile. Default: everything exists. */
  exists?: (id: string, imageUrl?: string) => boolean;
  /** Preflight result. Default: ok (a fake provider has no real preconditions). */
  preflight?: () => { ok: true } | { ok: false; message: string };
} = {}): StorageProvider & { puts: RecordedPut[]; deletes: string[]; existsCalls: string[] } {
  const puts: RecordedPut[] = [];
  const deletes: string[] = [];
  const existsCalls: string[] = [];
  const putImpl = opts.put ?? ((id) => `https://cdn.test/${id}.png`);
  const existsImpl = opts.exists ?? (() => true);
  const preflightImpl = opts.preflight ?? (() => ({ ok: true as const }));
  const throwOnPut = opts.throwOnPut ?? new Set<string>();
  const throwOnDelete = opts.throwOnDelete ?? new Set<string>();

  return {
    puts,
    deletes,
    existsCalls,
    async put(id: string, bytes: Uint8Array, contentType: string): Promise<string | null> {
      puts.push({ id, bytes, contentType });
      if (throwOnPut.has(id)) throw new Error(`simulated put failure for ${id}`);
      return putImpl(id, bytes, contentType);
    },
    async delete(id: string): Promise<void> {
      deletes.push(id);
      if (throwOnDelete.has(id)) throw new Error(`simulated delete failure for ${id}`);
    },
    async exists(id: string, imageUrl?: string): Promise<boolean> {
      existsCalls.push(id);
      return existsImpl(id, imageUrl);
    },
    async preflight(): Promise<{ ok: true } | { ok: false; message: string }> {
      return preflightImpl();
    },
  };
}

/** A single recorded outbound request from a fakeStorageRunner. */
export interface RecordedStorageCall {
  url: string;
  method: "PUT" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

/**
 * A fake StorageHttpRunner routing `${method} ${url}` to a canned {ok,status,body}, for
 * BlobStorageProvider tests. Records every call for request-shape assertions. An
 * unmatched route resolves to a 404; set `throws` to simulate a transport failure.
 */
export function fakeStorageRunner(opts: {
  routes?: Record<string, { ok?: boolean; status?: number; body?: string }>;
  throws?: boolean;
}): StorageHttpRunner & { calls: RecordedStorageCall[] } {
  const routes = opts.routes ?? {};
  const calls: RecordedStorageCall[] = [];

  const runner = async (args: {
    url: string;
    method: "PUT" | "POST" | "HEAD";
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }): Promise<{ ok: boolean; status: number; body: string }> => {
    calls.push({ url: args.url, method: args.method, headers: args.headers, body: args.body });
    if (opts.throws) throw new Error("simulated transport failure");
    const route = routes[`${args.method} ${args.url}`];
    if (!route) return { ok: false, status: 404, body: "" };
    return { ok: route.ok ?? true, status: route.status ?? 200, body: route.body ?? "" };
  };

  return Object.assign(runner, { calls });
}

/**
 * An in-memory StorageFs for LocalStorageProvider failure-path tests. Backs a Map of
 * path→bytes. Set `failWrite`/`failRename`/`failUnlink` to simulate FS errors; unlink of
 * a missing path throws an ENOENT-coded error (to prove non-fatal handling).
 */
export function fakeStorageFs(opts: {
  failWrite?: boolean;
  failRename?: boolean;
  failUnlink?: boolean;
} = {}): StorageFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async mkdir() {
      return undefined;
    },
    async writeFile(path: string, data: Uint8Array) {
      if (opts.failWrite) throw new Error("simulated write failure");
      files.set(path, data);
    },
    async rename(from: string, to: string) {
      if (opts.failRename) throw new Error("simulated rename failure");
      const data = files.get(from);
      if (data === undefined) {
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      }
      files.delete(from);
      files.set(to, data);
    },
    async unlink(path: string) {
      if (opts.failUnlink) throw new Error("simulated unlink failure");
      if (!files.has(path)) {
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      }
      files.delete(path);
    },
    async stat(path: string) {
      const data = files.get(path);
      if (data === undefined) {
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      }
      return { size: data.length };
    },
  };
}

/** A fake ClaudeRunner returning canned stdout/exit code, for subscription-impl tests. */
export function fakeRunner(opts: {
  stdout?: string;
  code?: number;
  throws?: boolean;
}): ClaudeRunner {
  return async () => {
    if (opts.throws) throw new Error("simulated spawn failure");
    return { stdout: opts.stdout ?? "", code: opts.code ?? 0 };
  };
}

/** A fake GrokChatRunner returning a canned HTTP response body, for grok-impl tests. */
export function fakeGrokRunner(opts: {
  body?: string;
  ok?: boolean;
  status?: number;
  throws?: boolean;
}): GrokChatRunner {
  return async () => {
    if (opts.throws) throw new Error("simulated transport failure");
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      body: opts.body ?? "",
    };
  };
}

/** A single recorded call to a fake terminal runner (grok-terminal text/image). */
export interface RecordedTerminalCall {
  command: string;
  args: string[];
  prompt: string;
  timeoutMs?: number;
}

/** A fake TerminalTextRunner returning canned stdout/exit code, for grok-terminal text tests. */
export function fakeTerminalTextRunner(opts: {
  stdout?: string;
  code?: number;
  throws?: boolean;
}): TerminalTextRunner & { calls: RecordedTerminalCall[] } {
  const calls: RecordedTerminalCall[] = [];
  const runner = async (a: RecordedTerminalCall) => {
    calls.push(a);
    if (opts.throws) throw new Error("simulated spawn failure");
    return { stdout: opts.stdout ?? "", code: opts.code ?? 0 };
  };
  return Object.assign(runner, { calls });
}

/** A fake TerminalImageRunner returning canned bytes/exit code, for grok-terminal image tests. */
export function fakeTerminalImageRunner(opts: {
  bytes?: Uint8Array;
  code?: number;
  throws?: boolean;
}): TerminalImageRunner & { calls: RecordedTerminalCall[] } {
  const calls: RecordedTerminalCall[] = [];
  const runner = async (a: RecordedTerminalCall) => {
    calls.push(a);
    if (opts.throws) throw new Error("simulated spawn failure");
    return { bytes: opts.bytes ?? new Uint8Array(0), code: opts.code ?? 0 };
  };
  return Object.assign(runner, { calls });
}

/**
 * A fake DeployRunner for deploy/cycle tests. Returns a canned exit code (default 0);
 * set `throws` to make it reject (to prove deploy() swallows it). Records every call so
 * tests can assert the command + cwd it was invoked with — and that it was NOT called when
 * deploy is skipped/refused/aborted.
 */
export function fakeDeployRunner(
  opts: { code?: number; throws?: boolean } = {},
): DeployRunner & { calls: { command: string; cwd: string }[] } {
  const calls: { command: string; cwd: string }[] = [];
  const runner = async (a: { command: string; cwd: string }) => {
    calls.push(a);
    if (opts.throws) throw new Error("simulated deploy spawn failure");
    return { code: opts.code ?? 0, stdout: "", stderr: "" };
  };
  return Object.assign(runner, { calls });
}

/** A single write recorded by fakeCycleIo, tagged by kind. */
export interface RecordedIoWrite {
  kind: "manifest" | "published" | "site";
  path: string;
  /** For a site write: the rendered file map. */
  files?: Record<string, string>;
}

/**
 * An in-memory CycleIo for orchestrator tests. `readManifest` returns the seeded manifest
 * (a fresh clone each call). Every write is recorded in `writes` (and the latest manifest
 * kept in `saved`) so tests can assert persistence order and prove `--dry-run` writes
 * nothing. Set `throwOn` to a write kind to simulate a hard IO failure mid-run.
 */
export function fakeCycleIo(
  manifest: Manifest,
  opts: {
    throwOn?: "manifest" | "published" | "site";
    throwOnRead?: boolean;
    /** Ads the (otherwise disk-reading) loadAds boundary returns. Default: none. */
    ads?: AdView[];
    /** Articles the (otherwise disk-reading) loadArticles boundary returns. Default: none. */
    articles?: Article[];
    /** Result the processHeadshots boundary returns. Default: an all-empty run. */
    headshots?: HeadshotsResult;
    /** Make the processHeadshots boundary throw (to prove the stage is tolerant). */
    throwOnHeadshots?: boolean;
  } = {},
): CycleIo & {
  writes: RecordedIoWrite[];
  saved?: Manifest;
  headshotCalls: { dir: string; manifestPath: string }[];
} {
  const state = {
    writes: [] as RecordedIoWrite[],
    saved: undefined as Manifest | undefined,
    headshotCalls: [] as { dir: string; manifestPath: string }[],
  };
  const io: CycleIo = {
    async readManifest() {
      if (opts.throwOnRead) throw new Error("simulated manifest read failure");
      return { version: manifest.version, stories: { ...manifest.stories } };
    },
    async writeManifest(path, m) {
      if (opts.throwOn === "manifest") throw new Error("simulated manifest write failure");
      state.writes.push({ kind: "manifest", path });
      state.saved = m;
    },
    async writePublished(path) {
      if (opts.throwOn === "published") throw new Error("simulated published write failure");
      state.writes.push({ kind: "published", path });
    },
    async writeSite(path, files) {
      if (opts.throwOn === "site") throw new Error("simulated site write failure");
      state.writes.push({ kind: "site", path, files });
    },
    async loadAds() {
      return opts.ads ?? [];
    },
    async loadArticles() {
      return opts.articles ?? [];
    },
    async processHeadshots(dir, manifestPath) {
      state.headshotCalls.push({ dir, manifestPath });
      if (opts.throwOnHeadshots) throw new Error("simulated headshots failure");
      return (
        opts.headshots ?? {
          processed: [],
          skipped: [],
          missing: [],
          failed: [],
          manifest: { version: 1, headshots: {} },
        }
      );
    },
  };
  return Object.assign(io, state);
}
