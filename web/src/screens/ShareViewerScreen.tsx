// The public share viewer: `/share/:token`, no sign-in.
//
// Written from scratch rather than by configuring `MapView` into a read-only
// mode, and that is a security decision rather than a stylistic one. MapView
// imports the catalog and the solver, carries every editing handler the app
// has, and decides what is interactive from ~40 props. Reusing it would mean
// the guarantee "the viewer cannot edit and cannot calculate" rested on every
// one of those props being passed correctly, forever, by everyone who touches
// it. Here the guarantee is structural: there is no project object, no catalog
// import, no solver import, and no mutation path in this file to get wrong.
//
// Everything on screen came out of the share document. The viewer's period and
// wind-speed dropdowns swap between states that were computed and embedded at
// publish time; nothing is derived, interpolated, or recomputed.

import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { escapeHtml } from '../lib/html';
import { paletteRgb, tForDb, type Palette } from '../lib/colormap';
import { PERIOD_LABEL } from '../lib/modes';
import {
  NO_RESULT, isShareToken, shareIsLive,
  type ShareDoc, type SharePayload, type ShareState,
} from '../lib/share';
import type { Period } from '../lib/types';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; doc: ShareDoc; payload: SharePayload };

/// `token` is passed in rather than read with `useParams`. This screen is
/// matched by App BEFORE the `<Routes>` tree — it has to be, so a public link
/// never touches the auth gate — which means there is no route context for
/// `useParams` to read and it would silently return an empty object, turning
/// every valid link into "that link is not valid".
export function ShareViewerScreen({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // Keep the token out of the document title and out of any analytics
    // surface. It is a live credential; a title lands in browser history and
    // in screen-share recordings.
    document.title = 'Shared noise assessment';
    (async () => {
      // Checked before the lookup so a malformed path is refused locally, and
      // so nothing but [A-Za-z0-9]{32} can ever address a document path.
      if (!isShareToken(token)) {
        setLoad({ status: 'error', message: 'That link is not valid.' });
        return;
      }
      try {
        const snap = await getDoc(doc(db(), 'shares', token));
        if (cancelled) return;
        if (!snap.exists()) {
          // The rules deny an expired or revoked share the same way they deny
          // a token that never existed, and the client cannot tell them apart.
          // Saying so plainly beats guessing at which it was.
          setLoad({
            status: 'error',
            message: 'This link has expired, been withdrawn, or never existed.',
          });
          return;
        }
        const d = snap.data() as ShareDoc;
        if (!shareIsLive(normaliseDates(d))) {
          setLoad({ status: 'error', message: 'This link has expired or been withdrawn.' });
          return;
        }
        if (!d.payload) {
          setLoad({
            status: 'error',
            message: 'This share’s data could not be loaded. Ask for a fresh link.',
          });
          return;
        }
        setLoad({ status: 'ready', doc: d, payload: d.payload });
      } catch {
        // A rules denial arrives here as a permission error. Same message: the
        // reader cannot act on the distinction, and spelling out which
        // condition failed would confirm that a token exists.
        if (!cancelled) {
          setLoad({
            status: 'error',
            message: 'This link has expired, been withdrawn, or never existed.',
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (load.status === 'loading') {
    return <Centred>Loading…</Centred>;
  }
  if (load.status === 'error') {
    return (
      <Centred>
        <div style={{ fontSize: 15, marginBottom: 6 }}>{load.message}</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          Shared noise assessments are published with an expiry date and can be withdrawn
          by their author.
        </div>
      </Centred>
    );
  }
  return <ShareMap doc={load.doc} payload={load.payload} />;
}

/// Firestore hands back a Timestamp for `expiresAt`; the share type models the
/// ISO string the function also writes. Normalise before comparing.
function normaliseDates(d: ShareDoc): { revoked: boolean; expiresAt: string } {
  const raw = d.expiresAt as unknown;
  if (raw && typeof raw === 'object' && 'toDate' in raw) {
    return { revoked: d.revoked, expiresAt: (raw as { toDate(): Date }).toDate().toISOString() };
  }
  return { revoked: d.revoked, expiresAt: String(d.expiresAt) };
}

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', gap: 4, padding: 24, textAlign: 'center',
    }}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------- map

function ShareMap({ doc: share, payload }: { doc: ShareDoc; payload: SharePayload }) {
  const states = payload.states ?? [];
  const periods = useMemo(
    () => (['day', 'evening', 'night'] as Period[]).filter(
      (p) => states.some((s) => s.period === p),
    ),
    [states],
  );
  const [period, setPeriod] = useState<Period>(periods[0] ?? 'night');
  const speeds = useMemo(
    () => [...new Set(states.filter((s) => s.period === period).map((s) => s.windSpeed))]
      .sort((a, b) => a - b),
    [states, period],
  );
  const [windSpeed, setWindSpeed] = useState<number | null>(null);
  // A period switch can leave the chosen wind speed with no state behind it.
  const activeSpeed = windSpeed != null && speeds.includes(windSpeed) ? windSpeed : speeds[0];
  const state = states.find((s) => s.period === period && s.windSpeed === activeSpeed);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Watermark share={share} payload={payload} />
      <div className="add-row" style={{ padding: '6px 10px', alignItems: 'center', gap: 8 }}>
        {periods.length > 1 && (
          <>
            <span style={{ fontSize: 11 }}>Period</span>
            <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              {periods.map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
            </select>
          </>
        )}
        {speeds.length > 1 && (
          <>
            <span style={{ fontSize: 11, marginLeft: 8 }}>Wind speed</span>
            <select
              value={activeSpeed ?? ''}
              onChange={(e) => setWindSpeed(Number(e.target.value))}
            >
              {speeds.map((w) => <option key={w} value={w}>{w} m/s</option>)}
            </select>
          </>
        )}
        <span style={{ fontSize: 11, opacity: 0.7, marginLeft: 'auto' }}>
          {/* Says what the viewer is, so nobody mistakes a frozen snapshot for
              a live model they can interrogate. */}
          View only · levels as published
        </span>
      </div>
      <LeafletCanvas payload={payload} state={state} />
    </div>
  );
}

function Watermark({ share, payload }: { share: ShareDoc; payload: SharePayload }) {
  const published = payload.publishedAt ? new Date(payload.publishedAt) : null;
  const isDraft = (payload.draftOrFinal ?? share.draftOrFinal) === 'draft';
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
      padding: '8px 10px', borderBottom: '1px solid var(--line, #ddd)',
      background: 'var(--panel, #fff)',
    }}>
      <b style={{ fontSize: 14 }}>{payload.projectName}</b>
      {share.label && <span style={{ fontSize: 12, opacity: 0.8 }}>{share.label}</span>}
      {isDraft && (
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: '1px 6px',
          border: '1px solid var(--amber, #b26a00)', color: 'var(--amber, #b26a00)',
          borderRadius: 3,
        }}>DRAFT</span>
      )}
      <span style={{ fontSize: 11, opacity: 0.7, marginLeft: 'auto' }}>
        Prepared by Resonate Consultants
        {published && ` · ${published.toLocaleDateString()}`}
      </span>
    </div>
  );
}

