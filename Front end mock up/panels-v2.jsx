// Side-panel components v2 — Arial, mid-fi cards.

const Section = ({ title, count, children, defaultOpen=true, nest=false }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className={'section'+(open?' open':'')+(nest?' nest':'')}>
      <div className="sec-hd" onClick={()=>setOpen(o=>!o)}>
        <span className="left"><span className="chev">▶</span> {title}</span>
        <span style={{display:'flex',gap:6,alignItems:'center'}}>
          {count!=null && <span className="pill">{count}</span>}
        </span>
      </div>
      {open && <div className="sec-body">{children}</div>}
    </div>
  );
};

// ── WTG add form ──
function WTGForm({ onAdd }){
  const [modelId, setModelId] = React.useState('v163');
  const [ws, setWs] = React.useState(8);
  const [hub, setHub] = React.useState(148);
  const [mode, setMode] = React.useState('PO4500');
  const m = WTG_MODELS.find(x=>x.id===modelId);
  React.useEffect(()=>{ setHub(m.hubHeights[Math.floor(m.hubHeights.length/2)]); setMode(m.modes[0]); }, [modelId]);
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <label className="fld"><span>Model</span>
        <select className="input" value={modelId} onChange={e=>setModelId(e.target.value)}>
          {WTG_MODELS.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <div className="grid-2">
        <label className="fld"><span>Wind speed (m/s)</span>
          <select className="input" value={ws} onChange={e=>setWs(+e.target.value)}>
            {WIND_SPEEDS.map(s=><option key={s} value={s}>{s} m/s @ 10 m</option>)}
          </select>
        </label>
        <label className="fld"><span>Hub height (m)</span>
          <input className="input" type="number" min="50" max="200" step="1"
                 value={hub} onChange={e=>setHub(+e.target.value)}
                 list={'hubs-'+modelId}/>
          <datalist id={'hubs-'+modelId}>
            {m.hubHeights.map(h=><option key={h} value={h}/>)}
          </datalist>
        </label>
      </div>
      <label className="fld"><span>Mode (sound power)</span>
        <select className="input" value={mode} onChange={e=>setMode(e.target.value)}>
          {m.modes.map(x=><option key={x} value={x}>{`${x}  —  LwA ${m.lwa[x]} dB`}</option>)}
        </select>
      </label>
      <div className="hint">Suggested hub heights: {m.hubHeights.join(', ')} m. LwA = {m.lwa[mode]} dB.</div>
      <div style={{display:'flex',gap:6}}>
        <button className="btn yellow" onClick={()=>onAdd({ modelId, ws, hub, mode })}>+ Add WTG</button>
        <button className="btn ghost tiny">Bulk add…</button>
      </div>
    </div>
  );
}

function WTGList({ items, selected, onSelect, onRemove }){
  if(!items.length) return <div className="hint">No WTGs placed yet.</div>;
  return items.map(w => {
    const m = WTG_MODELS.find(x=>x.id===w.modelId);
    return (
      <div key={w.id} className={'item'+(selected===w.id?' selected':'')} onClick={()=>onSelect(w.id)}>
        <span className="glyph">
          <svg width="18" height="18" viewBox="-10 -10 20 20">
            <line x1="0" y1="0" x2="0" y2="-8" stroke="#2A2A2A" strokeWidth="1.6" strokeLinecap="round"/>
            <line x1="0" y1="0" x2="7" y2="4" stroke="#2A2A2A" strokeWidth="1.6" strokeLinecap="round"/>
            <line x1="0" y1="0" x2="-7" y2="4" stroke="#2A2A2A" strokeWidth="1.6" strokeLinecap="round"/>
            <circle cx="0" cy="0" r="2" fill="#F2CB00" stroke="#2A2A2A" strokeWidth="0.8"/>
          </svg>
        </span>
        <span>
          <div className="name">{w.id}</div>
          <div className="meta">{m.name.replace(' (placeholder)','')} · {w.hub} m · {w.mode}</div>
        </span>
        <span className="x" onClick={(e)=>{e.stopPropagation();onRemove(w.id);}}>✕</span>
      </div>
    );
  });
}

// ── BESS ──
function BESSForm({ onAdd }){
  const [modelId, setModelId] = React.useState('mp2xl');
  const [mode, setMode] = React.useState('2-hr / 9-fan');
  const [count, setCount] = React.useState(20);
  const [heading, setHeading] = React.useState(0);
  const m = BESS_MODELS.find(x=>x.id===modelId);
  React.useEffect(()=>{ setMode(m.modes[0]); }, [modelId]);
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <label className="fld"><span>Model</span>
        <select className="input" value={modelId} onChange={e=>setModelId(e.target.value)}>
          {BESS_MODELS.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <label className="fld"><span>Mode</span>
        <select className="input" value={mode} onChange={e=>setMode(e.target.value)}>
          {m.modes.map(x=><option key={x} value={x}>{`${x} — ${m.lwa[x]} dB / unit`}</option>)}
        </select>
      </label>
      <div className="grid-2">
        <label className="fld"><span># of units</span>
          <input className="input" type="number" min="1" value={count} onChange={e=>setCount(+e.target.value)}/>
        </label>
        <label className="fld"><span>Heading (°)</span>
          <input className="input" type="number" min="0" max="359" value={heading} onChange={e=>setHeading(+e.target.value)}/>
        </label>
      </div>
      <div className="hint">Long-axis points to {heading}°. Drag the marker on map to rotate (hold Alt).</div>
      <button className="btn yellow" onClick={()=>onAdd({ modelId, mode, count, heading })}>+ Add BESS</button>
    </div>
  );
}

