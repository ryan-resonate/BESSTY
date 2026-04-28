// Markers v3 — refined design (cleaner halos, leader lines, better receivers)

function makeWTGIcon({ id, selected=false }){
  const ringStroke = selected ? '#F2CB00' : 'rgba(21,24,29,0.5)';
  const ringW = selected ? 2 : 1;
  const ringBg = selected ? 'rgba(255,247,209,0.95)' : 'rgba(255,255,255,0.85)';
  const html = `
    <div class="wtg-marker" style="position:relative;width:0;height:0">
      <div style="position:absolute;left:-17px;top:-17px;
                   width:34px;height:34px;border-radius:50%;
                   background:${ringBg};
                   border:${ringW}px solid ${ringStroke};
                   box-shadow:0 1px 2px rgba(0,0,0,.25);"></div>
      <div style="position:absolute;left:-13px;top:-13px">
        <svg width="26" height="26" viewBox="-13 -13 26 26">
          <line x1="0" y1="0" x2="0" y2="-10" stroke="#15181D" stroke-width="1.8" stroke-linecap="round"/>
          <line x1="0" y1="0" x2="8.7" y2="5"  stroke="#15181D" stroke-width="1.8" stroke-linecap="round"/>
          <line x1="0" y1="0" x2="-8.7" y2="5" stroke="#15181D" stroke-width="1.8" stroke-linecap="round"/>
          <circle cx="0" cy="0" r="2.4" fill="#F2CB00" stroke="#15181D" stroke-width="1"/>
        </svg>
      </div>
      <div style="position:absolute;left:21px;top:-7px;
                  font-size:10px;font-weight:600;color:#15181D;letter-spacing:-.005em;
                  background:rgba(255,255,255,.95);padding:1px 5px;border-radius:3px;
                  border:1px solid rgba(0,0,0,.12);white-space:nowrap;
                  box-shadow:0 1px 1px rgba(0,0,0,.06);">${id}</div>
    </div>`;
  return L.divIcon({ html, className:'', iconSize:[0,0], iconAnchor:[0,0] });
}

function makeBESSIcon({ id, heading=0, style='container', selected=false }){
  let inner='';
  if(style==='container'){
    inner = `
      <rect x="-11" y="-7.5" width="22" height="15" rx="1.5" fill="#15181D" stroke="#F2CB00" stroke-width="1.5"/>
      <polygon points="0,-13 -3.5,-8 3.5,-8" fill="#F2CB00" stroke="#15181D" stroke-width="0.8"/>
      <line x1="-7" y1="-7.5" x2="-7" y2="7.5" stroke="#F2CB00" stroke-width=".5" opacity=".5"/>
      <line x1="0"  y1="-7.5" x2="0"  y2="7.5" stroke="#F2CB00" stroke-width=".5" opacity=".5"/>
      <line x1="7"  y1="-7.5" x2="7"  y2="7.5" stroke="#F2CB00" stroke-width=".5" opacity=".5"/>`;
  } else if(style==='arrow'){
    inner = `
      <rect x="-11" y="-6" width="18" height="12" fill="#15181D"/>
      <line x1="0" y1="0" x2="14" y2="0" stroke="#F2CB00" stroke-width="2"/>
      <polygon points="14,-3 18,0 14,3" fill="#F2CB00"/>`;
  } else if(style==='flag'){
    inner = `
      <rect x="-10" y="-7" width="20" height="14" fill="white" stroke="#15181D" stroke-width="1.4"/>
      <rect x="-10" y="-12" width="20" height="4" fill="#F2CB00" stroke="#15181D" stroke-width="0.8"/>`;
  } else {
    inner = `
      <rect x="-10" y="-6" width="20" height="14" fill="#E4E6EC" stroke="#15181D" stroke-width="1.5"/>
      <circle cx="0" cy="0" r="2" fill="#F2CB00" stroke="#15181D" stroke-width="1"/>
      <line x1="0" y1="0" x2="0" y2="-13" stroke="#F2CB00" stroke-width="2"/>`;
  }
  const ringW = selected ? 2 : 1;
  const ringStroke = selected ? '#F2CB00' : 'rgba(21,24,29,0.45)';
  const ringBg = selected ? 'rgba(255,247,209,0.9)' : 'rgba(255,255,255,0.75)';
  const html = `
    <div class="bess-marker" style="position:relative;width:0;height:0;">
      <div style="position:absolute;left:-18px;top:-18px;
                  width:36px;height:36px;border-radius:6px;
                  background:${ringBg};
                  border:${ringW}px solid ${ringStroke};
                  box-shadow:0 1px 2px rgba(0,0,0,.25);"></div>
      <div style="position:absolute;left:-15px;top:-15px;
                  transform:rotate(${heading}deg);transform-origin:15px 15px;">
        <svg width="30" height="30" viewBox="-15 -15 30 30">${inner}</svg>
      </div>
      <div style="position:absolute;left:22px;top:-7px;
                  font-size:10px;font-weight:600;color:#15181D;letter-spacing:-.005em;
                  background:rgba(255,255,255,.95);padding:1px 5px;border-radius:3px;
                  border:1px solid rgba(0,0,0,.12);white-space:nowrap;
                  box-shadow:0 1px 1px rgba(0,0,0,.06);">${id}</div>
    </div>`;
  return L.divIcon({ html, className:'', iconSize:[0,0], iconAnchor:[0,0] });
}

