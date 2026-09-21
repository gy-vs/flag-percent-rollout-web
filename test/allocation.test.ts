import {describe, expect, it} from 'vitest';
import {
  allocateSlots,
  assignUser,
  fnv1a,
  hashUser,
  murmur3_32,
  parseFlagConfig,
  slotForHash,
  variantForSlot,
  TOTAL_SLOTS,
  type SlotRange,
  type VariantInput,
} from '../src/shared/allocation';

const utf8 = new TextEncoder();

function rangesOf(variants: VariantInput[]): SlotRange[] {
  const result = allocateSlots(variants);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  return result.allocation.ranges;
}

function slotsOf(variants: VariantInput[]): Record<string, number> {
  return Object.fromEntries(rangesOf(variants).map((range) => [range.key, range.slots]));
}

/** Every slot in [0, TOTAL_SLOTS) belongs to exactly one variant; counts match slot totals. */
function expectPartition(ranges: SlotRange[]) {
  expect(ranges[0].start).toBe(0);
  expect(ranges[ranges.length - 1].end).toBe(TOTAL_SLOTS);
  for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end);
  const counts = new Map<string, number>();
  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const owner = variantForSlot(ranges, slot);
    expect(owner, `slot ${slot} must have an owner`).not.toBeNull();
    counts.set(owner!.key, (counts.get(owner!.key) ?? 0) + 1);
  }
  for (const range of ranges) expect(counts.get(range.key) ?? 0).toBe(range.slots);
}

describe('allocateSlots: 0 and 100 weights', () => {
  it('gives a single 100% variant the entire slot space', () => {
    const ranges = rangesOf([{key: 'only', weight: 100}]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({start: 0, end: TOTAL_SLOTS, slots: TOTAL_SLOTS, effectiveWeight: 100});
    expectPartition(ranges);
  });

  it('assigns zero-weight variants empty ranges and never assigns them', () => {
    const ranges = rangesOf([
      {key: 'a-zero', weight: 0},
      {key: 'b-full', weight: 100},
      {key: 'c-zero', weight: 0},
    ]);
    expectPartition(ranges);
    const byKey = Object.fromEntries(ranges.map((range) => [range.key, range]));
    expect(byKey['a-zero'].slots).toBe(0);
    expect(byKey['c-zero'].slots).toBe(0);
    expect(byKey['a-zero'].start).toBe(byKey['a-zero'].end);
    expect(byKey['b-full'].slots).toBe(TOTAL_SLOTS);
    for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
      expect(variantForSlot(ranges, slot)?.key).toBe('b-full');
    }
  });

  it('handles 0-weight variants mixed with partial weights', () => {
    const ranges = rangesOf([
      {key: 'off', weight: 0},
      {key: 'x', weight: 25},
      {key: 'y', weight: 75},
    ]);
    expectPartition(ranges);
    expect(slotsOf([{key: 'off', weight: 0}, {key: 'x', weight: 25}, {key: 'y', weight: 75}])).toEqual({off: 0, x: 2500, y: 7500});
  });

  it('rejects an all-zero config because the sum is not 100', () => {
    const result = allocateSlots([{key: 'a', weight: 0}, {key: 'b', weight: 0}]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('weight_sum');
  });
});

describe('allocateSlots: decimal weights', () => {
  it('splits 33.33/33.33/33.34 into 3333/3333/3334 slots', () => {
    expect(slotsOf([
      {key: 'a', weight: 33.33},
      {key: 'b', weight: 33.33},
      {key: 'c', weight: 33.34},
    ])).toEqual({a: 3333, b: 3333, c: 3334});
  });

  it('handles small decimals like 0.1/99.9 exactly', () => {
    expect(slotsOf([{key: 'a', weight: 0.1}, {key: 'b', weight: 99.9}])).toEqual({a: 10, b: 9990});
  });

  it('breaks fraction ties by variant key, deterministically', () => {
    // 12.345% and 87.655% both quantize to a .5-slot fraction; the tie must
    // resolve the same way on every run and for every input order.
    const expected = {a: 1235, b: 8765};
    expect(slotsOf([{key: 'a', weight: 12.345}, {key: 'b', weight: 87.655}])).toEqual(expected);
    expect(slotsOf([{key: 'b', weight: 87.655}, {key: 'a', weight: 12.345}])).toEqual(expected);
  });

  it('distributes remainder slots by largest fraction then key order', () => {
    // 100/7 ≈ 14.2857 each: every variant has fraction 57/100 of a slot, so
    // the 4 leftover slots go to the first four keys alphabetically.
    const variants = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => ({key, weight: 14.2857}));
    expect(slotsOf(variants)).toEqual({a: 1429, b: 1429, c: 1429, d: 1429, e: 1428, f: 1428, g: 1428});
    expectPartition(rangesOf(variants));
  });
});

