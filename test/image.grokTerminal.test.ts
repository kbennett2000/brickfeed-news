import { describe, expect, it } from "vitest";
import { GrokTerminalImageProvider } from "../src/image/grokTerminal.js";
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
