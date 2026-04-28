// Top-level App: header, side panel layouts, map, tweaks.

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

// ── 3 panel layouts ─────────────────────────────────────
function PanelAccordion({ ms, ran, setRan }){
  if(!ms) return null;
  const counts = {
    src: ms.wtgs.length + ms.bess.length,
    wtg: ms.wtgs.length, bess: ms.bess.length, recv: ms.receivers.length,
  };
  return (
    <>
      <Section title="① Sources" count={counts.src}>
        <Section title="Wind turbines" count={counts.wtg} defaultOpen={true}>
          <WTGForm onAdd={ms.addWTG}/>
          <hr className="sk-hr"/>
          <WTGList items={ms.wtgs} selected={ms.selected} onSelect={ms.setSelected}
            onRemove={(id)=>ms.setWtgs(ms.wtgs.filter(w=>w.id!==id))}/>
        </Section>
        <Section title="BESS" count={counts.bess} defaultOpen={false}>
          <BESSForm onAdd={ms.addBESS}/>
          <hr className="sk-hr"/>
          <BESSList items={ms.bess} selected={ms.selected} onSelect={ms.setSelected}
            onRemove={(id)=>ms.setBess(ms.bess.filter(b=>b.id!==id))}/>
        </Section>
      </Section>
      <Section title="② Calculation area" defaultOpen={false}>
        <CalcAreaPanel area={ms.area} setArea={ms.setArea} drawingMode={ms.drawingMode} setDrawingMode={ms.setDrawingMode}/>
      </Section>
      <Section title="③ Receivers" count={counts.recv} defaultOpen={false}>
        <ReceiverForm onAdd={ms.addReceiver} defaultLimit={ms.defaultLimit} setDefaultLimit={ms.setDefaultLimit}/>
        <hr className="sk-hr"/>
        <ReceiverList items={ms.receivers} onRemove={(id)=>ms.setReceivers(ms.receivers.filter(r=>r.id!==id))}/>
      </Section>
      <Section title="④ Import" defaultOpen={false}>
        <ImportPanel/>
      </Section>
      <Section title="⑤ Run / Results" defaultOpen={true}>
        <ResultsPanel
          palette={ms.palette} setPalette={ms.setPalette}
          transparency={ms.transparency} setTransparency={ms.setTransparency}
          showContours={ms.showContours} setShowContours={ms.setShowContours}
          bandsOn={ms.bandsOn} setBandsOn={ms.setBandsOn}
          ran={ran} run={()=>setRan(true)}/>
      </Section>
    </>
  );
}

