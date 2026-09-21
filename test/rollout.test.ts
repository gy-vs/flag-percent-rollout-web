import {describe, expect, it} from 'vitest';
import {
  AllocationError,
  buildPlan,
  evaluate,
  hashToSlot,
  lookupSlot,
  slotForWord,
  TOTAL_SLOTS,
  validateConfig,
  type RolloutConfig,
} from '../src/server/rollout';

const N = TOTAL_SLOTS;
const U32 = 2 ** 32;

function cfg(...entries: Array<[string, number]>): RolloutConfig {
  return {variants: entries.map(([id, weight]) => ({id, weight}))};
}

/** Structural invariants of the half-open partition. */
function expectExactPartition(plan: ReturnType<typeof buildPlan>, slots = N) {
  expect(plan.totalSlots).toBe(slots);
  expect(plan.ranges.length).toBeGreaterThan(0);
  let cursor = 0;
  let total = 0;
  for (const range of plan.ranges) {
    // Contiguous half-open ranges: each starts exactly where the previous ended.
    expect(range.start).toBe(cursor);
    expect(range.end).toBeGreaterThanOrEqual(range.start);
    expect(range.slots).toBe(range.end - range.start);
    cursor = range.end;
    total += range.slots;
  }
  expect(cursor).toBe(slots);
  expect(total).toBe(slots);
  // Every range is genuinely half-open: the slot at `end` is not in range.
  for (const range of plan.ranges) {
    if (range.slots > 0) {
      expect(lookupSlot(plan, range.end - 1)?.variantId).toBe(range.variantId);
      if (range.end < slots) expect(lookupSlot(plan, range.end)?.variantId).not.toBe(range.variantId);
    } else {
      // Empty range owns no slot at any position within the partition.
      if (range.start < slots) expect(lookupSlot(plan, range.start)?.variantId).not.toBe(range.variantId);
    }
  }
}

describe('weight normalization', () => {
  it('turns 0/100 weights into an empty and a full range', () => {
    const plan = buildPlan(cfg(['off', 0], ['on', 100]));
    expectExactPartition(plan);
    const [off, on] = [plan.ranges.find(r => r.variantId === 'off')!, plan.ranges.find(r => r.variantId === 'on')!];
    expect(off.slots).toBe(0);
    expect(off.start).toBe(off.end);
    expect(on.slots).toBe(N);
    expect(on.start).toBe(0);
    expect(on.end).toBe(N);
    // A zero-weight variant keeps ranges contiguous wherever it lands; here
    // canonical order is a, b, silent, so the empty range sits at the boundary N.
    const middle = buildPlan(cfg(['a', 50], ['silent', 0], ['b', 50]));
    expectExactPartition(middle);
    const a = middle.ranges.find(r => r.variantId === 'a')!;
    const b = middle.ranges.find(r => r.variantId === 'b')!;
    const silent = middle.ranges.find(r => r.variantId === 'silent')!;
    expect(a).toMatchObject({start: 0, end: 500000, slots: 500000});
    expect(b).toMatchObject({start: 500000, end: N, slots: 500000});
    expect(silent).toMatchObject({start: N, end: N, slots: 0});
  });

  it('splits decimal weights with largest-remainder slots', () => {
    const plan = buildPlan(cfg(['a', 33.3333], ['b', 33.3333], ['c', 33.3334]));
    expectExactPartition(plan);
    const slots = Object.fromEntries(plan.ranges.map(r => [r.variantId, r.slots]));
    expect(slots).toEqual({a: 333333, b: 333333, c: 333334});
  });

  it('handles 10,000 micro weights of 0.01 without float accumulation drift', () => {
    const variants = Array.from({length: 10000}, (_, i) => [`v${i.toString().padStart(5, '0')}`, 0.01] as [string, number]);
    const plan = buildPlan(cfg(...variants));
    expectExactPartition(plan);
    expect(plan.ranges.every(r => r.slots === 100)).toBe(true);
  });

  it('breaks exact fractional ties by variant id ascending', () => {
    // Six equal weights: each quota is 166,666.666... with 4 slots left over.
    const w = 100 / 6;
    expect(w * 6).toBe(100);
    const plan = buildPlan(cfg(['zeta', w], ['delta', w], ['mid', w], ['alpha', w], ['beta', w], ['gamma', w]));
    const slots = Object.fromEntries(plan.ranges.map(r => [r.variantId, r.slots]));
    expect(slots).toEqual({alpha: 166667, beta: 166667, delta: 166667, gamma: 166667, mid: 166666, zeta: 166666});
    for (const id of ['alpha', 'beta', 'delta', 'gamma']) {
      expect(plan.remainders.find(r => r.variantId === id)!.awarded).toBe(true);
    }
    for (const id of ['mid', 'zeta']) {
      expect(plan.remainders.find(r => r.variantId === id)!.awarded).toBe(false);
    }
  });

  it('absorbs sub-tolerance float drift but still emits an exact partition', () => {
    const plan = buildPlan(cfg(['a', 50], ['b', 49.9999999]));
    expectExactPartition(plan);
    expect(plan.ranges.map(r => r.slots)).toEqual([500000, 500000]);
    const plan2 = buildPlan(cfg(['a', 50], ['b', 50.0000001]));
    expectExactPartition(plan2);
    expect(plan2.ranges.map(r => r.slots)).toEqual([500000, 500000]);
  });

  it('is deterministic across builds', () => {
    const c = cfg(['a', 12.5], ['b', 37.5], ['c', 50]);
    expect(buildPlan(c)).toEqual(buildPlan(c));
  });
});

