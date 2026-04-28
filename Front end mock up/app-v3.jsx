// App v3 — refined header, side panel, project picker, save state.

const { useState, useEffect } = React;

function useMapState(){
  const [s, setS] = useState(window.__mapState || null);
  useEffect(()=>{
    let lastSig = '';
    const h = ()=>{
      const next = window.__mapState;
      if(!next) return;
      const sig = JSON.stringify({
        wtgs: next.wtgs, bess: next.bess, receivers: next.receivers, area: next.area,
        drawingMode: next.drawingMode, defaultLimit: next.defaultLimit,
        selected: next.selected, showContours: next.showContours,
        transparency: next.transparency, bandsOn: next.bandsOn, palette: next.palette,
      });
      if(sig === lastSig) return;
      lastSig = sig;
      setS(next);
    };
    window.addEventListener('mapstate', h);
    h();
    return ()=> window.removeEventListener('mapstate', h);
  },[]);
  return s;
}

function ResonateLogo({ height=24 }){
  const [err, setErr] = useState(false);
  if(err){
    return <span className="logo-fallback" style={{fontSize: Math.round(height*0.65)}}>resonate</span>;
  }
  return (
    <img src="assets/ResonateLogo.svg" alt="Resonate"
      style={{ height }}
      onError={()=>setErr(true)} />
  );
}

// ── Layouts ──
function PanelTwoLevel({ ms, ran, setRan, busy, run }){
  const [tab, setTab] = useState('sources');
  if(!ms) return null;
  const tabs = [
    ['sources','Sources', ms.wtgs.length + ms.bess.length],
    ['area','Area', null],
    ['recv','Receivers', ms.receivers.length],
    ['import','Import', null],
    ['results','Results', ran ? '●' : null],
    ['layers','Layers', null],
  ];
  return (
    <>
      <div className="side-tabs">
        {tabs.map(([k,lbl,n])=>(
          <button key={k} className={tab===k?'active':''} onClick={()=>setTab(k)}>
            {lbl}{n!=null && <span className="badge">{n}</span>}
          </button>
        ))}
      </div>
      <div className="side-scroll">
        {tab==='sources' && (<>
          <Section title="Wind turbines" count={ms.wtgs.length} step="1" hasContent={ms.wtgs.length>0}>
            <WTGForm onAdd={ms.addWTG}/>
            <hr className="dim"/>
            <WTGList items={ms.wtgs} selected={ms.selected} onSelect={ms.setSelected}
              onRemove={(id)=>ms.setWtgs(ms.wtgs.filter(w=>w.id!==id))}/>
          </Section>
          <Section title="BESS" count={ms.bess.length} step="2" hasContent={ms.bess.length>0} defaultOpen={false}>
            <BESSForm onAdd={ms.addBESS}/>
            <hr className="dim"/>
            <BESSList items={ms.bess} selected={ms.selected} onSelect={ms.setSelected}
              onRemove={(id)=>ms.setBess(ms.bess.filter(b=>b.id!==id))}/>
          </Section>
        </>)}
        {tab==='area' && (
          <Section title="Calculation area" hasContent>
            <CalcAreaPanel area={ms.area} setArea={ms.setArea}
              drawingMode={ms.drawingMode} setDrawingMode={ms.setDrawingMode}/>
          </Section>
        )}
        {tab==='recv' && (
          <Section title="Receivers" count={ms.receivers.length} hasContent={ms.receivers.length>0}>
            <ReceiverForm onAdd={ms.addReceiver} defaultLimit={ms.defaultLimit} setDefaultLimit={ms.setDefaultLimit}/>
            <hr className="dim"/>
            <ReceiverList items={ms.receivers} onRemove={(id)=>ms.setReceivers(ms.receivers.filter(r=>r.id!==id))}/>
          </Section>
        )}
        {tab==='import' && <Section title="Import data"><ImportPanel/></Section>}
        {tab==='results' && (
          <Section title="Run / Results" hasContent={ran}>
            <ResultsPanel palette={ms.palette} setPalette={ms.setPalette}
              transparency={ms.transparency} setTransparency={ms.setTransparency}
              showContours={ms.showContours} setShowContours={ms.setShowContours}
              bandsOn={ms.bandsOn} setBandsOn={ms.setBandsOn}
              ran={ran} run={run} busy={busy} ms={ms}/>
          </Section>
        )}
        {tab==='layers' && (
          <Section title="Map layers" hasContent>
            <LayersPanel/>
          </Section>
        )}
      </div>
    </>
  );
}

