import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ArrowDown, ArrowUp, FlaskConical, Play, Plus, Save, Trash2, Users, X} from 'lucide-react';

type VariantDraft = {id: string; weight: string};
type Range = {variantId: string; start: number; end: number; slots: number};
type Remainder = {variantId: string; weight: number; floor: number; fraction: number; awarded: boolean};
type Plan = {totalSlots: number; ranges: Range[]; weightSum: number; remainderRule: string; remainders: Remainder[]};
type Summary = {id: string; name: string; revision: number; updatedAt: string; hasRollout: boolean};
type EvalResult = {key: string; slot: number; variantId: string; start: number; end: number};

const TOTAL = 1_000_000;

type ApiError = {error: string; message?: string};

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message ?? data.error), data as ApiError);
  return data;
}

function parseVariants(variants: VariantDraft[]) {
  return variants.map(v => ({id: v.id.trim(), weight: Number(v.weight)}));
}

function pct(slots: number) {
  return `${((slots / TOTAL) * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
}

const BAR_COLORS = ['#176b55', '#3f7f93', '#b07d23', '#7a4f9e', '#9e4f63', '#4f7a4f', '#5a6b8c', '#8c6b46'];

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [variants, setVariants] = useState<VariantDraft[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [storedSignature, setStoredSignature] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState('Ready');
  const [testerKey, setTesterKey] = useState('user-42');
  const [testerResult, setTesterResult] = useState<EvalResult | null>(null);
  const [distribution, setDistribution] = useState<Record<string, number> | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    fetch('/api/flags').then(r => r.json()).then(setItems);
  }, []);

  // Load the stored rollout for the selected flag (falls back to an empty draft).
  useEffect(() => {
    let cancelled = false;
    setStatus('Loading');
    setPlan(null);
    setPlanError(null);
    setTesterResult(null);
    setDistribution(null);
    fetch(`/api/flags/${selected}/rollout`)
      .then(async r => {
        if (r.status === 404) {
          // No rollout yet: still need the flag's current revision for optimistic save.
          const flag = await fetch(`/api/flags/${selected}`).then(res => res.json());
          return {revision: flag.revision as number, config: null};
        }
        if (!r.ok) throw new Error('load failed');
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        const draft: VariantDraft[] = data
          ? data.config.variants.map((v: {id: string; weight: number}) => ({id: v.id, weight: String(v.weight)}))
          : [{id: 'control', weight: '50'}, {id: 'treatment', weight: '50'}];
        setVariants(draft);
        setRevision(data?.revision ?? null);
        setStoredSignature(JSON.stringify(draft));
        setStatus(data ? 'Loaded' : 'New rollout');
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Recompute the server-side integer plan whenever the draft changes.
  const refreshPlan = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const numeric = parseVariants(variants);
      const data = await postJson('/api/rollout/plan', {variants: numeric});
      if (seq === requestSeq.current) {
        setPlan(data.plan);
        setPlanError(null);
      }
    } catch (error) {
      if (seq === requestSeq.current) {
        setPlan(null);
        setPlanError(error as ApiError);
      }
    }
  }, [variants]);

  useEffect(() => {
    const timer = setTimeout(refreshPlan, 120);
    return () => clearTimeout(timer);
  }, [refreshPlan]);

  const weightSum = useMemo(
    () => variants.reduce((sum, v) => sum + (Number(v.weight) || 0), 0),
    [variants],
  );
  const validDraft = !!plan;
  const dirty = JSON.stringify(variants) !== storedSignature;

  function update(index: number, patch: Partial<VariantDraft>) {
    setVariants(rows => rows.map((row, i) => (i === index ? {...row, ...patch} : row)));
  }
  function move(index: number, direction: -1 | 1) {
    setVariants(rows => {
      const next = [...rows];
      const target = index + direction;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  function remove(index: number) {
    setVariants(rows => rows.filter((_, i) => i !== index));
  }
  function add() {
    setVariants(rows => [...rows, {id: `variant-${rows.length + 1}`, weight: '0'}]);
  }

  async function save() {
    if (!validDraft) {
      setStatus('Fix validation errors before saving');
      return;
    }
    setStatus('Saving');
    try {
      const res = await fetch(`/api/flags/${selected}/rollout`, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({revision, variants: parseVariants(variants)}),
      });
      const data = await res.json();
      if (res.status === 409) {
        setStatus('Revision conflict — reload the flag');
        return;
      }
      if (!res.ok) {
        setPlanError(data);
        setStatus(data.message ?? data.error);
        return;
      }
      const draft = data.config.variants.map((v: {id: string; weight: number}) => ({id: v.id, weight: String(v.weight)}));
      setVariants(draft);
      setStoredSignature(JSON.stringify(draft));
      setRevision(data.revision);
      setPlan(data.plan);
      setPlanError(null);
      setStatus('Saved — integer slot plan persisted');
      setItems(rows => rows.map(row => (row.id === selected ? {...row, revision: data.revision, hasRollout: true} : row)));
    } catch {
      setStatus('Save failed');
    }
  }

  async function testKey() {
    try {
      const data = await postJson('/api/rollout/evaluate', {
        flagId: selected,
        variants: parseVariants(variants),
        keys: [testerKey],
      });
      setTesterResult(data.results[0]);
    } catch (error) {
      setTesterResult(null);
      setStatus((error as ApiError).message ?? 'Evaluation failed');
    }
  }

  async function simulate() {
    if (!validDraft) return;
    const keys = Array.from({length: 1000}, (_, i) => `sim-user-${i}`);
    const data = await postJson('/api/rollout/evaluate', {flagId: selected, variants: parseVariants(variants), keys});
    const counts: Record<string, number> = {};
    for (const result of data.results as EvalResult[]) {
      counts[result.variantId] = (counts[result.variantId] ?? 0) + 1;
    }
    setDistribution(counts);
  }

  const colorById = useMemo(() => {
    const ids = (plan?.ranges ?? []).map(r => r.variantId);
    return new Map(ids.map((id, i) => [id, BAR_COLORS[i % BAR_COLORS.length]]));
  }, [plan]);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Feature Evaluation Lab</strong>
        <small>Fixed-point variant rollout workbench</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Flags</h2>
          <div className="list">
            {items.map(item => (
              <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                {item.name}
                <br />
                <small>
                  Revision {item.revision}
                  {item.hasRollout ? ' · rollout' : ''}
                </small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={save} disabled={!validDraft || !dirty}>
              <Save size={15} />
              Save rollout
            </button>
            <button onClick={add}>
              <Plus size={15} />
              Add variant
            </button>
            <span className={Math.abs(weightSum - 100) < 1e-6 ? 'ok' : 'error'}>
              Sum: {Number(weightSum.toPrecision(12))}%
            </span>
            <span>{status}</span>
          </div>

          <table className="variant-table">
            <thead>
              <tr>
                <th>Variant identity (id)</th>
                <th className="num">Weight %</th>
                <th>Order</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {variants.map((row, index) => (
                <tr key={index}>
                  <td>
                    <input
                      aria-label={`variant id ${index + 1}`}
                      value={row.id}
                      onChange={event => update(index, {id: event.target.value})}
                    />
                  </td>
                  <td className="num">
                    <input
                      aria-label={`variant weight ${index + 1}`}
                      inputMode="decimal"
                      value={row.weight}
                      onChange={event => update(index, {weight: event.target.value})}
                    />
                  </td>
                  <td className="order">
                    <button title="Move up (slot boundaries do not depend on order)" onClick={() => move(index, -1)} disabled={index === 0}>
                      <ArrowUp size={14} />
                    </button>
                    <button
                      title="Move down (slot boundaries do not depend on order)"
                      onClick={() => move(index, 1)}
                      disabled={index === variants.length - 1}
                    >
                      <ArrowDown size={14} />
                    </button>
                  </td>
                  <td>
                    <button title="Remove variant" onClick={() => remove(index)} disabled={variants.length === 1}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Row order only affects display. The server assigns slots by stable variant id, so reordering rows never moves a user
            between variants.
          </p>

          {planError && (
            <div className="banner error-banner" role="alert">
              <X size={15} />
              <div>
                <strong>{planError.error}</strong>
                {planError.message ? ` — ${planError.message}` : ''}
              </div>
            </div>
          )}

          <h3>Slot preview</h3>
          {plan && (
            <>
              <div className="slot-bar" aria-label="slot ranges">
                {plan.ranges.map(range =>
                  range.slots === 0 ? null : (
                    <div
                      key={range.variantId}
                      className="slot-segment"
                      title={`${range.variantId}: [${range.start}, ${range.end})`}
                      style={{flexGrow: range.slots, background: colorById.get(range.variantId)}}
                    />
                  ),
                )}
              </div>
              <table className="range-table">
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th className="num">Actual half-open range</th>
                    <th className="num">Slots</th>
                    <th className="num">Share</th>
                    <th className="num">Remainder</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.ranges.map(range => {
                    const rem = plan.remainders.find(r => r.variantId === range.variantId)!;
                    return (
                      <tr key={range.variantId}>
                        <td>
                          <span className="dot" style={{background: colorById.get(range.variantId)}} />
                          {range.variantId}
                          {range.slots === 0 && <em className="zero"> 0 slots</em>}
                        </td>
                        <td className="num mono">
                          [{range.start.toLocaleString()}, {range.end.toLocaleString()})
                        </td>
                        <td className="num mono">{range.slots.toLocaleString()}</td>
                        <td className="num">{pct(range.slots)}</td>
                        <td className="num">
                          {rem.awarded ? <span className="badge">+1 largest remainder</span> : <span className="muted">floor</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="hint mono">
                {plan.remainderRule} · total {plan.totalSlots.toLocaleString()} slots · 1 slot = 1 ppm
              </p>
            </>
          )}
        </section>

        <aside className="pane">
          <h2>Inspection</h2>
          <span className="pill">{selected}</span>

          <h3>
            <Play size={14} /> Hash a user
          </h3>
          <div className="tester">
            <input aria-label="user key" value={testerKey} onChange={event => setTesterKey(event.target.value)} />
            <button onClick={testKey} disabled={!validDraft}>
              Evaluate
            </button>
          </div>
          {testerResult && (
            <div className="result-card">
              <div className="dot" style={{background: colorById.get(testerResult.variantId)}} />
              <strong>{testerResult.variantId}</strong>
              <div className="mono small">
                slot {testerResult.slot.toLocaleString()} ∈ [{testerResult.start.toLocaleString()}, {testerResult.end.toLocaleString()})
              </div>
            </div>
          )}

          <h3>
            <Users size={14} /> Distribution sample
          </h3>
          <button onClick={simulate} disabled={!validDraft}>
            Simulate 1,000 deterministic users
          </button>
          {distribution && plan && (
            <ul className="dist-list">
              {plan.ranges.map(range => {
                const count = distribution[range.variantId] ?? 0;
                return (
                  <li key={range.variantId}>
                    <span>
                      <span className="dot" style={{background: colorById.get(range.variantId)}} />
                      {range.variantId}
                    </span>
                    <div className="dist-track">
                      <div className="dist-fill" style={{width: `${count / 10}%`, background: colorById.get(range.variantId)}} />
                    </div>
                    <span className="num mono">{count} / 1000</span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="hint">All users hash through the same integer partition; boundaries are half-open, so 999,999 and 0 each land in exactly one variant.</p>
        </aside>
      </section>
    </main>
  );
}
