import { spawn } from "node:child_process";
import { buildGenerationPrompt } from "../prompt.js";
import type {
  ClaudeRunner,
  GenerationInput,
  Generator,
  GeneratorOutput,
} from "../types.js";
import { parseGeneratorOutput } from "./parse.js";

// Re-exported so existing importers (and tests) keep resolving the defensive parser
// through this module even though it now lives in ./parse.js and is shared with Grok.
export { extractJsonObject, parseGeneratorOutput } from "./parse.js";

/**
 * Headless args for the Claude CLI. Exported so a test can pin them — in
 * particular that `--bare` is NEVER present (it skips the subscription login and
 * makes every generation fail with "Not logged in"; see defaultRunner).
 */
export function buildClaudeArgs(model: string): string[] {
  return ["-p", "--output-format", "json", "--model", model];
}

/**
 * Subscription generator (ADR decision #6): shells out to the Claude CLI with
 * `claude -p --output-format json`. Single-shot text only — no tools, no
 * permissions. NEVER THROWS: any failure (spawn error, non-zero exit, unparseable
 * envelope, unparseable inner JSON, missing keys) returns null so the story stays
 * pending and retries next run.
 *
 * The subprocess is injected as a ClaudeRunner so tests can feed canned stdout
 * without spawning a real process or needing a token.
 */
export class SubscriptionGenerator implements Generator {
  private readonly model: string;
  private readonly runner: ClaudeRunner;

  constructor(opts: { model: string; runner?: ClaudeRunner }) {
    this.model = opts.model;
    this.runner = opts.runner ?? defaultRunner;
  }

  async generate(input: GenerationInput): Promise<GeneratorOutput | null> {
    const prompt = buildGenerationPrompt(input);

    let result: { stdout: string; code: number };
    try {
      result = await this.runner({ model: this.model, prompt });
    } catch {
      // Spawn/transport failure — never propagate.
      return null;
    }

    if (result.code !== 0) return null;

    const inner = extractResultText(result.stdout);
    if (inner == null) return null;

    return parseGeneratorOutput(inner);
  }
}

/**
 * Pull the assistant's text out of the `--output-format json` envelope. That
 * envelope looks like {"type":"result","result":"...text...","is_error":false,...}.
 * Defensive: if stdout isn't the expected envelope, fall back to treating the whole
 * of stdout as the inner text (some CLI modes emit bare text).
 */
export function extractResultText(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const envelope = JSON.parse(trimmed) as Record<string, unknown>;
    if (envelope.is_error === true) return null;
    if (typeof envelope.result === "string") return envelope.result;
    // Parsed as JSON but not the envelope we expected — maybe it's already the
    // inner object serialized directly. Hand the raw string to the inner parser.
    return trimmed;
  } catch {
    // Not JSON at all — treat the raw output as the inner text.
    return trimmed;
  }
}

/**
 * Default budget for a single headless `claude` turn before the child is SIGKILLed. Matches the
 * grok text runner (DEFAULT_TEXT_TIMEOUT_MS) and the TTS gate budget (DEFAULT_TTS_GATE_TIMEOUT_MS).
 * Without this bound the runner resolved only on the child's own close/error — on 2026-08-20 the
 * fallback taste-gate call hung ~303s then errored, stalling the whole cycle instead of failing fast
 * to the canned fallback (ADR-0033 item 2f).
 */
export const DEFAULT_CLAUDE_TIMEOUT_MS = 120_000;

/**
 * Spawn a CLI, write the prompt on stdin, collect stdout, and SIGKILL it past `timeoutMs` so a hung
 * child can never stall the caller (it resolves `code:1` → generate() degrades to null). All
 * resolutions route through `finish()` so the timer is always cleared and the promise settles once.
 * Exported (over `command`) purely as a test seam — production always passes `"claude"` via
 * defaultRunner; a test points it at a never-exiting stand-in to exercise the timeout deterministically.
 */
export function spawnClaude(
  command: string,
  args: string[],
  prompt: string,
  timeoutMs: number,
): Promise<{ stdout: string; code: number; stderr?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { stdout: string; code: number; stderr?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ stdout, code: 1, stderr });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    // Accumulate stderr (still drained so the pipe never blocks) — the story path ignores
    // it, but the free-form text seam surfaces it in its null-cause diagnostic (text.ts).
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err) => finish({ stdout: "", code: 1, stderr: err.message }));
    child.on("close", (code) => finish({ stdout, code: code ?? 1, stderr }));

    child.stdin.on("error", () => {}); // ignore EPIPE if the child exits early
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Default runner: spawn the Claude CLI, write the prompt on stdin, collect stdout, bounded by
 * `timeoutMs` (or DEFAULT_CLAUDE_TIMEOUT_MS). No `env` option is passed, so the child inherits our
 * environment — including CLAUDE_CODE_OAUTH_TOKEN when set — without this module ever touching the
 * environment directly (secrets.ts is the only env reader). A spawn error OR a timeout resolves as a
 * non-zero exit code so generate() degrades to null rather than rejecting or hanging. Exported so the
 * free-form text seam (text.ts) reuses this exact spawn — one stdin/exit-code truth — mirroring
 * grokTerminal's exported defaultTextRunner.
 *
 * Do NOT add `--bare` here. Minimal mode skips loading the stored subscription
 * login, so `claude -p --bare` returns is_error:true "Not logged in · Please run
 * /login" even on an authenticated box — every story would come back null. The
 * working headless invocation (mirroring photo-wrangler's launcher_core.build_claude_argv)
 * is plain `-p --output-format json --model <m>`.
 */
export const defaultRunner: ClaudeRunner = ({ model, prompt, timeoutMs }) =>
  spawnClaude("claude", buildClaudeArgs(model), prompt, timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS);
