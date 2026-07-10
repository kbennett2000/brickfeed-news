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
  /** Image provider settings (Slice 3). Selects Grok Imagine (default) or local imagegen. */
  image: ImageConfig;
  /** Durable image storage settings (Slice 4). Selects Vercel Blob (default) or local dir. */
  storage: StorageConfig;
  /** Records with no update older than this many hours are aged out (Slice 4). */
  maxAgeHours: number;
  /** Where the derived newest-first list of publishable records is written (Slice 4). */
  publishedPath: string;
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

/** Which image provider to use, plus provider-specific settings (Slice 3). */
export interface ImageConfig {
  provider: "grok" | "local";
  /** Settings for the "grok" (Grok Imagine, xAI) path. */
  grok: GrokImageConfig;
  /** Settings for the "local" (LAN imagegen microservice) path. */
  local: LocalImageConfig;
}

/** Grok Imagine (xAI) endpoint + generation params. The API key is a secret (env). */
export interface GrokImageConfig {
  baseUrl: string;
  model: string;
  aspectRatio: string;
  resolution: string;
}

/** Local imagegen microservice endpoint + base (no-LoRA) style name. */
export interface LocalImageConfig {
  url: string;
  style: string;
}

/** Which storage provider to use for durable images, plus per-provider settings (Slice 4). */
export interface StorageConfig {
  provider: "blob" | "local";
  /** Settings for the "blob" (Vercel Blob) path. */
  blob: BlobStorageConfig;
  /** Settings for the "local" (dir + self-served base URL) path. */
  local: LocalStorageConfig;
}

/**
 * Vercel Blob settings. The read/write token is a secret (env), never config.
 * `publicBaseUrl` is the store's public host (e.g.
 * https://<store>.public.blob.vercel-storage.com); it is what durable URLs are built
 * from and what delete targets, so it must be set for real Blob use (may be "" until then).
 */
export interface BlobStorageConfig {
  pathPrefix: string;
  publicBaseUrl: string;
}

/** Local storage: a directory to write bytes into + the public base URL they're served at. */
export interface LocalStorageConfig {
  dir: string;
  publicBaseUrl: string;
}

/** Defaults when the config omits the `generator` block (default = grok). */
export const DEFAULT_PROVIDER: GeneratorConfig["provider"] = "grok";
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_GROK_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_GROK_MODEL = "grok-4.5";

/** Defaults when the config omits the `image` block (default = grok Imagine). */
export const DEFAULT_IMAGE_PROVIDER: ImageConfig["provider"] = "grok";
export const DEFAULT_IMAGE_GROK_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_IMAGE_GROK_MODEL = "grok-imagine-image-quality";
export const DEFAULT_IMAGE_ASPECT_RATIO = "1:1";
export const DEFAULT_IMAGE_RESOLUTION = "1k";
export const DEFAULT_IMAGE_LOCAL_URL = "http://localhost:8189";
export const DEFAULT_IMAGE_LOCAL_STYLE = "base";

/** Defaults when the config omits the `storage` block (default = Vercel Blob). */
export const DEFAULT_STORAGE_PROVIDER: StorageConfig["provider"] = "blob";
export const DEFAULT_STORAGE_BLOB_PATH_PREFIX = "images/";
export const DEFAULT_STORAGE_BLOB_PUBLIC_BASE_URL = "";
export const DEFAULT_STORAGE_LOCAL_DIR = "data/blob";
export const DEFAULT_STORAGE_LOCAL_PUBLIC_BASE_URL = "http://localhost:8189/blob";

/** Defaults for the age-out + publish outputs (Slice 4). */
export const DEFAULT_MAX_AGE_HOURS = 72;
export const DEFAULT_PUBLISHED_PATH = "data/published.json";

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
  const image = validateImage(obj.image, path);
  const storage = validateStorage(obj.storage, path);
  const maxAgeHours = validateMaxAgeHours(obj.maxAgeHours, path);
  const publishedPath = requireStringField(
    obj.publishedPath,
    DEFAULT_PUBLISHED_PATH,
    path,
    "publishedPath",
  );

  return {
    feedUrls: feedUrls as string[],
    manifestPath,
    generator,
    brickStyle,
    image,
    storage,
    maxAgeHours,
    publishedPath,
  };
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
 * Validate the `image` block. Absent → defaults (provider "grok", default Grok
 * Imagine endpoint/model/params, default local endpoint/style). A present provider,
 * if any, must be "grok" or "local"; the nested grok/local blocks default per-field.
 */
function validateImage(raw: unknown, path: string): ImageConfig {
  if (raw == null) {
    return {
      provider: DEFAULT_IMAGE_PROVIDER,
      grok: defaultImageGrok(),
      local: defaultImageLocal(),
    };
  }
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: image must be an object.`);
  }
  const i = raw as Record<string, unknown>;

  const provider = i.provider ?? DEFAULT_IMAGE_PROVIDER;
  if (provider !== "grok" && provider !== "local") {
    throw new Error(`Config at ${path}: image.provider must be "grok" or "local".`);
  }

  const grok = validateImageGrok(i.grok, path);
  const local = validateImageLocal(i.local, path);

  return { provider, grok, local };
}

/** Default Grok Imagine endpoint/model/params, used when the block or a field is omitted. */
function defaultImageGrok(): GrokImageConfig {
  return {
    baseUrl: DEFAULT_IMAGE_GROK_BASE_URL,
    model: DEFAULT_IMAGE_GROK_MODEL,
    aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
    resolution: DEFAULT_IMAGE_RESOLUTION,
  };
}

/** Default local imagegen endpoint/style, used when the block or a field is omitted. */
function defaultImageLocal(): LocalImageConfig {
  return { url: DEFAULT_IMAGE_LOCAL_URL, style: DEFAULT_IMAGE_LOCAL_STYLE };
}

/**
 * Validate the nested `image.grok` block. Absent → defaults; any present field must
 * be a non-empty string. The API key is never here — it's a secret (env).
 */
function validateImageGrok(raw: unknown, path: string): GrokImageConfig {
  if (raw == null) return defaultImageGrok();
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: image.grok must be an object.`);
  }
  const g = raw as Record<string, unknown>;

  const baseUrl = requireStringField(g.baseUrl, DEFAULT_IMAGE_GROK_BASE_URL, path, "image.grok.baseUrl");
  const model = requireStringField(g.model, DEFAULT_IMAGE_GROK_MODEL, path, "image.grok.model");
  const aspectRatio = requireStringField(g.aspectRatio, DEFAULT_IMAGE_ASPECT_RATIO, path, "image.grok.aspectRatio");
  const resolution = requireStringField(g.resolution, DEFAULT_IMAGE_RESOLUTION, path, "image.grok.resolution");

  return { baseUrl, model, aspectRatio, resolution };
}

