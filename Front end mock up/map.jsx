// Map component — Leaflet wiring + contours + receivers + sources

const TILE_PROVIDERS = {
  satellite: {
    url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr:'Imagery © Esri'
  },
  light: {
    url:'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attr:'© OpenStreetMap · © CARTO'
  },
  dark: {
    url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attr:'© OpenStreetMap · © CARTO'
  },
  osm: {
    url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attr:'© OpenStreetMap'
  },
};

// ─── Compute rotated rectangle corners from center / size / rotation ───
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

// ─── Synthetic noise field for contours: superposition of point-source rolloffs ───
function noiseAt(lat, lng, wtgs, bess){
  let sumP = 0;
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.320 * Math.cos(lat*Math.PI/180);
  const addSrc = (slat,slng,lwa) => {
    const dx = (lng-slng)*kmPerDegLng*1000;
    const dy = (lat-slat)*kmPerDegLat*1000;
    const r = Math.max(50, Math.sqrt(dx*dx+dy*dy));
    // Spherical spreading + 0.005 dB/m air absorption
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

function MapView({ tweaks, panel, setPanel, view3D, setView3D, ran }){
  const mapRef = React.useRef(null);
  const containerRef = React.useRef(null);
  const layersRef = React.useRef({});
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
      center:[-33.595, 138.74], zoom:13, zoomControl:false,
      attributionControl:true,
    });
    mapRef.current = map;
    const tile = TILE_PROVIDERS[tweaks.mapStyle] || TILE_PROVIDERS.satellite;
    layersRef.current.tile = L.tileLayer(tile.url, { attribution: tile.attr, maxZoom:19, subdomains:'abcd' }).addTo(map);
    layersRef.current.contours = L.layerGroup().addTo(map);
    layersRef.current.calcArea = L.layerGroup().addTo(map);
    layersRef.current.wtgs = L.layerGroup().addTo(map);
    layersRef.current.bess = L.layerGroup().addTo(map);
    layersRef.current.recv = L.layerGroup().addTo(map);
    return ()=>{ map.remove(); };
  },[]);

  // swap tile layer when style changes
  React.useEffect(()=>{
    const map = mapRef.current; if(!map) return;
    if(layersRef.current.tile) map.removeLayer(layersRef.current.tile);
    const tile = TILE_PROVIDERS[tweaks.mapStyle] || TILE_PROVIDERS.satellite;
    layersRef.current.tile = L.tileLayer(tile.url, { attribution:tile.attr, maxZoom:19, subdomains:'abcd' }).addTo(map);
  },[tweaks.mapStyle]);

  // ── render WTGs ──
  React.useEffect(()=>{
    const g = layersRef.current.wtgs; if(!g) return; g.clearLayers();
    wtgs.forEach(w=>{
      const m = L.marker([w.lat,w.lng], {
        icon: makeWTGIcon({ showCircle: tweaks.showNoiseCircles, radiusPx: 70 }),
      }).bindTooltip(`<b>${w.id}</b><br>${WTG_MODELS.find(x=>x.id===w.modelId).name}<br>${w.hub}m · ${w.mode} · ${w.windSpeed} m/s`, {direction:'top'});
      m.on('click', ()=>setSelected(w.id));
      g.addLayer(m);
    });
  },[wtgs, tweaks.showNoiseCircles]);

  // ── render BESS ──
  React.useEffect(()=>{
    const g = layersRef.current.bess; if(!g) return; g.clearLayers();
    bess.forEach(b=>{
      const m = L.marker([b.lat,b.lng], {
        icon: makeBESSIcon({ heading:b.heading, style: tweaks.bessStyle }),
      }).bindTooltip(`<b>${b.id}</b><br>${BESS_MODELS.find(x=>x.id===b.modelId).name}<br>${b.count}× · ${b.mode} · heading ${b.heading}°`, {direction:'top'});
      m.on('click', ()=>setSelected(b.id));
      g.addLayer(m);
    });
  },[bess, tweaks.bessStyle]);

  // ── render receivers ──
  React.useEffect(()=>{
    const g = layersRef.current.recv; if(!g) return; g.clearLayers();
    receivers.forEach(r=>{
      const m = L.marker([r.lat,r.lng], {
        icon: makeReceiverIcon({ style: tweaks.receiverStyle, level:r.level, limit:r.limit, name:r.id }),
      }).bindTooltip(`<b>${r.name}</b> (${r.id})<br>${r.level.toFixed(1)} dB / limit ${r.limit} dB`, {direction:'top'});
      g.addLayer(m);
    });
  },[receivers, tweaks.receiverStyle]);

  // ── render calc area ──
  React.useEffect(()=>{
    const g = layersRef.current.calcArea; if(!g) return; g.clearLayers();
    const corners = calcAreaCorners(area);
    L.polygon(corners, { color:'#2A2A2A', weight:2, dashArray:'8 6', fillColor:'#F2CB00', fillOpacity:0.06 }).addTo(g);
    // corner handles
    corners.forEach((c,i)=>{
      L.circleMarker(c, { radius:5, color:'#2A2A2A', weight:1.5, fillColor:'#F2CB00', fillOpacity:1 }).addTo(g);
    });
    // North arrow on the area
    const north = [corners[0][0]+(corners[3][0]-corners[0][0])/2, corners[0][1]+(corners[3][1]-corners[0][1])/2];
  },[area]);

  // ── render contours (gridded squares) ──
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
    // point-in-polygon for rotated rectangle
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

  // recompute receiver levels when sources change OR run is pressed
  React.useEffect(()=>{
    if(!ran) return;
    setReceivers(rs => rs.map(r => ({ ...r, level: +noiseAt(r.lat, r.lng, wtgs, bess).toFixed(1) })));
  },[ran, wtgs, bess]);

  // map controls
  const zoom = (d) => mapRef.current && mapRef.current.setZoom(mapRef.current.getZoom()+d);
  const home = () => mapRef.current && mapRef.current.setView([-33.595,138.74],13);

  // bearing rotation (visual only — rotate the leaflet pane)
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
  };
  const addBESS = (cfg) => {
    const id = `BESS-${String.fromCharCode(65+bess.length)}`;
    setBess([...bess, { id, lat:-33.59+(Math.random()-.5)*.02, lng:138.74+(Math.random()-.5)*.03, ...cfg }]);
  };
  const addReceiver = () => {
    const id = `R${String(receivers.length+1).padStart(2,'0')}`;
    setReceivers([...receivers, { id, name:`New receiver ${receivers.length+1}`,
      lat:-33.595+(Math.random()-.5)*.04, lng:138.74+(Math.random()-.5)*.05, level:35+Math.random()*10, limit:defaultLimit }]);
  };

  return (
    <div className="map-wrap" style={{position:'relative',height:'100%'}}>
      <div ref={containerRef} id="map"></div>

      {/* 3D shaded overlay */}
      <div id="threed-overlay" className={view3D?'on':''}>
        <svg viewBox="0 0 1000 600" preserveAspectRatio="none">
          {/* synthetic 3D contour ridges */}
          {Array.from({length:14}).map((_,i)=>(
            <path key={i}
              d={`M 0 ${100+i*40} Q 250 ${60+i*40 + Math.sin(i)*30} 500 ${120+i*40} T 1000 ${100+i*40}`}
              fill="none" stroke={`rgba(242,203,0,${0.15+i*0.04})`} strokeWidth="1.5"/>
          ))}
          <text x="20" y="30" fill="#F2CB00" fontFamily="JetBrains Mono" fontSize="12" letterSpacing="2">3D TERRAIN VIEW · contoured · placeholder</text>
        </svg>
      </div>

      {/* Map status (top-left) */}
      <div className="map-status">
        <div className="pill"><span className="dot"></span><b>Project:</b> Mt Brown Wind Farm <span className="muted">(demo)</span></div>
        <div className="pill"><span className="dot warn"></span><b>{ran?'Calculated':'Not calculated'}</b></div>
      </div>

      {/* Map controls top-right */}
      <div className="map-controls">
        <div className="grp">
          <button title="Zoom in" onClick={()=>zoom(1)}>＋</button>
          <button title="Zoom out" onClick={()=>zoom(-1)}>−</button>
        </div>
        <div className="grp">
          <button title="Home" onClick={home}>⌂</button>
          <button title="Fit calc area" onClick={()=>{
            const c = calcAreaCorners(area);
            mapRef.current.fitBounds(c);
          }}>⊡</button>
        </div>
        <div className="grp">
          <button className={view3D?'':'active'} onClick={()=>setView3D(false)} title="2D satellite">2D</button>
          <button className={view3D?'active':''} onClick={()=>setView3D(true)} title="3D terrain">3D</button>
        </div>
        <div className="compass" title="Bearing — drag (placeholder)">
          <div className="needle" style={{transform:`translate(-50%,-100%) rotate(${-bearing}deg)`}}>
            <div className="n"></div><div className="s"></div>
          </div>
          <div className="lbl n">N</div>
          <div className="lbl e">E</div>
          <div className="lbl s">S</div>
          <div className="lbl w">W</div>
        </div>
        <div className="grp row-grp">
          <button title="Rotate left" onClick={()=>setBearing(b=>b-15)}>↺</button>
          <button title="Reset" onClick={()=>setBearing(0)}>○</button>
          <button title="Rotate right" onClick={()=>setBearing(b=>b+15)}>↻</button>
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="bottom-tools">
        <div className="grp">
          <button title="Pan"><span>✥</span> Pan</button>
          <button title="Place WTG"><span>🌀</span> + WTG</button>
          <button title="Place BESS"><span>⚡</span> + BESS</button>
          <button title="Place receiver"><span>📍</span> + Recv</button>
          <button title="Draw calc area"><span>▭</span> Calc area</button>
          <button title="Measure"><span>📏</span> Measure</button>
        </div>
      </div>

      {/* Legend */}
      <div className="legend">
        <div className="ttl"><span>Noise contours</span><span className="mono tiny">L<sub>Aeq</sub> dB</span></div>
        <div className="scale">
          {CONTOUR_BANDS.map((b,i)=>(
            <div key={i} className="row" style={{opacity: bandsOn[i]?1:.3}}>
              <span className="swatch" style={{background:PALETTES[palette][i]}}></span>
              <span>{b.label}</span>
            </div>
          ))}
        </div>
        <hr className="sk-hr" style={{margin:'8px 0'}}/>
        <div style={{display:'flex',flexDirection:'column',gap:3}}>
          <div style={{display:'grid',gridTemplateColumns:'18px 1fr',gap:8,alignItems:'center'}}>
            <span style={{display:'inline-block',width:12,height:12,borderRadius:'50%',background:'#2e7d32',border:'1px solid #2A2A2A'}}></span>
            <span>Receiver — within limit</span>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'18px 1fr',gap:8,alignItems:'center'}}>
            <span style={{display:'inline-block',width:12,height:12,borderRadius:'50%',background:'#c0392b',border:'1px solid #2A2A2A'}}></span>
            <span>Receiver — exceeds limit</span>
          </div>
        </div>
      </div>

      {/* Annotation: wireframe note */}
      <div className="arrow-note" style={{right:120,top:240,maxWidth:160,textAlign:'right'}}>
        <span className="anno">controls · zoom / pan / rotate · 2D ↔ 3D</span>
      </div>

      {/* expose state via context-ish stub for the side panel through props */}
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
      />
    </div>
  );
}

// invisible bridge — writes state to window so the SidePanel can read.
// Compare a stable serialisation of just the data props to avoid render loops.
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
