import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  AllocationError,
  buildPlan,
  evaluate,
  hashToSlot,
  RolloutConfig,
  TOTAL_SLOTS,
} from './rollout.js';

type RecordRow = {
  id: string;
  name: string;
  revision: number;
  content: string;
  rollout: RolloutConfig | null;
  updatedAt: string;
};

const rows: RecordRow[] = [
  {
    id: 'alpha',
    name: 'Primary evaluation rules',
    revision: 3,
    content: 'evaluation rules: alpha\nstate: active',
    rollout: {variants: [{id: 'control', weight: 60}, {id: 'canary', weight: 40}]},
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'beta',
    name: 'Secondary evaluation rules',
    revision: 5,
    content: 'evaluation rules: beta\nstate: review',
    rollout: null,
    updatedAt: new Date(1000).toISOString(),
  },
];

/** Public row shape: rollout config plus the server-computed integer plan. */
function rolloutView(row: RecordRow) {
  if (!row.rollout) return null;
  return {config: row.rollout, plan: buildPlan(row.rollout)};
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) => res.json({family: 'feature-eval', count: rows.length}));
  app.get('/api/flags', (_req, res) =>
    res.json(rows.map(({content, rollout, ...row}) => ({...row, hasRollout: rollout !== null}))),
  );
  app.get('/api/flags/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/flags/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    row.content = String(req.body.content ?? '');
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });
  app.post('/api/flags/:id/analyze', async (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise(resolve => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    res.json({
      id: row.id,
      revision: row.revision,
      lines: String(req.body.content ?? row.content).split(/\r?\n/).length,
      diagnostics: [],
    });
  });

  /** Compute the fixed-integer slot plan for a draft config without saving it. */
  app.post('/api/rollout/plan', (req, res) => {
    try {
      const config = {variants: req.body?.variants} as RolloutConfig;
      const plan = buildPlan(config, TOTAL_SLOTS);
      res.json({config, plan});
    } catch (error) {
      if (error instanceof AllocationError) return res.status(422).json({error: error.code, message: error.message, details: error.details});
      throw error;
    }
  });

  /** Evaluate unit keys against a draft or stored config. */
  app.post('/api/rollout/evaluate', (req, res) => {
    try {
      const flagId = typeof req.body?.flagId === 'string' ? req.body.flagId : 'draft';
      const source = req.body?.variants ? {variants: req.body.variants} : rows.find(r => r.id === flagId)?.rollout ?? null;
      if (!source) return res.status(404).json({error: 'not_found', message: 'No rollout config for that flag and no draft provided.'});
      const keys: unknown = req.body?.keys;
      if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) {
        return res.status(400).json({error: 'invalid_keys', message: 'keys must be an array of strings.'});
      }
      if (keys.length > 1000) return res.status(400).json({error: 'too_many_keys', message: 'At most 1000 keys per request.'});
      const results = keys.map(key => {
        const {slot, range} = evaluate(flagId, key, source, TOTAL_SLOTS);
        return {key, slot, variantId: range.variantId, start: range.start, end: range.end};
      });
      res.json({flagId, totalSlots: TOTAL_SLOTS, results});
    } catch (error) {
      if (error instanceof AllocationError) return res.status(422).json({error: error.code, message: error.message, details: error.details});
      throw error;
    }
  });

  /** Read the stored config together with its deterministic plan. */
  app.get('/api/flags/:id/rollout', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (!row.rollout) return res.status(404).json({error: 'no_rollout'});
    res.set('ETag', String(row.revision)).json({
      id: row.id,
      revision: row.revision,
      config: row.rollout,
      plan: buildPlan(row.rollout),
    });
  });

  /**
   * Persist a rollout config. The body is validated and normalized to
   * {id, weight:number}[], then stored verbatim, so a save/read round trip
   * returns exactly the submitted weights and recomputes an identical plan.
   */
  app.put('/api/flags/:id/rollout', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    try {
      const draft = {variants: req.body?.variants} as RolloutConfig;
      // Validate before touching stored state; buildPlan guarantees a partition.
      const plan = buildPlan(draft, TOTAL_SLOTS);
      const config: RolloutConfig = {
        variants: draft.variants.map(v => ({id: v.id, weight: v.weight})),
      };
      row.rollout = config;
      row.revision += 1;
      row.updatedAt = new Date().toISOString();
      res.json({id: row.id, revision: row.revision, config, plan});
    } catch (error) {
      if (error instanceof AllocationError) return res.status(422).json({error: error.code, message: error.message, details: error.details});
      throw error;
    }
  });

  /** Direct, unbiased slot lookup for a hashed key (used by the workbench tester). */
  app.post('/api/rollout/hash', (req, res) => {
    const flagId = typeof req.body?.flagId === 'string' ? req.body.flagId : 'draft';
    const key = req.body?.key;
    if (typeof key !== 'string') return res.status(400).json({error: 'invalid_key', message: 'key must be a string.'});
    const slot = hashToSlot(flagId, key, TOTAL_SLOTS);
    res.json({flagId, key, slot, totalSlots: TOTAL_SLOTS});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
