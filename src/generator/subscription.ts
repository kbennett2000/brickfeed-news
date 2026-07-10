import { spawn } from "node:child_process";
import { buildGenerationPrompt } from "../prompt.js";
import type {
  ClaudeRunner,
  GenerationInput,
  Generator,
  GeneratorOutput,
} from "../types.js";

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
 * Defensively parse the inner text Claude returned into a normalized
 * GeneratorOutput. Tolerates ```json fences, leading/trailing prose, and
 * whitespace by extracting the outermost {...} block before JSON.parse. Returns
 * null on any failure or if a required non-empty string key is missing.
 */
export function parseGeneratorOutput(text: string): GeneratorOutput | null {
  const jsonSlice = extractJsonObject(text);
  if (jsonSlice == null) return null;

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(jsonSlice);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const headline = cleanString(obj.headline);
  const description = cleanString(obj.description);
  const imagePrompt = cleanString(obj.imagePrompt);
  if (!headline || !description || !imagePrompt) return null;

  return { headline, description, imagePrompt };
}

/** Non-empty trimmed string, or "" if the value isn't a usable string. */
function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Extract the outermost JSON object from arbitrary text: strip code fences, then
 * take the substring from the first "{" to the last "}". Good enough for the
 * fenced / prose-wrapped / whitespace variants a chat model emits.
 */
export function extractJsonObject(text: string): string | null {
  // Drop the ```json ... ``` fence wrapper if present.
  const defenced = text.replace(/```(?:json)?/gi, "");
  const start = defenced.indexOf("{");
  const end = defenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return defenced.slice(start, end + 1);
}

/**
 * Default runner: spawn the Claude CLI, write the prompt on stdin, collect stdout.
 * No `env` option is passed, so the child inherits our environment — including
 * CLAUDE_CODE_OAUTH_TOKEN when set — without this module ever touching the
 * environment directly (secrets.ts is the only env reader). A spawn error resolves
 * as a non-zero exit code so generate() degrades to null rather than rejecting.
 */
const defaultRunner: ClaudeRunner = ({ model, prompt }) =>
  new Promise((resolve) => {
    const child = spawn(
      "claude",
      ["-p", "--bare", "--output-format", "json", "--model", model],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

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
