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

/** Vercel Blob read/write token, sent as a Bearer token by the Blob storage provider. */
export function getBlobReadWriteToken(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

/**
 * TTS local-provider endpoint OVERRIDE (ADR-0022). NOT a secret — `TTS_URL` is a non-secret
 * LAN endpoint whose canonical home is `config.json` (`generator.tts.url`); this optional env
 * override lets a cron cycle point at a different host via `cron.env` without editing config.
 * Confined here so the `grep process.env src/` single-file gate stays intact. Undefined → use
 * the config value.
 */
export function getTtsUrl(): string | undefined {
  return process.env.TTS_URL;
}

/**
 * Vercel deploy token for CI-like/headless contexts, appended as `--token` by the deploy
 * runner (Slice 8). The LAN box normally authenticates via a one-time `vercel login`, so
 * this is usually unset; it exists so the deploy step never reads env outside secrets.ts.
 */
export function getVercelToken(): string | undefined {
  return process.env.VERCEL_TOKEN;
}
