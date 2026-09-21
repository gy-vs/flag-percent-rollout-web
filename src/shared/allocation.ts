/**
 * Fixed integer slot allocation for feature-flag variant weights.
 *
 * Float weights (percent) are quantized to integer micro-percents and mapped
 * into a fixed space of 10_000 integer slots. Each variant owns a half-open
 * interval [start, end); every slot belongs to exactly one variant, so a user
 * hash can never fall between intervals or past the last boundary (the old
 * float-cumulative scheme leaked hashes at 99.999…% into the next variant or
 * into no variant at all).
 *
 * Allocation depends only on the (key, weight) set — never on list order:
 * variants are processed in sorted-key order and rounding remainders are
 * distributed by (fraction desc, key asc). Reordering variants in the UI
 * therefore cannot reshuffle users.
 */

export const TOTAL_SLOTS = 10_000;
export const MICRO_PER_PERCENT = 10_000; // weights quantized to 0.0001%
const TOTAL_MICRO = 100 * MICRO_PER_PERCENT; // 1_000_000 micro = 100%
export const SUM_TOLERANCE_PERCENT = 0.01;
const SUM_TOLERANCE_MICRO = SUM_TOLERANCE_PERCENT * MICRO_PER_PERCENT; // 100 micro
export const MAX_VARIANTS = 1000;

export interface VariantInput {
  key: string;
  weight: number;
}
export interface FlagConfig {
  flag?: string;
  variants: VariantInput[];
}
export interface SlotRange {
  key: string;
  weight: number; // configured weight, echoed back
  start: number; // inclusive
  end: number; // exclusive
  slots: number; // end - start
  effectiveWeight: number; // slots / 100, the weight actually enforced
}
export interface Allocation {
  totalSlots: number;
  ranges: SlotRange[]; // sorted by key, contiguous, covering [0, TOTAL_SLOTS)
}
export interface Issue {
  code: string;
  message: string;
  variant?: string;
}

export type AllocateResult =
  | {ok: true; allocation: Allocation}
  | {ok: false; issues: Issue[]};

const byKey = (a: {key: string}, b: {key: string}) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

export function allocateSlots(input: VariantInput[]): AllocateResult {
  const issues: Issue[] = [];
  if (!Array.isArray(input) || input.length === 0) {
    issues.push({code: 'variants_empty', message: 'At least one variant is required'});
  } else if (input.length > MAX_VARIANTS) {
    issues.push({code: 'too_many_variants', message: `At most ${MAX_VARIANTS} variants are supported`});
  }
  const seen = new Set<string>();
  for (const variant of input ?? []) {
    if (typeof variant.key !== 'string' || variant.key.length === 0) {
      issues.push({code: 'variant_key_invalid', message: 'Variant key must be a non-empty string'});
    } else if (seen.has(variant.key)) {
      issues.push({code: 'variant_key_duplicate', variant: variant.key, message: `Duplicate variant key "${variant.key}"`});
    } else {
      seen.add(variant.key);
    }
    if (typeof variant.weight !== 'number' || !Number.isFinite(variant.weight) || variant.weight < 0 || variant.weight > 100) {
      issues.push({code: 'weight_invalid', variant: String(variant.key), message: `Weight for "${variant.key}" must be a finite number in [0, 100]`});
    }
  }
  if (issues.length > 0) return {ok: false, issues};

  // Quantize to integer micro-percents first: the sum check and all slot math
  // below run on exact integers, so boundary sums like 99.99/100.01 are not
  // lost to float representation error (100 - 99.99 !== 0.01 in doubles).
  const sorted = [...input].sort(byKey).map((variant) => {
    const micro = Math.round(variant.weight * MICRO_PER_PERCENT);
    return {
      key: variant.key,
      weight: variant.weight,
      micro,
      slots: Math.floor(micro / 100), // 100 micro-percents per slot
      frac: micro % 100, // leftover micro-percents competing for remainder slots
    };
  });

  const sumMicro = sorted.reduce((total, variant) => total + variant.micro, 0);
  if (Math.abs(sumMicro - TOTAL_MICRO) > SUM_TOLERANCE_MICRO) {
    return {ok: false, issues: [{code: 'weight_sum', message: `Weights sum to ${sumMicro / MICRO_PER_PERCENT}, must total 100 ± ${SUM_TOLERANCE_PERCENT}`}]};
  }

  // Stable remainder rule: rank by (fraction desc, key asc). Leftover slots go
  // to the front of the ranking; excess slots are removed from the back (never
  // below zero). Ties can only resolve one way, so results never depend on the
  // order variants were listed in.
  let remainder = TOTAL_SLOTS - sorted.reduce((total, variant) => total + variant.slots, 0);
  const ranked = [...sorted].sort((a, b) => b.frac - a.frac || byKey(a, b));
  if (remainder > 0) {
    for (let i = 0; i < remainder; i++) ranked[i % ranked.length].slots += 1;
  } else if (remainder < 0) {
    let left = -remainder;
    for (const donor of [...ranked].reverse()) {
      if (left === 0) break;
      if (donor.slots <= 0) continue;
      const take = Math.min(donor.slots, left);
      donor.slots -= take;
      left -= take;
    }
    if (left > 0) {
      return {ok: false, issues: [{code: 'weight_sum', message: 'Weights sum too far above 100 to reconcile into slots'}]};
    }
  }

  // Contiguous half-open ranges in sorted-key order. The last range ends
  // exactly at TOTAL_SLOTS, so the partition is total by construction.
  const ranges: SlotRange[] = [];
  let start = 0;
  for (const variant of sorted) {
    const end = start + variant.slots;
    ranges.push({
      key: variant.key,
      weight: variant.weight,
      start,
      end,
      slots: variant.slots,
      effectiveWeight: variant.slots / (TOTAL_SLOTS / 100),
    });
    start = end;
  }
  return {ok: true, allocation: {totalSlots: TOTAL_SLOTS, ranges}};
}

