// App v2 — Arial mid-fi shell. Header logo loaded inline (object) with text fallback.

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

// Logo loader: try img with onError fallback to text
function ResonateLogo({ height=28, mono=false }){
  const [err, setErr] = useState(false);
  if(err){
    return <span className="logo-fallback" style={{fontSize: Math.round(height*0.62)}}>resonate</span>;
  }
  return (
    <img className="header-logo-img" src="assets/ResonateLogo.svg" alt="Resonate"
      style={{ height, filter: mono?'brightness(0)':'none' }}
      onError={()=>setErr(true)} />
  );
}

// ── 3 layouts ──
function PanelTwoLevel({ ms, ran, setRan, busy, run }){
  const [tab, setTab] = useState('sources');
  if(!ms) return null;
  const tabs = [
    ['sources','Sources', ms.wtgs.length + ms.bess.length],
    ['area','Calc area', null],
    ['recv','Receivers', ms.receivers.length],
    ['import','Import', null],
    ['results','Results', null],
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
          <Section title="Wind turbines" count={ms.wtgs.length} nest>
            <WTGForm onAdd={ms.addWTG}/>
            <hr className="dim"/>
            <WTGList items={ms.wtgs} selected={ms.selected} onSelect={ms.setSelected}
              onRemove={(id)=>ms.setWtgs(ms.wtgs.filter(w=>w.id!==id))}/>
          </Section>
          <Section title="BESS" count={ms.bess.length} nest defaultOpen={false}>
            <BESSForm onAdd={ms.addBESS}/>
            <hr className="dim"/>
            <BESSList items={ms.bess} selected={ms.selected} onSelect={ms.setSelected}
              onRemove={(id)=>ms.setBess(ms.bess.filter(b=>b.id!==id))}/>
          </Section>
        </>)}
        {tab==='area' && (
          <Section title="Calculation area">
            <CalcAreaPanel area={ms.area} setArea={ms.setArea}
              drawingMode={ms.drawingMode} setDrawingMode={ms.setDrawingMode}/>
          </Section>
        )}
        {tab==='recv' && (
          <Section title="Receivers" count={ms.receivers.length}>
            <ReceiverForm onAdd={ms.addReceiver} defaultLimit={ms.defaultLimit} setDefaultLimit={ms.setDefaultLimit}/>
            <hr className="dim"/>
            <ReceiverList items={ms.receivers} onRemove={(id)=>ms.setReceivers(ms.receivers.filter(r=>r.id!==id))}/>
          </Section>
        )}
        {tab==='import' && <Section title="Import data"><ImportPanel/></Section>}
        {tab==='results' && (
          <Section title="Run / Results">
            <ResultsPanel palette={ms.palette} setPalette={ms.setPalette}
              transparency={ms.transparency} setTransparency={ms.setTransparency}
              showContours={ms.showContours} setShowContours={ms.setShowContours}
              bandsOn={ms.bandsOn} setBandsOn={ms.setBandsOn}
              ran={ran} run={run} busy={busy}/>
          </Section>
        )}
        {tab==='layers' && (
          <Section title="Map layers">
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
      <Section title="① Sources" count={ms.wtgs.length+ms.bess.length}>
        <Section title="Wind turbines" count={ms.wtgs.length} nest>
          <WTGForm onAdd={ms.addWTG}/>
          <hr className="dim"/>
          <WTGList items={ms.wtgs} selected={ms.selected} onSelect={ms.setSelected}
            onRemove={(id)=>ms.setWtgs(ms.wtgs.filter(w=>w.id!==id))}/>
        </Section>
        <Section title="BESS" count={ms.bess.length} nest defaultOpen={false}>
          <BESSForm onAdd={ms.addBESS}/>
          <hr className="dim"/>
          <BESSList items={ms.bess} selected={ms.selected} onSelect={ms.setSelected}
            onRemove={(id)=>ms.setBess(ms.bess.filter(b=>b.id!==id))}/>
        </Section>
      </Section>
      <Section title="② Calculation area" defaultOpen={false}>
        <CalcAreaPanel area={ms.area} setArea={ms.setArea} drawingMode={ms.drawingMode} setDrawingMode={ms.setDrawingMode}/>
      </Section>
      <Section title="③ Receivers" count={ms.receivers.length} defaultOpen={false}>
        <ReceiverForm onAdd={ms.addReceiver} defaultLimit={ms.defaultLimit} setDefaultLimit={ms.setDefaultLimit}/>
        <hr className="dim"/>
        <ReceiverList items={ms.receivers} onRemove={(id)=>ms.setReceivers(ms.receivers.filter(r=>r.id!==id))}/>
      </Section>
      <Section title="④ Import" defaultOpen={false}><ImportPanel/></Section>
      <Section title="⑤ Run / Results">
        <ResultsPanel palette={ms.palette} setPalette={ms.setPalette}
          transparency={ms.transparency} setTransparency={ms.setTransparency}
          showContours={ms.showContours} setShowContours={ms.setShowContours}
          bandsOn={ms.bandsOn} setBandsOn={ms.setBandsOn}
          ran={ran} run={run} busy={busy}/>
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
        <button className={tab==='results'?'active':''} onClick={()=>setTab('results')}>Results</button>
        <button className={tab==='layers'?'active':''} onClick={()=>setTab('layers')}>Layers</button>
      </div>
      <div className="side-scroll">
        {tab==='setup' && (<>
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
          <Section title="Calc area" defaultOpen={false}>
            <CalcAreaPanel area={ms.area} setArea={ms.setArea} drawingMode={ms.drawingMode} setDrawingMode={ms.setDrawingMode}/>
          </Section>
          <Section title="Receivers" count={ms.receivers.length} defaultOpen={false}>
            <ReceiverForm onAdd={ms.addReceiver} defaultLimit={ms.defaultLimit} setDefaultLimit={ms.setDefaultLimit}/>
            <hr className="dim"/>
            <ReceiverList items={ms.receivers} onRemove={(id)=>ms.setReceivers(ms.receivers.filter(r=>r.id!==id))}/>
          </Section>
          <Section title="Import" defaultOpen={false}><ImportPanel/></Section>
        </>)}
        {tab==='results' && (
          <Section title="Run / Results">
            <ResultsPanel palette={ms.palette} setPalette={ms.setPalette}
              transparency={ms.transparency} setTransparency={ms.setTransparency}
              showContours={ms.showContours} setShowContours={ms.setShowContours}
              bandsOn={ms.bandsOn} setBandsOn={ms.setBandsOn}
              ran={ran} run={run} busy={busy}/>
          </Section>
        )}
        {tab==='layers' && <Section title="Map layers"><LayersPanel/></Section>}
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
        <div className="left">
          <span className="logo-wrap"><ResonateLogo height={28}/></span>
          <div className="pipe"></div>
          <h1>WTG + BESS Noise Modeller</h1>
          <span className="chip yel" style={{marginLeft:6}}>Mt Brown WF · demo</span>
        </div>
        <nav>
          <button className="active">Map</button>
          <button>Calculation</button>
          <button>Reports</button>
          <button>Settings</button>
        </nav>
        <div className="header-right">
          <button className="ic-btn" title="Save">💾</button>
          <button className="ic-btn" title="Help">?</button>
          <div className="avatar">RC</div>
        </div>
      </header>

      <div className="app-body">
        <aside className="side">
          <div className="side-head">
            <div>
              <h2>Mt Brown Wind Farm</h2>
              <div className="meta">Project · last saved 14:22</div>
            </div>
            <button className="btn tiny ghost">⌄</button>
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
        <TweakSection label="Layout"/>
        <TweakSelect label="Side panel"
          value={tweaks.panelLayout}
          options={[
            {value:'accordion', label:'A · Single accordion'},
            {value:'tabs',      label:'B · Tabs (Setup / Results / Layers)'},
            {value:'twolevel',  label:'C · Two-level tabs + accordions'},
          ]}
          onChange={v=>setTweak('panelLayout', v)}/>

        <TweakSection label="Visuals"/>
        <TweakRadio label="Map base" value={tweaks.mapStyle}
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