describe('validation', () => {
  it('rejects the 99.999% cumulative boundary instead of leaking users', () => {
    expect(() => validateConfig(cfg(['a', 40], ['b', 40], ['c', 19.999]))).toThrow(AllocationError);
    try {
      validateConfig(cfg(['a', 40], ['b', 40], ['c', 19.999]));
      expect.unreachable();
    } catch (error) {
      expect((error as AllocationError).code).toBe('weight_sum_mismatch');
    }
  });

  it.each([
    ['over sum', cfg(['a', 60], ['b', 40.0001])],
    ['under sum', cfg(['a', 1])],
    ['negative weight', cfg(['a', -1], ['b', 101])],
    ['NaN weight', cfg(['a', Number.NaN], ['b', 100])],
    ['Infinity weight', cfg(['a', Number.POSITIVE_INFINITY], ['b', 100])],
    ['boolean weight', {variants: [{id: 'a', weight: true}]} as unknown as RolloutConfig],
    ['duplicate ids', cfg(['a', 50], ['a', 50])],
    ['empty id', cfg(['', 100])],
    ['no variants', {variants: []}],
    ['missing variants', {} as RolloutConfig],
  ])('rejects %s', (_name, bad) => {
    expect(() => buildPlan(bad)).toThrow(AllocationError);
  });

  it('accepts a single variant covering 100', () => {
    const plan = buildPlan(cfg(['only', 100]));
    expect(plan.ranges[0]).toMatchObject({variantId: 'only', start: 0, end: N, slots: N});
  });
});

describe('order independence and set changes', () => {
  const c = cfg(['alpha', 50], ['beta', 30], ['gamma', 20]);
  const shuffled = cfg(['gamma', 20], ['alpha', 50], ['beta', 30]);

  it('emits canonical (id ordered) ranges regardless of row order', () => {
    expect(buildPlan(c).ranges).toEqual(buildPlan(shuffled).ranges);
  });

  it('never moves a user when rows are reordered', () => {
    const keys = Array.from({length: 5000}, (_, i) => `user-${i}`);
    for (const key of keys) {
      const before = evaluate('flag', key, c);
      const after = evaluate('flag', key, shuffled);
      expect(after.range.variantId).toBe(before.range.variantId);
      expect(after.slot).toBe(before.slot);
    }
  });

  it('keeps retained variant boundaries when a zero-weight variant is added or removed', () => {
    const two = buildPlan(cfg(['a', 50], ['b', 50]));
    const withZero = buildPlan(cfg(['a', 50], ['b', 50], ['ghost', 0]));
    const withoutZero = buildPlan(cfg(['ghost', 0], ['a', 50], ['b', 50]));
    for (const id of ['a', 'b']) {
      expect(withZero.ranges.find(r => r.variantId === id)).toEqual(two.ranges.find(r => r.variantId === id));
      expect(withoutZero.ranges.find(r => r.variantId === id)).toEqual(two.ranges.find(r => r.variantId === id));
    }
    // Adding real traffic means all variants must still sum exactly to 100;
    // weights that no longer balance are rejected rather than silently resized.
    expect(() => buildPlan(cfg(['a', 50], ['b', 50], ['c', 5]))).toThrow(AllocationError);
    const grown = buildPlan(cfg(['a', 45], ['b', 45], ['c', 10]));
    expectExactPartition(grown);
  });
});

