import {createHash} from 'node:crypto';

/**
 * Fixed-point traffic allocation.
 *
 * Weights are never accumulated as floating point cumulative percentages.
 * Instead weights are converted once, server-side, into a fixed number of
 * integer slots and each variant owns a half-open range [start, end).
 * The ranges form an exact partition of [0, TOTAL_SLOTS), so every slot -
 * and therefore every hashed user - belongs to exactly one variant.
 */

/** 1,000,000 slots => weight precision of 0.0001% (one slot = one part per million). */
export const TOTAL_SLOTS = 1_000_000;

/** Accepted absolute drift between the configured weight sum and 100 (%). */
export const WEIGHT_SUM_TOLERANCE = 1e-6;

/** Quotas this close to an integer (in slots) are snapped to that integer to kill float artifacts. */
const QUOTA_SNAP_EPSILON = 1e-7;

export type VariantInput = Readonly<{id: string; weight: number}>;
export type RolloutConfig = Readonly<{variants: readonly VariantInput[]}>;

export type RemainderDetail = {
  variantId: string;
  weight: number;
  floor: number;
  fraction: number;
  awarded: boolean;
};

export type SlotRange = {
  variantId: string;
  /** Inclusive lower bound. */
  start: number;
  /** Exclusive upper bound. */
  end: number;
  slots: number;
};

export type AllocationPlan = {
  totalSlots: number;
  /** Half-open ranges in canonical (variant id) order, independent of input order. */
  ranges: SlotRange[];
  weightSum: number;
  remainderRule: string;
  remainders: RemainderDetail[];
};

export type AllocationErrorCode =
  | 'variants_required'
  | 'invalid_variant_id'
  | 'duplicate_variant_id'
  | 'invalid_weight'
  | 'weight_sum_mismatch';

export class AllocationError extends Error {
  readonly code: AllocationErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: AllocationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AllocationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validate a rollout configuration. Throws AllocationError on the first problem.
 */
export function validateConfig(config: unknown): asserts config is RolloutConfig {
  const variants = (config as {variants?: unknown} | null)?.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new AllocationError('variants_required', 'At least one variant with a weight is required.');
  }
  const seen = new Set<string>();
  let weightSum = 0;
  for (let i = 0; i < variants.length; i++) {
    const entry = variants[i] as {id?: unknown; weight?: unknown} | null;
    const id = entry?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new AllocationError('invalid_variant_id', `Variant at position ${i} is missing a non-empty id.`, {position: i});
    }
    if (seen.has(id)) {
      throw new AllocationError('duplicate_variant_id', `Duplicate variant id "${id}". Variant identity must be unique.`, {variantId: id});
    }
    seen.add(id);
    // Reject booleans etc.: only real numbers.
    if (typeof entry?.weight !== 'number' || !Number.isFinite(entry.weight) || entry.weight < 0) {
      throw new AllocationError('invalid_weight', `Variant "${id}" must have a finite, non-negative numeric weight.`, {variantId: id, weight: entry?.weight});
    }
    weightSum += entry.weight;
  }
  const drift = weightSum - 100;
  if (!(Math.abs(drift) <= WEIGHT_SUM_TOLERANCE)) {
    throw new AllocationError(
      'weight_sum_mismatch',
      `Weights must sum to exactly 100 (got ${trimFloat(weightSum)}, drift ${trimFloat(drift)}).`,
      {weightSum, tolerance: WEIGHT_SUM_TOLERANCE},
    );
  }
}

function trimFloat(value: number): string {
  return Number(value.toPrecision(12)).toString();
}

/**
 * Convert weights into an exact integer partition using the largest-remainder
 * (Hamilton) method:
 *   1. quota_i = weight_i / sum(weights) * TOTAL_SLOTS  (sums exactly to TOTAL_SLOTS)
 *   2. every variant gets floor(quota_i) slots
 *   3. leftover slots go to the variants with the largest fractional remainders
 *   4. exact ties are broken by variant id ascending - a documented, stable rule
 *
 * Float artifacts are removed by snapping quotas that land within
 * QUOTA_SNAP_EPSILON of an integer. Ranges are emitted in canonical (id) order,
 * so reordering rows in the UI never moves a boundary.
 */
