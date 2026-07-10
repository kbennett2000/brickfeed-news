/**
 * The ONLY module in src/ that reads the environment. Per CLAUDE.md, secrets
 * (the two Claude auth tokens) come from env exclusively — never from config, never
 * from disk. Confining every `process.env` access here keeps the hard gate
 * `grep -rn "process.env" src/` pointing at a single, auditable file, and reads
 * only these two named variables and nothing else.
 */

/** Subscription auth (`claude setup-token`). Used by the subscription generator. */
export function getSubscriptionToken(): string | undefined {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

/** API-key auth (Messages API). Reserved for the Slice 2b apikey generator. */
export function getApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

/** xAI (Grok) API key, sent as a Bearer token by the Grok generator. */
export function getXaiApiKey(): string | undefined {
  return process.env.XAI_API_KEY;
}
