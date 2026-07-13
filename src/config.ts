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
  /**
   * Retention window for OPINION-category records only (ADR-0013 #5). Absent → 168 (7 days);
   * NEVER falls back to maxAgeHours — opinion pieces outlive the news churn by design.
   */
  opinionMaxAgeHours: number;
  /**
   * UTC hour (integer 0–23) the CYCLE's opinions stage first runs each day (ADR-0018).
   * The gate is >= so a missed tick self-heals next cycle; `npm run opinions` bypasses
   * it entirely. Absent → 13 (≈ 7 AM Denver).
   */
  opinionPublishHourUTC: number;
  /** Where the derived newest-first list of publishable records is written (Slice 4). */
  publishedPath: string;
  /**
   * How many stories the generate + image stages process CONCURRENTLY. Each grok call is
   * ~90% idle waiting on the server, so a small pool collapses total wall-clock. Default 4.
   */
  concurrency: number;
  /**
   * Max stories the generate + image stages ATTEMPT per cycle, so a big backlog is spread
   * across cron ticks instead of one very long run. Default 40 (DEFAULT_MAX_STORIES_PER_CYCLE).
   */
  maxStoriesPerCycle: number;
  /** Static cover-page render settings (Slice 7). */
  render: RenderConfig;
  /** Deploy-step settings (Slice 8): how the rendered site is published to Vercel. */
  deploy: DeployConfig;
}

/** Where the static site is written + how many secondary (rail) stories the cover shows. */
export interface RenderConfig {
  /** Build dir the rendered index.html + per-section pages + styles.css are written to. */
  outputDir: string;
  /** Number of secondary stories in the hero rail, after the single lead (Slice 7). */
  secondaryStoryCount: number;
  /**
   * IANA time zone (e.g. "America/Denver") the dateline + time-of-day edition label are
   * computed in. Defaults to "UTC" so the render stays deterministic; set it to the server's
   * local zone so the edition ("Morning"/"Evening"/…) matches the wall-clock the cron ran on.
   */
  timeZone: string;
  /**
   * Absolute site origin (scheme + host, NO trailing slash, e.g.
   * "https://www.brickfeed.news"), used to build the absolute og:url on per-story landing
   * pages and the absolute landing URLs the X share links point at (ADR-0009). Relative URLs
   * are not valid for social cards, so this must be a real absolute origin.
   */
  siteBaseUrl: string;
  /**
   * Cookieless web-analytics provider injected into every page's shell. "none" (default) emits
   * nothing — the site stays byte-identical and JS-free. "vercel" injects the Vercel Web
   * Analytics plain-HTML snippet (`/_vercel/insights/script.js`); it only reports once Web
   * Analytics is enabled for the project in the Vercel dashboard.
   */
  analytics: "vercel" | "none";
  /** Assisted-manual X (Twitter) share-sheet settings (ADR-0009). Both fields optional. */
  share: ShareConfig;
  /** Responsive image optimization via Vercel's Image Optimization API (ADR-0012). */
  imageOptimization: ImageOptimizationConfig;
}

/**
 * Responsive image optimization (ADR-0012). When `enabled`, the render points each cover/story
 * `<img>` at Vercel's same-origin `/_vercel/image` endpoint with a `srcset` across `widths`, so
 * the browser fetches a right-sized AVIF/WebP instead of the full 1280 px source, and the render
 * emits a `vercel.json` whose `images` block allow-lists the Blob host. Disable to emit today's
 * plain `<img src=blobUrl>` (byte-identical) and no image config. Metered on Vercel — conservative
 * `widths` + `quality` keep transformations within the Pro allotment.
 */
export interface ImageOptimizationConfig {
  enabled: boolean;
  /** Candidate widths (px) for the srcset; each becomes one `/_vercel/image?w=` variant. */
  widths: number[];
  /** Optimization quality (1–100); ~75 is a good size/quality balance for photographic art. */
  quality: number;
}

/**
 * X (Twitter) share settings for the assisted-manual share sheet (ADR-0009). Both optional:
 * with neither set, the Web Intent URL carries only text + url and no twitter:site is emitted.
 */