describe('allocateSlots: sum validation', () => {
  it('rejects sums outside 100 ± 0.01', () => {
    for (const variants of [
      [{key: 'a', weight: 50}, {key: 'b', weight: 50}, {key: 'c', weight: 50}],
      [{key: 'a', weight: 33.33}, {key: 'b', weight: 33.33}, {key: 'c', weight: 33.32}], // 99.98
      [{key: 'a', weight: 50.005}, {key: 'b', weight: 50.006}], // 100.011
      [{key: 'a', weight: 40}, {key: 'b', weight: 40}], // 80
    ]) {
      const result = allocateSlots(variants);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('weight_sum');
    }
  });

  it('accepts 99.99 and absorbs the gap via the remainder rule', () => {
    const ranges = rangesOf([
      {key: 'a', weight: 33.33},
      {key: 'b', weight: 33.33},
      {key: 'c', weight: 33.33},
    ]);
    expectPartition(ranges);
    expect(slotsOf([{key: 'a', weight: 33.33}, {key: 'b', weight: 33.33}, {key: 'c', weight: 33.33}])).toEqual({a: 3334, b: 3333, c: 3333});
  });

  it('accepts 100.01 and removes the excess via the remainder rule', () => {
    const ranges = rangesOf([
      {key: 'a', weight: 33.34},
      {key: 'b', weight: 33.33},
      {key: 'c', weight: 33.34},
    ]);
    expectPartition(ranges);
    expect(slotsOf([{key: 'a', weight: 33.34}, {key: 'b', weight: 33.33}, {key: 'c', weight: 33.34}])).toEqual({a: 3334, b: 3333, c: 3333});
  });

  it('rejects invalid weights and keys', () => {
    const cases: Array<[VariantInput[], string]> = [
      [[{key: 'a', weight: -1}, {key: 'b', weight: 101}], 'weight_invalid'],
      [[{key: 'a', weight: Number.NaN}, {key: 'b', weight: 100}], 'weight_invalid'],
      [[{key: 'a', weight: Number.POSITIVE_INFINITY}, {key: 'b', weight: 0}], 'weight_invalid'],
      [[{key: 'a', weight: 100.0001}], 'weight_invalid'],
      [[{key: 'a', weight: 50}, {key: 'a', weight: 50}], 'variant_key_duplicate'],
      [[{key: '', weight: 100}], 'variant_key_invalid'],
    ];
    for (const [variants, code] of cases) {
      const result = allocateSlots(variants);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain(code);
    }
    expect(allocateSlots([]).ok).toBe(false);
  });
});

