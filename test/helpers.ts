import type { Config } from "../src/config.js";
import type {
  ClaudeRunner,
  GenerationInput,
  Generator,
  GeneratorOutput,
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
    generator: { provider: "subscription", model: "test-model" },
    brickStyle: { styleLanguage: "TEST-STYLE toy-brick diorama" },
    ...over,
  };
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
