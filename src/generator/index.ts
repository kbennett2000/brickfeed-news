import type { Config } from "../config.js";
import { getSubscriptionToken, getXaiApiKey } from "../secrets.js";
import type {
  ClaudeRunner,
  Generator,
  GrokChatRunner,
  TerminalTextRunner,
} from "../types.js";
import { ApiKeyGenerator } from "./apikey.js";
import { GrokGenerator } from "./grok.js";
import { GrokTerminalGenerator } from "./grokTerminal.js";
import { SubscriptionGenerator } from "./subscription.js";

export { SubscriptionGenerator } from "./subscription.js";
export { ApiKeyGenerator } from "./apikey.js";
export { GrokGenerator } from "./grok.js";
export { GrokTerminalGenerator } from "./grokTerminal.js";

/**
 * Select a Generator from config (ADR decision #6). Default is "grok" (xAI). The
 * "claude" provider is the subscription generator (`claude -p`); "grok-terminal" is the
 * keyless subscription CLI (Slice 8); "apikey" is the Slice 2b Messages-API stub. Custom
 * runners can be injected (used by tests); production leaves them undefined so the real
 * HTTP/CLI boundary is used.
 */
export function createGenerator(
  config: Config,
  opts: {
    runner?: ClaudeRunner;
    grokRunner?: GrokChatRunner;
    terminalRunner?: TerminalTextRunner;
  } = {},
): Generator {
  const { provider, model, grok, grokTerminal } = config.generator;

  if (provider === "grok-terminal") {
    // Keyless subscription CLI: no env preflight (the CLI carries its own login, like
    // `claude -p`); a failed generation fails safe (null) and the story stays pending.
    return new GrokTerminalGenerator({
      command: grokTerminal.command,
      args: grokTerminal.args,
      timeoutMs: grokTerminal.timeoutMs,
      runner: opts.terminalRunner,
    });
  }

  if (provider === "claude") {
    // Advisory preflight only — do not block. `claude` may authenticate from a
    // stored login even when the env token is unset; if it can't, generate() fails
    // safe (null) and the story stays pending.
    if (!getSubscriptionToken()) {
      console.warn(
        "warning: CLAUDE_CODE_OAUTH_TOKEN is not set; relying on the Claude CLI's " +
          "stored login. Run `claude setup-token` if generation fails.",
      );
    }
    return new SubscriptionGenerator({ model, runner: opts.runner });
  }

  if (provider === "apikey") {
    return new ApiKeyGenerator();
  }

  // Default: Grok (xAI). Advisory preflight only — a missing key fails safe (null)
  // so the story stays pending rather than crashing the run.
  if (!getXaiApiKey()) {
    console.warn(
      "warning: XAI_API_KEY is not set; Grok generation will leave stories pending. " +
        "Set XAI_API_KEY to enable it.",
    );
  }
  return new GrokGenerator({
    baseUrl: grok.baseUrl,
    model: grok.model,
    runner: opts.grokRunner,
  });
}