export interface ShareConfig {
  /** The site's X handle, stored WITHOUT a leading "@" (feeds via= and twitter:site). */
  handle?: string;
  /** Default hashtags for a post, each WITHOUT a leading "#". */
  hashtags?: string[];
}

/**
 * Deploy step (Slice 8). The orchestrator shells out to `command` with cwd = `cwd` to
 * publish the rendered site. `enabled: false` skips deploy entirely (same as `--no-deploy`).
 * Any secret (a Vercel token for CI-like contexts) is env-only, never here.
 */
export interface DeployConfig {
  /** Shell command run to deploy (default `vercel --prod --yes`). */
  command: string;
  /** Working directory the command runs in (default = render.outputDir). */
  cwd: string;
  /** When false, deploy is skipped (same effect as `--no-deploy`). */
  enabled: boolean;
}

/** Which text generator to use, plus provider-specific settings. */
export interface GeneratorConfig {
  provider: "grok" | "claude" | "apikey" | "grok-terminal";
  /** Model for the "claude" (subscription) path. */
  model: string;
  /** Settings for the "grok" (xAI) path. */
  grok: GrokConfig;
  /** Settings for the "grok-terminal" (subscription CLI, no API key) path (Slice 8). */
  grokTerminal: GrokTerminalConfig;
}

/**
 * A subscription CLI invocation (Slice 8): the base `command` and its `args`. Used by the
 * keyless "grok-terminal" text generator and image provider. No API key — the CLI is logged
 * in via subscription on the box, exactly like the `claude -p` subscription path.
 */
export interface GrokTerminalConfig {
  command: string;
  args: string[];
  /**
   * Per-call wall-clock budget (ms) before the grok subprocess is SIGKILLed. Optional:
   * when omitted the provider's default applies (text 120s, image 180s). A hung call is
   * killed and the story stays pending, rather than stalling the whole cycle.
   */
  timeoutMs?: number;
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
  provider: "grok" | "local" | "grok-terminal";
  /** Settings for the "grok" (Grok Imagine, xAI) path. */
  grok: GrokImageConfig;
  /** Settings for the "local" (LAN imagegen microservice) path. */
  local: LocalImageConfig;
  /** Settings for the "grok-terminal" (subscription CLI, no API key) path (Slice 8). */
  grokTerminal: GrokTerminalConfig;
  /** Build-time bandwidth optimization applied to every stored image (all providers). */
  optimize: ImageOptimizeConfig;
}

/**
 * Build-time image optimization: cap each stored image's longest edge and re-encode to WebP.
 * Applied at the storage chokepoint (see src/storage/optimizing.ts) so it covers stories,
 * banner ads, and local articles. Provider-agnostic — the raw bytes any provider generates
 * are downscaled + WebP'd before upload. Disable to store the original bytes verbatim.
 */