/**
 * Validate the nested `image.local` block. Absent → defaults; any present field must
 * be a non-empty string.
 */
function validateImageLocal(raw: unknown, path: string): LocalImageConfig {
  if (raw == null) return defaultImageLocal();
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: image.local must be an object.`);
  }
  const l = raw as Record<string, unknown>;

  const url = requireStringField(l.url, DEFAULT_IMAGE_LOCAL_URL, path, "image.local.url");
  const style = requireStringField(l.style, DEFAULT_IMAGE_LOCAL_STYLE, path, "image.local.style");

  return { url, style };
}

/**
 * Validate the `storage` block. Absent → defaults (provider "blob", default blob
 * pathPrefix + empty publicBaseUrl, default local dir/base). A present provider, if any,
 * must be "blob" or "local"; the nested blocks default per-field.
 */
function validateStorage(raw: unknown, path: string): StorageConfig {
  if (raw == null) {
    return {
      provider: DEFAULT_STORAGE_PROVIDER,
      blob: defaultStorageBlob(),
      local: defaultStorageLocal(),
    };
  }
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: storage must be an object.`);
  }
  const s = raw as Record<string, unknown>;

  const provider = s.provider ?? DEFAULT_STORAGE_PROVIDER;
  if (provider !== "blob" && provider !== "local") {
    throw new Error(`Config at ${path}: storage.provider must be "blob" or "local".`);
  }

  const blob = validateStorageBlob(s.blob, path);
  const local = validateStorageLocal(s.local, path);

  return { provider, blob, local };
}

/** Default Vercel Blob settings, used when the block or a field is omitted. */
function defaultStorageBlob(): BlobStorageConfig {
  return {
    pathPrefix: DEFAULT_STORAGE_BLOB_PATH_PREFIX,
    publicBaseUrl: DEFAULT_STORAGE_BLOB_PUBLIC_BASE_URL,
  };
}

/** Default local storage settings, used when the block or a field is omitted. */
function defaultStorageLocal(): LocalStorageConfig {
  return {
    dir: DEFAULT_STORAGE_LOCAL_DIR,
    publicBaseUrl: DEFAULT_STORAGE_LOCAL_PUBLIC_BASE_URL,
  };
}

/**
 * Validate the nested `storage.blob` block. `pathPrefix` defaults + must be non-empty.
 * `publicBaseUrl` is OPTIONAL: it may be "" (unset) so config loads before a Blob store
 * exists, but must be a string; a real value is required for live delete + durable URLs.
 */
function validateStorageBlob(raw: unknown, path: string): BlobStorageConfig {
  if (raw == null) return defaultStorageBlob();
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: storage.blob must be an object.`);
  }
  const b = raw as Record<string, unknown>;

  const pathPrefix = requireStringField(
    b.pathPrefix,
    DEFAULT_STORAGE_BLOB_PATH_PREFIX,
    path,
    "storage.blob.pathPrefix",
  );

  const publicBaseUrl = b.publicBaseUrl ?? DEFAULT_STORAGE_BLOB_PUBLIC_BASE_URL;
  if (typeof publicBaseUrl !== "string") {
    throw new Error(`Config at ${path}: storage.blob.publicBaseUrl must be a string.`);
  }

  return { pathPrefix, publicBaseUrl };
}

/** Validate the nested `storage.local` block. Absent → defaults; present fields non-empty. */
function validateStorageLocal(raw: unknown, path: string): LocalStorageConfig {
  if (raw == null) return defaultStorageLocal();
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: storage.local must be an object.`);
  }
  const l = raw as Record<string, unknown>;

  const dir = requireStringField(l.dir, DEFAULT_STORAGE_LOCAL_DIR, path, "storage.local.dir");
  const publicBaseUrl = requireStringField(
    l.publicBaseUrl,
    DEFAULT_STORAGE_LOCAL_PUBLIC_BASE_URL,
    path,
    "storage.local.publicBaseUrl",
  );

  return { dir, publicBaseUrl };
}

/** Validate `maxAgeHours`. Absent → default; present must be a positive finite number. */
function validateMaxAgeHours(raw: unknown, path: string): number {
  if (raw == null) return DEFAULT_MAX_AGE_HOURS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`Config at ${path}: maxAgeHours must be a positive number.`);
  }
  return raw;
}

/** Coerce an optional config field to a non-empty string, defaulting when omitted. */
function requireStringField(
  value: unknown,
  fallback: string,
  path: string,
  field: string,
): string {
  const v = value ?? fallback;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Config at ${path}: ${field} must be a non-empty string.`);
  }
  return v;
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