function BESSList({ items, selected, onSelect, onRemove }){
  if(!items.length) return <div className="hint">No BESS placed yet.</div>;
  return items.map(b => {
    const m = BESS_MODELS.find(x=>x.id===b.modelId);
    return (
      <div key={b.id} className={'item'+(selected===b.id?' selected':'')} onClick={()=>onSelect(b.id)}>
        <span className="glyph">
          <svg width="18" height="18" viewBox="-10 -10 20 20" style={{transform:`rotate(${b.heading}deg)`}}>
            <rect x="-7" y="-4" width="14" height="9" fill="#2A2A2A" stroke="#F2CB00" strokeWidth="1"/>
            <polygon points="0,-8 -2,-5 2,-5" fill="#F2CB00"/>
          </svg>
        </span>
        <span>
          <div className="name">{b.id}</div>
          <div className="meta">{m.name.split(' (')[0]} · {b.count}× · {b.mode} · {b.heading}°</div>
        </span>
        <span className="x" onClick={(e)=>{e.stopPropagation();onRemove(b.id);}}>✕</span>
      </div>
    );
  });
}

// ── Calc area ──
function CalcAreaPanel({ area, setArea, drawingMode, setDrawingMode }){
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <div className="hint">Rectangular area — drag corners to resize, yellow handle to rotate.</div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        <button className={'btn'+(drawingMode==='2pt'?' yellow':'')} onClick={()=>setDrawingMode('2pt')}>↘ 2-point</button>
        <button className={'btn'+(drawingMode==='3pt'?' yellow':'')} onClick={()=>setDrawingMode('3pt')}>⤧ 3-point (rotated)</button>
        <button className="btn ghost">📁 Import .shp</button>
      </div>
      <hr className="dim"/>
      <div className="grid-2">
        <label className="fld"><span>Width (km)</span>
          <input className="input" type="number" step="0.5" value={area.widthKm} onChange={e=>setArea({...area,widthKm:+e.target.value})}/>
        </label>
        <label className="fld"><span>Height (km)</span>
          <input className="input" type="number" step="0.5" value={area.heightKm} onChange={e=>setArea({...area,heightKm:+e.target.value})}/>
        </label>
      </div>
      <div className="grid-2">
        <label className="fld"><span>Rotation (°)</span>
          <input className="input" type="number" value={area.rotationDeg} onChange={e=>setArea({...area,rotationDeg:+e.target.value})}/>
        </label>
        <label className="fld"><span>Grid spacing</span>
          <select className="input" defaultValue="50">
            <option>10 m</option><option>25 m</option><option value="50">50 m</option><option>100 m</option>
          </select>
        </label>
      </div>
    </div>
  );
}

// ── Receivers ──
function ReceiverForm({ onAdd, defaultLimit, setDefaultLimit }){
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <div className="grid-2">
        <label className="fld"><span>Default limit (dB)</span>
          <input className="input" type="number" value={defaultLimit} onChange={e=>setDefaultLimit(+e.target.value)}/>
        </label>
        <label className="fld"><span>Period</span>
          <select className="input" defaultValue="night">
            <option>Day</option><option>Evening</option><option value="night">Night</option>
          </select>
        </label>
      </div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        <button className="btn yellow" onClick={onAdd}>+ Add receiver</button>
        <button className="btn ghost">📁 Import .shp</button>
      </div>
      <div className="hint">Imported receivers inherit the default limit unless the shapefile carries one.</div>
    </div>
  );
}

function ReceiverList({ items, onRemove }){
  if(!items.length) return <div className="hint">No receivers yet.</div>;
  return items.map(r => {
    const fail = r.level > r.limit;
    return (
      <div key={r.id} className="item">
        <span className="glyph">
          <span style={{display:'inline-block',width:11,height:11,borderRadius:'50%',
            background:fail?'#C0392B':'#2E7D32',border:'2px solid #fff',
            boxShadow:'0 0 0 1px rgba(0,0,0,.4)'}}></span>
        </span>
        <span>
          <div className="name">{r.name} <span className="muted tiny">· {r.id}</span></div>
          <div className="meta">
            <span className="num">{r.level.toFixed(1)} dB</span> / limit {r.limit} dB ·
            {fail
              ? <span style={{color:'#C0392B',fontWeight:700}}> EXCEED +{(r.level-r.limit).toFixed(1)}</span>
              : <span style={{color:'#2E7D32',fontWeight:700}}> within limit</span>}
          </div>
        </span>
        <span className="x" onClick={()=>onRemove(r.id)}>✕</span>
      </div>
    );
  });
}

