/**
 * The opt-in TTS local provider (ADR-0022). `text-transform-service` (TTS) is a LAN LLM
 * service exposing named transforms `text (+options) → schema-constrained JSON` over plain
 * HTTP (`POST {url}/v1/transform/{name}` → `200 {output, meta}`; errors `{error:{code}}`).
 * This module is the HTTP client plus the STORY-COVER adapter (the story-text seam); the
 * opinion-gate / opinion-image-brief adapters live in `src/opinions-tts.ts` (opinion domain).
 *
 * Contract (ADR-0022): every image prompt TTS returns is SUBJECT-NEUTRAL — the toy-brick
 * styling stays a downstream, caller-side chokepoint (`wrapBrickStyle`, applied once in
 * generate.ts / opinions.ts), so this provider returns the prompt UNWRAPPED, matching the
 * incumbent's own neutral output. Failover posture: any non-200 or unreachable TTS logs one
 * structured warning and the caller falls back to the incumbent Claude path. Never throws.
 */
import { normalizeCategory } from "../category.js";
import { getTtsUrl } from "../secrets.js";
import type { GenerationInput, Generator, GeneratorOutput } from "../types.js";

/** The three Brickfeed tasks TTS can serve (opinion-piece is HELD — never routed). */
export type TtsTask = "story-cover" | "opinion-gate" | "opinion-image-brief";

/** A validated success (`output` is the transform's JSON) or a typed failure. */
export type TtsResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; status: number; code: string };

/**
 * A FINAL TTS failure (after any retries), reported to an optional observer so the cycle can
 * raise a loud "TTS-DEGRADED" alarm instead of the failure being silently swallowed by failover.
 * `code` is the frozen error code (`busy`, `model_unavailable`, `unreachable`, `bad_envelope`, …);
 * `attempts` is how many tries were made before giving up.
 */
export interface TtsFailure {
  task: TtsTask;
  status: number;
  code: string;
  attempts: number;
}
export type TtsFailureObserver = (failure: TtsFailure) => void;

/** Optional client behavior: bounded retry + a failure observer for degradation reporting. */
export interface TtsClientOptions {
  /** Extra attempts after the first on a failed call (default 0 → one try, unchanged). */
  retries?: number;
  /** Delay between attempts, ms (default 500; only used when retries > 0). */
  backoffMs?: number;
  /** Called ONCE per final failure (after retries exhausted) — the degradation signal. */
  onFailure?: TtsFailureObserver;
}

/** Default backoff between TTS retries (ms). */
export const DEFAULT_TTS_BACKOFF_MS = 500;

/**
 * The HTTP boundary for the TTS client, injected so tests feed canned responses without a
 * real network call or a running service. `url` is the full transform endpoint; `body` the
 * JSON request; `timeoutMs` the per-CALL wall-clock budget the client resolved for this task
 * (the runner applies it; omitted → the runner's own default). A transport error is surfaced
 * as ok:false (status 0) rather than a rejection so the client degrades to a failover instead
 * of throwing.
 */
export type TtsHttpRunner = (args: {
  url: string;
  body: string;
  timeoutMs?: number;
}) => Promise<{ ok: boolean; status: number; body: string }>;

/** Per-call wall-clock budget (ms) before a TTS request is aborted, so a hung TTS never stalls a cycle. */
export const DEFAULT_TTS_TIMEOUT_MS = 30_000;

/**
 * The `opinion-gate`'s own budget (ms). It runs a single constrained batch classification over
 * the whole candidate set (~34 verdicts) on the LAN 9B, which inherently takes ~42s — well over
 * the shared 30s default. The gate fails CLOSED, so aborting it starves every news author that
 * cycle; a longer budget lets the one gate call complete. See ADR-0021 (2026-07-14 amendment).
 */
export const DEFAULT_TTS_GATE_TIMEOUT_MS = 120_000;

/**
 * Resolve the per-call timeout for a task: an explicit config override wins; otherwise the
 * code default (the shared 30s, except the gate's 120s). Keeps story-cover/brief untouched.
 */
export function resolveTtsTimeout(
  task: TtsTask,
  overrides?: Partial<Record<TtsTask, number>>,
): number {
  return (
    overrides?.[task] ??
    (task === "opinion-gate" ? DEFAULT_TTS_GATE_TIMEOUT_MS : DEFAULT_TTS_TIMEOUT_MS)
  );
}

/**
 * Default runner: POST the transform over `fetch` with a hard timeout (`timeoutMs`, or the
 * shared default when the caller omits it). Keyless (prod TTS has no `TRANSFORM_API_KEY`). Any
 * transport error / abort resolves ok:false so the client fails over rather than throwing.
 */
