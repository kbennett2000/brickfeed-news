import type { Config } from "../config.js";
import { getXaiApiKey } from "../secrets.js";
import type { ImageHttpRunner, ImageProvider } from "../types.js";
import { GrokImageProvider } from "./grok.js";
import { LocalImageProvider } from "./local.js";

export { GrokImageProvider } from "./grok.js";
export { LocalImageProvider } from "./local.js";

/**
 * Select an ImageProvider from config (Slice 3). Default is "grok" (Grok Imagine,
 * xAI). "local" is the LAN imagegen microservice. A custom runner can be injected
 * (used by tests); production leaves it undefined so the real HTTP boundary is used.
 */
export function createImageProvider(
  config: Config,
  opts: { runner?: ImageHttpRunner } = {},
): ImageProvider {
  const { provider, grok, local } = config.image;

  if (provider === "local") {
    return new LocalImageProvider({
      url: local.url,
      style: local.style,
      runner: opts.runner,
    });
  }

  // Default: Grok Imagine (xAI). Advisory preflight only — a missing key fails safe
  // (null) so the story is skipped rather than crashing the run.
  if (!getXaiApiKey()) {
    console.warn(
      "warning: XAI_API_KEY is not set; Grok image generation will skip every story. " +
        "Set XAI_API_KEY to enable it.",
    );
  }
  return new GrokImageProvider({
    baseUrl: grok.baseUrl,
    model: grok.model,
    aspectRatio: grok.aspectRatio,
    resolution: grok.resolution,
    runner: opts.runner,
  });
}
