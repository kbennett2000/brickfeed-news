import { readFile } from "node:fs/promises";

/**
 * App configuration. File-based only (see CLAUDE.md). Secrets are NEVER config:
 * the two auth tokens come from env, confined to src/secrets.ts. This file reads
 * no environment.
 */
export interface Config {
  /** One or more RSS feed URLs. Google News RSS by default, but swappable. */
  feedUrls: string[];
  /** Where the text-only JSON manifest lives. */
  manifestPath: string;
  /** Claude generation settings (ADR decision #6). */
  generator: GeneratorConfig;
  /** Toy-brick style wrapping (ADR decision #7). Style text lives here, not in code. */
  brickStyle: BrickStyleConfig;
}

/** Which text generator to use, plus provider-specific settings. */
export interface GeneratorConfig {
  provider: "grok" | "claude" | "apikey";
  /** Model for the "claude" (subscription) path. */
  model: string;
  /** Settings for the "grok" (xAI) path. */
  grok: GrokConfig;
}

/** xAI/Grok endpoint + model. The API key is a secret (env), never config. */
export interface GrokConfig {
  baseUrl: string;
  model: string;
}

/** Configurable, generic toy-brick style language wrapped around the image prompt. */
export interface BrickStyleConfig {
  styleLanguage: string;
}

/** Defaults when the config omits the `generator` block (default = grok). */
export const DEFAULT_PROVIDER: GeneratorConfig["provider"] = "grok";
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_GROK_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_GROK_MODEL = "grok-4.5";

/** Load and validate config.json (path defaults to ./config.json). */
export async function loadConfig(path = "config.json"): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `Config not found at ${path}. Copy config.example.json to config.json.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Config at ${path} is not valid JSON.`);
  }

  return validateConfig(parsed, path);
}

/** Structural validation, exported so tests can exercise it directly. */
export function validateConfig(parsed: unknown, path = "config"): Config {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Config at ${path} must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;

  const feedUrls = obj.feedUrls;
  if (
    !Array.isArray(feedUrls) ||
    feedUrls.length === 0 ||
    !feedUrls.every((u) => typeof u === "string" && u.length > 0)
  ) {
    throw new Error(`Config at ${path} needs a non-empty feedUrls string array.`);
  }

  const manifestPath = obj.manifestPath;
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    throw new Error(`Config at ${path} needs a non-empty manifestPath string.`);
  }

  const generator = validateGenerator(obj.generator, path);
  const brickStyle = validateBrickStyle(obj.brickStyle, path);

  return { feedUrls: feedUrls as string[], manifestPath, generator, brickStyle };
}

/**
 * Validate the `generator` block. Absent → defaults (provider "grok", DEFAULT_MODEL,
 * default grok endpoint/model). Present provider, if any, must be one of the three
 * known values; model and the nested grok block default when omitted.
 */
function validateGenerator(raw: unknown, path: string): GeneratorConfig {
  if (raw == null) {
    return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, grok: defaultGrok() };
  }
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: generator must be an object.`);
  }
  const g = raw as Record<string, unknown>;

  const provider = g.provider ?? DEFAULT_PROVIDER;
  if (provider !== "grok" && provider !== "claude" && provider !== "apikey") {
    throw new Error(
      `Config at ${path}: generator.provider must be "grok", "claude", or "apikey".`,
    );
  }

  const model = g.model ?? DEFAULT_MODEL;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error(`Config at ${path}: generator.model must be a non-empty string.`);
  }

  const grok = validateGrok(g.grok, path);

  return { provider, model, grok };
}

/** Default grok endpoint/model, used when the block or a field is omitted. */
function defaultGrok(): GrokConfig {
  return { baseUrl: DEFAULT_GROK_BASE_URL, model: DEFAULT_GROK_MODEL };
}

/**
 * Validate the nested `generator.grok` block. Absent → defaults; any present field
 * must be a non-empty string. The API key is never here — it's a secret (env).
 */
function validateGrok(raw: unknown, path: string): GrokConfig {
  if (raw == null) return defaultGrok();
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: generator.grok must be an object.`);
  }
  const g = raw as Record<string, unknown>;

  const baseUrl = g.baseUrl ?? DEFAULT_GROK_BASE_URL;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error(`Config at ${path}: generator.grok.baseUrl must be a non-empty string.`);
  }

  const model = g.model ?? DEFAULT_GROK_MODEL;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error(`Config at ${path}: generator.grok.model must be a non-empty string.`);
  }

  return { baseUrl, model };
}

/**
 * Validate the `brickStyle` block. styleLanguage is required and non-empty: the
 * style text lives in config, never hardcoded (ADR decision #7).
 */
function validateBrickStyle(raw: unknown, path: string): BrickStyleConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Config at ${path}: brickStyle must be an object.`);
  }
  const styleLanguage = (raw as Record<string, unknown>).styleLanguage;
  if (typeof styleLanguage !== "string" || styleLanguage.trim().length === 0) {
    throw new Error(
      `Config at ${path}: brickStyle.styleLanguage must be a non-empty string.`,
    );
  }
  return { styleLanguage };
}
