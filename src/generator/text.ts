/**
 * Free-form text generation over the SAME provider abstraction the story generator uses
 * (ADR-0013 decision 1: opinion pieces come from the existing provider seam, not skills).
 * Where `createGenerator` is hard-locked to the five-key story JSON (its prompt builder and
 * parser both), this seam is transport-only: prompt in, plain text out. Prompt ASSEMBLY
 * stays with callers — today the persona bench (scripts/persona-bench.ts), next cycle the
 * opinion pipeline stage.
 *
 * Same never-throw posture as the story generators: the returned function resolves null on
 * any failure (spawn/transport error, non-zero exit, empty/unusable output). The one
 * exception is factory time — an unsupported provider throws immediately, because that is
 * a config error the caller should surface, not a per-story soft failure.
 */
import type { Config } from "../config.js";
import { getXaiApiKey } from "../secrets.js";
import type { ClaudeRunner, GrokChatRunner, TerminalTextRunner } from "../types.js";
import { extractChatContent } from "./grok.js";
import { defaultTextRunner, extractGrokText } from "./grokTerminal.js";
import { defaultRunner as defaultClaudeRunner, extractResultText } from "./subscription.js";

/** Free-form text generation: prompt in, plain text out. Never throws; null on failure. */
export type TextGenerator = (prompt: string) => Promise<string | null>;

/** Injectable transport boundaries (same shapes createGenerator takes); tests pass fakes. */
export interface TextGeneratorRunners {
  runner?: ClaudeRunner;
  grokRunner?: GrokChatRunner;
  terminalRunner?: TerminalTextRunner;
}

/**
 * Select a free-form TextGenerator from config, mirroring createGenerator's provider
 * dispatch: "grok-terminal" (keyless grok CLI), "claude" (subscription CLI), "grok" (xAI
 * chat API). "apikey" (a stub in the story path too) and unknown providers throw here at
 * construction — fail fast on a config error; the returned closure itself never throws.
 */
export function createTextGenerator(
  config: Config,
  opts: TextGeneratorRunners = {},
): TextGenerator {
  const { provider, model, grok, grokTerminal } = config.generator;

  if (provider === "grok-terminal") {
    const runner = opts.terminalRunner ?? defaultTextRunner;
    return async (prompt) => {
      let result: { stdout: string; code: number };
      try {
        result = await runner({
          command: grokTerminal.command,
          args: grokTerminal.args,
          prompt,
          timeoutMs: grokTerminal.timeoutMs,
        });
      } catch {
        return null;
      }
      if (result.code !== 0) return null;
      const text = extractGrokText(result.stdout).trim();
      return text.length > 0 ? text : null;
    };
  }

  if (provider === "claude") {
    const runner = opts.runner ?? defaultClaudeRunner;
    return async (prompt) => {
      let result: { stdout: string; code: number };
      try {
        result = await runner({ model, prompt });
      } catch {
        return null;
      }
      if (result.code !== 0) return null;
      const text = extractResultText(result.stdout)?.trim() ?? "";
      return text.length > 0 ? text : null;
    };
  }

  if (provider === "grok") {
    const runner = opts.grokRunner ?? defaultTextChatRunner;
    return async (prompt) => {
      let result: { ok: boolean; status: number; body: string };
      try {
        result = await runner({ baseUrl: grok.baseUrl, model: grok.model, prompt });
      } catch {
        return null;
      }
      if (!result.ok) return null;
      const text = extractChatContent(result.body)?.trim() ?? "";
      return text.length > 0 ? text : null;
    };
  }

  throw new Error(`free-form text generation is not implemented for provider "${provider}"`);
}

/**
 * Default xAI chat runner for free-form text. Same fetch shape as grok.ts's story runner,
 * WITHOUT `response_format: json_object` — forcing strict JSON on a 300–500 word essay
 * would mangle it. Bearer key via secrets.ts (the only env reader); a missing key or any
 * transport error resolves ok:false so the generator degrades to null.
 */
const defaultTextChatRunner: GrokChatRunner = async ({ baseUrl, model, prompt }) => {
  const apiKey = getXaiApiKey();
  if (!apiKey) return { ok: false, status: 0, body: "" };

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    return { ok: resp.ok, status: resp.status, body: await resp.text() };
  } catch {
    return { ok: false, status: 0, body: "" };
  }
};
