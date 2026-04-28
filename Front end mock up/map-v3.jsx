// Map v2 — draggable markers, satellite default, viridis default, mid-fi controls.

const TILE_PROVIDERS = {
  satellite: { url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr:'Imagery © Esri' },
  light:     { url:'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', attr:'© OpenStreetMap · © CARTO' },
  dark:      { url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',  attr:'© OpenStreetMap · © CARTO' },
  osm:       { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',             attr:'© OpenStreetMap' },
};

function calcAreaCorners(area){
  const { centerLat, centerLng, widthKm, heightKm, rotationDeg } = area;
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.320 * Math.cos(centerLat*Math.PI/180);
  const dx = widthKm/2, dy = heightKm/2;
  const rad = rotationDeg*Math.PI/180;
  const pts = [[-dx,-dy],[dx,-dy],[dx,dy],[-dx,dy]];
  return pts.map(([x,y])=>{
    const xr = x*Math.cos(rad) - y*Math.sin(rad);
    const yr = x*Math.sin(rad) + y*Math.cos(rad);
    return [centerLat + yr/kmPerDegLat, centerLng + xr/kmPerDegLng];
  });
}

function noiseAt(lat, lng, wtgs, bess){
  let sumP = 0;
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.320 * Math.cos(lat*Math.PI/180);
  const addSrc = (slat,slng,lwa) => {
    const dx = (lng-slng)*kmPerDegLng*1000;
    const dy = (lat-slat)*kmPerDegLat*1000;
    const r = Math.max(50, Math.sqrt(dx*dx+dy*dy));
    const lp = lwa - 20*Math.log10(r) - 11 - 0.005*r;
    sumP += Math.pow(10, lp/10);
  };
  for(const w of wtgs){
    const m = WTG_MODELS.find(x=>x.id===w.modelId);
    addSrc(w.lat, w.lng, m.lwa[w.mode] ?? 105);
  }
  for(const b of bess){
    const m = BESS_MODELS.find(x=>x.id===b.modelId);
    const perUnit = m.lwa[b.mode] ?? 90;
    const total = perUnit + 10*Math.log10(b.count||1);
    addSrc(b.lat, b.lng, total);
  }
  return sumP>0 ? 10*Math.log10(sumP) : 0;
}

function MapView({ tweaks, view3D, setView3D, ran, busy, setBusy, setRan, toast, setToast }){
  const mapRef = React.useRef(null);
  const containerRef = React.useRef(null);
  const layersRef = React.useRef({});
  const markersRef = React.useRef({ wtgs:{}, bess:{}, recv:{}, areaHandles:[] });
  const [bearing, setBearing] = React.useState(0);

  const [wtgs, setWtgs] = React.useState(INITIAL_WTGS);
  const [bess, setBess] = React.useState(INITIAL_BESS);
  const [area, setArea] = React.useState(INITIAL_CALC_AREA);
  const [drawingMode, setDrawingMode] = React.useState('3pt');
  const [defaultLimit, setDefaultLimit] = React.useState(40);
  const [receivers, setReceivers] = React.useState(INITIAL_RECEIVERS);
  const [selected, setSelected] = React.useState(null);

  const [showContours, setShowContours] = React.useState(true);
  const [transparency, setTransparency] = React.useState(35);
  const [bandsOn, setBandsOn] = React.useState([true,true,true,true,true]);
  const [palette, setPalette] = React.useState(tweaks.contourPalette);
  React.useEffect(()=>{ setPalette(tweaks.contourPalette); }, [tweaks.contourPalette]);

  // ── init map ──
  React.useEffect(()=>{
    const map = L.map(containerRef.current, {
      center:[-33.595, 138.74], zoom:13, zoomControl:false, attributionControl:true,
    });
    mapRef.current = map;
    const tile = TILE_PROVIDERS[tweaks.mapStyle] || TILE_PROVIDERS.satellite;
    layersRef.current.tile = L.tileLayer(tile.url, { attribution:tile.attr, maxZoom:19, subdomains:'abcd' }).addTo(map);
    layersRef.current.contours = L.layerGroup().addTo(map);
    layersRef.current.calcArea = L.layerGroup().addTo(map);
    layersRef.current.wtgs = L.layerGroup().addTo(map);
    layersRef.current.bess = L.layerGroup().addTo(map);
    layersRef.current.recv = L.layerGroup().addTo(map);
    return ()=>{ map.remove(); };
  },[]);

  // ── tile swap ──
  React.useEffect(()=>{
    const map = mapRef.current; if(!map) return;
    if(layersRef.current.tile) map.removeLayer(layersRef.current.tile);
    const tile = TILE_PROVIDERS[tweaks.mapStyle] || TILE_PROVIDERS.satellite;
    layersRef.current.tile = L.tileLayer(tile.url, { attribution:tile.attr, maxZoom:19, subdomains:'abcd' }).addTo(map);
  },[tweaks.mapStyle]);

  // ── render WTGs (draggable) ──
  React.useEffect(()=>{
    const g = layersRef.current.wtgs; if(!g) return; g.clearLayers();
    markersRef.current.wtgs = {};
    wtgs.forEach(w=>{
      const m = L.marker([w.lat,w.lng], {
        icon: makeWTGIcon({ id:w.id, selected:selected===w.id }),
        draggable: true,
      });
      const meta = WTG_MODELS.find(x=>x.id===w.modelId);
      m.bindTooltip(`<b>${w.id}</b><br>${meta.name}<br>${w.hub}m · ${w.mode} · ${w.windSpeed} m/s · LwA ${meta.lwa[w.mode]} dB`, {direction:'top'});
      m.on('click', ()=>setSelected(w.id));
      m.on('dragstart', ()=>setSelected(w.id));
      m.on('dragend', (e)=>{
        const ll = e.target.getLatLng();
        setWtgs(curr => curr.map(x=> x.id===w.id ? {...x, lat:ll.lat, lng:ll.lng } : x));
        setToast(`Moved ${w.id} → ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)} · recalculating…`);
      });
      g.addLayer(m);
      markersRef.current.wtgs[w.id] = m;
    });
  },[wtgs, selected]);

  // ── render BESS (draggable + Alt-rotate) ──
  React.useEffect(()=>{
    const g = layersRef.current.bess; if(!g) return; g.clearLayers();
    markersRef.current.bess = {};
    bess.forEach(b=>{
      const m = L.marker([b.lat,b.lng], {
        icon: makeBESSIcon({ id:b.id, heading:b.heading, style: tweaks.bessStyle, selected:selected===b.id }),
        draggable: true,
      });
      const meta = BESS_MODELS.find(x=>x.id===b.modelId);
      m.bindTooltip(`<b>${b.id}</b><br>${meta.name}<br>${b.count}× · ${b.mode} · heading ${b.heading}°`, {direction:'top'});
      m.on('click', ()=>setSelected(b.id));
      m.on('dragstart', (ev)=>{
        setSelected(b.id);
        // Alt-drag rotates instead of moving
        if(ev.originalEvent && ev.originalEvent.altKey){
          m._altRotate = true;
          m.dragging.disable();
        }
      });
      m.on('dragend', (e)=>{
        const ll = e.target.getLatLng();
        setBess(curr => curr.map(x=> x.id===b.id ? {...x, lat:ll.lat, lng:ll.lng } : x));
        setToast(`Moved ${b.id} → ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)} · recalculating…`);
      });
      g.addLayer(m);
      markersRef.current.bess[b.id] = m;
    });
  },[bess, selected, tweaks.bessStyle]);

  // ── render receivers (draggable) ──
  React.useEffect(()=>{
    const g = layersRef.current.recv; if(!g) return; g.clearLayers();
    markersRef.current.recv = {};
    receivers.forEach(r=>{
      const m = L.marker([r.lat,r.lng], {
        icon: makeReceiverIcon({ style: tweaks.receiverStyle, level:r.level, limit:r.limit, name:r.name, id:r.id }),
        draggable: true,
      });
      m.bindTooltip(`<b>${r.name}</b> (${r.id})<br>${r.level.toFixed(1)} dB / limit ${r.limit} dB`, {direction:'top'});
      m.on('dragend', (e)=>{
        const ll = e.target.getLatLng();
        setReceivers(curr => curr.map(x=> x.id===r.id ? {...x, lat:ll.lat, lng:ll.lng } : x));
        setToast(`Moved ${r.id} → ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)} · recalculating…`);
      });
      g.addLayer(m);
      markersRef.current.recv[r.id] = m;
    });
  },[receivers, tweaks.receiverStyle]);

  // ── calc area + draggable corner handles ──
  React.useEffect(()=>{
    const g = layersRef.current.calcArea; if(!g) return; g.clearLayers();
    const corners = calcAreaCorners(area);
    L.polygon(corners, { color:'#2A2A2A', weight:2, dashArray:'8 6',
      fillColor:'#F2CB00', fillOpacity:0.05 }).addTo(g);
    // edge midpoints + corners as draggable handles
    corners.forEach((c,i)=>{
      const handle = L.marker(c, {
        icon: L.divIcon({ html:'<div class="area-handle"></div>', className:'', iconSize:[0,0], iconAnchor:[0,0] }),
        draggable:true,
      });
      handle.on('drag', (e)=>{
        const ll = e.target.getLatLng();
        // recompute center/size from this corner moving (treat as resize from center)
        const opp = corners[(i+2)%4];
        const newCenterLat = (ll.lat + opp[0])/2;
        const newCenterLng = (ll.lng + opp[1])/2;
        const kmPerDegLat = 110.574;
        const kmPerDegLng = 111.320 * Math.cos(newCenterLat*Math.PI/180);
        const dxKm = (ll.lng - newCenterLng)*kmPerDegLng;
        const dyKm = (ll.lat - newCenterLat)*kmPerDegLat;
        // project onto rotated axes
        const rad = -area.rotationDeg*Math.PI/180;
        const lx = dxKm*Math.cos(rad) - dyKm*Math.sin(rad);
        const ly = dxKm*Math.sin(rad) + dyKm*Math.cos(rad);
        setArea(a => ({...a,
          centerLat:newCenterLat, centerLng:newCenterLng,
          widthKm: Math.max(0.5, Math.abs(lx)*2),
          heightKm: Math.max(0.5, Math.abs(ly)*2),
        }));
      });
      g.addLayer(handle);
    });
    // rotation handle: midpoint of top edge, offset out
    const top = [(corners[0][0]+corners[1][0])/2, (corners[0][1]+corners[1][1])/2];
    const rot = L.marker(top, {
      icon: L.divIcon({ html:'<div class="area-handle rot" title="rotate"></div>', className:'', iconSize:[0,0], iconAnchor:[0,0] }),
      draggable:true,
    });
    rot.on('drag', (e)=>{
      const ll = e.target.getLatLng();
      const ang = Math.atan2(ll.lng-area.centerLng, ll.lat-area.centerLat) * 180/Math.PI;
      setArea(a => ({...a, rotationDeg: -ang}));
    });
    g.addLayer(rot);
    L.polyline([[area.centerLat, area.centerLng], top], { color:'#F2CB00', weight:1.5, dashArray:'2 3' }).addTo(g);
  },[area]);

  // ── render contours ──
  React.useEffect(()=>{
    const g = layersRef.current.contours; if(!g) return; g.clearLayers();
    if(!showContours || !ran) return;
    const corners = calcAreaCorners(area);
    const lats = corners.map(c=>c[0]), lngs = corners.map(c=>c[1]);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const N = 38;
    const dLat = (maxLat-minLat)/N, dLng = (maxLng-minLng)/N;
    const pal = PALETTES[palette];
    const op = 1 - transparency/100;
    const inPoly = (lat,lng) => {
      let inside=false;
      for(let i=0,j=corners.length-1;i<corners.length;j=i++){
        const yi=corners[i][0], xi=corners[i][1];
        const yj=corners[j][0], xj=corners[j][1];
        const intersect = ((yi>lat)!==(yj>lat)) && (lng < (xj-xi)*(lat-yi)/(yj-yi)+xi);
        if(intersect) inside=!inside;
      }
      return inside;
    };
    for(let i=0;i<N;i++){
      for(let j=0;j<N;j++){
        const lat = minLat + (i+0.5)*dLat;
        const lng = minLng + (j+0.5)*dLng;
        if(!inPoly(lat,lng)) continue;
        const v = noiseAt(lat,lng,wtgs,bess);
        let bandIdx = -1;
        for(let k=0;k<CONTOUR_BANDS.length;k++){
          const b=CONTOUR_BANDS[k];
          if(v>=b.lo && v<b.hi){ bandIdx=k; break; }
        }
        if(bandIdx<0) continue;
        if(!bandsOn[bandIdx]) continue;
        L.rectangle([[lat-dLat/2,lng-dLng/2],[lat+dLat/2,lng+dLng/2]], {
          stroke:false, fillColor: pal[bandIdx], fillOpacity: op,
        }).addTo(g);
      }
    }
  },[showContours, ran, palette, transparency, bandsOn, area, wtgs, bess]);

  // recompute receiver levels when sources move (live feedback)
  React.useEffect(()=>{
    if(!ran) return;
    setReceivers(rs => rs.map(r => ({ ...r, level: +noiseAt(r.lat, r.lng, wtgs, bess).toFixed(1) })));
  },[ran, wtgs, bess]);

  const zoom = (d) => mapRef.current && mapRef.current.setZoom(mapRef.current.getZoom()+d);
  const home = () => mapRef.current && mapRef.current.setView([-33.595,138.74],13);

  React.useEffect(()=>{
    const map = mapRef.current; if(!map) return;
    const pane = map.getPane('mapPane');
    if(pane){
      pane.style.transform = `${pane.style.transform.replace(/rotate\([^)]*\)/,'')} rotate(${bearing}deg)`;
      pane.style.transformOrigin = '50% 50%';
    }
  },[bearing]);

  const addWTG = (cfg) => {
    const id = `WTG-${String(wtgs.length+1).padStart(2,'0')}`;
    setWtgs([...wtgs, { id, lat:-33.59+(Math.random()-.5)*.02, lng:138.74+(Math.random()-.5)*.03, ...cfg, windSpeed:cfg.ws }]);
    setToast(`Added ${id}. Drag on map to position.`);
  };
  const addBESS = (cfg) => {
    const id = `BESS-${String.fromCharCode(65+bess.length)}`;
    setBess([...bess, { id, lat:-33.59+(Math.random()-.5)*.02, lng:138.74+(Math.random()-.5)*.03, ...cfg }]);
    setToast(`Added ${id}.`);
  };
  const addReceiver = () => {
    const id = `R${String(receivers.length+1).padStart(2,'0')}`;
    setReceivers([...receivers, { id, name:`New receiver ${receivers.length+1}`,
      lat:-33.595+(Math.random()-.5)*.04, lng:138.74+(Math.random()-.5)*.05,
      level:35+Math.random()*10, limit:defaultLimit }]);
    setToast(`Added ${id}.`);
  };
  const run = () => {
    setBusy(true);
    setTimeout(()=>{ setBusy(false); setRan(true); setToast('Calculation complete · 0:42'); }, 600);
  };

  return (
    <div className="map-wrap">
      <div ref={containerRef} id="map"></div>

      <div id="threed-overlay" className={view3D?'on':''}>
        <svg viewBox="0 0 1000 600" preserveAspectRatio="none">
          {Array.from({length:18}).map((_,i)=>(
            <path key={i}
              d={`M 0 ${80+i*32} Q 250 ${50+i*32 + Math.sin(i*0.7)*22} 500 ${110+i*32 + Math.cos(i)*15} T 1000 ${85+i*32}`}
              fill="none" stroke={`rgba(242,203,0,${0.10+i*0.025})`} strokeWidth="1.4"/>
          ))}
        </svg>
        <div className="stamp">3D Terrain · Contoured</div>
      </div>

      <div className="map-status">
        <div className="glass pill">
          <span className="ind"></span><b>Mt Brown WF</b><span className="muted">· demo project</span>
        </div>
        <div className="glass stat-cluster">
          <div className="stat"><span className="v num">{wtgs.length}</span><span className="l">WTGs</span></div>
          <div className="stat"><span className="v num">{bess.length}</span><span className="l">BESS</span></div>
          <div className="stat"><span className="v num">{receivers.length}</span><span className="l">Receivers</span></div>
        </div>
        <div className="glass pill">
          <span className={'ind'+(ran?'':' warn')}></span>
          <b>{ran?'Calculated':'Not calculated'}</b>
          {ran && <span className="muted num">· 0:42</span>}
        </div>
      </div>

      <div className="map-controls">
        <div className="glass grp">
          <button title="Zoom in" onClick={()=>zoom(1)}>＋</button>
          <button title="Zoom out" onClick={()=>zoom(-1)}>−</button>
        </div>
        <div className="glass grp">
          <button title="Home" onClick={home}>⌂</button>
          <button title="Fit calc area" onClick={()=>{
            const c = calcAreaCorners(area);
            mapRef.current.fitBounds(c, { padding:[40,40] });
          }}>⊡</button>
        </div>
        <div className="glass grp">
          <button className={view3D?'':'active'} onClick={()=>setView3D(false)} title="2D satellite">2D</button>
          <button className={view3D?'active':''} onClick={()=>setView3D(true)} title="3D terrain">3D</button>
        </div>
        <div className="glass compass" title="Bearing">
          <div className="needle" style={{transform:`translate(-50%,-50%) rotate(${-bearing}deg)`}}>
            <div className="n"></div><div className="s"></div>
          </div>
          <div className="lbl n">N</div><div className="lbl e">E</div>
          <div className="lbl s">S</div><div className="lbl w">W</div>
        </div>
        <div className="glass grp row-grp">
          <button title="Rotate left" onClick={()=>setBearing(b=>b-15)}>↺</button>
          <button title="Reset" onClick={()=>setBearing(0)}>○</button>
          <button title="Rotate right" onClick={()=>setBearing(b=>b+15)}>↻</button>
        </div>
      </div>

      <div className="bottom-tools">
        <div className="glass grp">
          <button title="Pan" className="active"><span className="icon">✥</span> Pan</button>
          <button title="Place WTG"><span className="icon">⌬</span> WTG</button>
          <button title="Place BESS"><span className="icon">▭</span> BESS</button>
          <button title="Place receiver"><span className="icon">◉</span> Recv</button>
          <button title="Draw calc area"><span className="icon">⛶</span> Area</button>
          <button title="Measure"><span className="icon">↔</span> Measure</button>
        </div>
      </div>

      <div className="glass legend">
        <div className="ttl"><span>Noise contours</span><span className="unit">L<sub>Aeq</sub> dB(A)</span></div>
        <div className="gradient-strip">
          {CONTOUR_BANDS.map((b,i)=>(
            <div key={i} style={{background: bandsOn[i]?PALETTES[palette][i]:'transparent'}}></div>
          ))}
        </div>
        <div className="scale-axis">
          <span>30</span><span>35</span><span>40</span><span>45</span><span>50</span><span>55+</span>
        </div>
        <hr/>
        <div className="recv-row">
          <span className="recv-mini" style={{background:'#1F8E4A'}}></span>
          <span>Receiver · within limit</span>
        </div>
        <div className="recv-row">
          <span className="recv-mini" style={{background:'#C8362B'}}></span>
          <span>Receiver · exceeds limit</span>
        </div>
      </div>

      {ran && (
        <div className="glass results-dock">
          <div className="rd-hd">
            <span className="ttl">Results · live</span>
            <span className="chip ok"><span className="ddot"></span>fresh</span>
          </div>
          {(()=>{
            const fails = receivers.filter(r=>r.level>r.limit);
            const maxR = receivers.reduce((m,r)=> r.level>m.level?r:m, receivers[0]||{level:0,name:'—'});
            return <>
              <div className="rd-row">
                <span className="lbl">Receivers exceeding</span>
                <span className={'v '+(fails.length?'fail':'ok')}>{fails.length}<span style={{color:'var(--mid)',fontWeight:400}}> / {receivers.length}</span></span>
              </div>
              <div className="rd-row">
                <span className="lbl">Max level @ {maxR.name}</span>
                <span className={'v '+(maxR.level>maxR.limit?'fail':'ok')}>{maxR.level?.toFixed(1)} dB</span>
              </div>
              <div className="rd-bar">
                {receivers.map((r,i)=> (
                  <div key={i} style={{flex:1,background:r.level>r.limit?'#C8362B':'#1F8E4A',marginRight:i===receivers.length-1?0:1}}></div>
                ))}
              </div>
            </>;
          })()}
        </div>
      )}

      <MapState
        wtgs={wtgs} bess={bess} receivers={receivers} area={area}
        addWTG={addWTG} addBESS={addBESS} addReceiver={addReceiver}
        setWtgs={setWtgs} setBess={setBess} setReceivers={setReceivers}
        setArea={setArea}
        drawingMode={drawingMode} setDrawingMode={setDrawingMode}
        defaultLimit={defaultLimit} setDefaultLimit={setDefaultLimit}
        selected={selected} setSelected={setSelected}
        showContours={showContours} setShowContours={setShowContours}
        transparency={transparency} setTransparency={setTransparency}
        bandsOn={bandsOn} setBandsOn={setBandsOn}
        palette={palette} setPalette={setPalette}
        run={run}
      />
    </div>
  );
}

function MapState(props){
  const sig = JSON.stringify({
    wtgs: props.wtgs, bess: props.bess, receivers: props.receivers, area: props.area,
    drawingMode: props.drawingMode, defaultLimit: props.defaultLimit,
    selected: props.selected, showContours: props.showContours,
    transparency: props.transparency, bandsOn: props.bandsOn, palette: props.palette,
  });
  React.useEffect(()=>{
    window.__mapState = props;
    window.dispatchEvent(new Event('mapstate'));
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

Object.assign(window, { MapView, calcAreaCorners });
