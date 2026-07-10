import type { ImageHttpRunner, ImageProvider } from "../types.js";
import { defaultRunner } from "./grok.js";

/**
 * Local imagegen microservice provider — the switchable alternative to Grok Imagine.
 * Raw fetch to `POST {url}/generate` with the wrapped prompt as `prompt` and a
 * BASE/no-LoRA `style` from config. The style is base-only on purpose: brick styling
 * is already carried by `wrappedPrompt` (wrapBrickStyle, the single chokepoint), so
 * sending a brick LoRA here would double-apply it. Returns the raw PNG bytes.
 *
 * NEVER THROWS: an unreachable service, non-2xx, or transport error returns null so
 * the caller skips the story — same contract as the Grok provider. The service may
 * not be running in CI or on this box; that's expected (exercised via mocks).
 *
 * `wrappedPrompt` is passed through UNCHANGED; no styling is applied here.
 */
export class LocalImageProvider implements ImageProvider {
  private readonly url: string;
  private readonly style: string;
  private readonly runner: ImageHttpRunner;

  constructor(opts: { url: string; style: string; runner?: ImageHttpRunner }) {
    this.url = opts.url;
    this.style = opts.style;
    this.runner = opts.runner ?? defaultRunner;
  }

  async generate(wrappedPrompt: string): Promise<Uint8Array | null> {
    try {
      const resp = await this.runner({
        url: `${this.url}/generate`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: wrappedPrompt, style: this.style }),
      });
      if (!resp.ok) return null;
      return resp.bytes;
    } catch {
      return null;
    }
  }
}
