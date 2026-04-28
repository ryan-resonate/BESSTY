// Side-panel components v3 — refined design.

const Section = ({ title, count, children, defaultOpen=true, step=null, hasContent=false }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className={'section'+(open?' open':'')+(hasContent?' has-content':'')}>
      <div className="sec-hd" onClick={()=>setOpen(o=>!o)}>
        <span className="left">
          {step!=null && <span className="num-step">{step}</span>}
          <span className="chev">▶</span>
          <span>{title}</span>
        </span>
        <span style={{display:'flex',gap:6,alignItems:'center'}}>
          {count!=null && <span className={'pill'+(count>0?' brand':'')}>{count}</span>}
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
        <label className="fld"><span>Wind speed</span>
          <select className="input" value={ws} onChange={e=>setWs(+e.target.value)}>
            {WIND_SPEEDS.map(s=><option key={s} value={s}>{s} m/s @ 10 m</option>)}
          </select>
        </label>
        <label className="fld"><span>Hub height</span>
          <input className="input" type="number" min="50" max="200" step="1"
                 value={hub} onChange={e=>setHub(+e.target.value)}
                 list={'hubs-'+modelId}/>
          <datalist id={'hubs-'+modelId}>
            {m.hubHeights.map(h=><option key={h} value={h}/>)}
          </datalist>
        </label>
      </div>
      <label className="fld"><span>Mode · sound power</span>
        <select className="input" value={mode} onChange={e=>setMode(e.target.value)}>
          {m.modes.map(x=><option key={x} value={x}>{`${x}  —  L${'\u2090'} ${m.lwa[x]} dB`}</option>)}
        </select>
      </label>
      <div className="hint">Suggested hubs: <span className="num">{m.hubHeights.join(', ')} m</span> · L<sub>w,A</sub> = <span className="num">{m.lwa[mode]} dB</span></div>
      <div style={{display:'flex',gap:6}}>
        <button className="btn brand" onClick={()=>onAdd({ modelId, ws, hub, mode })}>+ Add WTG</button>
        <button className="btn ghost tiny">Bulk add…</button>
      </div>
    </div>
  );
}