export interface ImageOptimizeConfig {
  enabled: boolean;
  /** Longest-edge cap in px; larger images are downscaled, smaller ones left as-is. */
  maxEdge: number;
  /** WebP quality (1–100). */
  quality: number;
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

/** Allowed provider values per block, single source of truth for validation + error text. */
const GENERATOR_PROVIDERS = ["grok", "claude", "apikey", "grok-terminal"] as const;
const IMAGE_PROVIDERS = ["grok", "local", "grok-terminal"] as const;
const STORAGE_PROVIDERS = ["blob", "local"] as const;

/**
 * Back-compat aliases for renamed enum values, keyed by block+field. A config predating a
 * rename maps to the canonical value with a one-time deprecation warning (rather than a hard
 * failure). Currently only the subscription-CLI text provider was renamed
 * "subscription" → "claude" (Slice 2c). Image + storage providers were never renamed, so
 * they have none. Add an entry here whenever an enum value is renamed.
 */
const GENERATOR_PROVIDER_ALIASES: Record<string, GeneratorConfig["provider"]> = {
  subscription: "claude",
};

/**
 * Defaults when the config omits the `generator` block. Prod is KEYLESS: the default is
 * the subscription-CLI "grok-terminal" path (no API key), NOT the xAI API-key "grok" path.
 * A fresh or legacy config must resolve to the keyless path, never demand XAI_API_KEY.
 */
export const DEFAULT_PROVIDER: GeneratorConfig["provider"] = "grok-terminal";
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_GROK_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_GROK_MODEL = "grok-4.5";

/**
 * Defaults for the keyless "grok-terminal" subscription CLI path (Slice 8), shared by the
 * text generator and the image provider. The exact binary/flags are tuned on the box.
 */
export const DEFAULT_GROK_TERMINAL_COMMAND = "grok";
export const DEFAULT_GROK_TERMINAL_ARGS: string[] = [];

/**
 * Defaults when the config omits the `image` block. Prod is KEYLESS: the default is the
 * subscription-CLI "grok-terminal" path (no API key), NOT the xAI API-key "grok" Imagine
 * path. A fresh or legacy config must resolve to the keyless path, never demand XAI_API_KEY.
 */
export const DEFAULT_IMAGE_PROVIDER: ImageConfig["provider"] = "grok-terminal";
export const DEFAULT_IMAGE_GROK_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_IMAGE_GROK_MODEL = "grok-imagine-image-quality";
export const DEFAULT_IMAGE_ASPECT_RATIO = "1:1";
export const DEFAULT_IMAGE_RESOLUTION = "1k";
export const DEFAULT_IMAGE_LOCAL_URL = "http://localhost:8189";
export const DEFAULT_IMAGE_LOCAL_STYLE = "base";

/**
 * Defaults for build-time image optimization (image.optimize). ON by default: images are
 * generated at 1024–1376 px / 0.3–2.2 MB but displayed a few hundred px wide, so a 1280 px
 * WebP at q80 typically cuts image bytes 40–70% with no visible quality loss.
 */
export const DEFAULT_IMAGE_OPTIMIZE_ENABLED = true;
export const DEFAULT_IMAGE_OPTIMIZE_MAX_EDGE = 1280;
export const DEFAULT_IMAGE_OPTIMIZE_QUALITY = 80;

/** Defaults when the config omits the `storage` block (default = Vercel Blob). */
export const DEFAULT_STORAGE_PROVIDER: StorageConfig["provider"] = "blob";
export const DEFAULT_STORAGE_BLOB_PATH_PREFIX = "images/";
export const DEFAULT_STORAGE_BLOB_PUBLIC_BASE_URL = "";
// Local storage writes INTO the render output dir so images ship with the site (Vercel
// serves `site/` statically). `dir` is `site/images` and the public base is the RELATIVE
// path `images`, so `put` returns `images/<id>.<ext>` — exactly what render emits as the
// `<img src>` and what resolves under the served site root. (Overridable in config.)
export const DEFAULT_STORAGE_LOCAL_DIR = "site/images";
export const DEFAULT_STORAGE_LOCAL_PUBLIC_BASE_URL = "images";

/** Defaults for the age-out + publish outputs (Slice 4). */
export const DEFAULT_MAX_AGE_HOURS = 72;
/** 7 days — opinion pieces outlive the news churn (ADR-0013 #5); never inherits maxAgeHours. */
export const DEFAULT_OPINION_MAX_AGE_HOURS = 168;
/** 13:00 UTC ≈ 7 AM Denver — the cycle's opinion publish hour (ADR-0018). */
export const DEFAULT_OPINION_PUBLISH_HOUR_UTC = 13;
export const DEFAULT_PUBLISHED_PATH = "data/published.json";

/** Defaults for the pipeline throughput controls. */
export const DEFAULT_CONCURRENCY = 4;
// Imaging is newest-first (src/image.ts), so this caps how many of the freshest un-imaged
// stories get a picture per cycle. Sized to cover a cycle's fresh intake with headroom so the
// lead tracks current news; ~40 images ≈ a few minutes wall time, trivial for the cron cadence.
export const DEFAULT_MAX_STORIES_PER_CYCLE = 40;

/** Defaults when the config omits the `render` block (Slice 7). */
export const DEFAULT_RENDER_OUTPUT_DIR = "site";
export const DEFAULT_RENDER_SECONDARY_STORY_COUNT = 4;
// UTC keeps the render deterministic by default; the box overrides this with its local zone.
export const DEFAULT_RENDER_TIME_ZONE = "UTC";
// The production origin, so an omitted siteBaseUrl still yields correct absolute card/share
// URLs on the live box. No trailing slash (ADR-0009). Override in config for other origins.
export const DEFAULT_RENDER_SITE_BASE_URL = "https://www.brickfeed.news";
// Web analytics provider. "none" (default) emits no beacon; "vercel" injects the cookieless
// Vercel Web Analytics plain-HTML snippet into every page's shell.
export const DEFAULT_RENDER_ANALYTICS = "none";
// Responsive image optimization (ADR-0012). On by default so a live config.json without the
// block still serves right-sized AVIF/WebP; a conservative width ladder + q75 keeps Vercel
// Image Optimization transformations within the Pro allotment.
export const DEFAULT_RENDER_IMAGE_OPTIMIZATION_ENABLED = true;
export const DEFAULT_RENDER_IMAGE_OPTIMIZATION_WIDTHS = [320, 480, 640, 960, 1280];
export const DEFAULT_RENDER_IMAGE_OPTIMIZATION_QUALITY = 75;

/** Defaults when the config omits the `deploy` block (Slice 8). `cwd` defaults to outputDir. */
export const DEFAULT_DEPLOY_COMMAND = "vercel --prod --yes";
export const DEFAULT_DEPLOY_ENABLED = true;

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
  const maxAgeHours = validatePositiveHours(obj.maxAgeHours, DEFAULT_MAX_AGE_HOURS, path, "maxAgeHours");
  const opinionMaxAgeHours = validatePositiveHours(
    obj.opinionMaxAgeHours,
    DEFAULT_OPINION_MAX_AGE_HOURS,
    path,
    "opinionMaxAgeHours",
  );
  const opinionPublishHourUTC = validateHourOfDay(
    obj.opinionPublishHourUTC,
    DEFAULT_OPINION_PUBLISH_HOUR_UTC,
    path,
    "opinionPublishHourUTC",
  );
  const publishedPath = requireStringField(
    obj.publishedPath,
    DEFAULT_PUBLISHED_PATH,
    path,
    "publishedPath",
  );
  const concurrency = validatePositiveInt(
    obj.concurrency,
    DEFAULT_CONCURRENCY,
    path,
    "concurrency",
  );
  const maxStoriesPerCycle = validatePositiveInt(
    obj.maxStoriesPerCycle,
    DEFAULT_MAX_STORIES_PER_CYCLE,
    path,
    "maxStoriesPerCycle",
  );
  const render = validateRender(obj.render, path);
  const deploy = validateDeploy(obj.deploy, render.outputDir, path);