export type ParsedContent =
  | {kind: 'text'} // legacy plain-text rules, no variant allocation
  | {kind: 'invalid'; issues: Issue[]} // looks like a config but fails validation
  | {kind: 'config'; config: FlagConfig; allocation: Allocation};

/**
 * Classify flag content. Anything that is not a JSON object with a "variants"
 * field is treated as legacy plain text; once it looks like a config it is
 * validated strictly.
 */
export function parseFlagConfig(content: string): ParsedContent {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return {kind: 'text'};
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return {kind: 'text'};
  if (!('variants' in data)) return {kind: 'text'};

  const flagValue = (data as Record<string, unknown>).flag;
  const flag = typeof flagValue === 'string' ? flagValue : undefined;
  const raw = (data as Record<string, unknown>).variants;
  if (!Array.isArray(raw)) {
    return {kind: 'invalid', issues: [{code: 'variants_invalid', message: '"variants" must be an array of {key, weight}'}]};
  }
  const issues: Issue[] = [];
  const variants: VariantInput[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push({code: 'variant_invalid', message: `variants[${index}] must be an object with key and weight`});
      return;
    }
    const key = (entry as Record<string, unknown>).key;
    const weight = (entry as Record<string, unknown>).weight;
    if (typeof key !== 'string' || key.length === 0) {
      issues.push({code: 'variant_key_invalid', message: `variants[${index}].key must be a non-empty string`});
      return;
    }
    if (typeof weight !== 'number') {
      issues.push({code: 'weight_invalid', variant: key, message: `variants[${index}].weight must be a number`});
      return;
    }
    variants.push({key, weight});
  });
  if (issues.length > 0) return {kind: 'invalid', issues};

  const result = allocateSlots(variants);
  if (!result.ok) return {kind: 'invalid', issues: result.issues};
  return {kind: 'config', config: {flag, variants}, allocation: result.allocation};
}

const utf8 = new TextEncoder();

/** FNV-1a 32-bit — used to derive a per-flag hash seed from the flag id. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Murmur3 x86 32-bit over UTF-8 bytes; strong avalanche for sequential ids. */
export function murmur3_32(data: Uint8Array, seed: number): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h1 = seed >>> 0;
  const blocks = data.length >> 2;
  for (let i = 0; i < blocks; i++) {
    const offset = i * 4;
    let k1 = (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
  }
  let k1 = 0;
  const tail = data.length & 3;
  const offset = blocks * 4;
  if (tail === 3) k1 ^= data[offset + 2] << 16;
  if (tail >= 2) k1 ^= data[offset + 1] << 8;
  if (tail >= 1) {
    k1 ^= data[offset];
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }
  h1 ^= data.length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

/**
 * Hash a user into a 32-bit value. Seeded by the flag id so the same user
 * lands in independent slots across flags.
 */
export function hashUser(flagId: string, userId: string): number {
  return murmur3_32(utf8.encode(userId), fnv1a(flagId));
}

/**
 * Map a 32-bit hash to a slot in [0, TOTAL_SLOTS) via multiply-shift. Every
 * slot receives either floor(2^32/TOTAL_SLOTS) or ceil(2^32/TOTAL_SLOTS) hash
 * values — as uniform as a deterministic map can be — and the maximum hash
 * 0xFFFFFFFF maps to TOTAL_SLOTS - 1, never out of range.
 */
export function slotForHash(hash: number): number {
  return Math.floor(((hash >>> 0) * TOTAL_SLOTS) / 0x1_0000_0000);
}

/** Owning variant for a slot, using half-open [start, end) containment. */
export function variantForSlot(ranges: SlotRange[], slot: number): SlotRange | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= TOTAL_SLOTS) return null;
  return ranges.find((range) => slot >= range.start && slot < range.end) ?? null;
}

export interface Assignment {
  hash: number;
  slot: number;
  variant: string | null;
}

export function assignUser(flagId: string, userId: string, allocation: Allocation): Assignment {
  const hash = hashUser(flagId, userId);
  const slot = slotForHash(hash);
  const range = variantForSlot(allocation.ranges, slot);
  return {hash, slot, variant: range ? range.key : null};
}