describe('allocateSlots: variant identity is separated from order', () => {
  const variants = [
    {key: 'control', weight: 20},
    {key: 'treatment-a', weight: 30},
    {key: 'treatment-b', weight: 50},
  ];
  const permutations: VariantInput[][] = [
    variants,
    [variants[2], variants[0], variants[1]],
    [variants[1], variants[2], variants[0]],
    [variants[2], variants[1], variants[0]],
  ];

  it('produces identical ranges for every input order', () => {
    const baseline = rangesOf(variants);
    for (const permutation of permutations) {
      expect(rangesOf(permutation)).toEqual(baseline);
    }
  });

  it('keeps every user in the same variant when the list is reordered', () => {
    const baseline = rangesOf(variants);
    const reordered = rangesOf([...variants].reverse());
    for (let i = 0; i < 2000; i++) {
      const userId = `user-${i}`;
      expect(assignUser('flag-x', userId, {totalSlots: TOTAL_SLOTS, ranges: reordered}).variant)
        .toBe(assignUser('flag-x', userId, {totalSlots: TOTAL_SLOTS, ranges: baseline}).variant);
    }
  });
});

describe('allocateSlots: adding and removing variants', () => {
  const base = [
    {key: 'a', weight: 50},
    {key: 'b', weight: 50},
  ];

  it('keeps earlier variants stable when a later-sorting variant is added', () => {
    const before = rangesOf(base);
    const after = rangesOf([
      {key: 'a', weight: 50},
      {key: 'b', weight: 30},
      {key: 'c', weight: 20},
    ]);
    expectPartition(after);
    // a is untouched; c's traffic comes out of b's former tail.
    expect(after.find((range) => range.key === 'a')).toEqual(before.find((range) => range.key === 'a'));
    expect(after.find((range) => range.key === 'c')).toMatchObject({start: 8000, end: 10000});
    for (let slot = 0; slot < 5000; slot++) {
      expect(variantForSlot(after, slot)?.key).toBe('a');
    }
  });

  it('restores the exact original allocation when the variant is removed again', () => {
    const before = rangesOf(base);
    const restored = rangesOf(base);
    expect(restored).toEqual(before);
    const withC = rangesOf([
      {key: 'a', weight: 50},
      {key: 'b', weight: 30},
      {key: 'c', weight: 20},
    ]);
    expect(withC).not.toEqual(before);
    expect(rangesOf(base)).toEqual(before); // removing c returns to the identical layout
  });

  it('keeps surviving slots with their variant when a middle variant is removed', () => {
    const before = rangesOf([
      {key: 'a', weight: 50},
      {key: 'b', weight: 30},
      {key: 'c', weight: 20},
    ]);
    const after = rangesOf([
      {key: 'a', weight: 60},
      {key: 'c', weight: 40},
    ]);
    expectPartition(after);
    // Slots a and c owned before must still belong to the same variants.
    for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
      const previous = variantForSlot(before, slot)?.key;
      if (previous === 'b') continue;
      if (slot < 5000 || slot >= 8000) expect(variantForSlot(after, slot)?.key).toBe(previous);
    }
  });
});

describe('hash to slot mapping', () => {
  it('matches known murmur3 vectors', () => {
    expect(murmur3_32(utf8.encode(''), 0)).toBe(0);
    expect(murmur3_32(utf8.encode('hello'), 0)).toBe(0x248bfa47);
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
  });

  it('maps hash boundaries into the slot space without overflow', () => {
    expect(slotForHash(0)).toBe(0);
    expect(slotForHash(0x80000000)).toBe(5000);
    expect(slotForHash(0xffffffff)).toBe(TOTAL_SLOTS - 1); // max hash stays in range
    expect(slotForHash(0xfffffffe)).toBe(TOTAL_SLOTS - 1);
  });

  it('keeps every 32-bit hash inside [0, TOTAL_SLOTS)', () => {
    let previous = -1;
    for (let hash = 0; hash <= 0xffffffff; hash += 0x01010101) {
      const slot = slotForHash(hash);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(TOTAL_SLOTS);
      expect(slot).toBeGreaterThanOrEqual(previous); // monotonic: no interval can be skipped
      previous = slot;
    }
  });

  it('honours half-open boundaries exactly', () => {
    const ranges = rangesOf([
      {key: 'a', weight: 50},
      {key: 'b', weight: 50},
    ]);
    expect(variantForSlot(ranges, 0)?.key).toBe('a');
    expect(variantForSlot(ranges, 4999)?.key).toBe('a');
    expect(variantForSlot(ranges, 5000)?.key).toBe('b'); // boundary slot belongs to the next variant
    expect(variantForSlot(ranges, 9999)?.key).toBe('b');
    expect(variantForSlot(ranges, TOTAL_SLOTS)).toBeNull();
    expect(variantForSlot(ranges, -1)).toBeNull();
  });

  it('is deterministic per flag and user', () => {
    expect(hashUser('alpha', 'alice')).toBe(hashUser('alpha', 'alice'));
    expect(hashUser('alpha', 'alice')).not.toBe(hashUser('beta', 'alice'));
  });
});