  return {
    feedUrls: feedUrls as string[],
    manifestPath,
    generator,
    brickStyle,
    image,
    storage,
    maxAgeHours,
    opinionMaxAgeHours,
    opinionPublishHourUTC,
    publishedPath,
    concurrency,
    maxStoriesPerCycle,
    render,
    deploy,
  };
}

/** Validate an optional positive-integer field, defaulting when omitted. */
function validatePositiveInt(
  raw: unknown,
  fallback: number,
  path: string,
  field: string,
): number {
  if (raw == null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`Config at ${path}: ${field} must be a positive integer.`);
  }
  return raw;
}

/**
 * Validate the `generator` block. Absent → defaults (keyless provider "grok-terminal",
 * DEFAULT_MODEL, default grok endpoint/model, default grok-terminal command/args). A
 * present provider, if any, must be one of the known values; model and the nested blocks
 * default when omitted.
 */
function validateGenerator(raw: unknown, path: string): GeneratorConfig {
  if (raw == null) {
    return {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      grok: defaultGrok(),
      grokTerminal: defaultGrokTerminal(),
    };
  }
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: generator must be an object.`);
  }
  const g = raw as Record<string, unknown>;

  const provider = validateEnum(
    g.provider ?? DEFAULT_PROVIDER,
    GENERATOR_PROVIDERS,
    GENERATOR_PROVIDER_ALIASES,
    path,
    "generator.provider",
  );

  const model = g.model ?? DEFAULT_MODEL;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error(`Config at ${path}: generator.model must be a non-empty string.`);
  }

  const grok = validateGrok(g.grok, path);
  const grokTerminal = validateGrokTerminal(g.grokTerminal, path, "generator.grokTerminal");

  return { provider, model, grok, grokTerminal };
}

/** Default grok-terminal CLI settings, used when the block or a field is omitted. */
function defaultGrokTerminal(): GrokTerminalConfig {
  return { command: DEFAULT_GROK_TERMINAL_COMMAND, args: [...DEFAULT_GROK_TERMINAL_ARGS] };
}

/**
 * Validate a nested `grokTerminal` block (shared by generator + image, Slice 8). Absent →
 * defaults; a present `command` must be a non-empty string; a present `args` must be an
 * array of strings. No secret is ever here — the CLI is subscription-authed.
 */
function validateGrokTerminal(
  raw: unknown,
  path: string,
  field: string,
): GrokTerminalConfig {
  if (raw == null) return defaultGrokTerminal();
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: ${field} must be an object.`);
  }
  const t = raw as Record<string, unknown>;

  const command = requireStringField(
    t.command,
    DEFAULT_GROK_TERMINAL_COMMAND,
    path,
    `${field}.command`,
  );

  const args = t.args ?? [...DEFAULT_GROK_TERMINAL_ARGS];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new Error(`Config at ${path}: ${field}.args must be an array of strings.`);
  }

  // Optional per-call timeout: when omitted, the provider's default applies (undefined
  // passes through). Present → must be a positive integer number of milliseconds.
  let timeoutMs: number | undefined;
  if (t.timeoutMs != null) {
    if (typeof t.timeoutMs !== "number" || !Number.isInteger(t.timeoutMs) || t.timeoutMs < 1) {
      throw new Error(`Config at ${path}: ${field}.timeoutMs must be a positive integer.`);
    }
    timeoutMs = t.timeoutMs;
  }

  return { command, args: args as string[], timeoutMs };
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
 * Validate the `image` block. Absent → defaults (keyless provider "grok-terminal", default
 * Grok Imagine endpoint/model/params, default local endpoint/style, default grok-terminal
 * command/args). A present provider, if any, must be one of the known values; the nested
 * blocks default per-field.
 */
