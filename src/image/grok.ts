import { getXaiApiKey } from "../secrets.js";
import type { ImageHttpRunner, ImageProvider } from "../types.js";

/**
 * Grok Imagine (xAI) image provider — the default. Talks to xAI's OpenAI-compatible
 * `POST {baseUrl}/images/generations` with raw fetch (no SDK, matching the project's
 * no-framework discipline). The response carries an EPHEMERAL image URL, so this
 * downloads the bytes in the same call and returns them; the xAI URL is never passed
 * downstream.
 *
 * NEVER THROWS: any failure (missing key, transport error, non-2xx, unparseable
 * envelope, missing url, failed download) returns null so the caller skips the story
 * and retries next run — same contract as the text generators.
 *
 * The two-step HTTP interaction (POST for the url, GET for the bytes) lives here,
 * above an injected low-level ImageHttpRunner, so tests exercise it hermetically
 * without a real network call or an API key.
 *
 * `wrappedPrompt` is passed through UNCHANGED as the request prompt: brick styling is
 * already applied upstream by wrapBrickStyle (the single styling chokepoint), never
 * here.
 */
export class GrokImageProvider implements ImageProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly aspectRatio: string;
  private readonly resolution: string;
  private readonly runner: ImageHttpRunner;

  constructor(opts: {
    baseUrl: string;
    model: string;
    aspectRatio: string;
    resolution: string;
    runner?: ImageHttpRunner;
  }) {
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.aspectRatio = opts.aspectRatio;
    this.resolution = opts.resolution;
    this.runner = opts.runner ?? defaultRunner;
  }

  async generate(wrappedPrompt: string): Promise<Uint8Array | null> {
    const apiKey = getXaiApiKey();
    if (!apiKey) return null; // fail safe — story stays pending

    try {
      // Step 1: request generation; the envelope carries an ephemeral image URL.
      const gen = await this.runner({
        url: `${this.baseUrl}/images/generations`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          prompt: wrappedPrompt,
          aspect_ratio: this.aspectRatio,
          resolution: this.resolution,
          n: 1,
        }),
      });
      if (!gen.ok) return null;

      const url = extractImageUrl(gen.bytes);
      if (url == null) return null;

      // Step 2: download the bytes immediately — the URL is ephemeral.
      const img = await this.runner({ url, method: "GET" });
      if (!img.ok) return null;

      return img.bytes;
    } catch {
      // Transport or any other failure — never propagate.
      return null;
    }
  }
}

/**
 * Pull the image URL out of an OpenAI-compatible images-generations envelope:
 * {"data":[{"url":"https://..."}], ...}. Defensive — returns null if the bytes
 * aren't JSON, have no data array, or the first entry's url isn't a string.
 */
export function extractImageUrl(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder().decode(bytes).trim();
  } catch {
    return null;
  }
  if (!text) return null;

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof envelope !== "object" || envelope === null) return null;
  const data = (envelope as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const url = (data[0] as { url?: unknown }).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Default runner: a thin raw-fetch wrapper returning response bytes. Any transport
 * error resolves as ok:false with empty bytes so generate() degrades to null rather
 * than throwing. Shared by the local provider too. No new runtime deps.
 */
export const defaultRunner: ImageHttpRunner = async ({ url, method, headers, body }) => {
  try {
    const resp = await fetch(url, { method, headers, body });
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return { ok: resp.ok, status: resp.status, bytes };
  } catch {
    return { ok: false, status: 0, bytes: new Uint8Array(0) };
  }
};
