/**
 * Opinion-stage adapters for the opt-in TTS local provider (ADR-0022): the `opinion-gate`
 * and `opinion-image-brief` transforms, plus the wiring helper that builds the optional
 * `OpinionsDeps.ttsGate` / `OpinionsDeps.ttsBrief` from config. Kept out of `opinions.ts` so
 * the stage logic stays provider-agnostic; imports its domain types from there (type-only, no
 * runtime cycle). The `opinion-piece` task is HELD by product decision and is never routed —
 * it stays on the incumbent Claude path.
 *
 * Two contracts differ by task:
 *  - `opinion-image-brief`: FAILOVER. Any TTS failure → return null; the caller falls back to
 *    the incumbent brief call. The returned imagePrompt is NEUTRAL (wrapped downstream).
 *  - `opinion-gate`: FAIL-CLOSED (safety, binding RESPONSE §2 / TTS ADR-0007). Any 4xx/5xx or
 *    unreachable → return null (the caller excludes ALL candidates). On a 200, every verdict
 *    that is `uncertain`, and every id that is missing or duplicated, maps to `excluded`. There
 *    is NO failover to Claude for the gate — excluding is the safe outcome.
 */
import type { Config } from "./config.js";
import { TtsClient, type TtsHttpRunner, resolveTtsUrl } from "./generator/tts.js";
import type { GateVerdict, ImageBrief } from "./opinions.js";
import type { Persona } from "./personas.js";
import type { ManifestRecord } from "./types.js";

/** Non-empty trimmed string, or "" if the value isn't a usable string. */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The `opinion-gate` transform input: a JSON array of `{id,title,summary}` (our own rewrites). */
export function buildGateInput(candidates: ManifestRecord[]): string {
  const stories = candidates.map((r) => ({
    id: r.id,
    title: r.headline ?? r.title,
    summary: r.description ?? "",
  }));
  return JSON.stringify(stories);
}

/**
 * Run the TTS `opinion-gate` and map to the fail-closed verdict map the caller expects. On any
 * TTS failure → null (caller excludes all candidates). On a 200 → a COMPLETE map over every
 * sent id: `eligible` only when TTS returned exactly one `eligible` verdict for that id;
 * `excluded` for `excluded`/`uncertain`/unknown verdicts, missing ids, and duplicate ids.
 */
export async function ttsGateVerdicts(
  client: TtsClient,
  candidates: ManifestRecord[],
): Promise<Map<string, GateVerdict> | null> {
  const res = await client.run("opinion-gate", buildGateInput(candidates));
  if (!res.ok) return null; // fail-closed: caller treats null as ALL EXCLUDED

  // First pass over the (schema-valid) verdicts: first occurrence sets the verdict; a second
  // occurrence forces the id excluded (duplicate). Anything not "eligible" is excluded.
  const decided = new Map<string, "eligible" | "excluded">();
  const reasons = new Map<string, string>();
  const verdicts = res.output.verdicts;
  if (Array.isArray(verdicts)) {
    for (const v of verdicts) {
      if (typeof v !== "object" || v === null) continue;
      const id = (v as Record<string, unknown>).id;
      if (typeof id !== "string") continue;
      if (decided.has(id)) {
        decided.set(id, "excluded"); // duplicate id → fail-closed
        reasons.set(id, "duplicate id (fail-closed)");
        continue;
      }
      const verdict = (v as Record<string, unknown>).verdict;
      const eligible = verdict === "eligible";
      decided.set(id, eligible ? "eligible" : "excluded");
      const reason = str((v as Record<string, unknown>).reason);
      reasons.set(id, eligible ? reason : reason || `${String(verdict)} (fail-closed)`);
    }
  }

  // Second pass: emit one verdict per SENT id; anything not decided-eligible is excluded.
  const out = new Map<string, GateVerdict>();
  for (const r of candidates) {
    const verdict: "eligible" | "excluded" = decided.get(r.id) === "eligible" ? "eligible" : "excluded";
    const reason =
      reasons.get(r.id) ?? (verdict === "excluded" ? "missing id (fail-closed)" : "");
    out.set(r.id, { id: r.id, verdict, reason });
  }
  return out;
}

/**
 * The `opinion-image-brief` transform input: the finished piece plus subject context (source
 * article blocks for news personas, a subject phrase for letters). The transform template
 * supplies all instructions, so only the piece + subject travel in `text`.
 */
export function buildBriefInput(
  persona: Persona,
  title: string,
  body: string,
  articles: ManifestRecord[],
): string {
  const subject =
    persona.source === "letters"
      ? "\n\nSUBJECT: the everyday situation described in the reader letter the piece answers."
      : "\n\nSOURCE ARTICLES the piece reacts to:\n" +
        articles
          .map((r, i) => {
            const lines = [r.headline ?? r.title];
            if (r.description) lines.push(r.description);
            return `ARTICLE ${i + 1}:\n${lines.join("\n")}`;
          })
          .join("\n\n");
  return `Title: ${title}\n\n${body}${subject}`;
}

/** Map an `opinion-image-brief` output to an ImageBrief; null if a key is missing/empty. */
export function mapBriefOutput(output: Record<string, unknown>): ImageBrief | null {
  const imagePrompt = str(output.imagePrompt); // NEUTRAL — wrapped downstream, never here
  const caption = str(output.caption);
  if (!imagePrompt || !caption) return null;
  return { imagePrompt, caption };
}

/**
 * Run the TTS `opinion-image-brief`. Returns an ImageBrief on a clean 200, or null on ANY
 * failure so the caller falls over to the incumbent brief call.
 */
export async function ttsImageBrief(
  client: TtsClient,
  persona: Persona,
  title: string,
  body: string,
  articles: ManifestRecord[],
): Promise<ImageBrief | null> {
  const res = await client.run("opinion-image-brief", buildBriefInput(persona, title, body, articles));
  if (!res.ok) return null;
  return mapBriefOutput(res.output);
}

/** The optional opinion-stage TTS deps (undefined members when a task is not opted in). */
export interface OpinionTtsDeps {
  ttsGate?: (candidates: ManifestRecord[]) => Promise<Map<string, GateVerdict> | null>;
  ttsBrief?: (
    persona: Persona,
    title: string,
    body: string,
    articles: ManifestRecord[],
  ) => Promise<ImageBrief | null>;
}

/**
 * Build the opinion-stage TTS deps from config (ADR-0022). Returns `{}` when the `generator.tts`
 * block is absent or neither opinion task is opted in, so the stage is byte-identical to today.
 * `runner` is injectable for tests. The `TTS_URL` env override (cron) wins over `tts.url`.
 */
export function createOpinionTtsDeps(config: Config, runner?: TtsHttpRunner): OpinionTtsDeps {
  const tts = config.generator.tts;
  if (!tts || (!tts.opinionGate && !tts.opinionImageBrief)) return {};
  const client = new TtsClient(resolveTtsUrl(tts.url), runner, tts.timeoutMs);
  const deps: OpinionTtsDeps = {};
  if (tts.opinionGate) deps.ttsGate = (candidates) => ttsGateVerdicts(client, candidates);
  if (tts.opinionImageBrief) {
    deps.ttsBrief = (persona, title, body, articles) =>
      ttsImageBrief(client, persona, title, body, articles);
  }
  return deps;
}
