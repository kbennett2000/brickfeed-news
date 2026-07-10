import { buildGenerationPrompt } from "../prompt.js";
import { getXaiApiKey } from "../secrets.js";
import type {
  GenerationInput,
  Generator,
  GeneratorOutput,
  GrokChatRunner,
} from "../types.js";
import { parseGeneratorOutput } from "./parse.js";

/**
 * Grok (xAI) generator — the default provider. Talks to xAI's OpenAI-compatible
 * `POST {baseUrl}/chat/completions` with raw fetch (no SDK, matching the project's
 * no-framework discipline). Requests a single strict-JSON completion, pulls the
 * assistant message out of the chat envelope, and runs it through the SAME
 * defensive inner-JSON parser the subscription generator uses.
 *
 * NEVER THROWS: any failure (missing key, transport error, non-2xx, unparseable
 * envelope or inner JSON, missing keys) returns null so the story stays pending and
 * retries next run — same contract as SubscriptionGenerator.
 *
 * The HTTP call is injected as a GrokChatRunner so tests feed a canned response
 * body without a real network call or an API key.
 */
export class GrokGenerator implements Generator {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly runner: GrokChatRunner;

  constructor(opts: { baseUrl: string; model: string; runner?: GrokChatRunner }) {
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.runner = opts.runner ?? defaultRunner;
  }

  async generate(input: GenerationInput): Promise<GeneratorOutput | null> {
    const prompt = buildGenerationPrompt(input);

    let result: { ok: boolean; status: number; body: string };
    try {
      result = await this.runner({ baseUrl: this.baseUrl, model: this.model, prompt });
    } catch {
      // Transport failure — never propagate.
      return null;
    }

    if (!result.ok) return null;

    const content = extractChatContent(result.body);
    if (content == null) return null;

    return parseGeneratorOutput(content);
  }
}

/**
 * Pull the assistant's text out of an OpenAI-compatible chat-completions envelope:
 * {"choices":[{"message":{"content":"...text..."}}], ...}. Defensive — returns null
 * if the body isn't JSON, has no choices, or the content isn't a string.
 */
export function extractChatContent(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof envelope !== "object" || envelope === null) return null;
  const choices = (envelope as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

/**
 * Default runner: POST the prompt to xAI's chat-completions endpoint with the
 * Bearer key from secrets.ts (the only env reader). A missing key or any transport
 * error resolves as ok:false so generate() degrades to null (story stays pending)
 * rather than throwing. `response_format: json_object` asks for strict JSON; the
 * defensive parser still tolerates fences/prose if the model ignores it.
 */
const defaultRunner: GrokChatRunner = async ({ baseUrl, model, prompt }) => {
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
        response_format: { type: "json_object" },
      }),
    });
    return { ok: resp.ok, status: resp.status, body: await resp.text() };
  } catch {
    return { ok: false, status: 0, body: "" };
  }
};