function validateImage(raw: unknown, path: string): ImageConfig {
  if (raw == null) {
    return {
      provider: DEFAULT_IMAGE_PROVIDER,
      grok: defaultImageGrok(),
      local: defaultImageLocal(),
      grokTerminal: defaultGrokTerminal(),
      optimize: defaultImageOptimize(),
    };
  }
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: image must be an object.`);
  }
  const i = raw as Record<string, unknown>;

  const provider = validateEnum(
    i.provider ?? DEFAULT_IMAGE_PROVIDER,
    IMAGE_PROVIDERS,
    {},
    path,
    "image.provider",
  );

  const grok = validateImageGrok(i.grok, path);
  const local = validateImageLocal(i.local, path);
  const grokTerminal = validateGrokTerminal(i.grokTerminal, path, "image.grokTerminal");
  const optimize = validateImageOptimize(i.optimize, path);

  return { provider, grok, local, grokTerminal, optimize };
}

/** Default image-optimization settings, used when the block or a field is omitted. */
function defaultImageOptimize(): ImageOptimizeConfig {
  return {
    enabled: DEFAULT_IMAGE_OPTIMIZE_ENABLED,
    maxEdge: DEFAULT_IMAGE_OPTIMIZE_MAX_EDGE,
    quality: DEFAULT_IMAGE_OPTIMIZE_QUALITY,
  };
}

/**
 * Validate the nested `image.optimize` block. Absent → defaults (optimization ON). `enabled`
 * must be a boolean; `maxEdge` a positive integer; `quality` an integer in 1–100.
 */
function validateImageOptimize(raw: unknown, path: string): ImageOptimizeConfig {
  if (raw == null) return defaultImageOptimize();
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: image.optimize must be an object.`);
  }
  const o = raw as Record<string, unknown>;

  const enabled = o.enabled ?? DEFAULT_IMAGE_OPTIMIZE_ENABLED;
  if (typeof enabled !== "boolean") {
    throw new Error(`Config at ${path}: image.optimize.enabled must be a boolean.`);
  }

  const maxEdge = o.maxEdge ?? DEFAULT_IMAGE_OPTIMIZE_MAX_EDGE;
  if (typeof maxEdge !== "number" || !Number.isInteger(maxEdge) || maxEdge < 1) {
    throw new Error(`Config at ${path}: image.optimize.maxEdge must be a positive integer.`);
  }

  const quality = o.quality ?? DEFAULT_IMAGE_OPTIMIZE_QUALITY;
  if (typeof quality !== "number" || !Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new Error(`Config at ${path}: image.optimize.quality must be an integer in 1–100.`);
  }

  return { enabled, maxEdge, quality };
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

  const provider = validateEnum(
    s.provider ?? DEFAULT_STORAGE_PROVIDER,
    STORAGE_PROVIDERS,
    {},
    path,
    "storage.provider",
  );

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

