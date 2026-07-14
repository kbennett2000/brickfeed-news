/**
 * Slot-based hero eligibility (ADR-0020). The image stage should pay Grok only for heroes a
 * reader can actually encounter in a visible listing slot, and the render should list only
 * those same slots — so the image budget and the display bound MUST be one shared constant.
 * That constant is SECTION_SLOT_LIMIT here; the image stage and the render both key off it.
 *
 * Pure and hermetic: no clock, no IO — callers pass `now` (ms) and the config.
 */
import { retentionHoursFor } from "./ageout.js";
import { type Category, normalizeCategory } from "./category.js";
import type { Config } from "./config.js";
import type { ManifestRecord } from "./types.js";

/**
 * K — the top-K stories per section that (a) get a hero and (b) are listed on the cover/section
 * pages. ONE constant so the image budget and the display bound can never drift. Generous by
 * design: with 72h retention a section rarely holds this many live stories, so the new bound is
 * tail-only — nothing above the fold changes. A code constant (like HERO_FILL_COUNT), not config:
 * it encodes the image==display invariant, not a per-deploy tunable.
 */
export const SECTION_SLOT_LIMIT = 30;

/**
 * A fresh hero needs at least this many hours of life left before the age-out (measured from
 * `lastSeen`, the same basis ageOut uses). A story ingested old enough to vanish overnight is
 * not worth a paid image — it would age out before a reader could encounter it.
 */
export const HERO_MIN_LIFETIME_HOURS = 12;

/**
 * An opinion piece (ADR-0015): marked by an `author`, or an OPINION category. Exempt from the
 * slot + lifetime gate — opinions are always imaged and always displayed (2–4/day, by design).
 * Mirrors the render's opinion test (`!v.opinion && v.kicker !== "OPINION"`).
 */
export function isOpinionRecord(record: ManifestRecord): boolean {
  return !!record.author || normalizeCategory(record.category) === "OPINION";
}

/**
 * Rank each live NON-OPINION record within its section (normalized category) by `firstSeen`
 * DESCENDING — the same newest-first key publish.ts and the render order by. Returns id →
 * 0-based rank. Opinion records are omitted (their section is unbounded, ADR-0016). Records
 * are bucketed by `normalizeCategory` (undefined → WORLD) so the ranking matches exactly the
 * sections the render displays. Sorts internally, so an unordered
 * `Object.values(manifest.stories)` is a valid input.
 */
export function sectionRanks(records: ManifestRecord[]): Map<string, number> {
  const bySection = new Map<Category, ManifestRecord[]>();
  for (const r of records) {
    if (isOpinionRecord(r)) continue;
    const cat = normalizeCategory(r.category);
    const list = bySection.get(cat);
    if (list) list.push(r);
    else bySection.set(cat, [r]);
  }
  const ranks = new Map<string, number>();
  for (const list of bySection.values()) {
    list.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
    list.forEach((r, i) => ranks.set(r.id, i));
  }
  return ranks;
}

/**
 * The ids within the top-`limit` of their section — the display bound (render) and, via
 * SECTION_SLOT_LIMIT, the image budget both use this so they can never diverge. OPINION records
 * are ALWAYS included (never capped). Built from `sectionRanks`, so the ranking key is identical
 * everywhere.
 */
export function sectionSlotIds(records: ManifestRecord[], limit: number): Set<string> {
  const ranks = sectionRanks(records);
  const ids = new Set<string>();
  for (const r of records) {
    if (isOpinionRecord(r)) {
      ids.add(r.id);
      continue;
    }
    const rank = ranks.get(r.id);
    if (rank !== undefined && rank < limit) ids.add(r.id);
  }
  return ids;
}

/** The verdict for one image-generation cycle over a set of live records. */
export interface HeroDecision {
  /** Ids that should be imaged this run: image-needing records that pass (incl. all opinions). */
  eligible: Set<string>;
  /** Image-needing records skipped because they already have an image, or aren't generated yet. */
  skipped: number;
  /** Non-opinion records that need an image but rank outside the top-K of their section. */
  belowFold: number;
  /** In-slot non-opinion records skipped because they'd age out within HERO_MIN_LIFETIME_HOURS. */
  nearAgeout: number;
}

/**
 * Classify every live record for the image stage. A record NEEDS an image when it has a
 * `wrappedPrompt` and no `imageUrl` yet; anything else is `skipped` (already stored — idempotent
 * — or not generated yet). An image-needing record is `eligible` iff:
 *  - it's an opinion piece (always), OR
 *  - (slot test) it ranks within the top-`SECTION_SLOT_LIMIT` of its section by newest-first
 *    firstSeen, competing against ALL live stories in the section (imaged or not — already-imaged
 *    records occupy slots because they're ranked too), AND
 *  - (lifetime test) it has >= HERO_MIN_LIFETIME_HOURS of life left before its age-out (measured
 *    from `lastSeen` via retentionHoursFor — a READ of retention, never a change; an unparseable
 *    lastSeen is treated as infinite life, matching ageOut keeping NaN records).
 *
 * Precedence when a record fails both: below-fold first, so `nearAgeout` counts only stories that
 * were IN a slot but too close to death — the meaningful "we'd have paid, but it's dying" bucket.
 *
 * Pure: recompute fresh each cycle. Newest-first makes the slot decision naturally stable, so no
 * skip state is ever persisted.
 */
export function heroEligibility(
  records: ManifestRecord[],
  config: Config,
  nowMs: number,
): HeroDecision {
  const ranks = sectionRanks(records);
  const eligible = new Set<string>();
  let skipped = 0;
  let belowFold = 0;
  let nearAgeout = 0;

  for (const record of records) {
    if (!!record.imageUrl || !record.wrappedPrompt) {
      skipped++; // already stored (idempotent) or not generated yet — nothing to image
      continue;
    }
    if (isOpinionRecord(record)) {
      eligible.add(record.id); // exempt: always imaged, always displayed (ADR-0016)
      continue;
    }
    const rank = ranks.get(record.id);
    if (rank === undefined || rank >= SECTION_SLOT_LIMIT) {
      belowFold++; // ranks outside the top-K of its section — no reader could encounter it
      continue;
    }
    if (!withinHeroLifetime(record, config, nowMs)) {
      nearAgeout++; // in a slot, but it would age out before anyone sees it
      continue;
    }
    eligible.add(record.id);
  }

  return { eligible, skipped, belowFold, nearAgeout };
}

/** Remaining life (from `lastSeen`, per retentionHoursFor) is at least HERO_MIN_LIFETIME_HOURS. */
function withinHeroLifetime(record: ManifestRecord, config: Config, nowMs: number): boolean {
  const lastSeenMs = new Date(record.lastSeen).getTime();
  if (!Number.isFinite(lastSeenMs)) return true; // NaN never ages out (matches ageOut)
  const retentionMs = retentionHoursFor(normalizeCategory(record.category), config) * 3600_000;
  const remainingMs = retentionMs - (nowMs - lastSeenMs);
  return remainingMs >= HERO_MIN_LIFETIME_HOURS * 3600_000;
}