describe('distribution over large samples', () => {
  it('assigns 200k users within tolerance of the slot shares', () => {
    const variants = [
      {key: 'a', weight: 33.33},
      {key: 'b', weight: 33.33},
      {key: 'c', weight: 33.34},
    ];
    const allocation = {totalSlots: TOTAL_SLOTS, ranges: rangesOf(variants)};
    const samples = 200_000;
    const counts: Record<string, number> = {a: 0, b: 0, c: 0};
    for (let i = 0; i < samples; i++) {
      const {variant} = assignUser('alpha', `sim-${i}`, allocation);
      expect(variant).not.toBeNull();
      counts[variant!] += 1;
    }
    expect(counts.a + counts.b + counts.c).toBe(samples);
    for (const range of allocation.ranges) {
      const expected = (range.slots / TOTAL_SLOTS) * samples;
      expect(Math.abs(counts[range.key] - expected), range.key).toBeLessThanOrEqual(800);
    }
  });

  it('never assigns a zero-weight variant across a large sample', () => {
    const allocation = {totalSlots: TOTAL_SLOTS, ranges: rangesOf([
      {key: 'off', weight: 0},
      {key: 'on', weight: 100},
    ])};
    for (let i = 0; i < 50_000; i++) {
      expect(assignUser('alpha', `user-${i}`, allocation).variant).toBe('on');
    }
  });
});

describe('config round-trip stability', () => {
  it('reallocating from effective weights reproduces identical ranges', () => {
    const variants = [
      {key: 'a', weight: 33.33},
      {key: 'b', weight: 33.33},
      {key: 'c', weight: 33.34},
    ];
    const first = rangesOf(variants);
    const rebuilt = first.map((range) => ({key: range.key, weight: range.effectiveWeight}));
    expect(rangesOf(rebuilt)).toEqual(first);
  });

  it('parses and reallocates a serialized config to the same allocation', () => {
    const config = {
      flag: 'checkout',
      variants: [
        {key: 'control', weight: 12.345},
        {key: 'treatment', weight: 87.655},
      ],
    };
    const once = parseFlagConfig(JSON.stringify(config, null, 2));
    expect(once.kind).toBe('config');
    const twice = parseFlagConfig(JSON.stringify(config));
    expect(twice.kind).toBe('config');
    if (once.kind === 'config' && twice.kind === 'config') {
      expect(twice.allocation).toEqual(once.allocation);
    }
  });

  it('classifies non-config content as plain text', () => {
    expect(parseFlagConfig('evaluation rules: alpha').kind).toBe('text');
    expect(parseFlagConfig('{"notVariants": true}').kind).toBe('text');
    expect(parseFlagConfig('[1,2,3]').kind).toBe('text');
    expect(parseFlagConfig('{broken json').kind).toBe('text');
  });

  it('reports issues for malformed configs', () => {
    const notArray = parseFlagConfig('{"variants": "nope"}');
    expect(notArray.kind).toBe('invalid');
    const badSum = parseFlagConfig('{"variants": [{"key": "a", "weight": 60}, {"key": "b", "weight": 60}]}');
    expect(badSum.kind).toBe('invalid');
    if (badSum.kind === 'invalid') expect(badSum.issues[0].code).toBe('weight_sum');
    const badEntry = parseFlagConfig('{"variants": [{"key": "a"}]}');
    expect(badEntry.kind).toBe('invalid');
  });
});