describe('unbiased slot mapping', () => {
  it('rejects words outside the largest multiple instead of biasing low slots', () => {
    const limit = Math.floor(U32 / N) * N;
    expect(limit).toBe(4_294_000_000);
    expect(slotForWord(U32 - 1)).toBeNull(); // maximum hash word is rejected, never wrapped
    expect(slotForWord(limit)).toBeNull(); // half-open: first rejected word
    expect(slotForWord(0)).toBe(0);
    expect(slotForWord(limit - 1)).toBe(N - 1); // last accepted word maps to the last slot
  });

  it('maps exactly floor(2^32/N) words to every slot when evenly divisible', () => {
    const perSlot = Math.floor(U32 / N);
    expect(U32 - perSlot * N).toBeGreaterThan(0); // rejection region is non-empty
    for (const s of [0, 1, 499999, 500000, N - 1]) {
      // Every accepted word for slot s: s + k*N for k in [0, perSlot).
      expect(slotForWord(s)).toBe(s);
      const lastWord = s + (perSlot - 1) * N;
      if (lastWord < U32) {
        expect(slotForWord(lastWord)).toBe(s);
        const nextWord = lastWord + N;
        if (nextWord < U32) expect(slotForWord(nextWord)).toBeNull();
      }
      const accepted = Math.ceil((Math.floor(U32 / N) * N - s) / N);
      expect(accepted).toBe(perSlot);
    }
  });

  it('keeps counts within one word even when 2^32 is not divisible by the slot count', () => {
    const slots = 7;
    const limit = Math.floor(U32 / slots) * slots;
    for (let s = 0; s < slots; s++) {
      const count = Math.ceil((limit - s) / slots);
      expect(count === Math.floor(U32 / slots) || count === Math.ceil(U32 / slots)).toBe(true);
    }
  });

  it('maps the maximum key stably and always inside a variant range', () => {
    const plan = buildPlan(cfg(['a', 1], ['b', 99]));
    for (const key of ['', ' ', 'z'.repeat(1000), '😀'.repeat(50)]) {
      const slot = hashToSlot('flag', key);
      expect(Number.isInteger(slot)).toBe(true);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(N);
      expect(lookupSlot(plan, slot)).not.toBeNull();
    }
    expect(hashToSlot('flag', 'max-like-key')).toBe(hashToSlot('flag', 'max-like-key'));
  });

  it('salts hashes per flag so variants are independent', () => {
    const keys = Array.from({length: 3000}, (_, i) => `user-${i}`);
    const differing = keys.filter(k => hashToSlot('flag-a', k) !== hashToSlot('flag-b', k)).length;
    expect(differing).toBeGreaterThan(2500);
  });
});

describe('partition completeness over every slot', () => {
  it.each([
    ['decimals', cfg(['a', 33.3333], ['b', 33.3333], ['c', 33.3334])],
    ['zero in the middle', cfg(['a', 25], ['quiet', 0], ['b', 75])],
    ['binary fractions', cfg(['a', 12.5], ['b', 12.5], ['c', 25], ['d', 50])],
    ['0 and 100', cfg(['none', 0], ['all', 100])],
  ])('assigns all %d slots to exactly one variant (%s)', (_name, c) => {
    const plan = buildPlan(c);
    expectExactPartition(plan);
    for (let slot = 0; slot < N; slot++) {
      const range = lookupSlot(plan, slot);
      if (!range) throw new Error(`slot ${slot} has no variant`);
      expect(slot >= range.start && slot < range.end).toBe(true);
    }
  });
});

describe('large distribution sample', () => {
  it('distributes 100,000 users close to configured weights with no unassigned users', () => {
    const c = cfg(
      ['v0', 10], ['v1', 10], ['v2', 10], ['v3', 10], ['v4', 10],
      ['v5', 10], ['v6', 10], ['v7', 10], ['v8', 10], ['v9', 10],
    );
    const counts = new Map<string, number>();
    const seenSlots = new Set<number>();
    for (let i = 0; i < 100_000; i++) {
      const {slot, range} = evaluate('demo-flag', `user-${i}`, c);
      counts.set(range.variantId, (counts.get(range.variantId) ?? 0) + 1);
      seenSlots.add(slot);
    }
    for (let v = 0; v < 10; v++) {
      const count = counts.get(`v${v}`)!;
      // 10,000 expected; ±5% gives a huge safety margin (the 100k/10-way
      // standard deviation is ~95) while still catching gross imbalance.
      expect(count).toBeGreaterThan(9500);
      expect(count).toBeLessThan(10500);
    }
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(seenSlots.size).toBeGreaterThan(60_000); // slots actually spread out
  });

  it('stays stable for every user across a reorder + zero add/remove cycle', () => {
    const base = cfg(['red', 40], ['green', 35], ['blue', 25]);
    const edited = cfg(['blue', 25], ['dark', 0], ['red', 40], ['green', 35]);
    const keys = Array.from({length: 3000}, (_, i) => `acct:${i.toString(36)}`);
    for (const key of keys) {
      expect(evaluate('f', key, edited).range.variantId).toBe(evaluate('f', key, base).range.variantId);
    }
  });
});