export const defaultTtsRunner: TtsHttpRunner = async ({ url, body, timeoutMs }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    return { ok: resp.ok, status: resp.status, body: await resp.text() };
  } catch {
    return { ok: false, status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Plain-HTTP TTS client. `run` posts a transform and returns a validated `TtsResult`; on any
 * non-200, unreachable endpoint, or malformed 200 envelope it emits ONE structured warning
 * (task, status, code) and returns a failure the caller handles (failover, or fail-closed for
 * the gate). No retries beyond whatever TTS does internally. Never throws.
 */
export class TtsClient {
  private readonly base: string;
  private readonly runner: TtsHttpRunner;
  private readonly timeouts?: Partial<Record<TtsTask, number>>;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly onFailure?: TtsFailureObserver;

  constructor(
    url: string,
    runner: TtsHttpRunner = defaultTtsRunner,
    timeouts?: Partial<Record<TtsTask, number>>,
    opts: TtsClientOptions = {},
  ) {
    this.base = url.replace(/\/+$/, "");
    this.runner = runner;
    this.timeouts = timeouts;
    this.retries = Math.max(0, opts.retries ?? 0);
    this.backoffMs = opts.backoffMs ?? DEFAULT_TTS_BACKOFF_MS;
    this.onFailure = opts.onFailure;
  }

  /** Emit the structured warning AND notify the observer — the single degradation signal. */
  private reportFailure(task: TtsTask, status: number, code: string, attempts: number): void {
    warnTts(task, status, code);
    this.onFailure?.({ task, status, code, attempts });
  }

  async run(task: TtsTask, text: string): Promise<TtsResult> {
    const url = `${this.base}/v1/transform/${task}`;
    const timeoutMs = resolveTtsTimeout(task, this.timeouts);
    const body = JSON.stringify({ text, options: {} });

    // Bounded retry: a transient failure (e.g. a 503 `busy` burst against the single worker)
    // may clear on a second try. `retries` extra attempts, short backoff between them. A clean
    // 200 short-circuits. Retrying does NOT change the failover contract — the caller still
    // falls back to Claude if every attempt fails.
    const tries = 1 + this.retries;
    let res: { ok: boolean; status: number; body: string } = { ok: false, status: 0, body: "" };
    let attempts = 0;
    for (let i = 0; i < tries; i++) {
      if (i > 0 && this.backoffMs > 0) await delay(this.backoffMs);
      attempts++;
      try {
        res = await this.runner({ url, body, timeoutMs });
      } catch {
        // A runner should surface transport failures as ok:false, but belt-and-braces.
        res = { ok: false, status: 0, body: "" };
      }
      if (res.ok) break;
    }

    if (!res.ok) {
      const code = res.status === 0 ? "unreachable" : extractErrorCode(res.body);
      this.reportFailure(task, res.status, code, attempts);
      return { ok: false, status: res.status, code };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      this.reportFailure(task, res.status, "bad_envelope", attempts);
      return { ok: false, status: res.status, code: "bad_envelope" };
    }
    const output = (parsed as { output?: unknown })?.output;
    if (typeof output !== "object" || output === null || Array.isArray(output)) {
      this.reportFailure(task, res.status, "bad_envelope", attempts);
      return { ok: false, status: res.status, code: "bad_envelope" };
    }
    return { ok: true, output: output as Record<string, unknown> };
  }
}

/** Promise-based delay used for retry backoff (kept tiny + injectable-free for testability). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve the effective TTS base URL: the `TTS_URL` env override (cron) wins over config. */
export function resolveTtsUrl(configUrl: string): string {
  return getTtsUrl() ?? configUrl;
}

/** Pull the frozen error `code` out of a `{error:{code}}` envelope; "error" if absent. */
function extractErrorCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    return typeof code === "string" && code.length > 0 ? code : "error";
  } catch {
    return "error";
  }
}

/** The single structured warning emitted on any TTS unavailability (task, status, code). */
function warnTts(task: TtsTask, status: number, code: string): void {
  console.warn(`tts unavailable: task=${task} status=${status} code=${code}`);
}

/** Non-empty trimmed string, or "" if the value isn't a usable string. */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the `story-cover` transform input: the story's source-context block (mirrors the tail
 * of `buildGenerationPrompt`). The transform template supplies all instructions, so only the
 * context travels in `text`.
 */
export function buildStoryCoverInput(input: GenerationInput): string {
  const source = input.sourceName ? input.sourceName : "unknown source";
  return `Source article title: ${input.title}\nPublisher: ${source}\nSource URL: ${input.url}`;
}

/** Map a `story-cover` output to a GeneratorOutput; null if a required field is missing/empty. */
export function mapStoryCoverOutput(output: Record<string, unknown>): GeneratorOutput | null {
  const headline = str(output.headline);
  const description = str(output.description);
  const imagePrompt = str(output.imagePrompt); // NEUTRAL — wrapped downstream, never here
  const caption = str(output.caption);
  if (!headline || !description || !imagePrompt || !caption) return null;
  return { headline, description, imagePrompt, category: normalizeCategory(output.category), caption };
}

/**
 * A Generator backed by the TTS `story-cover` transform. Returns a GeneratorOutput on a clean
 * 200, or null on ANY failure (non-200, unreachable, malformed) so the failover wrapper hands
 * off to the incumbent. Never throws.
 */
export function createTtsStoryGenerator(client: TtsClient): Generator {
  return {
    async generate(input: GenerationInput): Promise<GeneratorOutput | null> {
      const res = await client.run("story-cover", buildStoryCoverInput(input));
      if (!res.ok) return null;
      return mapStoryCoverOutput(res.output);
    },
  };
}

/**
 * Per-task failover Generator: try TTS first, fall back to the incumbent on null. Preserves
 * the `Generator` contract (never throws; null only when BOTH fail → story stays pending).
 */
export class TtsFailoverGenerator implements Generator {
  constructor(
    private readonly tts: Generator,
    private readonly incumbent: Generator,
  ) {}

  async generate(input: GenerationInput): Promise<GeneratorOutput | null> {
    const out = await this.tts.generate(input);
    if (out != null) return out;
    return this.incumbent.generate(input);
  }
}