function makeReceiverIcon({ style='dot', level=40, limit=40, name='R', id='R' }){
  const fail = level > limit;
  const col = fail ? '#C8362B':'#1F8E4A';
  const bg  = fail ? '#FCEAE7':'#E5F4EC';
  let html='';
  if(style==='square'){
    html = `<div class="recv-marker">
      <div style="display:flex;flex-direction:column;align-items:center;gap:0;transform:translate(-50%,-100%)">
        <div style="background:#fff;border:1.5px solid ${col};color:${col};
                    padding:2px 6px;border-radius:4px;font-weight:700;font-size:11px;
                    box-shadow:0 1px 2px rgba(0,0,0,.18);font-variant-numeric:tabular-nums;">${level.toFixed(1)} dB</div>
        <div style="width:1px;height:6px;background:${col};opacity:.6"></div>
        <div style="width:13px;height:13px;border-radius:50%;border:2px solid #fff;
                    background:${col};box-shadow:0 0 0 1.5px rgba(0,0,0,.4);"></div>
        <div style="font-size:9.5px;color:#7A8290;font-weight:500;margin-top:1px;
                    background:rgba(255,255,255,.85);padding:0 4px;border-radius:2px;">${id}</div>
      </div>
    </div>`;
  } else if(style==='pill'){
    html = `<div class="recv-marker">
      <div style="display:flex;flex-direction:column;align-items:center;gap:1px;transform:translate(-50%,-100%)">
        <div style="background:${bg};border:1px solid ${col};border-radius:99px;padding:2px 8px;
                    display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;letter-spacing:-.005em;
                    box-shadow:0 1px 2px rgba(0,0,0,.12);">
          <span style="width:6px;height:6px;border-radius:50%;background:${col}"></span>
          <span style="color:${col};font-variant-numeric:tabular-nums">${level.toFixed(1)}</span>
          <span style="color:#15181D;font-weight:500">${id}</span>
        </div>
        <div style="width:1px;height:4px;background:${col};opacity:.5"></div>
        <div style="width:7px;height:7px;border-radius:50%;background:${col};
                    border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35);"></div>
      </div>
    </div>`;
  } else {
    // dot (default) — clean number badge above + leader + dot + small id below
    html = `<div class="recv-marker">
      <div style="display:flex;flex-direction:column;align-items:center;gap:0;transform:translate(-50%,-100%)">
        <div style="background:#fff;border:1px solid ${col};color:${col};
                    padding:1px 6px;border-radius:3px;font-weight:700;font-size:10.5px;
                    box-shadow:0 1px 2px rgba(0,0,0,.15);font-variant-numeric:tabular-nums;line-height:1.3">
          ${level.toFixed(1)}<span style="color:#7A8290;font-weight:500;font-size:9px;margin-left:2px">dB</span>
        </div>
        <div style="width:1px;height:5px;background:${col};opacity:.6"></div>
        <div style="width:11px;height:11px;border-radius:50%;border:2px solid #fff;
                    background:${col};box-shadow:0 0 0 1.5px rgba(0,0,0,.4),0 1px 2px rgba(0,0,0,.25);"></div>
        <div style="font-size:9px;color:#7A8290;font-weight:600;margin-top:2px;letter-spacing:.02em;
                    background:rgba(255,255,255,.92);padding:0 4px;border-radius:2px;border:1px solid rgba(0,0,0,.08);">${id}</div>
      </div>
    </div>`;
  }
  return L.divIcon({ html, className:'', iconSize:[0,0], iconAnchor:[0,0] });
}

Object.assign(window, { makeWTGIcon, makeBESSIcon, makeReceiverIcon });
