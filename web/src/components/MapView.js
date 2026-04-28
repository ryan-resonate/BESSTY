import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { limitForPeriod } from '../lib/types';
import { paletteRgb, paletteCss, tForDb, makeBandsForRange, bicubicUpscale } from '../lib/colormap';
import { buildContourLines } from '../lib/contourLines';
const SOURCE_KIND_COLOR = {
    wtg: '#2A2A2A',
    bess: '#5e35b1',
    inverter: '#1565c0',
    transformer: '#c62828',
};
function sourceMarker(s, selected, groupColor) {
    const colour = SOURCE_KIND_COLOR[s.kind] ?? '#2A2A2A';
    // Selection ring: bright yellow halo when selected.
    // Group ring: small coloured arc on the upper-left of the icon.
    const selRing = selected
        ? `<circle cx="0" cy="0" r="14" fill="none" stroke="#F2CB00" stroke-width="2.5" stroke-dasharray="3 2"/>`
        : '';
    const groupRing = groupColor
        ? `<circle cx="0" cy="0" r="13" fill="none" stroke="${groupColor}" stroke-width="2"/>`
        : '';
    if (s.kind === 'wtg') {
        return L.divIcon({
            className: 'wtg-marker',
            html: `<svg width="36" height="36" viewBox="-18 -18 36 36" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.4))">
        ${selRing}
        ${groupRing}
        <circle cx="0" cy="0" r="10" fill="rgba(255,255,255,.7)" stroke="#2A2A2A" stroke-width="0.6"/>
        <line x1="0" y1="-1" x2="0" y2="-13" stroke="#2A2A2A" stroke-width="2.4" stroke-linecap="round"/>
        <line x1="-1" y1="1" x2="-11" y2="9" stroke="#2A2A2A" stroke-width="2.4" stroke-linecap="round"/>
        <line x1="1" y1="1" x2="11" y2="9" stroke="#2A2A2A" stroke-width="2.4" stroke-linecap="round"/>
        <circle cx="0" cy="0" r="3.2" fill="#F2CB00" stroke="#2A2A2A" stroke-width="1.2"/>
      </svg>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
        });
    }
    return L.divIcon({
        className: 'eqpt-marker',
        html: `<svg width="28" height="28" viewBox="-14 -14 28 28" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.4))">
      ${selRing}
      ${groupRing}
      <rect x="-9" y="-6" width="18" height="12" rx="1" fill="${colour}" stroke="#fff" stroke-width="1.4"/>
    </svg>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
    });
}
function receiverMarker(_r, dbA, activeLimit, selected, groupColor) {
    const fail = dbA != null && dbA > activeLimit;
    const colour = fail ? '#d32f2f' : '#2e7d32';
    const text = dbA != null ? `${dbA.toFixed(1)}` : '— ';
    const dotBorder = selected ? '#F2CB00' : (groupColor ?? '#fff');
    const dotBorderWidth = selected ? 3 : 2;
    return L.divIcon({
        className: 'recv-marker',
        html: `<div style="display:flex;flex-direction:column;align-items:center;gap:0;pointer-events:auto">
      <div style="background:rgba(255,255,255,0.92);backdrop-filter:blur(6px);border:${selected ? 2 : 1.5}px solid ${selected ? '#F2CB00' : '#2A2A2A'};border-radius:99px;padding:2px 9px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;color:${colour};white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.3)">
        ${text} <span style="opacity:.6;font-weight:400">dB(A)</span>
      </div>
      <div style="width:0;height:8px;border-left:1.5px dashed ${colour}"></div>
      <div style="width:14px;height:14px;border-radius:50%;border:${dotBorderWidth}px solid ${dotBorder};background:${colour};box-shadow:0 1px 2px rgba(0,0,0,.4)"></div>
    </div>`,
        iconSize: [80, 42],
        iconAnchor: [40, 38],
    });
}
const TILE_URLS = {
    satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: '© Esri',
        max: 19,
    },
    osm: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© OpenStreetMap',
        max: 19,
        subdomains: 'abc',
    },
};
function tileLayerOpts(b) {
    const cfg = TILE_URLS[b];
    return {
        maxZoom: cfg.max,
        attribution: cfg.attribution,
        crossOrigin: true,
        subdomains: cfg.subdomains ?? 'abc',
    };
}
function gridToCanvas(grid, palette, opacity, domainLo, domainHi) {
    const canvas = document.createElement('canvas');
    canvas.width = grid.cols;
    canvas.height = grid.rows;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(grid.cols, grid.rows);
    const a = Math.round(255 * opacity);
    for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
            const v = grid.dbA[row * grid.cols + col];
            const t = tForDb(v, domainLo, domainHi);
            const [r, g, b] = paletteRgb(palette, t);
            // Flip vertically: row 0 in our grid is southern, but ImageData row 0 is north.
            const flippedRow = grid.rows - 1 - row;
            const idx = (flippedRow * grid.cols + col) * 4;
            img.data[idx] = r;
            img.data[idx + 1] = g;
            img.data[idx + 2] = b;
            img.data[idx + 3] = v < -100 ? 0 : a;
        }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
}
export function MapView({ project, results, grid, selectedIds, onSelect, onBoxSelect, onAddSource, onAddReceiver, onMoveSource, onMoveReceiver, onResizeCalcArea, onMoveCalcArea, addMode, baseMap, showContours, contourMode, contourOpacity, contourStepDb, palette, dbDomain, onCursorMove, onReady, }) {
    // Map: object id → group color (for the small ring around the marker).
    const groupColorById = new Map();
    for (const g of project.groups ?? []) {
        if (!g.color)
            continue;
        for (const id of g.memberIds)
            groupColorById.set(id, g.color);
    }
    const containerRef = useRef(null);
    const mapRef = useRef(null);
    const baseLayerRef = useRef(null);
    const markersGroupRef = useRef(null);
    const overlayGroupRef = useRef(null);
    const measureGroupRef = useRef(null);
    const measurePointsRef = useRef([]);
    /// id → Leaflet Marker handle, so we can update sibling marker positions
    /// during a group drag without going through React state.
    const markersByIdRef = useRef(new Map());
    /// Selection set kept in a ref so drag handlers (bound at marker-effect
    /// time) read the latest set without needing the effect to re-run.
    const selectedIdsRef = useRef(selectedIds);
    useEffect(() => { selectedIdsRef.current = selectedIds; });
    /// Lets the marker drag handlers signal the box-select code to stand down.
    const cancelBoxSelectRef = useRef(() => { });
    // Stash every callback in a ref so the marker render effect doesn't re-fire
    // on every prop identity change (cursor mousemove updates ProjectScreen
    // state on every frame, which would otherwise rebuild markers — and a
    // marker rebuilt mid-drag drops the drag interaction).
    const callbacksRef = useRef({
        onAddSource, onAddReceiver, onMoveSource, onMoveReceiver,
        onResizeCalcArea, onMoveCalcArea, onCursorMove, onSelect, onBoxSelect, addMode,
    });
    useEffect(() => {
        callbacksRef.current = {
            onAddSource, onAddReceiver, onMoveSource, onMoveReceiver,
            onResizeCalcArea, onMoveCalcArea, onCursorMove, onSelect, onBoxSelect, addMode,
        };
    });
    // ProjectScreen needs to know the lat/lng of every source/receiver to
    // resolve box-select hits — read from the latest project via a ref so the
    // event handler doesn't need re-binding.
    const projectRef = useRef(project);
    useEffect(() => { projectRef.current = project; });
    // Init map.
    useEffect(() => {
        if (!containerRef.current || mapRef.current)
            return;
        const initial = project.calculationArea?.centerLatLng ?? project.sources[0]?.latLng ?? [-33.6, 138.7];
        const map = L.map(containerRef.current, {
            center: initial, zoom: 12,
            // Custom MapControls panel replaces Leaflet's default zoom widget.
            zoomControl: false,
            // Disable Leaflet's default left-mouse drag — we use LMB for box-select
            // and bind middle-mouse to manual pan below.
            dragging: false,
            // Right-click context menu is harmless; LMB box-select reserves left.
            boxZoom: false,
        });
        baseLayerRef.current = L.tileLayer(TILE_URLS[baseMap].url, tileLayerOpts(baseMap)).addTo(map);
        overlayGroupRef.current = L.layerGroup().addTo(map);
        measureGroupRef.current = L.layerGroup().addTo(map);
        markersGroupRef.current = L.layerGroup().addTo(map);
        // ---- Middle-mouse pan (Leaflet's left-mouse drag is disabled above) ----
        const containerEl = containerRef.current;
        let panLast = null;
        const onMmbDown = (ev) => {
            if (ev.button !== 1)
                return;
            ev.preventDefault();
            panLast = { x: ev.clientX, y: ev.clientY };
            containerEl.style.cursor = 'grabbing';
        };
        const onMmbMove = (ev) => {
            if (!panLast)
                return;
            const dx = ev.clientX - panLast.x;
            const dy = ev.clientY - panLast.y;
            panLast = { x: ev.clientX, y: ev.clientY };
            map.panBy([-dx, -dy], { animate: false });
        };
        const onMmbUp = (ev) => {
            if (ev.button !== 1)
                return;
            panLast = null;
            containerEl.style.cursor = '';
        };
        containerEl.addEventListener('mousedown', onMmbDown);
        window.addEventListener('mousemove', onMmbMove);
        window.addEventListener('mouseup', onMmbUp);
        // ---- LMB drag → box-select (only on empty map / when addMode is none) ----
        //
        // Wired to DOM mousedown rather than Leaflet's `map.on('mousedown')`
        // because Leaflet's bubblingMouseEvents:false on markers turns out not
        // to suppress the map's mousedown reliably across browsers. Filtering
        // by the actual DOM target gives us full control: anything inside a
        // .leaflet-marker-icon is the marker's territory; everything else is
        // treated as empty-map.
        let boxStart = null;
        let boxStartPx = null;
        let boxRect = null;
        cancelBoxSelectRef.current = () => {
            if (boxRect) {
                boxRect.remove();
                boxRect = null;
            }
            boxStart = null;
            boxStartPx = null;
        };
        const onLmbDown = (ev) => {
            if (ev.button !== 0)
                return;
            const target = ev.target;
            if (target.closest('.leaflet-marker-icon, .leaflet-control'))
                return;
            if (callbacksRef.current.addMode !== 'none')
                return;
            const cr = containerEl.getBoundingClientRect();
            const cx = ev.clientX - cr.left;
            const cy = ev.clientY - cr.top;
            boxStartPx = L.point(cx, cy);
            boxStart = map.containerPointToLatLng(boxStartPx);
        };
        containerEl.addEventListener('mousedown', onLmbDown);
        const onBoxMove = (ev) => {
            if (!boxStart)
                return;
            const cr = containerEl.getBoundingClientRect();
            const here = map.containerPointToLatLng([ev.clientX - cr.left, ev.clientY - cr.top]);
            if (boxRect)
                boxRect.remove();
            boxRect = L.rectangle(L.latLngBounds(boxStart, here), {
                color: '#F2CB00', weight: 2, dashArray: '4 3', fillOpacity: 0.1,
                interactive: false,
            }).addTo(map);
        };
        const onBoxUp = (ev) => {
            if (!boxStart)
                return;
            const cr = containerEl.getBoundingClientRect();
            const cx = ev.clientX - cr.left;
            const cy = ev.clientY - cr.top;
            const here = map.containerPointToLatLng([cx, cy]);
            const bounds = L.latLngBounds(boxStart, here);
            const dx = Math.abs((boxStartPx?.x ?? cx) - cx);
            const dy = Math.abs((boxStartPx?.y ?? cy) - cy);
            // < 4 px = treat as click (clear selection unless shift held).
            if (dx < 4 && dy < 4) {
                if (!ev.shiftKey)
                    callbacksRef.current.onSelect(null);
            }
            else {
                const p = projectRef.current;
                const ids = [];
                for (const s of p.sources) {
                    if (bounds.contains(L.latLng(s.latLng[0], s.latLng[1])))
                        ids.push(s.id);
                }
                for (const r of p.receivers) {
                    if (bounds.contains(L.latLng(r.latLng[0], r.latLng[1])))
                        ids.push(r.id);
                }
                callbacksRef.current.onBoxSelect(ids, { shift: ev.shiftKey });
            }
            if (boxRect) {
                boxRect.remove();
                boxRect = null;
            }
            boxStart = null;
            boxStartPx = null;
        };
        window.addEventListener('mousemove', onBoxMove);
        window.addEventListener('mouseup', onBoxUp);
        map.on('click', (e) => {
            const { addMode, onAddSource, onAddReceiver } = callbacksRef.current;
            const latLng = [e.latlng.lat, e.latlng.lng];
            if (addMode === 'measure') {
                const pts = measurePointsRef.current;
                const group = measureGroupRef.current;
                if (!group)
                    return;
                if (pts.length >= 2) {
                    group.clearLayers();
                    pts.length = 0;
                }
                pts.push(e.latlng);
                L.circleMarker(e.latlng, {
                    radius: 4, color: '#F2CB00', fillColor: '#F2CB00', fillOpacity: 1, weight: 2,
                }).addTo(group);
                if (pts.length === 2) {
                    const distance = pts[0].distanceTo(pts[1]);
                    L.polyline(pts, { color: '#F2CB00', weight: 3, dashArray: '6 4', opacity: 0.95 }).addTo(group);
                    const mid = L.latLng((pts[0].lat + pts[1].lat) / 2, (pts[0].lng + pts[1].lng) / 2);
                    L.marker(mid, {
                        icon: L.divIcon({
                            className: 'measure-label',
                            html: `<div style="background:#F2CB00;color:#1f2937;border:1px solid #1f2937;border-radius:4px;padding:3px 8px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.3)">${distance >= 1000 ? (distance / 1000).toFixed(2) + ' km' : distance.toFixed(0) + ' m'}</div>`,
                            iconSize: [80, 22],
                            iconAnchor: [40, 11],
                        }),
                        interactive: false,
                    }).addTo(group);
                }
                return;
            }
            if (addMode === 'none') {
                // Empty-map clicks are handled by the LMB box-select (mouseup with
                // small move = click → clear selection).
                return;
            }
            if (addMode === 'receiver')
                onAddReceiver?.(latLng);
            else
                onAddSource?.(latLng);
        });
        // Cursor tracking, throttled to one update per animation frame.
        let pendingCursorUpdate = null;
        let pendingLatLng = null;
        map.on('mousemove', (e) => {
            pendingLatLng = [e.latlng.lat, e.latlng.lng];
            if (pendingCursorUpdate == null) {
                pendingCursorUpdate = requestAnimationFrame(() => {
                    callbacksRef.current.onCursorMove?.(pendingLatLng);
                    pendingCursorUpdate = null;
                });
            }
        });
        map.on('mouseout', () => {
            if (pendingCursorUpdate != null) {
                cancelAnimationFrame(pendingCursorUpdate);
                pendingCursorUpdate = null;
            }
            callbacksRef.current.onCursorMove?.(null);
        });
        mapRef.current = map;
        onReady?.(map);
        return () => {
            if (pendingCursorUpdate != null)
                cancelAnimationFrame(pendingCursorUpdate);
            containerEl.removeEventListener('mousedown', onMmbDown);
            containerEl.removeEventListener('mousedown', onLmbDown);
            window.removeEventListener('mousemove', onMmbMove);
            window.removeEventListener('mouseup', onMmbUp);
            window.removeEventListener('mousemove', onBoxMove);
            window.removeEventListener('mouseup', onBoxUp);
            map.remove();
            mapRef.current = null;
            baseLayerRef.current = null;
            markersGroupRef.current = null;
            overlayGroupRef.current = null;
            measureGroupRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Switch base layer when baseMap changes.
    useEffect(() => {
        const map = mapRef.current;
        if (!map)
            return;
        if (baseLayerRef.current) {
            map.removeLayer(baseLayerRef.current);
        }
        baseLayerRef.current = L.tileLayer(TILE_URLS[baseMap].url, tileLayerOpts(baseMap)).addTo(map);
        if (overlayGroupRef.current) {
            overlayGroupRef.current.remove();
            overlayGroupRef.current.addTo(map);
        }
        if (measureGroupRef.current) {
            measureGroupRef.current.remove();
            measureGroupRef.current.addTo(map);
        }
        if (markersGroupRef.current) {
            markersGroupRef.current.remove();
            markersGroupRef.current.addTo(map);
        }
    }, [baseMap]);
    // Clear measurement when leaving measure mode.
    useEffect(() => {
        if (addMode !== 'measure' && measureGroupRef.current) {
            measureGroupRef.current.clearLayers();
            measurePointsRef.current = [];
        }
    }, [addMode]);
    // Re-render markers + calc area outline.
    useEffect(() => {
        const map = mapRef.current;
        const group = markersGroupRef.current;
        if (!map || !group)
            return;
        group.clearLayers();
        markersByIdRef.current.clear();
        /// Track group-drag state. When a selected marker starts dragging, we
        /// snapshot all sibling positions and translate them in lockstep on
        /// every `drag` event (no React state involved — direct setLatLng).
        let dragGroup = null;
        const anySelected = selectedIds.size > 0;
        const isSelected = (id) => selectedIds.has(id);
        const dimNonSelected = (id) => (anySelected && !isSelected(id) ? 0.55 : 1);
        for (const s of project.sources) {
            const sel = isSelected(s.id);
            const marker = L.marker(s.latLng, {
                icon: sourceMarker(s, sel, groupColorById.get(s.id)),
                title: s.name,
                opacity: dimNonSelected(s.id),
                draggable: true,
                // Stop mousedown propagating to map so box-select doesn't start.
                bubblingMouseEvents: false,
            });
            markersByIdRef.current.set(s.id, marker);
            marker.on('click', (e) => {
                const shift = !!e.originalEvent?.shiftKey;
                callbacksRef.current.onSelect(s.id, { shift });
            });
            marker.on('dragstart', () => {
                cancelBoxSelectRef.current();
                const sel = selectedIdsRef.current;
                if (sel.size <= 1 || !sel.has(s.id))
                    return;
                const siblings = new Map();
                for (const id of sel) {
                    if (id === s.id)
                        continue;
                    const m = markersByIdRef.current.get(id);
                    if (m)
                        siblings.set(id, m.getLatLng());
                }
                dragGroup = { leaderId: s.id, leaderStart: marker.getLatLng(), siblings };
            });
            marker.on('drag', () => {
                if (!dragGroup || dragGroup.leaderId !== s.id)
                    return;
                const here = marker.getLatLng();
                const dLat = here.lat - dragGroup.leaderStart.lat;
                const dLng = here.lng - dragGroup.leaderStart.lng;
                for (const [id, orig] of dragGroup.siblings) {
                    const m = markersByIdRef.current.get(id);
                    if (m)
                        m.setLatLng([orig.lat + dLat, orig.lng + dLng]);
                }
            });
            marker.on('dragend', (e) => {
                const m = e.target;
                const latLng = m.getLatLng();
                callbacksRef.current.onMoveSource?.(s.id, [latLng.lat, latLng.lng]);
                dragGroup = null;
            });
            marker.addTo(group);
        }
        for (const r of project.receivers) {
            const dbA = results?.find((x) => x.receiverId === r.id)?.totalDbA ?? null;
            const sel = isSelected(r.id);
            const activeLimit = limitForPeriod(r, project.scenario.period);
            const marker = L.marker(r.latLng, {
                icon: receiverMarker(r, dbA && isFinite(dbA) ? dbA : null, activeLimit, sel, groupColorById.get(r.id)),
                title: r.name,
                opacity: dimNonSelected(r.id),
                draggable: true,
                bubblingMouseEvents: false,
            });
            markersByIdRef.current.set(r.id, marker);
            marker.on('click', (e) => {
                const shift = !!e.originalEvent?.shiftKey;
                onSelect(r.id, { shift });
            });
            marker.on('dragstart', () => {
                cancelBoxSelectRef.current();
                const sel = selectedIdsRef.current;
                if (sel.size <= 1 || !sel.has(r.id))
                    return;
                const siblings = new Map();
                for (const id of sel) {
                    if (id === r.id)
                        continue;
                    const m = markersByIdRef.current.get(id);
                    if (m)
                        siblings.set(id, m.getLatLng());
                }
                dragGroup = { leaderId: r.id, leaderStart: marker.getLatLng(), siblings };
            });
            marker.on('drag', () => {
                if (!dragGroup || dragGroup.leaderId !== r.id)
                    return;
                const here = marker.getLatLng();
                const dLat = here.lat - dragGroup.leaderStart.lat;
                const dLng = here.lng - dragGroup.leaderStart.lng;
                for (const [id, orig] of dragGroup.siblings) {
                    const m = markersByIdRef.current.get(id);
                    if (m)
                        m.setLatLng([orig.lat + dLat, orig.lng + dLng]);
                }
            });
            marker.on('dragend', (e) => {
                const m = e.target;
                const latLng = m.getLatLng();
                callbacksRef.current.onMoveReceiver?.(r.id, [latLng.lat, latLng.lng]);
                dragGroup = null;
            });
            marker.addTo(group);
        }
        const ca = project.calculationArea;
        if (ca) {
            const halfW = ca.widthM / 2;
            const halfH = ca.heightM / 2;
            const R = 6371008.8;
            const lat0 = (ca.centerLatLng[0] * Math.PI) / 180;
            const dLat = (halfH / R) * (180 / Math.PI);
            const dLng = (halfW / (R * Math.cos(lat0))) * (180 / Math.PI);
            const south = ca.centerLatLng[0] - dLat;
            const north = ca.centerLatLng[0] + dLat;
            const west = ca.centerLatLng[1] - dLng;
            const east = ca.centerLatLng[1] + dLng;
            const bounds = [[south, west], [north, east]];
            L.rectangle(bounds, {
                color: '#F2CB00', weight: 1.5, dashArray: '8 6', fillOpacity: 0, interactive: false,
            }).addTo(group);
            // Corner handles. Dragging a corner resizes the rectangle keeping the
            // centre fixed: width = 2·|Δlng→m|, height = 2·|Δlat→m|.
            const cornerHandle = () => L.divIcon({
                className: 'ca-handle',
                html: `<div style="width:12px;height:12px;background:#F2CB00;border:1.5px solid #1f2937;border-radius:2px;cursor:nwse-resize;box-shadow:0 1px 2px rgba(0,0,0,.4)"></div>`,
                iconSize: [14, 14], iconAnchor: [7, 7],
            });
            const corners = [
                [south, west], [south, east], [north, east], [north, west],
            ];
            for (const c of corners) {
                const m = L.marker(c, { icon: cornerHandle(), draggable: true, zIndexOffset: 800 });
                m.on('dragend', (e) => {
                    const handle = e.target;
                    const ll = handle.getLatLng();
                    const cb = callbacksRef.current.onResizeCalcArea;
                    if (!cb)
                        return;
                    // Convert lat/lng delta from centre to metres.
                    const dLatM = (ll.lat - ca.centerLatLng[0]) * (Math.PI / 180) * R;
                    const dLngM = (ll.lng - ca.centerLatLng[1]) * (Math.PI / 180) * R * Math.cos(lat0);
                    const newW = Math.max(500, Math.abs(dLngM) * 2);
                    const newH = Math.max(500, Math.abs(dLatM) * 2);
                    cb(newW, newH);
                });
                m.addTo(group);
            }
            // Centre handle. Drag → translate the entire rectangle.
            const centreHandle = L.divIcon({
                className: 'ca-handle-centre',
                html: `<div style="width:14px;height:14px;background:#fff;border:2px solid #F2CB00;border-radius:50%;cursor:move;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
                iconSize: [18, 18], iconAnchor: [9, 9],
            });
            const cm = L.marker(ca.centerLatLng, { icon: centreHandle, draggable: true, zIndexOffset: 850 });
            cm.on('dragend', (e) => {
                const handle = e.target;
                const ll = handle.getLatLng();
                callbacksRef.current.onMoveCalcArea?.([ll.lat, ll.lng]);
            });
            cm.addTo(group);
        }
        // `onSelect` deliberately omitted — we read it from callbacksRef inside
        // the click handlers, so we don't want a fresh closure to invalidate the
        // markers (and break in-flight drags) every time the parent re-renders.
    }, [project, results, selectedIds]);
    // Render contour overlay (filled raster, iso-lines, or both).
    useEffect(() => {
        const map = mapRef.current;
        const group = overlayGroupRef.current;
        if (!map || !group)
            return;
        group.clearLayers();
        if (!showContours || !grid)
            return;
        if (contourMode === 'filled' || contourMode === 'both') {
            const canvas = gridToCanvas(grid, palette, contourOpacity, dbDomain.min, dbDomain.max);
            const url = canvas.toDataURL('image/png');
            L.imageOverlay(url, [grid.bounds.sw, grid.bounds.ne], {
                opacity: 1, interactive: false,
            }).addTo(group);
        }
        if (contourMode === 'lines' || contourMode === 'both') {
            const bands = makeBandsForRange(dbDomain.min, dbDomain.max, contourStepDb);
            // Iso-line at every band boundary.
            const thresholds = bands.map((b) => b.lo).concat([bands[bands.length - 1]?.hi ?? dbDomain.max]);
            // Bicubic-upscale the grid 4× before contour generation: d3-contour's
            // marching-squares produces visibly blocky lines on coarse rasters,
            // and second-order interpolation between cells smooths them out at
            // negligible cost (10k cells → 160k cells, ~30 ms total in practice).
            const upsFactor = 4;
            const ups = bicubicUpscale(grid.dbA, grid.cols, grid.rows, upsFactor);
            const upsGrid = {
                cols: ups.cols, rows: ups.rows, bounds: grid.bounds,
                dbA: ups.data, computedMs: 0,
            };
            const sets = buildContourLines(upsGrid, thresholds);
            for (const s of sets) {
                const t = Math.max(0, Math.min(1, (s.threshold - dbDomain.min) / (dbDomain.max - dbDomain.min || 1)));
                const colour = paletteCss(palette, t);
                // White halo + coloured stroke for legibility on both satellite and OSM.
                for (const line of s.lines) {
                    L.polyline(line, {
                        color: '#ffffff', weight: 4, opacity: 0.6, interactive: false,
                    }).addTo(group);
                    const main = L.polyline(line, {
                        color: colour, weight: 1.5,
                        opacity: contourMode === 'lines' ? 1 : 0.95,
                        interactive: false,
                    });
                    main.addTo(group);
                    // One label per line, placed at the midpoint and rotated to follow
                    // the line's tangent.
                    if (line.length >= 4) {
                        const midIdx = Math.floor(line.length / 2);
                        const a = line[midIdx - 1];
                        const b = line[midIdx];
                        const angle = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
                        const tilt = angle > 90 ? angle - 180 : angle < -90 ? angle + 180 : angle;
                        L.marker(b, {
                            icon: L.divIcon({
                                className: 'contour-label',
                                html: `<div style="background:rgba(255,255,255,0.85);border:0.5px solid #1f2937;border-radius:3px;padding:0 4px;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:600;font-variant-numeric:tabular-nums;color:#1f2937;white-space:nowrap;transform:rotate(${-tilt}deg);transform-origin:center">${s.threshold.toFixed(0)}</div>`,
                                iconSize: [22, 12],
                                iconAnchor: [11, 6],
                            }),
                            interactive: false,
                        }).addTo(group);
                    }
                }
            }
        }
        if (markersGroupRef.current) {
            markersGroupRef.current.remove();
            markersGroupRef.current.addTo(map);
        }
    }, [grid, showContours, contourMode, contourOpacity, palette, dbDomain.min, dbDomain.max]);
    useEffect(() => {
        if (!containerRef.current)
            return;
        containerRef.current.style.cursor = addMode === 'none' ? '' : 'crosshair';
    }, [addMode]);
    return _jsx("div", { ref: containerRef, style: { position: 'absolute', inset: 0 } });
}
