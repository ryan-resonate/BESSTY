// Side-panel components — reusable across the 3 layouts.

const Section = ({ title, count, children, defaultOpen=true }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className={'section'+(open?' open':'')}>
      <div className="sec-hd" onClick={()=>setOpen(o=>!o)}>
        <span>{open?'▾':'▸'} {title}</span>
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
    <div style={{display:'flex',flexDirection:'column',gap:8}}>
      <label className="fld"><span>Model</span>
        <select className="input" value={modelId} onChange={e=>setModelId(e.target.value)}>
          {WTG_MODELS.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <div className="grid-2">
        <label className="fld"><span>Wind speed</span>
          <select className="input" value={ws} onChange={e=>setWs(+e.target.value)}>
            {WIND_SPEEDS.map(s=><option key={s} value={s}>{s} m/s</option>)}
          </select>
        </label>
        <label className="fld"><span>Hub height</span>
          <select className="input" value={hub} onChange={e=>setHub(+e.target.value)}>
            {m.hubHeights.map(h=><option key={h} value={h}>{h} m</option>)}
          </select>
        </label>
      </div>
      <label className="fld"><span>Mode</span>
        <select className="input" value={mode} onChange={e=>setMode(e.target.value)}>
          {m.modes.map(x=><option key={x} value={x}>{`${x}  ·  LwA = ${m.lwa[x]} dB`}</option>)}
        </select>
      </label>
      <div className="hint">L<small style={{fontSize:'0.7em',verticalAlign:'sub'}}>WA</small> = {m.lwa[mode]} dB · click map to place, or:</div>
      <div style={{display:'flex',gap:6}}>
        <button className="btn primary" onClick={()=>onAdd({ modelId, ws, hub, mode })}>+ Place WTG</button>
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
        <span className="glyph"><WTGGlyph size={20}/></span>
        <span>
          <b>{w.id}</b><br/>
          <span className="meta">{m.name.replace(' (placeholder)','')} · {w.hub}m · {w.mode}</span>
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
    <div style={{display:'flex',flexDirection:'column',gap:8}}>
      <label className="fld"><span>Model</span>
        <select className="input" value={modelId} onChange={e=>setModelId(e.target.value)}>
          {BESS_MODELS.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <label className="fld"><span>Mode</span>
        <select className="input" value={mode} onChange={e=>setMode(e.target.value)}>
          {m.modes.map(x=><option key={x} value={x}>{x}  ·  {m.lwa[x]} dB</option>)}
        </select>
      </label>
      <div className="grid-2">
        <label className="fld"><span># of units</span>
          <input className="input" type="number" min="1" value={count} onChange={e=>setCount(+e.target.value)}/>
        </label>
        <label className="fld"><span>Heading °</span>
          <input className="input" type="number" min="0" max="359" value={heading} onChange={e=>setHeading(+e.target.value)}/>
        </label>
      </div>
      <div className="hint">Click on map to place — drag rotate handle to set orientation.</div>
      <div style={{display:'flex',gap:6}}>
        <button className="btn primary" onClick={()=>onAdd({ modelId, mode, count, heading })}>+ Place BESS</button>
      </div>
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
          <svg width="22" height="22" viewBox="-14 -14 28 28" style={{transform:`rotate(${b.heading}deg)`}}>
            <rect x="-8" y="-5" width="16" height="11" fill="#2A2A2A" stroke="#F2CB00" strokeWidth="1.2"/>
            <polygon points="0,-10 -2,-6 2,-6" fill="#F2CB00"/>
          </svg>
        </span>
        <span>
          <b>{b.id}</b><br/>
          <span className="meta">{m.name.split(' (')[0]} · {b.count}× · {b.mode} · {b.heading}°</span>
        </span>
        <span className="x" onClick={(e)=>{e.stopPropagation();onRemove(b.id);}}>✕</span>
      </div>
    );
  });
}

// ── Calc area ──
function CalcAreaPanel({ area, setArea, drawingMode, setDrawingMode }){
  return (
    <div style={{display:'flex',flexDirection:'column',gap:8}}>
      <div className="hint">Rectangular area — can be rotated off-north.</div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        <button className={'btn'+(drawingMode==='2pt'?' primary':'')} onClick={()=>setDrawingMode('2pt')}>2-point</button>
        <button className={'btn'+(drawingMode==='3pt'?' primary':'')} onClick={()=>setDrawingMode('3pt')}>3-point (rotated)</button>
        <button className="btn ghost">📁 Import .shp</button>
      </div>
      <hr className="sk-hr"/>
      <div className="grid-2">
        <label className="fld"><span>Width (km)</span>
          <input className="input" type="number" step="0.5" value={area.widthKm} onChange={e=>setArea({...area,widthKm:+e.target.value})}/>
        </label>
        <label className="fld"><span>Height (km)</span>
          <input className="input" type="number" step="0.5" value={area.heightKm} onChange={e=>setArea({...area,heightKm:+e.target.value})}/>
        </label>
      </div>
      <div className="grid-2">
        <label className="fld"><span>Rotation °</span>
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
    <div style={{display:'flex',flexDirection:'column',gap:8}}>
      <div className="grid-2">
        <label className="fld"><span>Default limit (dB)</span>
          <input className="input" type="number" value={defaultLimit} onChange={e=>setDefaultLimit(+e.target.value)}/>
        </label>
        <label className="fld"><span>Period</span>
          <select className="input" defaultValue="night">
            <option>Day</option>
            <option>Evening</option>
            <option value="night">Night</option>
          </select>
        </label>
      </div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        <button className="btn primary" onClick={onAdd}>+ Click on map</button>
        <button className="btn ghost">📁 Import .shp</button>
      </div>
    </div>
  );
}