function LeafletCanvas({
  payload, state,
}: { payload: SharePayload; state: ShareState | undefined }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  // Create the map once.
  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, { zoomControl: true, attributionControl: true });
    const base = payload.display?.baseMap === 'satellite'
      ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Imagery © Esri', maxZoom: 19,
      })
      : L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors', maxZoom: 19,
      });
    base.addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    map.setView([-33.6, 138.7], 12);
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw everything whenever the chosen state changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds = L.latLngBounds([]);

    if (state?.grid) drawGrid(layer, state.grid, payload, bounds);
    for (const set of state?.contours ?? []) {
      for (const line of set.lines) {
        if (line.length < 2) continue;
        L.polyline(line as [number, number][], {
          color: set.label ? '#c0392b' : '#333',
          weight: set.label ? 2.5 : 1.2,
          opacity: 0.9,
          interactive: false,
        }).addTo(layer);
        for (const p of line) bounds.extend(p as [number, number]);
      }
    }

    for (const b of payload.barriers ?? []) {
      if (b.polylineLatLng.length < 2) continue;
      L.polyline(b.polylineLatLng as [number, number][], {
        color: '#7f5539', weight: 3, interactive: false,
      }).addTo(layer);
      for (const p of b.polylineLatLng) bounds.extend(p as [number, number]);
    }

    for (const s of payload.sources ?? []) {
      L.circleMarker(s.latLng as [number, number], {
        radius: 4, color: '#1f2937', weight: 1.5, fillColor: '#fff', fillOpacity: 1,
      }).bindTooltip(
        // Escaped: names travel from a project into a public page. The payload
        // is server-shaped, but the viewer is the last place this can go wrong
        // and it costs nothing to be certain here.
        escapeHtml([s.name, s.modelName, s.modeName].filter(Boolean).join(' · ')),
      ).addTo(layer);
      bounds.extend(s.latLng as [number, number]);
    }

    const levels = new Map((state?.receivers ?? []).map((r) => [r.id, r]));
    for (const r of payload.receivers ?? []) {
      const lv = levels.get(r.id);
      const over = lv?.exceeds === true;
      const shown = lv?.assessedDb ?? lv?.levelDb ?? null;
      L.circleMarker(r.latLng as [number, number], {
        radius: 6,
        color: over ? '#c0392b' : '#1f2937',
        weight: 2,
        fillColor: over ? '#c0392b' : '#2ecc71',
        fillOpacity: 0.85,
      }).bindTooltip(
        escapeHtml(
          `${r.name}: ${shown == null ? 'no result' : `${shown.toFixed(1)} dB`}`
          + (lv ? ` (limit ${lv.limitDb} dB)` : ''),
        ),
      ).addTo(layer);
      bounds.extend(r.latLng as [number, number]);
    }

    if (bounds.isValid()) map.fitBounds(bounds.pad(0.12));
  }, [state, payload]);

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />;
}

/// Paint the embedded raster as an image overlay.
function drawGrid(
  layer: L.LayerGroup,
  grid: NonNullable<ShareState['grid']>,
  payload: SharePayload,
  bounds: L.LatLngBounds,
) {
  const { cols, rows, dbA } = grid;
  if (cols <= 0 || rows <= 0 || dbA.length < cols * rows) return;
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(cols, rows);
  const palette = (payload.display?.palette ?? 'viridis') as Palette;
  const lo = payload.display?.contourMin ?? 25;
  const hi = payload.display?.contourMax ?? 60;
  for (let row = 0; row < rows; row++) {
    // The raster is stored south-row-first; canvas rows run north-first.
    const src = rows - 1 - row;
    for (let col = 0; col < cols; col++) {
      const v = dbA[src * cols + col];
      const i = (row * cols + col) * 4;
      if (v === NO_RESULT) { img.data[i + 3] = 0; continue; }
      const [r, g, b] = paletteRgb(palette, tForDb(v, lo, hi));
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
      img.data[i + 3] = 160;
    }
  }
  ctx.putImageData(img, 0, 0);
  const sw = grid.bounds.sw;
  const ne = grid.bounds.ne;
  L.imageOverlay(canvas.toDataURL(), [sw, ne], { opacity: 1, interactive: false }).addTo(layer);
  bounds.extend(sw as [number, number]);
  bounds.extend(ne as [number, number]);
}
