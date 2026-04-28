// Marker SVGs and Leaflet divIcon factories.

// WTG: traditional 3-blade hub, hand-drawn feel
function WTGGlyph({ size=26, mode='normal' }){
  // mode: 'normal' | 'small' | 'mini'
  const stroke = '#2A2A2A';
  return (
    <svg width={size} height={size} viewBox="-14 -14 28 28">
      <g style={{strokeLinecap:'round'}}>
        <line x1="0" y1="0" x2="0" y2="-12" stroke={stroke} strokeWidth="2.2"/>
        <line x1="0" y1="0" x2="10.4" y2="6"  stroke={stroke} strokeWidth="2.2"/>
        <line x1="0" y1="0" x2="-10.4" y2="6" stroke={stroke} strokeWidth="2.2"/>
        <circle cx="0" cy="0" r="2.6" fill="#F2CB00" stroke={stroke} strokeWidth="1.5"/>
      </g>
    </svg>
  );
}

// BESS: container with directional arrow (orientation = heading)
function BESSGlyph({ size=30, heading=0, style='container' }){
  const stroke='#2A2A2A';
  // style: 'container' | 'arrow' | 'flag' | 'antenna'
  return (
    <svg width={size} height={size} viewBox="-18 -18 36 36" style={{transform:`rotate(${heading}deg)`}}>
      {style==='container' && (
        <g>
          <rect x="-10" y="-7" width="20" height="14" fill="#2A2A2A" stroke="#F2CB00" strokeWidth="1.5"/>
          {/* fin showing front */}
          <polygon points="0,-13 -3,-8 3,-8" fill="#F2CB00" stroke="#2A2A2A" strokeWidth="1"/>
          {/* small ribs */}
          <line x1="-6" y1="-7" x2="-6" y2="7" stroke="#F2CB00" strokeWidth=".7" opacity=".7"/>
          <line x1="0"  y1="-7" x2="0"  y2="7" stroke="#F2CB00" strokeWidth=".7" opacity=".7"/>
          <line x1="6"  y1="-7" x2="6"  y2="7" stroke="#F2CB00" strokeWidth=".7" opacity=".7"/>
        </g>
      )}
      {style==='arrow' && (
        <g>
          <rect x="-11" y="-6" width="18" height="12" fill="#2A2A2A"/>
          <line x1="0" y1="0" x2="14" y2="0" stroke="#F2CB00" strokeWidth="2"/>
          <polygon points="14,-3 18,0 14,3" fill="#F2CB00"/>
        </g>
      )}
      {style==='flag' && (
        <g>
          <rect x="-10" y="-7" width="20" height="14" fill="none" stroke="#2A2A2A" strokeWidth="1.6"/>
          <rect x="-10" y="-12" width="20" height="4" fill="#F2CB00" stroke="#2A2A2A" strokeWidth="1"/>
        </g>
      )}
      {style==='antenna' && (
        <g>
          <rect x="-10" y="-6" width="20" height="14" fill="#D9D9D9" stroke="#2A2A2A" strokeWidth="1.5"/>
          <circle cx="0" cy="0" r="2" fill="#F2CB00" stroke="#2A2A2A" strokeWidth="1"/>
          <line x1="0" y1="0" x2="0" y2="-13" stroke="#F2CB00" strokeWidth="2"/>
        </g>
      )}
    </svg>
  );
}

// Receiver: 3 styles
function ReceiverGlyph({ style='dot', level=40, limit=40, name='R' }){
  const fail = level > limit;
  if(style==='square'){
    return (
      <div className="recv-marker">
        <div className={'recv-square'+(fail?' fail':'')}>{level.toFixed(1)}</div>
        <div className="recv-label">{name}</div>
      </div>
    );
  }
  if(style==='pill'){
    return (
      <div className="recv-marker">
        <div className={'recv-pill'+(fail?' fail':'')}>
          <span className="ddot"></span>
          <b>{name}</b>
          <span style={{fontFamily:'JetBrains Mono, monospace',fontSize:11}}>{level.toFixed(1)} dB</span>
        </div>
      </div>
    );
  }
  // dot (default)
  return (
    <div className="recv-marker">
      <div className="recv-label">{level.toFixed(1)}</div>
      <div className={'recv-dot'+(fail?' fail':'')}></div>
      <div className="recv-label" style={{borderColor:'#8E8E8E'}}>{name}</div>
    </div>
  );
}

// Render a React element to a DOM node string for Leaflet divIcon
function renderToHTML(el){
  const div = document.createElement('div');
  ReactDOM.createRoot(div).render(el);
  // synchronous-ish: Leaflet pulls innerHTML on next tick anyway, return wrapper
  return div;
}

