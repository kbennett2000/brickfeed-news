import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findGrokImagePath,
  GrokTerminalImageProvider,
  newestImageUnder,
} from "../src/image/grokTerminal.js";
import { bytes, fakeTerminalImageRunner } from "./helpers.js";

function provider(runner: ReturnType<typeof fakeTerminalImageRunner>) {
  return new GrokTerminalImageProvider({ command: "grok", args: ["image"], runner });
}

describe("GrokTerminalImageProvider.generate — happy path", () => {
  it("returns the raw bytes from stdout", async () => {
    const runner = fakeTerminalImageRunner({ bytes: bytes("PNGDATA") });
    expect(await provider(runner).generate("a wrapped prompt")).toEqual(bytes("PNGDATA"));
  });

  it("passes the configured command + args + wrapped prompt to the runner unchanged", async () => {
    const runner = fakeTerminalImageRunner({ bytes: bytes("PNGDATA") });
    await provider(runner).generate("WRAPPED brick prompt");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe("grok");
    expect(runner.calls[0].args).toEqual(["image"]);
    expect(runner.calls[0].prompt).toBe("WRAPPED brick prompt");
  });

  it("passes a configured timeoutMs through to the runner (undefined when unset)", async () => {
    const withTimeout = fakeTerminalImageRunner({ bytes: bytes("PNGDATA") });
    await new GrokTerminalImageProvider({
      command: "grok",
      args: ["image"],
      timeoutMs: 150_000,
      runner: withTimeout,
    }).generate("p");
    expect(withTimeout.calls[0].timeoutMs).toBe(150_000);

    const noTimeout = fakeTerminalImageRunner({ bytes: bytes("PNGDATA") });
    await provider(noTimeout).generate("p");
    expect(noTimeout.calls[0].timeoutMs).toBeUndefined();
  });
});

describe("GrokTerminalImageProvider.generate — never-throw failure modes", () => {
  it("returns null on a non-zero exit code", async () => {
    const runner = fakeTerminalImageRunner({ bytes: bytes("PNGDATA"), code: 1 });
    expect(await provider(runner).generate("p")).toBeNull();
  });

  it("returns null on empty output (zero bytes)", async () => {
    const runner = fakeTerminalImageRunner({ bytes: new Uint8Array(0), code: 0 });
    expect(await provider(runner).generate("p")).toBeNull();
  });

  it("returns null when the runner throws (spawn failure)", async () => {
    const runner = fakeTerminalImageRunner({ throws: true });
    expect(await provider(runner).generate("p")).toBeNull();
  });
});

// Image location: grok writes the file to disk (never stdout) and records its path in the
// session's chat_history.jsonl. These exercise the two location strategies against a fake
// ~/.grok/sessions/<enc(cwd)> tree — no real grok, no subprocess.
describe("findGrokImagePath / newestImageUnder", () => {
  let base: string; // stands in for ~/.grok/sessions/<enc(cwd)>
  const SESSION = "019f-session";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bf-sessions-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function writeSessionImage(sessionId: string, name: string, mtimeMs?: number): string {
    const imagesDir = join(base, sessionId, "images");
    mkdirSync(imagesDir, { recursive: true });
    const full = join(imagesDir, name);
    writeFileSync(full, bytes("JPEGDATA"));
    if (mtimeMs !== undefined) utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
    return full;
  }

  function writeChatHistory(sessionId: string, imagePath: string): void {
    const dir = join(base, sessionId);
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "assistant", content: "thinking" }),
      // The GenerateImage tool_result: content is a JSON STRING carrying the path.
      JSON.stringify({ type: "tool_result", content: JSON.stringify({ path: imagePath, filename: "1.jpg" }) }),
    ];
    writeFileSync(join(dir, "chat_history.jsonl"), lines.join("\n") + "\n");
  }

  it("finds the path recorded in the session chat history", () => {
    const img = writeSessionImage(SESSION, "1.jpg");
    writeChatHistory(SESSION, img);
    expect(findGrokImagePath(base, SESSION)).toBe(img);
  });

  it("returns undefined when there is no chat history for the session", () => {
    expect(findGrokImagePath(base, "missing-session")).toBeUndefined();
  });

  it("ignores a recorded path that no longer exists on disk", () => {
    writeChatHistory(SESSION, join(base, SESSION, "images", "gone.jpg"));
    expect(findGrokImagePath(base, SESSION)).toBeUndefined();
  });

  it("salvages the newest image written at/after the run start", () => {
    const now = 2_000_000_000_000;
    writeSessionImage(SESSION, "old.jpg", now - 60_000); // before the run — excluded
    const fresh = writeSessionImage(SESSION, "new.jpg", now + 5_000);
    expect(newestImageUnder(base, now)).toBe(fresh);
  });

  it("returns undefined from the salvage scan when the sessions base is absent", () => {
    expect(newestImageUnder(join(base, "does-not-exist"), 0)).toBeUndefined();
  });
});
