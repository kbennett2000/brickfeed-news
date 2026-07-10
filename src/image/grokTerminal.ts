import { spawn } from "node:child_process";
import type { ImageProvider, TerminalImageRunner } from "../types.js";

/**
 * Grok-terminal image provider (Slice 8): the keyless subscription path for IMAGES. Shells
 * out to a configured CLI (`command` + `args`, e.g. `grok`) logged in via subscription on
 * the box — no API key, mirroring the text grok-terminal generator and the `claude -p`
 * subscription path. The `wrappedPrompt` (already brick-styled by wrapBrickStyle, the single
 * chokepoint) goes in on stdin; the raw PNG bytes come back on stdout.
 *
 * `wrappedPrompt` is passed through UNCHANGED; no styling is applied here.
 *
 * NEVER THROWS: a spawn error, non-zero exit, or empty output returns null so the caller
 * skips the story and retries next run — same contract as the Grok/local image providers.
 * The subprocess is injected as a TerminalImageRunner so tests feed canned bytes without a
 * real process or a login.
 */
export class GrokTerminalImageProvider implements ImageProvider {
  private readonly command: string;
  private readonly args: string[];
  private readonly runner: TerminalImageRunner;

  constructor(opts: { command: string; args: string[]; runner?: TerminalImageRunner }) {
    this.command = opts.command;
    this.args = opts.args;
    this.runner = opts.runner ?? defaultImageRunner;
  }

  async generate(wrappedPrompt: string): Promise<Uint8Array | null> {
    let result: { bytes: Uint8Array; code: number };
    try {
      result = await this.runner({
        command: this.command,
        args: this.args,
        prompt: wrappedPrompt,
      });
    } catch {
      return null;
    }

    if (result.code !== 0 || result.bytes.length === 0) return null;
    return result.bytes;
  }
}

/**
 * Default runner: spawn the configured CLI, write the wrapped prompt on stdin, collect the
 * raw image BYTES from stdout. The child inherits our environment (subscription login)
 * without this module touching it directly. A spawn error resolves as a non-zero code so
 * generate() degrades to null.
 */
export const defaultImageRunner: TerminalImageRunner = ({ command, args, prompt }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    // Drain stderr so the pipe never blocks; we don't surface it.
    child.stderr.on("data", () => {});

    child.on("error", () => resolve({ bytes: new Uint8Array(0), code: 1 }));
    child.on("close", (code) =>
      resolve({ bytes: new Uint8Array(Buffer.concat(chunks)), code: code ?? 1 }),
    );

    child.stdin.on("error", () => {}); // ignore EPIPE if the child exits early
    child.stdin.write(prompt);
    child.stdin.end();
  });