function makeWTGIcon({ showCircle=true, radiusPx=80 }){
  const html = `
    <div class="wtg-marker" style="position:relative;width:0;height:0">
      ${showCircle ? `<div class="wtg-noise-circle" style="position:absolute;width:${radiusPx*2}px;height:${radiusPx*2}px;left:${-radiusPx}px;top:${-radiusPx}px"></div>`:''}
      <div style="position:absolute;left:-13px;top:-13px">
        <svg width="26" height="26" viewBox="-14 -14 28 28">
          <line x1="0" y1="0" x2="0" y2="-12" stroke="#2A2A2A" stroke-width="2.2" stroke-linecap="round"/>
          <line x1="0" y1="0" x2="10.4" y2="6"  stroke="#2A2A2A" stroke-width="2.2" stroke-linecap="round"/>
          <line x1="0" y1="0" x2="-10.4" y2="6" stroke="#2A2A2A" stroke-width="2.2" stroke-linecap="round"/>
          <circle cx="0" cy="0" r="2.6" fill="#F2CB00" stroke="#2A2A2A" stroke-width="1.5"/>
        </svg>
      </div>
    </div>`;
  return L.divIcon({ html, className:'', iconSize:[0,0], iconAnchor:[0,0] });
}

function makeBESSIcon({ heading=0, style='container' }){
  let inner='';
  if(style==='container'){
    inner = `
      <rect x="-10" y="-7" width="20" height="14" fill="#2A2A2A" stroke="#F2CB00" stroke-width="1.5"/>
      <polygon points="0,-13 -3,-8 3,-8" fill="#F2CB00" stroke="#2A2A2A" stroke-width="1"/>
      <line x1="-6" y1="-7" x2="-6" y2="7" stroke="#F2CB00" stroke-width=".7" opacity=".7"/>
      <line x1="0" y1="-7" x2="0" y2="7" stroke="#F2CB00" stroke-width=".7" opacity=".7"/>
      <line x1="6" y1="-7" x2="6" y2="7" stroke="#F2CB00" stroke-width=".7" opacity=".7"/>`;
  } else if(style==='arrow'){
    inner = `
      <rect x="-11" y="-6" width="18" height="12" fill="#2A2A2A"/>
      <line x1="0" y1="0" x2="14" y2="0" stroke="#F2CB00" stroke-width="2"/>
      <polygon points="14,-3 18,0 14,3" fill="#F2CB00"/>`;
  } else if(style==='flag'){
    inner = `
      <rect x="-10" y="-7" width="20" height="14" fill="none" stroke="#2A2A2A" stroke-width="1.6"/>
      <rect x="-10" y="-12" width="20" height="4" fill="#F2CB00" stroke="#2A2A2A" stroke-width="1"/>`;
  } else {
    inner = `
      <rect x="-10" y="-6" width="20" height="14" fill="#D9D9D9" stroke="#2A2A2A" stroke-width="1.5"/>
      <circle cx="0" cy="0" r="2" fill="#F2CB00" stroke="#2A2A2A" stroke-width="1"/>
      <line x1="0" y1="0" x2="0" y2="-13" stroke="#F2CB00" stroke-width="2"/>`;
  }
  const html = `<div class="bess-marker" style="transform:translate(-15px,-15px)">
    <svg width="30" height="30" viewBox="-18 -18 36 36" style="transform:rotate(${heading}deg)">${inner}</svg>
  </div>`;
  return L.divIcon({ html, className:'', iconSize:[0,0], iconAnchor:[0,0] });
}

function makeReceiverIcon({ style='dot', level=40, limit=40, name='R' }){
  const fail = level > limit;
  let html='';
  if(style==='square'){
    html = `<div class="recv-marker">
      <div class="recv-square${fail?' fail':''}">${level.toFixed(1)}</div>
      <div class="recv-label">${name}</div>
    </div>`;
  } else if(style==='pill'){
    html = `<div class="recv-marker">
      <div class="recv-pill${fail?' fail':''}">
        <span class="ddot"></span><b>${name}</b>
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px">${level.toFixed(1)} dB</span>
      </div>
    </div>`;
  } else {
    html = `<div class="recv-marker">
      <div class="recv-label">${level.toFixed(1)}</div>
      <div class="recv-dot${fail?' fail':''}"></div>
      <div class="recv-label" style="border-color:#8E8E8E">${name}</div>
    </div>`;
  }
  return L.divIcon({ html, className:'', iconSize:[0,0], iconAnchor:[0,0] });
}

Object.assign(window, { WTGGlyph, BESSGlyph, ReceiverGlyph, makeWTGIcon, makeBESSIcon, makeReceiverIcon });
