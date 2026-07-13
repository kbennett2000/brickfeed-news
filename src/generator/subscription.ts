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
 * Default runner: spawn the Claude CLI, write the prompt on stdin, collect stdout.
 * No `env` option is passed, so the child inherits our environment — including
 * CLAUDE_CODE_OAUTH_TOKEN when set — without this module ever touching the
 * environment directly (secrets.ts is the only env reader). A spawn error resolves
 * as a non-zero exit code so generate() degrades to null rather than rejecting.
 * Exported so the free-form text seam (text.ts) reuses this exact spawn — one
 * stdin/exit-code truth — mirroring grokTerminal's exported defaultTextRunner.
 *
 * Do NOT add `--bare` here. Minimal mode skips loading the stored subscription
 * login, so `claude -p --bare` returns is_error:true "Not logged in · Please run
 * /login" even on an authenticated box — every story would come back null. The
 * working headless invocation (mirroring photo-wrangler's launcher_core.build_claude_argv)
 * is plain `-p --output-format json --model <m>`.
 */
export const defaultRunner: ClaudeRunner = ({ model, prompt }) =>
  new Promise((resolve) => {
    const child = spawn("claude", buildClaudeArgs(model), {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    // Drain stderr so the pipe never blocks; we don't surface it.
    child.stderr.on("data", () => {});

    child.on("error", () => resolve({ stdout: "", code: 1 }));
    child.on("close", (code) => resolve({ stdout, code: code ?? 1 }));

    child.stdin.on("error", () => {}); // ignore EPIPE if the child exits early
    child.stdin.write(prompt);
    child.stdin.end();
  });