function ReceiverList({ items, onRemove }){
  if(!items.length) return <div className="hint">No receivers.</div>;
  return items.map(r => {
    const fail = r.level > r.limit;
    return (
      <div key={r.id} className="item">
        <span className="glyph">
          <span style={{display:'inline-block',width:12,height:12,borderRadius:'50%',
            background:fail?'#c0392b':'#2e7d32',border:'1.5px solid #2A2A2A'}}></span>
        </span>
        <span>
          <b>{r.name}</b> <span className="mono tiny">{r.id}</span><br/>
          <span className="meta">{r.level.toFixed(1)} dB / limit {r.limit} dB
          {fail ? <span style={{color:'#c0392b',fontWeight:700}}> · EXCEED +{(r.level-r.limit).toFixed(1)}</span>
                : <span style={{color:'#2e7d32',fontWeight:700}}> · ok</span>}</span>
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
      <div className="hint">Drop .shp + .dbf + .shx (or zip)</div>
      <div className="sk-dash" style={{padding:'18px 12px',textAlign:'center',background:'#fffce6'}}>
        <div style={{fontFamily:'var(--hand2)',fontSize:22}}>↓ Drop shapefile here ↓</div>
        <div className="hint">or <u>browse</u></div>
      </div>
      <div className="grid-2">
        <button className="btn">📍 Receivers.shp</button>
        <button className="btn">⚡ BESS.shp</button>
        <button className="btn">🌀 WTGs.shp</button>
        <button className="btn">⛰ DEM.tif</button>
      </div>
      <hr className="sk-hr"/>
      <div className="fld"><span>Ground elevation source</span></div>
      <select className="input" defaultValue="srtm">
        <option value="srtm">Auto · SRTM 30 m (online)</option>
        <option>Auto · Geoscience AU 5 m</option>
        <option>User-uploaded DEM…</option>
      </select>
      <div className="hint">Auto-fetches if a coverage exists. Override with higher-res upload.</div>
    </div>
  );
}

// ── Results / Contour controls ──
function ResultsPanel({ palette, setPalette, transparency, setTransparency, showContours, setShowContours, bandsOn, setBandsOn, ran, run }){
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <button className="btn run" onClick={run}>▶ Run calculation</button>
      <div className="hint">{ran ? 'Last run: 0:42 · 8 WTGs · 2 BESS · 12,400 grid cells' : 'No results yet.'}</div>
      <hr className="sk-hr"/>
      <div className="fld"><span>Palette</span></div>
      <select className="input" value={palette} onChange={e=>setPalette(e.target.value)}>
        {Object.keys(PALETTES).map(p=><option key={p} value={p}>{p[0].toUpperCase()+p.slice(1)}</option>)}
      </select>
      <div style={{display:'flex',gap:4}}>
        {PALETTES[palette].map((c,i)=>(
          <div key={i} style={{flex:1,height:14,background:c,border:'1px solid #2A2A2A'}}></div>
        ))}
      </div>

      <div className="fld"><span>Transparency · {transparency}%</span></div>
      <input type="range" min="0" max="100" value={transparency} onChange={e=>setTransparency(+e.target.value)}/>

      <label style={{display:'flex',alignItems:'center',gap:8,fontFamily:'var(--hand)'}}>
        <input type="checkbox" checked={showContours} onChange={e=>setShowContours(e.target.checked)}/>
        Show contours
      </label>

      <div className="fld"><span>Bands</span></div>
      <div style={{display:'flex',flexDirection:'column',gap:4}}>
        {CONTOUR_BANDS.map((b,i)=>(
          <label key={i} style={{display:'flex',alignItems:'center',gap:6,fontSize:12,fontFamily:'var(--hand)'}}>
            <input type="checkbox" checked={!!bandsOn[i]} onChange={e=>{ const n=[...bandsOn]; n[i]=e.target.checked; setBandsOn(n); }}/>
            <span style={{width:18,height:12,background:PALETTES[palette][i],border:'1px solid #2A2A2A'}}></span>
            <span>{b.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, {
  Section, WTGForm, WTGList, BESSForm, BESSList, CalcAreaPanel,
  ReceiverForm, ReceiverList, ImportPanel, ResultsPanel,
});