/**
 * Validate the `render` block (Slice 7). Absent → defaults (outputDir "site",
 * secondaryStoryCount 4, timeZone "UTC", siteBaseUrl the prod origin, empty share). A present
 * outputDir/timeZone must be a non-empty string; a present secondaryStoryCount must be a
 * non-negative integer (0 = lead only, no rail); siteBaseUrl must be an absolute origin with
 * no trailing slash; share is an optional { handle?, hashtags? } block (ADR-0009).
 */
function validateRender(raw: unknown, path: string): RenderConfig {
  if (raw == null) {
    return {
      outputDir: DEFAULT_RENDER_OUTPUT_DIR,
      secondaryStoryCount: DEFAULT_RENDER_SECONDARY_STORY_COUNT,
      timeZone: DEFAULT_RENDER_TIME_ZONE,
      siteBaseUrl: DEFAULT_RENDER_SITE_BASE_URL,
      analytics: DEFAULT_RENDER_ANALYTICS,
      share: {},
      imageOptimization: defaultImageOptimization(),
    };
  }
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: render must be an object.`);
  }
  const r = raw as Record<string, unknown>;

  const outputDir = requireStringField(
    r.outputDir,
    DEFAULT_RENDER_OUTPUT_DIR,
    path,
    "render.outputDir",
  );

  const secondaryStoryCount = r.secondaryStoryCount ?? DEFAULT_RENDER_SECONDARY_STORY_COUNT;
  if (
    typeof secondaryStoryCount !== "number" ||
    !Number.isInteger(secondaryStoryCount) ||
    secondaryStoryCount < 0
  ) {
    throw new Error(
      `Config at ${path}: render.secondaryStoryCount must be a non-negative integer.`,
    );
  }

  const timeZone = requireStringField(
    r.timeZone,
    DEFAULT_RENDER_TIME_ZONE,
    path,
    "render.timeZone",
  );

  const siteBaseUrl = validateSiteBaseUrl(r.siteBaseUrl, path);
  const analytics = validateAnalytics(r.analytics, path);
  const share = validateShare(r.share, path);
  const imageOptimization = validateImageOptimization(r.imageOptimization, path);

  return { outputDir, secondaryStoryCount, timeZone, siteBaseUrl, analytics, share, imageOptimization };
}

/** The default image-optimization sub-block (a fresh copy so callers can't mutate the defaults). */
function defaultImageOptimization(): ImageOptimizationConfig {
  return {
    enabled: DEFAULT_RENDER_IMAGE_OPTIMIZATION_ENABLED,
    widths: [...DEFAULT_RENDER_IMAGE_OPTIMIZATION_WIDTHS],
    quality: DEFAULT_RENDER_IMAGE_OPTIMIZATION_QUALITY,
  };
}

/**
 * Validate the optional `render.imageOptimization` block (ADR-0012). Absent → defaults (enabled,
 * the standard width ladder, q75). Each present field defaults independently: `enabled` must be a
 * boolean; `widths` a non-empty array of positive integers; `quality` an integer in 1–100.
 */
function validateImageOptimization(raw: unknown, path: string): ImageOptimizationConfig {
  if (raw == null) return defaultImageOptimization();
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: render.imageOptimization must be an object.`);
  }
  const o = raw as Record<string, unknown>;

  const enabled = o.enabled ?? DEFAULT_RENDER_IMAGE_OPTIMIZATION_ENABLED;
  if (typeof enabled !== "boolean") {
    throw new Error(`Config at ${path}: render.imageOptimization.enabled must be a boolean.`);
  }

  const widths = o.widths ?? DEFAULT_RENDER_IMAGE_OPTIMIZATION_WIDTHS;
  if (
    !Array.isArray(widths) ||
    widths.length === 0 ||
    !widths.every((w) => typeof w === "number" && Number.isInteger(w) && w > 0)
  ) {
    throw new Error(
      `Config at ${path}: render.imageOptimization.widths must be a non-empty array of positive integers.`,
    );
  }

  const quality = o.quality ?? DEFAULT_RENDER_IMAGE_OPTIMIZATION_QUALITY;
  if (typeof quality !== "number" || !Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new Error(
      `Config at ${path}: render.imageOptimization.quality must be an integer between 1 and 100.`,
    );
  }

  return { enabled, widths: [...(widths as number[])], quality };
}