function WTGList({ items, selected, onSelect, onRemove }){
  if(!items.length) return (
    <div className="empty-state">
      <div className="ic">⌬</div>
      <div className="ttl">No WTGs placed</div>
      <div className="sub">Add a turbine above, then drag on the map to position.</div>
    </div>
  );
  return items.map(w => {
    const m = WTG_MODELS.find(x=>x.id===w.modelId);
    return (
      <div key={w.id} className={'item'+(selected===w.id?' selected':'')} onClick={()=>onSelect(w.id)}>
        <span className="glyph">
          <svg width="16" height="16" viewBox="-10 -10 20 20">
            <line x1="0" y1="0" x2="0" y2="-8" stroke="#15181D" strokeWidth="1.6" strokeLinecap="round"/>
            <line x1="0" y1="0" x2="7" y2="4" stroke="#15181D" strokeWidth="1.6" strokeLinecap="round"/>
            <line x1="0" y1="0" x2="-7" y2="4" stroke="#15181D" strokeWidth="1.6" strokeLinecap="round"/>
            <circle cx="0" cy="0" r="2.2" fill="#F2CB00" stroke="#15181D" strokeWidth="0.8"/>
          </svg>
        </span>
        <span>
          <div className="name">{w.id}</div>
          <div className="meta">{m.name.replace(' (placeholder)','')} · <span className="num">{w.hub} m</span> · {w.mode}</div>
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
        <label className="fld"><span>Units</span>
          <input className="input" type="number" min="1" value={count} onChange={e=>setCount(+e.target.value)}/>
        </label>
        <label className="fld"><span>Heading °</span>
          <input className="input" type="number" min="0" max="359" value={heading} onChange={e=>setHeading(+e.target.value)}/>
        </label>
      </div>
      <div className="hint">Long-axis points to <span className="num">{heading}°</span>. Alt-drag the marker to rotate on map.</div>
      <button className="btn brand" onClick={()=>onAdd({ modelId, mode, count, heading })}>+ Add BESS</button>
    </div>
  );
}

function BESSList({ items, selected, onSelect, onRemove }){
  if(!items.length) return (
    <div className="empty-state">
      <div className="ic">▭</div>
      <div className="ttl">No BESS placed</div>
      <div className="sub">Add a battery system above to place on the map.</div>
    </div>
  );
  return items.map(b => {
    const m = BESS_MODELS.find(x=>x.id===b.modelId);
    return (
      <div key={b.id} className={'item'+(selected===b.id?' selected':'')} onClick={()=>onSelect(b.id)}>
        <span className="glyph">
          <svg width="16" height="16" viewBox="-10 -10 20 20" style={{transform:`rotate(${b.heading}deg)`}}>
            <rect x="-7" y="-4" width="14" height="9" fill="#15181D" stroke="#F2CB00" strokeWidth="1"/>
            <polygon points="0,-8 -2,-5 2,-5" fill="#F2CB00"/>
          </svg>
        </span>
        <span>
          <div className="name">{b.id}</div>
          <div className="meta">{m.name.split(' (')[0]} · <span className="num">{b.count}×</span> · {b.mode} · <span className="num">{b.heading}°</span></div>
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
      <div className="hint">Drag corner handles to resize · yellow handle to rotate.</div>
      <div className="segmented">
        <button className={drawingMode==='2pt'?'active':''} onClick={()=>setDrawingMode('2pt')}>↘ 2-point</button>
        <button className={drawingMode==='3pt'?'active':''} onClick={()=>setDrawingMode('3pt')}>⤧ 3-point rotated</button>
      </div>
      <button className="btn ghost" style={{justifyContent:'center'}}>↑ Import .shp</button>
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
      <div style={{display:'flex',gap:6}}>
        <button className="btn brand" onClick={onAdd}>+ Add receiver</button>
        <button className="btn ghost">↑ Import .shp</button>
      </div>
      <div className="hint">Imported receivers inherit the default limit unless the shapefile carries one.</div>
    </div>
  );
}

function ReceiverList({ items, onRemove }){
  if(!items.length) return (
    <div className="empty-state">
      <div className="ic">◉</div>
      <div className="ttl">No receivers</div>
      <div className="sub">Add receivers manually or import a shapefile.</div>
    </div>
  );
  return items.map(r => {
    const fail = r.level > r.limit;
    const margin = r.level - r.limit;
    return (
      <div key={r.id} className="item">
        <span className="glyph">
          <span style={{display:'inline-block',width:11,height:11,borderRadius:'50%',
            background:fail?'#C8362B':'#1F8E4A',border:'2px solid #fff',
            boxShadow:'0 0 0 1px rgba(0,0,0,.4)'}}></span>
        </span>
        <span>
          <div className="name">{r.name} <span className="muted tiny">· {r.id}</span></div>
          <div className="meta">
            <span className="num" style={{fontWeight:600,color:fail?'#C8362B':'#1F8E4A'}}>{r.level.toFixed(1)} dB</span>
            <span className="muted"> / limit <span className="num">{r.limit}</span> · </span>
            {fail
              ? <span style={{color:'#C8362B',fontWeight:600}}>+{margin.toFixed(1)} over</span>
              : <span style={{color:'#1F8E4A',fontWeight:600}}>{margin.toFixed(1)} under</span>}
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
        <div className="ic">↑</div>
        <div className="ttl">Drop shapefile or DEM here</div>
        <div className="hint">.shp + .dbf + .shx (or .zip) · .tif</div>
      </div>
      <div className="grid-2">
        <button className="btn">Receivers.shp</button>
        <button className="btn">BESS.shp</button>
        <button className="btn">WTGs.shp</button>
        <button className="btn">DEM.tif</button>
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
function ResultsPanel({ palette, setPalette, transparency, setTransparency, showContours, setShowContours, bandsOn, setBandsOn, ran, run, busy, ms }){
  const receivers = ms ? ms.receivers : [];
  const fails = receivers.filter(r=>r.level>r.limit);
  const maxLevel = receivers.length ? Math.max(...receivers.map(r=>r.level)) : 0;
  const counts = CONTOUR_BANDS.map(b => receivers.filter(r=>r.level>=b.lo && r.level<b.hi).length);

  return (
    <div style={{display:'flex',flexDirection:'column',gap:12}}>
      <button className="btn run" onClick={run} disabled={busy}>
        {busy ? '⟳  Calculating…' : '▶  Run calculation'}
      </button>

      {ran && <>
        <div className="kpi-grid">
          <div className={'kpi'+(fails.length?' warn':' ok')}>
            <div className="lbl">Receivers</div>
            <div className="val num">{fails.length}<span style={{fontSize:13,color:'var(--mid)',fontWeight:500}}>/{receivers.length}</span></div>
            <div className="sub">{fails.length ? 'exceeding limit' : 'all within limit'}</div>
          </div>
          <div className="kpi">
            <div className="lbl">Max level</div>
            <div className="val num">{maxLevel.toFixed(1)}<span style={{fontSize:11,color:'var(--mid)',fontWeight:500,marginLeft:3}}>dB</span></div>
            <div className="sub">{fails.length ? fails[0].name : 'within budget'}</div>
          </div>
        </div>

        <div>
          <div style={{fontSize:10.5,color:'var(--mid)',textTransform:'uppercase',letterSpacing:'.06em',fontWeight:500,marginBottom:4}}>Receiver levels</div>
          <div className="recv-bars">
            {receivers.map((r,i)=>{
              const h = Math.max(8, (r.level/55)*100);
              return <div key={i} className={'bar '+(r.level>r.limit?'fail':'ok')}
                style={{height:`${h}%`}} title={`${r.id}: ${r.level.toFixed(1)} dB`}></div>;
            })}
          </div>
        </div>

        <div className="hint" style={{marginTop:-4}}>Last run: <span className="num">0:42</span> · {ms?.wtgs.length} WTGs · {ms?.bess.length} BESS · 12,400 cells</div>
        <hr className="dim"/>
      </>}

      <div>
        <div style={{fontSize:10.5,color:'var(--mid)',textTransform:'uppercase',letterSpacing:'.06em',fontWeight:500,marginBottom:4}}>Palette</div>
        <div className="pal-grid">
          {Object.keys(PALETTES).map(p=>(
            <div key={p} className={'pal-card'+(palette===p?' active':'')} onClick={()=>setPalette(p)}>
              <div className="name">{p[0].toUpperCase()+p.slice(1)}</div>
              <div className="strip">{PALETTES[p].map((c,i)=><div key={i} style={{background:c}}></div>)}</div>
            </div>
          ))}
        </div>
      </div>

      <label className="fld"><span>Transparency · <span className="num">{transparency}%</span></span>
        <input type="range" min="0" max="100" value={transparency} onChange={e=>setTransparency(+e.target.value)}/>
      </label>

      <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5,fontWeight:500}}>
        <input type="checkbox" checked={showContours} onChange={e=>setShowContours(e.target.checked)}/>
        Show contour grid
      </label>

      <div>
        <div style={{fontSize:10.5,color:'var(--mid)',textTransform:'uppercase',letterSpacing:'.06em',fontWeight:500,marginBottom:4}}>Visible bands</div>
        <div style={{display:'flex',flexDirection:'column',gap:1}}>
          {CONTOUR_BANDS.map((b,i)=>(
            <label key={i} className="band-row">
              <input type="checkbox" checked={!!bandsOn[i]} onChange={e=>{ const n=[...bandsOn]; n[i]=e.target.checked; setBandsOn(n); }}/>
              <span className="sw" style={{background:PALETTES[palette][i]}}></span>
              <span className="lbl">{b.label}</span>
              <span className="cnt num">{counts[i] ? counts[i]+' rcv' : ''}</span>
            </label>
          ))}
        </div>
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
    ['sat','Satellite imagery','Esri World Imagery','#7A8290'],
    ['dem','Ground elevation','SRTM 30 m','#8b6914'],
    ['calc','Calculation area','Rotated rectangle','#15181D'],
    ['wtgs','WTGs','8 placed','#F2CB00'],
    ['bess','BESS','2 placed','#15181D'],
    ['recv','Receivers','8 placed','#1F8E4A'],
    ['contours','Noise contours','5 bands · viridis','linear-gradient(90deg,#440154,#21918c,#fde725)'],
    ['props','Property boundaries','Not loaded','#B5BBC6'],
    ['roads','Roads & labels','OSM overlay','#7A8290'],
  ];
  return items.map(([k,t1,t2,col])=>(
    <div key={k} className={'layer-row'+(layers[k]?'':' disabled')} onClick={()=>t(k)}>
      <input type="checkbox" checked={layers[k]} onChange={()=>t(k)} onClick={e=>e.stopPropagation()}/>
      <span className="swatch" style={{background:col}}></span>
      <div style={{minWidth:0}}>
        <div className="ttl">{t1}</div>
        <div className="meta">{t2}</div>
      </div>
      <span className="grip">⋮⋮</span>
    </div>
  ));
}

Object.assign(window, {
  Section, WTGForm, WTGList, BESSForm, BESSList, CalcAreaPanel,
  ReceiverForm, ReceiverList, ImportPanel, ResultsPanel, LayersPanel,
});
