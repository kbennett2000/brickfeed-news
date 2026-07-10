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

/** Which Claude generator to use, and the model it runs. */
export interface GeneratorConfig {
  provider: "subscription" | "apikey";
  model: string;
}

/** Configurable, generic toy-brick style language wrapped around Claude's prompt. */
export interface BrickStyleConfig {
  styleLanguage: string;
}

/** Defaults when the config omits the `generator` block (default = subscription). */
export const DEFAULT_PROVIDER: GeneratorConfig["provider"] = "subscription";
export const DEFAULT_MODEL = "claude-sonnet-5";

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
 * Validate the `generator` block. Absent → defaults (provider "subscription",
 * DEFAULT_MODEL). Present provider, if any, must be one of the two known values;
 * model defaults when omitted.
 */
function validateGenerator(raw: unknown, path: string): GeneratorConfig {
  if (raw == null) {
    return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
  }
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: generator must be an object.`);
  }
  const g = raw as Record<string, unknown>;

  const provider = g.provider ?? DEFAULT_PROVIDER;
  if (provider !== "subscription" && provider !== "apikey") {
    throw new Error(
      `Config at ${path}: generator.provider must be "subscription" or "apikey".`,
    );
  }

  const model = g.model ?? DEFAULT_MODEL;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error(`Config at ${path}: generator.model must be a non-empty string.`);
  }

  return { provider, model };
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
