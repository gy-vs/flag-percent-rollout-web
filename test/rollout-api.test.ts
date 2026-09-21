import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {TOTAL_SLOTS} from '../src/server/rollout';

const N = TOTAL_SLOTS;
const decimalVariants = [
  {id: 'a', weight: 33.3333},
  {id: 'b', weight: 33.3333},
  {id: 'c', weight: 33.3334},
];

async function currentRevision(app: ReturnType<typeof createApp>, id: string) {
  const res = await request(app).get(`/api/flags/${id}`).expect(200);
  return res.body.revision as number;
}

describe('rollout API', () => {
  it('saves a config and round-trips without drift', async () => {
    const app = createApp();
    const revision = await currentRevision(app, 'alpha');
    const put = await request(app)
      .put('/api/flags/alpha/rollout')
      .send({revision, variants: decimalVariants})
      .expect(200);

    expect(put.body.config.variants).toEqual(decimalVariants);
    expect(put.body.revision).toBe(revision + 1);
    const slots = Object.fromEntries(put.body.plan.ranges.map((r: {variantId: string; slots: number}) => [r.variantId, r.slots]));
    expect(slots).toEqual({a: 333333, b: 333333, c: 333334});
    expect(put.body.plan.ranges.at(-1).end).toBe(N);

    // GET returns exactly the stored weights and the identical plan.
    const got = await request(app).get('/api/flags/alpha/rollout').expect(200);
    expect(got.body.config).toEqual(put.body.config);
    expect(got.body.plan).toEqual(put.body.plan);
  });

  it('rejects a 99.999 sum with 422 and leaves stored config untouched', async () => {
    const app = createApp();
    const revision = await currentRevision(app, 'alpha');
    const before = await request(app).get('/api/flags/alpha/rollout').expect(200);
    const bad = await request(app)
      .put('/api/flags/alpha/rollout')
      .send({revision, variants: [{id: 'a', weight: 50}, {id: 'b', weight: 49.999}]})
      .expect(422);
    expect(bad.body.error).toBe('weight_sum_mismatch');

    const after = await request(app).get('/api/flags/alpha/rollout').expect(200);
    expect(after.body.config).toEqual(before.body.config);
    expect(after.body.revision).toBe(revision);
  });

  it('stores variants in submitted order while plan ranges are canonical', async () => {
    const app = createApp();
    const revision = await currentRevision(app, 'beta');
    const variants = [
      {id: 'zeta', weight: 20},
      {id: 'alpha', weight: 50},
      {id: 'mid', weight: 30},
    ];
    const put = await request(app)
      .put('/api/flags/beta/rollout')
      .send({revision, variants})
      .expect(200);
    expect(put.body.config.variants.map((v: {id: string}) => v.id)).toEqual(['zeta', 'alpha', 'mid']);
    expect(put.body.plan.ranges.map((r: {variantId: string}) => r.variantId)).toEqual(['alpha', 'mid', 'zeta']);

    // Evaluating the reordered draft assigns identically to the stored canonical plan.
    const keys = Array.from({length: 500}, (_, i) => `user-${i}`);
    const [stored, reorderedDraft] = await Promise.all([
      request(app).post('/api/rollout/evaluate').send({flagId: 'beta', keys}),
      request(app).post('/api/rollout/evaluate').send({
        flagId: 'beta',
        variants: [...variants].reverse(),
        keys,
      }),
    ]);
    expect(stored.body.results).toEqual(reorderedDraft.body.results);
    for (const result of stored.body.results) {
      const range = put.body.plan.ranges.find((r: {variantId: string}) => r.variantId === result.variantId)!;
      expect(result.slot).toBeGreaterThanOrEqual(range.start);
      expect(result.slot).toBeLessThan(range.end);
    }
  });

  it('accepts 0/100 weights and reports actual half-open ranges', async () => {
    const app = createApp();
    const revision = await currentRevision(app, 'alpha');
    const plan = await request(app)
      .post('/api/rollout/plan')
      .send({variants: [{id: 'off', weight: 0}, {id: 'on', weight: 100}]})
      .expect(200);
    expect(plan.body.plan.ranges).toContainEqual(
      expect.objectContaining({variantId: 'off', start: 0, end: 0, slots: 0}),
    );
    expect(plan.body.plan.ranges).toContainEqual(
      expect.objectContaining({variantId: 'on', start: 0, end: N, slots: N}),
    );

    await request(app)
      .put('/api/flags/alpha/rollout')
      .send({revision, variants: [{id: 'off', weight: 0}, {id: 'on', weight: 100}]})
      .expect(200);
  });

  it('reports validation errors for duplicate ids and bad weights', async () => {
    const app = createApp();
    const dup = await request(app)
      .post('/api/rollout/plan')
      .send({variants: [{id: 'a', weight: 50}, {id: 'a', weight: 50}]})
      .expect(422);
    expect(dup.body.error).toBe('duplicate_variant_id');
    const invalid = await request(app)
      .post('/api/rollout/plan')
      .send({variants: [{id: 'a', weight: -5}, {id: 'b', weight: 105}]})
      .expect(422);
    expect(invalid.body.error).toBe('invalid_weight');
  });

  it('guards revisions and returns 409 on stale writes', async () => {
    const app = createApp();
    const revision = await currentRevision(app, 'alpha');
    await request(app)
      .put('/api/flags/alpha/rollout')
      .send({revision, variants: [{id: 'a', weight: 100}]})
      .expect(200);
    await request(app)
      .put('/api/flags/alpha/rollout')
      .send({revision, variants: [{id: 'a', weight: 100}]})
      .expect(409);
  });

  it('hashes deterministically and evaluates drafts', async () => {
    const app = createApp();
    const first = await request(app).post('/api/rollout/hash').send({flagId: 'f', key: 'user-42'}).expect(200);
    const second = await request(app).post('/api/rollout/hash').send({flagId: 'f', key: 'user-42'}).expect(200);
    expect(first.body.slot).toBe(second.body.slot);
    expect(first.body.slot).toBeGreaterThanOrEqual(0);
    expect(first.body.slot).toBeLessThan(N);

    const evalRes = await request(app)
      .post('/api/rollout/evaluate')
      .send({flagId: 'f', variants: [{id: 'a', weight: 50}, {id: 'b', weight: 50}], keys: ['user-42']})
      .expect(200);
    const {slot, variantId, start, end} = evalRes.body.results[0];
    expect(slot).toBe(first.body.slot);
    expect(slot >= start && slot < end).toBe(true);
    expect(['a', 'b']).toContain(variantId);
  });
});
