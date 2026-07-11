import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGenerationPrompt } from "../prompt.js";
import type {
  GenerationInput,
  Generator,
  GeneratorOutput,
  TerminalTextRunner,
} from "../types.js";
import { parseGeneratorOutput } from "./parse.js";

/**
 * Grok-terminal generator (Slice 8): the keyless subscription path for TEXT. Shells out to
 * a configured CLI (`command` + `args`, e.g. `grok`) that is logged in via subscription on
 * the box — no API key, mirroring the `claude -p` SubscriptionGenerator.
 *
 * The real `grok` is an agentic *coding* CLI (like `claude`), so — matching the Chronicle
 * reference — the prompt is passed HEADLESSLY as the `-p` value with `--output-format json`
 * (NOT on stdin), and the reply comes back wrapped in a `{ "text": "...", "sessionId": ... }`
 * envelope on stdout. `extractGrokText` unwraps `.text`; the shared, defensive
 * parseGeneratorOutput then tolerates fences / prose / whitespace inside it. The default
 * runner (below) also cages grok in a throwaway temp dir with mutating tools denied so a
 * stray reply can never explore or edit this repo.
 *
 * NEVER THROWS: any failure (spawn error, non-zero exit, unparseable output, missing keys)
 * returns null so the story stays pending and retries next run. The subprocess is injected
 * as a TerminalTextRunner so tests feed canned stdout without a real process or a login.
 */
export class GrokTerminalGenerator implements Generator {
  private readonly command: string;
  private readonly args: string[];
  private readonly runner: TerminalTextRunner;
  private readonly timeoutMs?: number;

  constructor(opts: {
    command: string;
    args: string[];
    runner?: TerminalTextRunner;
    timeoutMs?: number;
  }) {
    this.command = opts.command;
    this.args = opts.args;
    this.runner = opts.runner ?? defaultTextRunner;
    this.timeoutMs = opts.timeoutMs;
  }

  async generate(input: GenerationInput): Promise<GeneratorOutput | null> {
    const prompt = buildGenerationPrompt(input);

    let result: { stdout: string; code: number };
    try {
      result = await this.runner({
        command: this.command,
        args: this.args,
        prompt,
        timeoutMs: this.timeoutMs,
      });
    } catch {
      // Spawn/transport failure — never propagate.
      return null;
    }

    if (result.code !== 0) return null;

    return parseGeneratorOutput(extractGrokText(result.stdout));
  }
}

/**
 * Unwrap grok's headless JSON envelope. `grok -p ... --output-format json` prints
 * `{ "text": "<model reply>", "sessionId": ..., ... }`; the reply we want to parse is the
 * `.text` string. Returns that string when the envelope is present, otherwise the raw
 * stdout unchanged — so a bare or fenced JSON reply (and the injected-runner tests that feed
 * one) still flow straight into the shared parser. Never throws.
 */
export function extractGrokText(stdout: string): string {
  try {
    const env = JSON.parse(stdout) as { text?: unknown };
    if (env && typeof env === "object" && typeof env.text === "string") {
      return env.text;
    }
  } catch {
    // Not an envelope (bare/fenced JSON or prose) — fall through to the raw text.
  }
  return stdout;
}

/** Default budget for a single headless grok text turn before it is SIGKILLed (measured ~5s). */
export const DEFAULT_TEXT_TIMEOUT_MS = 120_000;

/**
 * Default runner: invoke the configured CLI headlessly and collect its stdout. Matching the
 * Chronicle reference, the prompt is the `-p` VALUE (not stdin) with `--output-format json`,
 * and grok runs in a throwaway temp `--cwd` with planning/subagents/web-search off and the
 * mutating tools denied — so an agentic reply can neither explore nor edit this repo, and
 * runs fast. The child inherits our environment (subscription login) without this module
 * reading it (secrets.ts is the only env reader). A spawn error or timeout resolves as a
 * non-zero code so generate() degrades to null.
 */
export const defaultTextRunner: TerminalTextRunner = ({ command, args, prompt, timeoutMs }) =>
  new Promise((resolve) => {
    const workDir = mkdtempSync(join(tmpdir(), "brickfeed-gen-"));
    let settled = false;
    const finish = (result: { stdout: string; code: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      resolve(result);
    };

    const child = spawn(command, [...args, ...grokHeadlessArgs(workDir, "-p", prompt)], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ stdout, code: 1 });
    }, timeoutMs ?? DEFAULT_TEXT_TIMEOUT_MS);

    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    // Drain stderr so the pipe never blocks; we don't surface it.
    child.stderr.on("data", () => {});

    child.on("error", () => finish({ stdout: "", code: 1 }));
    child.on("close", (code) => finish({ stdout, code: code ?? 1 }));
  });

/**
 * The headless flags shared by the grok-terminal text + image runners (Chronicle reference):
 * an isolated `--cwd`, JSON output, the agentic scaffolding trimmed off, and every mutating /
 * shell tool denied so grok can only produce its answer. `promptFlag`/`prompt` carry the turn
 * (`-p "<prompt>"` for text, `-p "/imagine <prompt>"` for image).
 */
export function grokHeadlessArgs(
  workDir: string,
  promptFlag: string,
  prompt: string,
): string[] {
  return [
    "--cwd",
    workDir,
    promptFlag,
    prompt,
    "--output-format",
    "json",
    "--no-plan",
    "--no-subagents",
    "--disable-web-search",
    "--deny",
    "Bash",
    "--deny",
    "Shell",
    "--deny",
    "Terminal",
    "--deny",
    "Edit",
    "--deny",
    "Write",
  ];
}