function PanelAccordion({ ms, ran, setRan, busy, run }){
  if(!ms) return null;
  return (
    <div className="side-scroll">
      <Section title="Sources" count={ms.wtgs.length+ms.bess.length} step="1" hasContent={ms.wtgs.length+ms.bess.length>0}>
        <Section title="Wind turbines" count={ms.wtgs.length}>
          <WTGForm onAdd={ms.addWTG}/>
          <hr className="dim"/>
          <WTGList items={ms.wtgs} selected={ms.selected} onSelect={ms.setSelected}
            onRemove={(id)=>ms.setWtgs(ms.wtgs.filter(w=>w.id!==id))}/>
        </Section>
        <Section title="BESS" count={ms.bess.length} defaultOpen={false}>
          <BESSForm onAdd={ms.addBESS}/>
          <hr className="dim"/>
          <BESSList items={ms.bess} selected={ms.selected} onSelect={ms.setSelected}
            onRemove={(id)=>ms.setBess(ms.bess.filter(b=>b.id!==id))}/>
        </Section>
      </Section>
      <Section title="Calculation area" step="2" hasContent defaultOpen={false}>
        <CalcAreaPanel area={ms.area} setArea={ms.setArea} drawingMode={ms.drawingMode} setDrawingMode={ms.setDrawingMode}/>
      </Section>
      <Section title="Receivers" count={ms.receivers.length} step="3" hasContent={ms.receivers.length>0} defaultOpen={false}>
        <ReceiverForm onAdd={ms.addReceiver} defaultLimit={ms.defaultLimit} setDefaultLimit={ms.setDefaultLimit}/>
        <hr className="dim"/>
        <ReceiverList items={ms.receivers} onRemove={(id)=>ms.setReceivers(ms.receivers.filter(r=>r.id!==id))}/>
      </Section>
      <Section title="Import" step="4" defaultOpen={false}><ImportPanel/></Section>
      <Section title="Run / Results" step="5" hasContent={ran}>
        <ResultsPanel palette={ms.palette} setPalette={ms.setPalette}
          transparency={ms.transparency} setTransparency={ms.setTransparency}
          showContours={ms.showContours} setShowContours={ms.setShowContours}
          bandsOn={ms.bandsOn} setBandsOn={ms.setBandsOn}
          ran={ran} run={run} busy={busy} ms={ms}/>
      </Section>
    </div>
  );
}

function PanelTabs({ ms, ran, setRan, busy, run }){
  const [tab, setTab] = useState('setup');
  if(!ms) return null;
  return (
    <>
      <div className="side-tabs">
        <button className={tab==='setup'?'active':''} onClick={()=>setTab('setup')}>Setup</button>
        <button className={tab==='results'?'active':''} onClick={()=>setTab('results')}>
          Results{ran && <span className="badge">●</span>}
        </button>
        <button className={tab==='layers'?'active':''} onClick={()=>setTab('layers')}>Layers</button>
      </div>
      <div className="side-scroll">
        {tab==='setup' && (<>
          <Section title="Wind turbines" count={ms.wtgs.length} hasContent={ms.wtgs.length>0}>
            <WTGForm onAdd={ms.addWTG}/>
            <hr className="dim"/>
            <WTGList items={ms.wtgs} selected={ms.selected} onSelect={ms.setSelected}
              onRemove={(id)=>ms.setWtgs(ms.wtgs.filter(w=>w.id!==id))}/>
          </Section>
          <Section title="BESS" count={ms.bess.length} hasContent={ms.bess.length>0} defaultOpen={false}>
            <BESSForm onAdd={ms.addBESS}/>
            <hr className="dim"/>
            <BESSList items={ms.bess} selected={ms.selected} onSelect={ms.setSelected}
              onRemove={(id)=>ms.setBess(ms.bess.filter(b=>b.id!==id))}/>
          </Section>
          <Section title="Calc area" hasContent defaultOpen={false}>
            <CalcAreaPanel area={ms.area} setArea={ms.setArea} drawingMode={ms.drawingMode} setDrawingMode={ms.setDrawingMode}/>
          </Section>
          <Section title="Receivers" count={ms.receivers.length} hasContent={ms.receivers.length>0} defaultOpen={false}>
            <ReceiverForm onAdd={ms.addReceiver} defaultLimit={ms.defaultLimit} setDefaultLimit={ms.setDefaultLimit}/>
            <hr className="dim"/>
            <ReceiverList items={ms.receivers} onRemove={(id)=>ms.setReceivers(ms.receivers.filter(r=>r.id!==id))}/>
          </Section>
          <Section title="Import" defaultOpen={false}><ImportPanel/></Section>
        </>)}
        {tab==='results' && (
          <Section title="Run / Results" hasContent={ran}>
            <ResultsPanel palette={ms.palette} setPalette={ms.setPalette}
              transparency={ms.transparency} setTransparency={ms.setTransparency}
              showContours={ms.showContours} setShowContours={ms.setShowContours}
              bandsOn={ms.bandsOn} setBandsOn={ms.setBandsOn}
              ran={ran} run={run} busy={busy} ms={ms}/>
          </Section>
        )}
        {tab==='layers' && <Section title="Map layers" hasContent><LayersPanel/></Section>}
      </div>
    </>
  );
}