export function buildPlan(config: RolloutConfig, totalSlots: number = TOTAL_SLOTS): AllocationPlan {
  validateConfig(config);
  if (!Number.isInteger(totalSlots) || totalSlots <= 0) {
    throw new Error('totalSlots must be a positive integer');
  }
  const variants = config.variants.map(v => ({id: v.id, weight: v.weight}));
  const weightSum = variants.reduce((sum, v) => sum + v.weight, 0);

  const quotas = variants.map(v => {
    let quota = (v.weight / weightSum) * totalSlots;
    const rounded = Math.round(quota);
    if (Math.abs(quota - rounded) < QUOTA_SNAP_EPSILON) quota = rounded;
    return quota;
  });

  const floors = quotas.map(q => Math.floor(q));
  let leftover = totalSlots - floors.reduce((a, b) => a + b, 0);

  // Remainders drive both directions of the adjustment, so the result is always
  // an exact partition even in the presence of floating point drift.
  const ordered = variants
    .map((v, i) => ({id: v.id, weight: v.weight, floor: floors[i], fraction: quotas[i] - floors[i]}))
    .sort((a, b) => b.fraction - a.fraction || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const awardedIds = new Set<string>();
  if (leftover > 0) {
    for (const entry of ordered) {
      if (leftover === 0) break;
      awardedIds.add(entry.id);
      leftover--;
    }
  } else if (leftover < 0) {
    // Defensive: only reachable with pathological float drift; take from the
    // smallest remainders (the variants most over-represented by flooring).
    for (let i = ordered.length - 1; i >= 0 && leftover < 0; i--) {
      const entry = ordered[i];
      if (entry.floor > 0) {
        entry.floor--;
        leftover++;
      }
    }
  }

  const slotsById = new Map<string, number>();
  const details: RemainderDetail[] = ordered.map(entry => {
    const slots = entry.floor + (awardedIds.has(entry.id) ? 1 : 0);
    slotsById.set(entry.id, slots);
    return {
      variantId: entry.id,
      weight: entry.weight,
      floor: entry.floor,
      fraction: trimFraction(entry.fraction),
      awarded: awardedIds.has(entry.id),
    };
  });

  // Canonical order: variant identity, never array position, determines boundaries.
  const byId = variants.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ranges: SlotRange[] = [];
  let cursor = 0;
  for (const v of byId) {
    const slots = slotsById.get(v.id)!;
    ranges.push({variantId: v.id, start: cursor, end: cursor + slots, slots});
    cursor += slots;
  }

  return {
    totalSlots,
    ranges,
    weightSum,
    remainderRule: `largest_remainder: floor(weight/${trimFloat(weightSum)}*${totalSlots}), leftover slots awarded by largest fractional remainder, ties broken by variant id ascending`,
    remainders: details.sort((a, b) => (a.variantId < b.variantId ? -1 : 1)),
  };
}

function trimFraction(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return Number(value.toFixed(9));
}

/**
 * Find the variant owning a slot. The slot must satisfy 0 <= slot < totalSlots.
 * Binary search over the partition; returns null only for an out-of-range slot.
 * Empty ranges (start === end) are skipped, so a zero-weight variant placed
 * first cannot shadow the next range when two starts coincide.
 */
export function lookupSlot(plan: AllocationPlan, slot: number): SlotRange | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= plan.totalSlots) return null;
  const ranges = plan.ranges;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ranges[mid].start <= slot) lo = mid;
    else hi = mid - 1;
  }
  // Walk back across any adjacent empty ranges sharing the same start.
  while (lo + 1 < ranges.length && ranges[lo].slots === 0 && ranges[lo + 1].start === ranges[lo].start) {
    lo++;
  }
  const range = ranges[lo];
  return slot < range.end ? range : null;
}

const WORD_MOD = 2 ** 32;

/**
 * Map one unbiased 32-bit word to a slot with no modulo bias.
 *
 * Naively doing word % totalSlots over-represents the first
 * (2^32 mod totalSlots) slots. We restrict to the largest multiple of
 * totalSlots below 2^32; words outside it are rejected so the caller draws
 * the next word. Returns null precisely for rejected words.
 */
export function slotForWord(word: number, totalSlots: number = TOTAL_SLOTS): number | null {
  if (!Number.isInteger(word) || word < 0 || word >= WORD_MOD) {
    throw new Error('word must be an unsigned 32-bit integer');
  }
  const limit = Math.floor(WORD_MOD / totalSlots) * totalSlots;
  return word < limit ? word % totalSlots : null;
}

function seedDigest(flagId: string, unitKey: string): Buffer {
  // Length-prefixed encoding so ("ab","c") and ("a","bc") cannot collide.
  const idBuf = Buffer.from(flagId, 'utf8');
  const keyBuf = Buffer.from(unitKey, 'utf8');
  const seed = Buffer.alloc(4 + idBuf.length + keyBuf.length);
  seed.writeUInt32LE(idBuf.length, 0);
  idBuf.copy(seed, 4);
  keyBuf.copy(seed, 4 + idBuf.length);
  return seed;
}

/**
 * Hash a user/unit key to an unbiased slot.
 *
 * SHA-256 words feed rejection sampling (see slotForWord); a rejected word
 * advances to the next word, and further SHA-256 rounds are derived as needed.
 * The flag id salts the hash, so the same user can occupy independent slots in
 * different flags. Output is deterministic: same (flagId, key) => same slot.
 */
export function hashToSlot(flagId: string, unitKey: string, totalSlots: number = TOTAL_SLOTS): number {
  if (typeof flagId !== 'string' || typeof unitKey !== 'string') {
    throw new Error('flagId and unitKey must be strings');
  }
  const seed = seedDigest(flagId, unitKey);
  for (let round = 0; ; round++) {
    const digest = createHash('sha256').update(seed).update(Buffer.from(Uint32Array.of(round))).digest();
    for (let w = 0; w < 8; w++) {
      const word = digest.readUInt32LE(w * 4);
      const slot = slotForWord(word, totalSlots);
      if (slot !== null) return slot;
    }
  }
}

export type Evaluation = {
  slot: number;
  range: SlotRange;
};

/** Evaluate one unit key against a stored rollout configuration. */
export function evaluate(flagId: string, unitKey: string, config: RolloutConfig, totalSlots: number = TOTAL_SLOTS): Evaluation {
  validateConfig(config);
  const plan = buildPlan(config, totalSlots);
  const slot = hashToSlot(flagId, unitKey, totalSlots);
  const range = lookupSlot(plan, slot);
  if (!range) throw new Error(`internal: slot ${slot} unassigned`);
  return {slot, range};
}
