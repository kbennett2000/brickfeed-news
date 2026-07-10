import type { Config } from "../config.js";
import { getSubscriptionToken } from "../secrets.js";
import type { ClaudeRunner, Generator } from "../types.js";
import { ApiKeyGenerator } from "./apikey.js";
import { SubscriptionGenerator } from "./subscription.js";

export { SubscriptionGenerator } from "./subscription.js";
export { ApiKeyGenerator } from "./apikey.js";

/**
 * Select a Generator from config (ADR decision #6). Default is "subscription".
 * The `apikey` provider returns the Slice 2b stub. A custom runner can be injected
 * (used by tests); production leaves it undefined so the subscription generator
 * spawns the real Claude CLI.
 */
export function createGenerator(
  config: Config,
  opts: { runner?: ClaudeRunner } = {},
): Generator {
  const { provider, model } = config.generator;

  if (provider === "apikey") {
    return new ApiKeyGenerator();
  }

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