function PanelTabs({ ms, ran, setRan }){
  const [tab, setTab] = useState('setup');
  if(!ms) return null;
  return (
    <>
      <div className="side-tabs" style={{position:'sticky',top:0,zIndex:5}}>
        <button className={tab==='setup'?'active':''} onClick={()=>setTab('setup')}>Setup</button>
        <button className={tab==='results'?'active':''} onClick={()=>setTab('results')}>Results</button>
        <button className={tab==='layers'?'active':''} onClick={()=>setTab('layers')}>Layers</button>
      </div>
      <div style={{padding:'12px 0 0'}}>
        {tab==='setup' && (
          <>
            <Section title="Wind turbines" count={ms.wtgs.length}>
              <WTGForm onAdd={ms.addWTG}/>
              <hr className="sk-hr"/>
              <WTGList items={ms.wtgs} selected={ms.selected} onSelect={ms.setSelected}
                onRemove={(id)=>ms.setWtgs(ms.wtgs.filter(w=>w.id!==id))}/>
            </Section>
            <Section title="BESS" count={ms.bess.length} defaultOpen={false}>
              <BESSForm onAdd={ms.addBESS}/>
              <hr className="sk-hr"/>
              <BESSList items={ms.bess} selected={ms.selected} onSelect={ms.setSelected}
                onRemove={(id)=>ms.setBess(ms.bess.filter(b=>b.id!==id))}/>
            </Section>
            <Section title="Calc area" defaultOpen={false}>
              <CalcAreaPanel area={ms.area} setArea={ms.setArea} drawingMode={ms.drawingMode} setDrawingMode={ms.setDrawingMode}/>
            </Section>
            <Section title="Receivers" count={ms.receivers.length} defaultOpen={false}>
              <ReceiverForm onAdd={ms.addReceiver} defaultLimit={ms.defaultLimit} setDefaultLimit={ms.setDefaultLimit}/>
              <hr className="sk-hr"/>
              <ReceiverList items={ms.receivers} onRemove={(id)=>ms.setReceivers(ms.receivers.filter(r=>r.id!==id))}/>
            </Section>
            <Section title="Import" defaultOpen={false}><ImportPanel/></Section>
          </>
        )}
        {tab==='results' && (
          <ResultsPanel palette={ms.palette} setPalette={ms.setPalette}
            transparency={ms.transparency} setTransparency={ms.setTransparency}
            showContours={ms.showContours} setShowContours={ms.setShowContours}
            bandsOn={ms.bandsOn} setBandsOn={ms.setBandsOn}
            ran={ran} run={()=>setRan(true)}/>
        )}
        {tab==='layers' && (
          <Section title="Map layers">
            <div className="hint">Toggle each layer.</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {['Satellite imagery','Ground elevation contours','Calc area','WTGs','BESS','Receivers','Noise contours','Property boundaries','Roads / labels'].map(l=>(
                <label key={l} style={{display:'flex',alignItems:'center',gap:6,fontFamily:'var(--hand)'}}>
                  <input type="checkbox" defaultChecked/> {l}
                </label>
              ))}
            </div>
          </Section>
        )}
      </div>
    </>
  );
}

function PanelTwoLevel({ ms, ran, setRan }){
  const [tab, setTab] = useState('sources');
  if(!ms) return null;
  return (
    <>
      <div className="side-tabs" style={{position:'sticky',top:0,zIndex:5,flexWrap:'wrap'}}>
        {[
          ['sources','🌀 Sources'],
          ['area','▭ Area'],
          ['recv','📍 Receivers'],
          ['import','📁 Import'],
          ['results','📊 Results'],
        ].map(([k,lbl])=>(
          <button key={k} className={tab===k?'active':''} onClick={()=>setTab(k)}>{lbl}</button>
        ))}
      </div>
      <div style={{padding:'12px 0 0'}}>
        {tab==='sources' && (<>
          <Section title="Wind turbines" count={ms.wtgs.length}>
            <WTGForm onAdd={ms.addWTG}/>
            <hr className="sk-hr"/>
            <WTGList items={ms.wtgs} selected={ms.selected} onSelect={ms.setSelected}
              onRemove={(id)=>ms.setWtgs(ms.wtgs.filter(w=>w.id!==id))}/>
          </Section>
          <Section title="BESS" count={ms.bess.length}>
            <BESSForm onAdd={ms.addBESS}/>
            <hr className="sk-hr"/>
            <BESSList items={ms.bess} selected={ms.selected} onSelect={ms.setSelected}
              onRemove={(id)=>ms.setBess(ms.bess.filter(b=>b.id!==id))}/>
          </Section>
        </>)}
        {tab==='area' && <Section title="Calculation area"><CalcAreaPanel area={ms.area} setArea={ms.setArea} drawingMode={ms.drawingMode} setDrawingMode={ms.setDrawingMode}/></Section>}
        {tab==='recv' && (
          <Section title="Receivers" count={ms.receivers.length}>
            <ReceiverForm onAdd={ms.addReceiver} defaultLimit={ms.defaultLimit} setDefaultLimit={ms.setDefaultLimit}/>
            <hr className="sk-hr"/>
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
              ran={ran} run={()=>setRan(true)}/>
          </Section>
        )}
      </div>
    </>
  );
}

