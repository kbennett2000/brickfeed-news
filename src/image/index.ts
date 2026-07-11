import type { Config } from "../config.js";
import { getXaiApiKey } from "../secrets.js";
import type { ImageHttpRunner, ImageProvider, TerminalImageRunner } from "../types.js";
import { GrokImageProvider } from "./grok.js";
import { GrokTerminalImageProvider } from "./grokTerminal.js";
import { LocalImageProvider } from "./local.js";

export { GrokImageProvider } from "./grok.js";
export { LocalImageProvider } from "./local.js";
export { GrokTerminalImageProvider } from "./grokTerminal.js";

/**
 * Select an ImageProvider from config (Slice 3). Default is "grok" (Grok Imagine,
 * xAI). "local" is the LAN imagegen microservice; "grok-terminal" is the keyless
 * subscription CLI (Slice 8). A custom runner can be injected (used by tests);
 * production leaves it undefined so the real HTTP/CLI boundary is used.
 */
export function createImageProvider(
  config: Config,
  opts: { runner?: ImageHttpRunner; terminalRunner?: TerminalImageRunner } = {},
): ImageProvider {
  const { provider, grok, local, grokTerminal } = config.image;

  if (provider === "grok-terminal") {
    // Keyless subscription CLI: no env preflight; a failure fails safe (null) and the
    // story is skipped, retried next run.
    return new GrokTerminalImageProvider({
      command: grokTerminal.command,
      args: grokTerminal.args,
      timeoutMs: grokTerminal.timeoutMs,
      runner: opts.terminalRunner,
    });
  }

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
