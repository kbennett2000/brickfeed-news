import { spawn } from "node:child_process";
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
 * the box — no API key, mirroring the `claude -p` SubscriptionGenerator. The prompt goes in
 * on stdin; the model's JSON reply comes back on stdout and is fed to the shared, defensive
 * parseGeneratorOutput (tolerates fences / prose / whitespace).
 *
 * NEVER THROWS: any failure (spawn error, non-zero exit, unparseable output, missing keys)
 * returns null so the story stays pending and retries next run. The subprocess is injected
 * as a TerminalTextRunner so tests feed canned stdout without a real process or a login.
 */
export class GrokTerminalGenerator implements Generator {
  private readonly command: string;
  private readonly args: string[];
  private readonly runner: TerminalTextRunner;

  constructor(opts: { command: string; args: string[]; runner?: TerminalTextRunner }) {
    this.command = opts.command;
    this.args = opts.args;
    this.runner = opts.runner ?? defaultTextRunner;
  }

  async generate(input: GenerationInput): Promise<GeneratorOutput | null> {
    const prompt = buildGenerationPrompt(input);

    let result: { stdout: string; code: number };
    try {
      result = await this.runner({ command: this.command, args: this.args, prompt });
    } catch {
      // Spawn/transport failure — never propagate.
      return null;
    }

    if (result.code !== 0) return null;

    return parseGeneratorOutput(result.stdout);
  }
}

/**
 * Default runner: spawn the configured CLI, write the prompt on stdin, collect stdout.
 * No `env` option is passed, so the child inherits our environment (subscription login),
 * without this module touching the environment directly (secrets.ts is the only env
 * reader). A spawn error resolves as a non-zero code so generate() degrades to null.
 */
export const defaultTextRunner: TerminalTextRunner = ({ command, args, prompt }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

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
