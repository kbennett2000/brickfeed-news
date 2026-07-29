import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createTextGenerator } from "../src/generator/text.js";
import { makeConfig } from "./helpers.js";

function withProvider(provider: Config["generator"]["provider"]): Config {
  const config = makeConfig();
  config.generator.provider = provider;
  return config;
}

describe("createTextGenerator", () => {
  it("claude: passes model + prompt to the runner and unwraps the result envelope", async () => {
    let seen: { model: string; prompt: string } | undefined;
    const generate = createTextGenerator(withProvider("claude"), {
      runner: async (args) => {
        seen = args;
        return { stdout: JSON.stringify({ type: "result", result: "  the essay  " }), code: 0 };
      },
    });
    await expect(generate("write it")).resolves.toBe("the essay");
    expect(seen).toEqual({ model: "test-model", prompt: "write it" });
  });

  it("claude: non-zero exit → null", async () => {
    const generate = createTextGenerator(withProvider("claude"), {
      runner: async () => ({ stdout: "essay", code: 1 }),
    });
    await expect(generate("p")).resolves.toBeNull();
  });

  it("claude: a throwing runner → null (never propagates)", async () => {
    const generate = createTextGenerator(withProvider("claude"), {
      runner: async () => {
        throw new Error("spawn failed");
      },
    });
    await expect(generate("p")).resolves.toBeNull();
  });

  it("claude: non-zero exit logs ONE diagnostic line with the exit code + stderr, still null", async () => {
    const lines: string[] = [];
    const generate = createTextGenerator(
      withProvider("claude"),
      { runner: async () => ({ stdout: "", code: 2, stderr: "Not logged in" }) },
      (m) => lines.push(m),
    );
    await expect(generate("p")).resolves.toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("text(claude) returned null");
    expect(lines[0]).toContain("exit=2");
    expect(lines[0]).toContain("Not logged in");
  });

  it("claude: an is_error envelope logs the error message from stdout, still null", async () => {
    const lines: string[] = [];
    const generate = createTextGenerator(
      withProvider("claude"),
      {
        runner: async () => ({
          stdout: JSON.stringify({ type: "result", is_error: true, result: "Not logged in · /login" }),
          code: 0,
        }),
      },
      (m) => lines.push(m),
    );
    await expect(generate("p")).resolves.toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("text(claude) returned null");
    expect(lines[0]).toContain("Not logged in");
  });

  it("grok-terminal: passes command/args/timeout from config and unwraps the text envelope", async () => {
    const config = withProvider("grok-terminal");
    config.generator.grokTerminal = { command: "grok-test", args: ["--fast"], timeoutMs: 5 };
    let seen: { command: string; args: string[]; prompt: string; timeoutMs?: number } | undefined;
    const generate = createTextGenerator(config, {
      terminalRunner: async (args) => {
        seen = args;
        return { stdout: JSON.stringify({ text: "the piece", sessionId: "s1" }), code: 0 };
      },
    });
    await expect(generate("go")).resolves.toBe("the piece");
    expect(seen).toEqual({ command: "grok-test", args: ["--fast"], prompt: "go", timeoutMs: 5 });
  });

  it("grok-terminal: empty/whitespace output → null", async () => {
    const generate = createTextGenerator(withProvider("grok-terminal"), {
      terminalRunner: async () => ({ stdout: "   ", code: 0 }),
    });
    await expect(generate("p")).resolves.toBeNull();
  });

  it("grok: unwraps the chat-completions envelope; non-ok → null", async () => {
    const ok = createTextGenerator(withProvider("grok"), {
      grokRunner: async ({ baseUrl, model }) => {
        expect(baseUrl).toBe("https://grok.test/v1");
        expect(model).toBe("grok-test");
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({ choices: [{ message: { content: "hot take" } }] }),
        };
      },
    });
    await expect(ok("p")).resolves.toBe("hot take");

    const bad = createTextGenerator(withProvider("grok"), {
      grokRunner: async () => ({ ok: false, status: 500, body: "" }),
    });
    await expect(bad("p")).resolves.toBeNull();
  });

  it("apikey: throws at factory time, naming the provider", () => {
    expect(() => createTextGenerator(withProvider("apikey"))).toThrow(/apikey/);
  });
});