function App(){
  const [tweaks, setTweak] = useTweaks(window.TWEAK_DEFAULTS);
  const ms = useMapState();
  const [view3D, setView3D] = useState(false);
  const [ran, setRan] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(()=>{
    if(!toast) return;
    const t = setTimeout(()=>setToast(null), 2400);
    return ()=>clearTimeout(t);
  },[toast]);

  const layout = tweaks.panelLayout;
  const Panel = layout==='accordion' ? PanelAccordion
              : layout==='tabs'      ? PanelTabs
              :                        PanelTwoLevel;
  const run = ms ? ms.run : ()=>setRan(true);

  return (
    <>
      <header className="app">
        <div className="h-left">
          <span className="logo-wrap"><ResonateLogo height={24}/></span>
          <div className="h-pipe"></div>
          <div className="h-product">
            <div className="pname">Noise Modeller</div>
            <div className="proj">
              <b>Mt Brown Wind Farm</b><span className="sep">/</span>
              <span>Scenario A · 110 dB PO</span>
            </div>
          </div>
        </div>
        <nav>
          <button className="active">Map</button>
          <button>Calculation</button>
          <button>Reports</button>
          <button>Settings</button>
        </nav>
        <div className="h-right">
          <div className="save-state"><span className="dot"></span>Saved · 14:22</div>
          <button className="ic-btn" title="Share">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11 5l-3-3-3 3M8 2v9M3 11v2a1 1 0 001 1h8a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button className="ic-btn" title="Help">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4"/><path d="M6.5 6.2c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5c0 .9-1.5 1.1-1.5 2.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><circle cx="8" cy="11.2" r=".7" fill="currentColor"/></svg>
          </button>
          <div className="avatar">RC</div>
        </div>
      </header>

      <div className="app-body">
        <aside className="side">
          <div className="side-head">
            <div className="grow">
              <h2>Mt Brown WF <span className="caret">▾</span></h2>
              <div className="meta"><span className="live"></span>Scenario A · last calc 14:22</div>
            </div>
            <button className="ic-btn" title="Project menu">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>
            </button>
          </div>
          <Panel ms={ms} ran={ran} setRan={setRan} busy={busy} run={()=>{
            if(ms){ ms.run ? ms.run() : run(); }
          }}/>
        </aside>

        <main style={{position:'relative',overflow:'hidden'}}>
          <MapView
            tweaks={tweaks}
            view3D={view3D} setView3D={setView3D}
            ran={ran} busy={busy} setBusy={setBusy} setRan={setRan}
            toast={toast} setToast={setToast}
          />
        </main>
      </div>

      {toast && (
        <div className="toast"><span className="ddot"></span>{toast}</div>
      )}

      <TweaksPanel>
        <TweakSection label="Side panel"/>
        <TweakSelect label="Layout"
          value={tweaks.panelLayout}
          options={[
            {value:'accordion', label:'A · Single accordion'},
            {value:'tabs',      label:'B · Setup / Results / Layers'},
            {value:'twolevel',  label:'C · Two-level tabs (default)'},
          ]}
          onChange={v=>setTweak('panelLayout', v)}/>

        <TweakSection label="Map"/>
        <TweakRadio label="Base map" value={tweaks.mapStyle}
          options={['satellite','light','dark','osm']}
          onChange={v=>setTweak('mapStyle', v)}/>
        <TweakSelect label="Contour palette" value={tweaks.contourPalette}
          options={Object.keys(PALETTES).map(p=>({value:p,label:p[0].toUpperCase()+p.slice(1)}))}
          onChange={v=>setTweak('contourPalette', v)}/>

        <TweakSection label="Symbols"/>
        <TweakRadio label="Receiver style" value={tweaks.receiverStyle}
          options={[
            {value:'dot',    label:'Dot + dB'},
            {value:'square', label:'Square'},
            {value:'pill',   label:'Pill'},
          ]}
          onChange={v=>setTweak('receiverStyle', v)}/>
        <TweakSelect label="BESS symbol" value={tweaks.bessStyle}
          options={[
            {value:'container', label:'Container w/ fin'},
            {value:'arrow',     label:'Box + arrow'},
            {value:'flag',      label:'Outline + flag'},
            {value:'antenna',   label:'Antenna marker'},
          ]}
          onChange={v=>setTweak('bessStyle', v)}/>
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
