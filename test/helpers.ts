import type { Config } from "../src/config.js";
import type {
  ClaudeRunner,
  GenerationInput,
  Generator,
  GeneratorOutput,
  GrokChatRunner,
  ImageHttpRunner,
  ImageProvider,
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
    },
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
