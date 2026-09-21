import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  assignUser,
  hashUser,
  parseFlagConfig,
  slotForHash,
  variantForSlot,
  TOTAL_SLOTS,
  type Allocation,
  type Issue,
} from '../shared/allocation';

type RecordRow = {id: string; name: string; revision: number; content: string; updatedAt: string};
type RowView = RecordRow & {allocation: Allocation | null; diagnostics: Issue[]};

const rows: RecordRow[] = [
  {
    id: 'alpha',
    name: 'Primary evaluation rules',
    revision: 3,
    content: JSON.stringify(
      {
        flag: 'checkout-redesign',
        variants: [
          {key: 'control', weight: 50},
          {key: 'treatment-a', weight: 30},
          {key: 'treatment-b', weight: 20},
        ],
      },
      null,
      2,
    ),
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'beta',
    name: 'Secondary evaluation rules',
    revision: 5,
    content: JSON.stringify(
      {
        flag: 'search-ranking',
        variants: [
          {key: 'control', weight: 33.33},
          {key: 'treatment-a', weight: 33.33},
          {key: 'treatment-b', weight: 33.34},
        ],
      },
      null,
      2,
    ),
    updatedAt: new Date(1000).toISOString(),
  },
];

function view(row: RecordRow): RowView {
  const parsed = parseFlagConfig(row.content);
  if (parsed.kind === 'config') return {...row, allocation: parsed.allocation, diagnostics: []};
  if (parsed.kind === 'invalid') return {...row, allocation: null, diagnostics: parsed.issues};
  return {...row, allocation: null, diagnostics: []};
}

function findRow(id: string) {
  return rows.find((row) => row.id === id);
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) => res.json({family: 'feature-eval', count: rows.length}));

  app.get('/api/flags', (_req, res) => res.json(rows.map(({content, ...row}) => row)));

  app.get('/api/flags/:id', (req, res) => {
    const row = findRow(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(view(row));
  });

  app.put('/api/flags/:id', (req, res) => {
    const row = findRow(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body?.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: view(row)});
    const content = String(req.body?.content ?? '');
    const parsed = parseFlagConfig(content);
    if (parsed.kind === 'invalid') return res.status(422).json({error: 'invalid_config', issues: parsed.issues});
    row.content = content;
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(view(row));
  });

  app.post('/api/flags/:id/analyze', async (req, res) => {
    const row = findRow(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise((resolve) => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    const content = String(req.body?.content ?? row.content);
    const parsed = parseFlagConfig(content);
    res.json({
      id: row.id,
      revision: row.revision,
      lines: content.split(/\r?\n/).length,
      diagnostics: parsed.kind === 'invalid' ? parsed.issues : [],
      allocation: parsed.kind === 'config' ? parsed.allocation : null,
    });
  });

  app.post('/api/flags/:id/assign', (req, res) => {
    const row = findRow(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const parsed = parseFlagConfig(row.content);
    if (parsed.kind !== 'config') {
      return res.status(422).json({error: 'not_a_config', issues: parsed.kind === 'invalid' ? parsed.issues : []});
    }
    const userId = req.body?.userId;
    if (typeof userId !== 'string') return res.status(400).json({error: 'user_id_required'});
    const {hash, slot, variant} = assignUser(row.id, userId, parsed.allocation);
    res.json({flagId: row.id, revision: row.revision, userId, hash, slot, variant});
  });

  app.post('/api/flags/:id/simulate', (req, res) => {
    const row = findRow(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const parsed = parseFlagConfig(row.content);
    if (parsed.kind !== 'config') {
      return res.status(422).json({error: 'not_a_config', issues: parsed.kind === 'invalid' ? parsed.issues : []});
    }
    const samples = req.body?.samples === undefined ? 50_000 : Number(req.body.samples);
    if (!Number.isInteger(samples) || samples < 1 || samples > 500_000) {
      return res.status(400).json({error: 'invalid_samples', message: 'samples must be an integer in [1, 500000]'});
    }
    const counts: Record<string, number> = {};
    for (const range of parsed.allocation.ranges) counts[range.key] = 0;
    for (let i = 0; i < samples; i++) {
      const slot = slotForHash(hashUser(row.id, `sim-${i}`));
      const range = variantForSlot(parsed.allocation.ranges, slot);
      if (range) counts[range.key] += 1;
    }
    res.json({
      flagId: row.id,
      revision: row.revision,
      samples,
      totalSlots: TOTAL_SLOTS,
      counts,
      expectedSlots: Object.fromEntries(parsed.allocation.ranges.map((range) => [range.key, range.slots])),
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