// ── Import ──
function ImportPanel(){
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <div className="dropzone">
        <div className="ic">⤓</div>
        <div style={{fontWeight:600}}>Drop shapefile here</div>
        <div className="hint">.shp + .dbf + .shx (or .zip)</div>
      </div>
      <div className="grid-2">
        <button className="btn">📍 Receivers.shp</button>
        <button className="btn">⚡ BESS.shp</button>
        <button className="btn">🌀 WTGs.shp</button>
        <button className="btn">⛰ DEM.tif</button>
      </div>
      <hr className="dim"/>
      <label className="fld"><span>Ground elevation source</span>
        <select className="input" defaultValue="srtm">
          <option value="srtm">Auto · SRTM 30 m (online)</option>
          <option>Auto · Geoscience AU 5 m</option>
          <option>User-uploaded DEM…</option>
        </select>
      </label>
      <div className="hint">Auto-fetches if a coverage exists. Override with a higher-res upload as needed.</div>
    </div>
  );
}

// ── Results / Contour controls ──
function ResultsPanel({ palette, setPalette, transparency, setTransparency, showContours, setShowContours, bandsOn, setBandsOn, ran, run, busy }){
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <button className="btn run" onClick={run} disabled={busy}>
        {busy ? '⟳ Calculating…' : '▶ Run calculation'}
      </button>
      <div className="hint">{ran ? 'Last run: 0:42 · 8 WTGs · 2 BESS · 12,400 grid cells' : 'No results yet.'}</div>
      <hr className="dim"/>
      <label className="fld"><span>Palette</span>
        <select className="input" value={palette} onChange={e=>setPalette(e.target.value)}>
          {Object.keys(PALETTES).map(p=><option key={p} value={p}>{p[0].toUpperCase()+p.slice(1)}</option>)}
        </select>
      </label>
      <div style={{display:'flex',gap:0,height:14,border:'1px solid rgba(0,0,0,.2)',borderRadius:3,overflow:'hidden'}}>
        {PALETTES[palette].map((c,i)=>(
          <div key={i} style={{flex:1,background:c}}></div>
        ))}
      </div>
      <label className="fld"><span>Transparency · {transparency}%</span>
        <input type="range" min="0" max="100" value={transparency} onChange={e=>setTransparency(+e.target.value)}/>
      </label>
      <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5}}>
        <input type="checkbox" checked={showContours} onChange={e=>setShowContours(e.target.checked)}/>
        Show contours
      </label>
      <div className="fld"><span>Bands</span></div>
      <div style={{display:'flex',flexDirection:'column',gap:4}}>
        {CONTOUR_BANDS.map((b,i)=>(
          <label key={i} style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5,
            padding:'4px 6px',border:'1px solid #ECECEC',borderRadius:4}}>
            <input type="checkbox" checked={!!bandsOn[i]} onChange={e=>{ const n=[...bandsOn]; n[i]=e.target.checked; setBandsOn(n); }}/>
            <span style={{width:18,height:12,background:PALETTES[palette][i],border:'1px solid rgba(0,0,0,.2)',borderRadius:2}}></span>
            <span style={{flex:1}}>{b.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Layers panel ──
function LayersPanel(){
  const [layers, setLayers] = React.useState({
    sat:true, dem:true, calc:true, wtgs:true, bess:true, recv:true, contours:true, props:false, roads:true,
  });
  const t = (k) => setLayers(s=>({...s, [k]:!s[k]}));
  const items = [
    ['sat','Satellite imagery','Esri World Imagery'],
    ['dem','Ground elevation','SRTM 30 m'],
    ['calc','Calculation area','Rotated rectangle'],
    ['wtgs','WTGs','8 placed'],
    ['bess','BESS','2 placed'],
    ['recv','Receivers','8 placed'],
    ['contours','Noise contours','5 bands · viridis'],
    ['props','Property boundaries','Not loaded'],
    ['roads','Roads & labels','OSM overlay'],
  ];
  return items.map(([k,t1,t2])=>(
    <div key={k} className={'layer-row'+(layers[k]?'':' disabled')}>
      <input type="checkbox" checked={layers[k]} onChange={()=>t(k)}/>
      <div style={{flex:1}}>
        <div className="ttl">{t1}</div>
        <div className="meta">{t2}</div>
      </div>
    </div>
  ));
}

Object.assign(window, {
  Section, WTGForm, WTGList, BESSForm, BESSList, CalcAreaPanel,
  ReceiverForm, ReceiverList, ImportPanel, ResultsPanel, LayersPanel,
});