// ── App ─────────────────────────────────────────────────
function App(){
  const [tweaks, setTweak] = useTweaks(window.TWEAK_DEFAULTS);
  const ms = useMapState();
  const [view3D, setView3D] = useState(false);
  const [ran, setRan] = useState(true); // start with results visible

  const layout = tweaks.panelLayout;

  const Panel = layout==='accordion' ? PanelAccordion
              : layout==='tabs'      ? PanelTabs
              :                        PanelTwoLevel;

  return (
    <>
      <header className="app">
        <div className="left">
          {tweaks.logoPlacement==='header' && (
            <img className="logo" src="assets/ResonateLogo.svg" alt="Resonate" onError={(e)=>{e.target.style.display='none';}}/>
          )}
          <div className="pipe"></div>
          <h1>
            <span className="scribble-underline">WTG + BESS Noise Modeller</span>
            <small>Wireframe</small>
          </h1>
        </div>
        <nav>
          <button className="active">Project A</button>
          <button>Calculation</button>
          <button>Reports</button>
          <button>Settings</button>
        </nav>
        <div className="header-right">
          <span className="chip yel">⚙ wireframe build</span>
          <button className="ic-btn" title="Save">💾</button>
          <button className="ic-btn" title="Help">?</button>
          <div style={{width:30,height:30,borderRadius:'50%',background:'#2A2A2A',color:'#F2CB00',
            display:'flex',alignItems:'center',justifyContent:'center',
            fontFamily:'JetBrains Mono',fontSize:11,fontWeight:700}}>RC</div>
        </div>
      </header>

      <div className="wf-banner">LOW-FI WIREFRAME · structure & flow only</div>

      <div className={'app-body layout-'+layout}>
        <aside className="side">
          <div className="side-scroll">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div>
                <div style={{fontFamily:'var(--hand2)',fontSize:22,fontWeight:700,lineHeight:1}}>Mt Brown WF</div>
                <div className="mono tiny muted">Project · last saved 14:22</div>
              </div>
              <button className="btn tiny ghost">⌄</button>
            </div>
            <Panel ms={ms} ran={ran} setRan={setRan}/>
          </div>
          {tweaks.logoPlacement==='sidebar-bottom' && (
            <div style={{padding:'10px 14px',borderTop:'1.5px solid var(--ink)',background:'var(--paper)'}}>
              <img src="assets/ResonateLogo.svg" alt="Resonate" style={{height:22,opacity:.85}}
                onError={(e)=>{e.target.style.display='none';}}/>
            </div>
          )}
        </aside>

        <main style={{position:'relative',overflow:'hidden'}}>
          <MapView tweaks={tweaks} view3D={view3D} setView3D={setView3D} ran={ran}/>
        </main>
      </div>

      {tweaks.logoPlacement==='watermark' && (
        <img src="assets/ResonateLogo.svg" alt="Resonate"
          style={{position:'fixed',right:14,bottom:64,height:20,opacity:.55,zIndex:300,pointerEvents:'none'}}
          onError={(e)=>{e.target.style.display='none';}}/>
      )}

      <div className="stamp">wireframe</div>

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
            {value:'container', label:'Container w/ fin (recommended)'},
            {value:'arrow',     label:'Box + arrow'},
            {value:'flag',      label:'Outline + flag'},
            {value:'antenna',   label:'Antenna marker'},
          ]}
          onChange={v=>setTweak('bessStyle', v)}/>
        <TweakToggle label="Show WTG noise circles" value={tweaks.showNoiseCircles}
          onChange={v=>setTweak('showNoiseCircles', v)}/>

        <TweakSection label="Branding"/>
        <TweakRadio label="Logo placement" value={tweaks.logoPlacement}
          options={[
            {value:'header', label:'Header'},
            {value:'sidebar-bottom', label:'Sidebar foot'},
            {value:'watermark', label:'Watermark'},
            {value:'none',  label:'Hidden'},
          ]}
          onChange={v=>setTweak('logoPlacement', v)}/>
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