/**
 * Validate `render.analytics`. Absent → "none" (no beacon). A present value must be exactly
 * "vercel" or "none"; anything else is a config error.
 */
function validateAnalytics(raw: unknown, path: string): "vercel" | "none" {
  const v = raw ?? DEFAULT_RENDER_ANALYTICS;
  if (v !== "vercel" && v !== "none") {
    throw new Error(
      `Config at ${path}: render.analytics must be "vercel" or "none".`,
    );
  }
  return v;
}

/**
 * Validate `render.siteBaseUrl` (ADR-0009). Absent → the prod-origin default. A present
 * value must be a non-empty absolute http(s) origin with NO trailing slash — that's what
 * the absolute og:url and share URLs are built from, and a trailing slash would yield
 * "…//s/<id>.html".
 */
function validateSiteBaseUrl(raw: unknown, path: string): string {
  const v = raw ?? DEFAULT_RENDER_SITE_BASE_URL;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Config at ${path}: render.siteBaseUrl must be a non-empty string.`);
  }
  if (!/^https?:\/\//.test(v)) {
    throw new Error(
      `Config at ${path}: render.siteBaseUrl must be an absolute URL starting with http:// or https://.`,
    );
  }
  if (v.endsWith("/")) {
    throw new Error(
      `Config at ${path}: render.siteBaseUrl must not have a trailing slash (e.g. "https://www.brickfeed.news").`,
    );
  }
  return v;
}

/**
 * Validate the optional `render.share` block (ADR-0009). Absent → {}. A present `handle`
 * must be a non-empty string (a leading "@" is stripped — it's re-added for twitter:site);
 * a present `hashtags` must be an array of non-empty strings (each with any leading "#"
 * stripped — the Web Intent `hashtags=` param wants bare tags).
 */
