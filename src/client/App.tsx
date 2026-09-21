import {useEffect,useMemo,useState} from 'react';
import {FlaskConical,Play,Save} from 'lucide-react';
import {parseFlagConfig,hashUser,slotForHash,variantForSlot,TOTAL_SLOTS,type Allocation,type Issue} from '../shared/allocation';
type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string;allocation?:Allocation|null;diagnostics?:Issue[]};
const PALETTE=['#4f8ef7','#f7784f','#4fc38a','#b478f7','#f7c44f','#f74f8e','#4fd6f7','#9ac74f'];
function AllocationPanel({draft,flagId}:{draft:string;flagId:string}){
  const parsed=useMemo(()=>parseFlagConfig(draft),[draft]);
  const [userId,setUserId]=useState('user-1234');
  if(parsed.kind==='text')return <div className="alloc"><h3>Variant slots</h3><p className="muted">Plain-text rules have no slot allocation. Save a JSON config such as <code>{'{"variants":[{"key":"control","weight":50},{"key":"treatment","weight":50}]}'}</code> to preview fixed integer slots.</p></div>;
  if(parsed.kind==='invalid')return <div className="alloc"><h3>Variant slots</h3><ul className="issues">{parsed.issues.map((issue,index)=><li key={index}><code>{issue.code}</code> {issue.message}</li>)}</ul></div>;
  const {allocation}=parsed;
  const hash=hashUser(flagId,userId);const slot=slotForHash(hash);const hit=variantForSlot(allocation.ranges,slot);
  return <div className="alloc"><h3>Variant slots — {TOTAL_SLOTS.toLocaleString()} fixed slots, half-open [start, end)</h3>
    <div className="alloc-bar">{allocation.ranges.map((range,index)=><div key={range.key} className="seg" style={{width:`${range.slots/(TOTAL_SLOTS/100)}%`,background:PALETTE[index%PALETTE.length]}} title={`${range.key} [${range.start}, ${range.end})`}/>)}</div>
    <table className="alloc-table"><thead><tr><th>Variant</th><th>Weight</th><th>Slots</th><th>Range</th><th>Effective %</th></tr></thead>
    <tbody>{allocation.ranges.map((range,index)=><tr key={range.key}><td><span className="dot" style={{background:PALETTE[index%PALETTE.length]}}/>{range.key}</td><td>{range.weight}</td><td>{range.slots}</td><td><code>[{range.start}, {range.end})</code></td><td>{range.effectiveWeight}%</td></tr>)}</tbody></table>
    <div className="assign"><label>Test user <input value={userId} onChange={event=>setUserId(event.target.value)}/></label><span>hash <code>{hash}</code> → slot <code>{slot}</code> → <strong>{hit?hit.key:'—'}</strong></span></div>
  </div>;
}
export default function App(){
  const [items,setItems]=useState<Summary[]>([]);const [selected,setSelected]=useState('alpha');const [row,setRow]=useState<Row|null>(null);const [draft,setDraft]=useState('');const [analysis,setAnalysis]=useState<unknown>(null);const [status,setStatus]=useState('Ready');
  useEffect(()=>{fetch('/api/flags').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{setStatus('Loading');fetch('/api/flags/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/flags/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus(response.status===422?'Invalid config: '+(value.issues??[]).map((issue:Issue)=>issue.message).join('; '):'Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/flags/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Feature Evaluation Lab</strong><small>Local workspace</small></header><section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><span>{status}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/><AllocationPanel draft={draft} flagId={selected}/></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(analysis??row,null,2)}</pre></aside></section></main>;
}
