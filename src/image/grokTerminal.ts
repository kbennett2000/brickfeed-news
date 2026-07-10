import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { grokHeadlessArgs } from "../generator/grokTerminal.js";
import type { ImageProvider, TerminalImageRunner } from "../types.js";

/**
 * Grok-terminal image provider (Slice 8): the keyless subscription path for IMAGES. Shells
 * out to a configured CLI (`command` + `args`, e.g. `grok`) logged in via subscription on
 * the box — no API key, mirroring the text grok-terminal generator and the `claude -p`
 * subscription path. The `wrappedPrompt` (already brick-styled by wrapBrickStyle, the single
 * chokepoint) is passed through UNCHANGED; no styling is applied here.
 *
 * Grok Build is a full agentic *coding* assistant, not a bare image endpoint (Chronicle
 * reference): it NEVER prints image bytes on stdout. Instead `/imagine <prompt>` writes the
 * generated file under `~/.grok/sessions/<enc(cwd)>/<sessionId>/images/` and records its
 * absolute path in that session's `chat_history.jsonl`. The default runner (below) drives
 * that flow — isolated temp `--cwd`, mutating tools denied, locate the file, read its bytes —
 * so the provider itself keeps the simple bytes-or-null contract of every ImageProvider.
 *
 * NEVER THROWS: a spawn error, non-zero exit, or no locatable image returns null so the
 * caller skips the story and retries next run. The subprocess is injected as a
 * TerminalImageRunner so tests feed canned bytes without a real process or a login.
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

/** How long a single headless grok image turn may run before it is SIGKILLed. */
const IMAGE_TIMEOUT_MS = 240_000;

/**
 * Default runner: drive grok's `/imagine` headlessly and return the generated image BYTES.
 * grok runs in a throwaway temp `--cwd` (mutating tools denied) so it can only generate; it
 * writes the file to disk rather than stdout, so we locate it — preferring the exact path
 * recorded in the session's chat history, then falling back to the newest image written
 * under this run (which also salvages a run killed on timeout). The child inherits our
 * environment (subscription login) without this module reading it (secrets.ts is the only env
 * reader). Any failure resolves as a non-zero code so the provider degrades to null.
 */
export const defaultImageRunner: TerminalImageRunner = async ({ command, args, prompt }) => {
  const workDir = mkdtempSync(join(tmpdir(), "brickfeed-img-"));
  const sessionsBase = join(homedir(), ".grok", "sessions", encodeURIComponent(workDir));
  const startedAt = startedAtMs();
  try {
    const { stdout, code } = await runGrok(command, [
      ...args,
      ...grokHeadlessArgs(workDir, "-p", `/imagine ${prompt}`),
    ]);

    // Preferred: the exact path grok recorded in this session's chat history. Salvage: the
    // newest image written during this run (works even when a timeout robbed us of stdout /
    // the sessionId). Both are keyed to workDir, the cwd grok actually ran under.
    let imagePath: string | undefined;
    try {
      const env = JSON.parse(stdout) as { sessionId?: unknown };
      if (env && typeof env.sessionId === "string") {
        imagePath = findGrokImagePath(sessionsBase, env.sessionId);
      }
    } catch {
      /* unparseable stdout — lean on the salvage scan */
    }
    if (!imagePath) imagePath = newestImageUnder(sessionsBase, startedAt);
    // A non-zero exit with a salvaged file is still a success; only "no image" fails.
    if (!imagePath) return { bytes: new Uint8Array(0), code: code === 0 ? 1 : code };

    return { bytes: new Uint8Array(readFileSync(imagePath)), code: 0 };
  } catch {
    return { bytes: new Uint8Array(0), code: 1 };
  } finally {
    // Remove both our temp cwd and grok's own session copy for this run, so a scheduled
    // cycle doesn't grow ~/.grok/sessions without bound.
    for (const dir of [workDir, sessionsBase]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
};

/** Wall-clock ms floor for the salvage scan; split out so it is trivial to reason about. */
function startedAtMs(): number {
  return Date.now();
}

/** Spawn grok, collect stdout, SIGKILL on timeout; resolve {stdout, code}, never reject. */
function runGrok(
  command: string,
  argv: string[],
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (result: { stdout: string; code: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ stdout, code: 1 });
    }, IMAGE_TIMEOUT_MS);

    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", () => {});

    child.on("error", () => finish({ stdout: "", code: 1 }));
    child.on("close", (code) => finish({ stdout, code: code ?? 1 }));
  });
}

/**
 * The absolute path of the image grok generated in this session, read from its
 * `chat_history.jsonl` (a `tool_result` entry whose JSON `content` carries a `path`). Grok
 * Build does not print this path on stdout, so this session-layout read is the one place that
 * assumption lives (Chronicle reference). Returns undefined if nothing usable is found.
 * Exported + parameterized by `sessionsBase` so it is unit-testable against a fake tree.
 */
export function findGrokImagePath(
  sessionsBase: string,
  sessionId: string,
): string | undefined {
  const chatHistoryPath = join(sessionsBase, sessionId, "chat_history.jsonl");
  if (!existsSync(chatHistoryPath)) return undefined;

  let found: string | undefined;
  for (const line of readFileSync(chatHistoryPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      (entry as { type?: unknown }).type !== "tool_result" ||
      typeof (entry as { content?: unknown }).content !== "string"
    ) {
      continue;
    }
    try {
      const parsed = JSON.parse((entry as { content: string }).content) as { path?: unknown };
      if (typeof parsed.path === "string" && existsSync(parsed.path)) {
        // Last match wins — if a call somehow triggered more than one image, keep the newest.
        found = parsed.path;
      }
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * Newest image file under `<sessionsBase>/<sessionId>/images/`, written at or after
 * `sinceMs`, or undefined if none. The salvage path (Chronicle reference): usable even when a
 * timeout leaves us without the stdout sessionId. The `sinceMs` floor keeps a stale image
 * from an earlier call from being resurrected. Exported + parameterized for unit testing.
 */
export function newestImageUnder(sessionsBase: string, sinceMs: number): string | undefined {
  if (!existsSync(sessionsBase)) return undefined;
  let best: string | undefined;
  let bestMtime = -1;
  for (const sessionId of readdirSync(sessionsBase)) {
    const imagesDir = join(sessionsBase, sessionId, "images");
    if (!existsSync(imagesDir)) continue;
    for (const name of readdirSync(imagesDir)) {
      const full = join(imagesDir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      // 1s slack for coarse filesystem mtime resolution vs. Date.now().
      if (!stat.isFile() || stat.mtimeMs + 1000 < sinceMs) continue;
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        best = full;
      }
    }
  }
  return best;
}