function validateShare(raw: unknown, path: string): ShareConfig {
  if (raw == null) return {};
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: render.share must be an object.`);
  }
  const s = raw as Record<string, unknown>;

  const share: ShareConfig = {};

  if (s.handle != null) {
    if (typeof s.handle !== "string" || s.handle.trim().length === 0) {
      throw new Error(`Config at ${path}: render.share.handle must be a non-empty string.`);
    }
    share.handle = s.handle.trim().replace(/^@/, "");
  }

  if (s.hashtags != null) {
    if (
      !Array.isArray(s.hashtags) ||
      !s.hashtags.every((h) => typeof h === "string" && h.trim().length > 0)
    ) {
      throw new Error(
        `Config at ${path}: render.share.hashtags must be an array of non-empty strings.`,
      );
    }
    share.hashtags = (s.hashtags as string[]).map((h) => h.trim().replace(/^#/, ""));
  }

  return share;
}

/**
 * Validate the `deploy` block (Slice 8). Absent → defaults (`vercel --prod --yes`, cwd =
 * the render outputDir, enabled). A present `command`/`cwd` must be a non-empty string
 * (cwd defaults to the render outputDir); a present `enabled` must be a boolean.
 */
function validateDeploy(raw: unknown, renderOutputDir: string, path: string): DeployConfig {
  if (raw == null) {
    return {
      command: DEFAULT_DEPLOY_COMMAND,
      cwd: renderOutputDir,
      enabled: DEFAULT_DEPLOY_ENABLED,
    };
  }
  if (typeof raw !== "object") {
    throw new Error(`Config at ${path}: deploy must be an object.`);
  }
  const d = raw as Record<string, unknown>;

  const command = requireStringField(d.command, DEFAULT_DEPLOY_COMMAND, path, "deploy.command");
  const cwd = requireStringField(d.cwd, renderOutputDir, path, "deploy.cwd");

  const enabled = d.enabled ?? DEFAULT_DEPLOY_ENABLED;
  if (typeof enabled !== "boolean") {
    throw new Error(`Config at ${path}: deploy.enabled must be a boolean.`);
  }

  return { command, cwd, enabled };
}

/** Validate an hour-of-day field. Absent → its own fallback; present must be an integer 0–23. */
function validateHourOfDay(raw: unknown, fallback: number, path: string, field: string): number {
  if (raw == null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 23) {
    throw new Error(`Config at ${path}: ${field} must be an integer hour 0-23 (UTC).`);
  }
  return raw;
}

/** Validate an hours field. Absent → its own fallback; present must be a positive finite number. */
function validatePositiveHours(raw: unknown, fallback: number, path: string, field: string): number {
  if (raw == null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`Config at ${path}: ${field} must be a positive number.`);
  }
  return raw;
}

/**
 * Validate a config enum field with back-compat aliasing. A value matching a legacy
 * `aliases` key is mapped to its canonical replacement and a one-time deprecation warning
 * is emitted to stderr (NOT a hard failure), so configs predating a rename keep loading. An
 * allowed value passes through. Anything else throws an ACTIONABLE error (see `enumError`):
 * the offending file, the bad value, the allowed values, and — when a rename is the likely
 * cause — the fix. Callers pass the already-defaulted value, so an omitted field never lands
 * here.
 */
function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  aliases: Record<string, T>,
  path: string,
  field: string,
): T {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(aliases, value)) {
    const canonical = aliases[value];
    warnDeprecated(
      `Config at ${path}: ${field} "${value}" is a legacy value renamed to "${canonical}"; ` +
        `loading it as "${canonical}". Update ${path} to "${canonical}" to silence this warning.`,
    );
    return canonical;
  }
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(enumError(value, allowed, aliases, path, field));
}

/**
 * Build an actionable enum error: names the file, the bad value, the allowed set, and — when
 * renamed aliases exist for this field — the likely fix (e.g. `"subscription" → "claude"`).
 */
function enumError(
  value: unknown,
  allowed: readonly string[],
  aliases: Record<string, string>,
  path: string,
  field: string,
): string {
  const allowedList = allowed.map((v) => `"${v}"`).join(", ");
  let msg =
    `Config at ${path}: ${field} is ${describeValue(value)}, which is not a valid choice. ` +
    `Allowed values: ${allowedList}.`;
  const renames = Object.keys(aliases);
  if (renames.length > 0) {
    const hints = renames.map((k) => `"${k}" → "${aliases[k]}"`).join(", ");
    msg += ` If you see an old value here, it was renamed — change ${hints}.`;
  }
  return msg;
}

/** Render a value for an error message: strings quoted, everything else JSON-ish. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

/** Emit a deprecation warning to stderr. Kept in one place so the channel is consistent. */
function warnDeprecated(message: string): void {
  console.warn(message);
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
