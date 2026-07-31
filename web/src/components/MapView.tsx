import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Project, Receiver, Source, ReferenceLayerStyle } from '../lib/types';
import { limitForPeriod } from '../lib/types';
import { exceedsLimit, limitComparisonFor, type LimitComparison } from '../lib/limits';
import type { ReceiverResult, GridResult } from '../lib/solver';
import { paletteRgb, paletteCss, type Palette, tForDb, makeBandsForRange } from '../lib/colormap';
import { buildContourLines } from '../lib/contourLines';
import { footprintFor, lookupEntry, resolveContainer } from '../lib/catalog';

export type ContourMode = 'filled' | 'lines' | 'both';

export type BaseMap = 'satellite' | 'osm';

interface Props {
  project: Project;
  results: ReceiverResult[] | null;
  grid: GridResult | null;
  /// Set of currently-selected source / receiver IDs.
  selectedIds: Set<string>;
  /// Click handler. `modifiers.shift` is true when the user shift-clicked
  /// (toggle membership in the selection); otherwise the parent should
  /// reset selection to just this id.
  onSelect(id: string | null, modifiers?: { shift?: boolean }): void;
  /// Box-select handler — fired with the IDs of every source / receiver
  /// inside the user's drag rectangle. `modifiers.shift` true → add to the
  /// existing selection; otherwise replace.
  onBoxSelect(ids: string[], modifiers?: { shift?: boolean }): void;
  onAddSource?(latLng: [number, number]): void;
  onAddReceiver?(latLng: [number, number]): void;
  /// Called once the user finishes a barrier draw (double-click / Enter).
  /// The polyline carries every vertex placed (≥2). Parent picks the next
  /// id, default name, default height etc.
  onAddBarrierPolyline?(polyline: Array<[number, number]>): void;
  /// Called on barrier-vertex drag-end. The vertex array IS the new
  /// `polylineLatLng` value — parent replaces it wholesale (and saves
  /// it to the project). Same callback is used for both endpoint drags
  /// (single vertex moved) and midpoint drags (every vertex shifted by
  /// the same delta).
  onUpdateBarrier?(id: string, polyline: Array<[number, number]>): void;
  onMoveSource?(id: string, latLng: [number, number]): void;
  onMoveReceiver?(id: string, latLng: [number, number]): void;
  /// Calc-area edit callbacks. `onResizeCalcArea` is called when a corner
  /// handle is dragged (centre stays fixed); `onMoveCalcArea` when the
  /// centre handle is dragged.
  onResizeCalcArea?(widthM: number, heightM: number): void;
  onMoveCalcArea?(centerLatLng: [number, number]): void;
  /// BESS-group on-map editing callbacks. `onOpenBessGroupWizard` opens
  /// the editor wizard for a group (fired on double-click of any
  /// group member). `onMoveBessGroup` is fired on centre-handle drag.
  /// `onRotateBessGroup` is fired on rotation-handle drag.
  onOpenBessGroupWizard?(group: import('../lib/types').BessGroup): void;
  onMoveBessGroup?(groupId: string, newCenter: [number, number]): void;
  onRotateBessGroup?(groupId: string, newRotationDeg: number): void;
  /// The active saved (general) group, if a group is the current selection.
  /// Drives the on-map drag/rotate handles for that group.
  selectedGroupId?: string | null;
  /// Translate every member of a general group by a lat/lng delta (centre-
  /// handle drag). `onRotateGroup` rotates members about the group centroid by
  /// an incremental angle in degrees (rotation-handle drag).
  onTranslateGroup?(groupId: string, dLat: number, dLng: number): void;
  onRotateGroup?(groupId: string, deltaDeg: number): void;
  addMode: 'none' | 'wtg' | 'bess' | 'auxiliary' | 'receiver' | 'measure' | 'barrier';
  baseMap: BaseMap;
  showContours: boolean;
  /// Debug overlay — paints a small dot at every grid cell centre so the
  /// user can eyeball alignment between the raster, contour lines, and
  /// the actual sampled cells. Off by default.
  showGridDebug?: boolean;
  /// I1: draw the active period's limit as a second line on receiver markers.
  showReceiverLimits?: boolean;
  contourMode: ContourMode;
  contourOpacity: number;
  /// Step (dB) between iso-line thresholds, e.g. 5 dB.
  contourStepDb: number;
  palette: Palette;
  /// dB range used as the colormap domain.
  dbDomain: { min: number; max: number };
  /// Notified on every map mousemove with the cursor's lat/lng (and `null`
  /// when the cursor leaves the map). Throttled to one update per animation
  /// frame to avoid render storms.
  onCursorMove?(latLng: [number, number] | null): void;
  /// Receives an imperative handle to drive the map programmatically — used
  /// by the floating MapControls panel for zoom / pan / home actions.
  onReady?(map: L.Map): void;
}

const SOURCE_KIND_COLOR: Record<string, string> = {
  wtg: '#2A2A2A',
  bess: '#5e35b1',
  inverter: '#1565c0',
  transformer: '#c62828',
};

function sourceMarker(
  s: Source,
  selected: boolean,
  groupColor: string | undefined,
  /// Rotation (clockwise from north) applied to the unit's footprint
  /// rectangle for BESS / Auxiliary markers. Used by the BESS-group path
  /// (fix #7) so each unit's rectangle rotates with the parent group
  /// rather than staying axis-aligned. WTGs ignore this.
  groupYawDeg?: number,
): L.DivIcon {
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
  // Rotate the rect (and the group/selection rings stay axis-aligned so
  // the selection halo still reads as a halo, not a tilted ellipse).
  // groupYawDeg is in degrees clockwise from north == SVG-clockwise.
  const rectTransform = (typeof groupYawDeg === 'number' && Number.isFinite(groupYawDeg))
    ? ` transform="rotate(${groupYawDeg})"`
    : '';
  return L.divIcon({
    className: 'eqpt-marker',
    html: `<svg width="28" height="28" viewBox="-14 -14 28 28" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.4))">
      ${selRing}
      ${groupRing}
      <rect${rectTransform} x="-9" y="-6" width="18" height="12" rx="1" fill="${colour}" stroke="#fff" stroke-width="1.4"/>
    </svg>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function receiverMarker(
  _r: Receiver,
  dbA: number | null,
  activeLimit: number,
  selected: boolean,
  groupColor: string | undefined,
  mode: LimitComparison,
  showLimit: boolean,
): L.DivIcon {
  // The pass/fail rule lives in one place (I17) — never compare inline here.
  // Note the DISPLAYED level keeps full precision: only the verdict rounds, so
  // a green marker reading 40.4 against a 40 limit is correct, not a glitch.
  const fail = exceedsLimit(dbA, activeLimit, mode);
  const colour = fail ? '#d32f2f' : '#2e7d32';
  const text = dbA != null ? `${dbA.toFixed(1)}` : '— ';
  const dotBorder = selected ? '#F2CB00' : (groupColor ?? '#fff');
  const dotBorderWidth = selected ? 3 : 2;
  // I1: the active period's limit, smaller and dimmer under the level.
  const limitLine = showLimit && Number.isFinite(activeLimit)
    ? `<div style="font-size:9px;font-weight:500;opacity:.65;line-height:1.1;margin-top:-1px">
        limit ${activeLimit.toFixed(0)}
      </div>`
    : '';
  return L.divIcon({
    className: 'recv-marker',
    html: `<div style="display:flex;flex-direction:column;align-items:center;gap:0;pointer-events:auto">
      <div style="background:rgba(255,255,255,0.92);backdrop-filter:blur(6px);border:${selected ? 2 : 1.5}px solid ${selected ? '#F2CB00' : '#2A2A2A'};border-radius:99px;padding:2px 9px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;color:${colour};white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.3);text-align:center">
        <div>${text} <span style="opacity:.6;font-weight:400">dB(A)</span></div>
        ${limitLine}
      </div>
      <div style="width:0;height:8px;border-left:1.5px dashed ${colour}"></div>
      <div style="width:14px;height:14px;border-radius:50%;border:${dotBorderWidth}px solid ${dotBorder};background:${colour};box-shadow:0 1px 2px rgba(0,0,0,.4)"></div>
    </div>`,
    iconSize: [80, showLimit ? 54 : 42],
    iconAnchor: [40, showLimit ? 50 : 38],
  });
}

const TILE_URLS: Record<BaseMap, { url: string; attribution: string; max: number; subdomains?: string }> = {
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
    // Bumped back to 22 because the custom EsriCanvasTileLayer below
    // can now handle placeholders properly: it samples each loaded
    // tile, and if it detects the Esri placeholder it recursively
    // walks UP the zoom tree (z-1, z-2, ...) until it finds real
    // imagery and draws THAT scaled into the canvas, cropped to the
    // current tile's quadrant. So you get pixelated real imagery
    // at high zooms in poorly-covered areas instead of the gray text
    // card -- the behaviour the user has been asking for from the
    // start.
    max: 22,
  },
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap',
    max: 19,
    subdomains: 'abc',
  },
};

// ===== Esri placeholder detection + parent-tile canvas fallback =====
//
// Esri's World Imagery returns a "Map data not yet available" placeholder
// PNG with HTTP 200 in poorly-covered areas, so there's no error code
// to filter on. We work around it with a custom GridLayer that emits
// <canvas> tiles instead of <img> tiles. For each requested tile we
// load Esri's image, check whether it's the placeholder, and if so
// recursively load the PARENT tile (z-1), drawing the relevant
// quadrant into the canvas at 2x scale. Recursion continues up the
// zoom tree until a real tile is found; floors at z=10 (always
// covered globally).
//
// All loaded tile images are cached by (z, x, y) so a single parent
// tile reused by all four children only fetches once. Cache is
// per-layer-instance and cleared on layer removal.

/// Pixel-sampling detector for Esri's placeholder PNG. Heuristic:
/// sample 8 corner-ish pixels (avoiding the central text area), require
/// all of them to be near-grayscale (R≈G≈B), within Esri's grey band
/// (180-220), and low variance. Real satellite imagery virtually never
/// looks like that. Returns false on CORS-tainted canvases (the bail
/// path) so an unconfigured CORS setup degrades gracefully to the
/// "show placeholder" baseline.
function isEsriPlaceholder(img: HTMLImageElement | HTMLCanvasElement, ctx: CanvasRenderingContext2D): boolean {
  // Draw image into ctx first if it's an HTMLImageElement; canvases
  // are already drawn.
  try {
    if (img instanceof HTMLImageElement) {
      if (img.naturalWidth !== 256 || img.naturalHeight !== 256) return false;
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(img, 0, 0);
    }
    const xs = [16, 64, 192, 240, 16, 192, 64, 240];
    const ys = [16, 32, 32, 16, 240, 224, 224, 240];
    let sumGrey = 0;
    const greys: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const d = ctx.getImageData(xs[i], ys[i], 1, 1).data;
      const r = d[0], g = d[1], b = d[2];
      // Hard reject as soon as any sample fails the grey test --
      // satellite imagery usually fails fast on the first sample.
      const maxChan = Math.max(r, g, b);
      const minChan = Math.min(r, g, b);
      if (maxChan - minChan > 8) return false;
      const grey = (r + g + b) / 3;
      if (grey < 180 || grey > 220) return false;
      greys.push(grey);
      sumGrey += grey;
    }
    const mean = sumGrey / greys.length;
    let variance = 0;
    for (const v of greys) variance += (v - mean) * (v - mean);
    variance /= greys.length;
    return variance < 40;
  } catch {
    return false;
  }
}

/// Load an Esri tile as an HTMLImageElement. Returns null on error.
/// All requests are CORS-anonymous so the canvas reads aren't tainted.
function loadEsriTileImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/// Custom canvas-based tile layer for Esri. Detects placeholders and
/// substitutes with the parent tile at 2x scale, recursing as needed.
/// Subclasses L.GridLayer so each tile is a fresh <canvas> we control.
const EsriCanvasTileLayer = L.GridLayer.extend({
  initialize: function (options: L.GridLayerOptions & { urlTemplate: string }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (L.GridLayer.prototype as any).initialize.call(this, options);
    // Per-layer-instance image cache: key = "z/x/y" -> Promise<image|null>.
    // Shared across siblings so a parent tile fetched on behalf of one
    // quadrant is reused for the other three without an extra request.
    this._tileCache = new Map<string, Promise<HTMLImageElement | null>>();
  },
  // Floor for the recursive fallback. Z=10 always has global imagery
  // (e.g. for Australia, even ocean tiles return something at z=10).
  _floorZoom: 10,

  _tileKey: function (z: number, x: number, y: number) {
    return `${z}/${x}/${y}`;
  },
  _urlFor: function (z: number, x: number, y: number) {
    // The TileLayer URL template uses {z}/{y}/{x} for Esri. Mimic.
    return (this.options.urlTemplate as string)
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
  },
  _loadImage: function (z: number, x: number, y: number): Promise<HTMLImageElement | null> {
    const key = this._tileKey(z, x, y);
    const cached = this._tileCache.get(key);
    if (cached) return cached;
    const p = loadEsriTileImage(this._urlFor(z, x, y));
    this._tileCache.set(key, p);
    return p;
  },

  createTile: function (coords: { z: number; x: number; y: number }, done: (err: Error | null, tile: HTMLElement) => void) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      // No 2d context? Shouldn't happen in any real browser. Bail.
      done(null, canvas);
      return canvas;
    }
    // Async resolution path: load the tile, check if placeholder,
    // walk up if needed, paint to canvas, call done().
    const that = this;
    (async () => {
      // Walk up the zoom tree until we find a non-placeholder tile,
      // or until we hit the floor. Track how many levels we climbed
      // so we know the upscale factor + quadrant offset for drawing.
      let z = coords.z, x = coords.x, y = coords.y;
      let scale = 1;        // 2^(levelsUp) -- how much to scale the source image when drawing
      let img: HTMLImageElement | null = null;
      while (z >= that._floorZoom) {
        img = await that._loadImage(z, x, y);
        if (img && !isEsriPlaceholder(img, ctx)) break;
        // Placeholder (or load failure): try the parent. Each level
        // up doubles the scale at which we'll draw the source.
        z -= 1;
        x = Math.floor(x / 2);
        y = Math.floor(y / 2);
        scale *= 2;
      }
      if (!img) {
        // Total miss (even the floor failed). Leave the canvas blank
        // -- the leaflet background colour shows; same as a 404.
        done(null, canvas);
        return;
      }
      // Figure out which quadrant of the source tile we want. Each
      // step up halves the coordinate; the LOST low bits tell us
      // which quadrant the original (coords.x, coords.y) lived in
      // relative to the ancestor we ended up at.
      const levelsUp = Math.log2(scale);                     // integer
      const subTilesPerSide = scale;                         // e.g. 1 / 2 / 4 / 8...
      const localX = coords.x & (subTilesPerSide - 1);       // lower N bits
      const localY = coords.y & (subTilesPerSide - 1);
      // Source rect within the parent (256 px wide) that we want to
      // sample and stretch to fill our 256x256 canvas.
      const srcSize = 256 / subTilesPerSide;
      const srcX = localX * srcSize;
      const srcY = localY * srcSize;
      ctx.imageSmoothingEnabled = false;     // crisp pixelation, matches Leaflet CSS upscale
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, 256, 256);
      // If we drew an upscaled parent (levelsUp > 0), faintly tag
      // the tile so the user can tell the resolution dropped --
      // optional, lightly subtle.
      if (levelsUp > 0) {
        // Intentionally no-op: the natural pixelation is the
        // indicator. Keep this block as a deliberate decision rather
        // than a forgotten TODO -- if visual annotation becomes
        // desired, add a thin border or watermark here.
      }
      done(null, canvas);
    })().catch(() => {
      // Should never happen with the resolve-on-error pattern above,
      // but keep the handler so promise rejections don't go silently
      // into the void.
      done(null, canvas);
    });
    return canvas;
  },
});

// 1x1 transparent PNG. Returned in place of any tile that errors / 404s
// so Leaflet keeps showing the prior good (up-sampled) tile rather than
// rendering the provider's "Map data not yet available" placeholder.
const TRANSPARENT_TILE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function tileLayerOpts(b: BaseMap): L.TileLayerOptions {
  const cfg = TILE_URLS[b];
  return {
    // Two separate caps: `maxNativeZoom` is the highest zoom the tile
    // server actually has imagery for; `maxZoom` is how far Leaflet
    // will let the user zoom regardless. Above maxNativeZoom Leaflet
    // up-samples the deepest available tile, so the basemap stays
    // visible (pixelated) instead of going blank when the user wants
    // to inspect close-up geometry.
    maxNativeZoom: cfg.max,
    maxZoom: 24,
    attribution: cfg.attribution,
    crossOrigin: true,
    subdomains: cfg.subdomains ?? 'abc',
    // Silence HTTP-error placeholders. (Esri's HTTP-200 placeholder
    // PNGs are handled inside EsriCanvasTileLayer, not here.)
    errorTileUrl: TRANSPARENT_TILE,
    // Keep adjacent tiles around when panning so they don't pop out
    // before the new ones arrive.
    keepBuffer: 4,
  };
}

/// Build the right tile layer for a base map. Satellite uses the
/// EsriCanvasTileLayer so we get parent-tile fallback whenever Esri
/// serves the placeholder. Other base maps use the stock L.tileLayer.
/// Build a reference-layer point as the chosen shape. Circle uses a vector
/// circleMarker; square / triangle use an inline-SVG divIcon so stroke + fill
/// + opacities all apply consistently.
function refPointLayer(latlng: [number, number], s: ReferenceLayerStyle): L.Layer {
  const shape = s.pointShape ?? 'circle';
  const size = Math.max(2, s.pointSizePx ?? 5);
  if (shape === 'circle') {
    return L.circleMarker(latlng, {
      radius: size, color: s.stroke, weight: s.weight, opacity: s.opacity,
      fillColor: s.fill, fillOpacity: s.fillOpacity, interactive: false,
    });
  }
  const w = Math.max(0, s.weight);
  const pad = w + 1;
  const span = size * 2;
  const dim = span + pad * 2;
  const cx = dim / 2;
  const inner = shape === 'square'
    ? `<rect x="${pad}" y="${pad}" width="${span}" height="${span}" />`
    : `<polygon points="${cx},${pad} ${pad},${dim - pad} ${dim - pad},${dim - pad}" />`;
  const svg = `<svg width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" style="overflow:visible">`
    + `<g fill="${s.fill}" fill-opacity="${s.fillOpacity}" stroke="${s.stroke}" stroke-width="${w}" stroke-opacity="${s.opacity}">${inner}</g></svg>`;
  return L.marker(latlng, {
    interactive: false,
    icon: L.divIcon({ className: 'ref-point', html: svg, iconSize: [dim, dim], iconAnchor: [cx, cx] }),
  });
}

function makeBaseLayer(b: BaseMap): L.Layer {
  const cfg = TILE_URLS[b];
  if (b === 'satellite') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (EsriCanvasTileLayer as any)({
      urlTemplate: cfg.url,
      maxNativeZoom: cfg.max,
      maxZoom: 24,
      attribution: cfg.attribution,
      keepBuffer: 4,
    });
  }
  return L.tileLayer(cfg.url, tileLayerOpts(b));
}

function gridToCanvas(
  grid: GridResult,
  palette: Palette,
  opacity: number,
  domainLo: number,
  domainHi: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols;
  canvas.height = grid.rows;
  const ctx = canvas.getContext('2d')!;
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

export function MapView({
  project, results, grid, selectedIds, onSelect, onBoxSelect,
  onAddSource, onAddReceiver, onAddBarrierPolyline, onUpdateBarrier, onMoveSource, onMoveReceiver,
  onResizeCalcArea, onMoveCalcArea,
  onOpenBessGroupWizard, onMoveBessGroup, onRotateBessGroup,
  selectedGroupId, onTranslateGroup, onRotateGroup,
  addMode, baseMap, showContours, showGridDebug, showReceiverLimits, contourMode, contourOpacity, contourStepDb,
  palette, dbDomain, onCursorMove, onReady,
}: Props) {
  // Map: object id → group color (for the small ring around the marker).
  const groupColorById = new Map<string, string>();
  for (const g of project.groups ?? []) {
    if (!g.color) continue;
    for (const id of g.memberIds) groupColorById.set(id, g.color);
  }
  // Map: BessGroup id → rotation in degrees, used by sourceMarker to
  // rotate each unit's footprint rectangle so it stays oriented with
  // the parent group (fix #7). Built once per render from the live
  // bessGroups list -- cheap; usually a handful of groups.
  const bessGroupRotById = new Map<string, number>();
  for (const bg of project.bessGroups ?? []) {
    bessGroupRotById.set(bg.id, bg.rotationDeg);
  }
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const markersGroupRef = useRef<L.LayerGroup | null>(null);
  /// Footprint polygons for BESS / Auxiliary sources — metre-true
  /// rectangles sized from the catalog entry's `footprintM`, rotated
  /// by source.yawDeg. Drawn UNDER the marker icons so the pixel-icon
  /// stays the click affordance + selection feedback while the polygon
  /// shows the real footprint at high zoom.
  const footprintsGroupRef = useRef<L.LayerGroup | null>(null);
  const overlayGroupRef = useRef<L.LayerGroup | null>(null);
  /// Grid-debug cell centres. Its own group (not the contour overlay) because
  /// it redraws on every pan — see I13 — and rebuilding the filled raster or
  /// the contour labels that often would be needlessly slow.
  const gridDebugGroupRef = useRef<L.LayerGroup | null>(null);
  /// Reference / annotation geometry (property boundaries etc.) — purely
  /// visual, drawn at the bottom z-order (just above the base tiles), never
  /// interactive so it can't intercept selection / drawing.
  const referenceGroupRef = useRef<L.LayerGroup | null>(null);
  const measureGroupRef = useRef<L.LayerGroup | null>(null);
  const measurePointsRef = useRef<L.LatLng[]>([]);
  /// Layer + draft state for the in-progress barrier draw. The layer
  /// group hosts both the persistent barrier polylines AND the live
  /// preview while the user is mid-draw. A draw accumulates an ordered
  /// list of `points` (each click drops one vertex + a `dot` marker);
  /// `cursor` is the live mouse position used to rubber-band the next
  /// segment; `preview` is the dashed polyline through points + cursor.
  /// Double-click / Enter commits (≥2 points); Esc (mode exit) cancels;
  /// Backspace removes the last vertex.
  const barriersGroupRef = useRef<L.LayerGroup | null>(null);
  const barrierDraftRef = useRef<{
    points: L.LatLng[];
    cursor: L.LatLng | null;
    preview: L.Polyline | null;
    dots: L.CircleMarker[];
  } | null>(null);
  /// BESS-group overlays: one bounding rect, rotation handle, centre
  /// handle per group. Re-rendered when project.bessGroups, the
  /// materialised sources, or the selection change.
  const bessGroupsLayerRef = useRef<L.LayerGroup | null>(null);
  /// On-map drag/rotate handles for the selected GENERAL group (bbox +
  /// centre move handle + rotation handle). Separate from the BESS-group
  /// layer so the two redraw effects don't clobber each other.
  const groupHandlesLayerRef = useRef<L.LayerGroup | null>(null);
  /// id → Leaflet Marker handle, so we can update sibling marker positions
  /// during a group drag without going through React state.
  const markersByIdRef = useRef<Map<string, L.Marker>>(new Map());
  /// Per-source footprint polygons. Lives in parallel with
  /// markersByIdRef so the live-drag handlers (single drag, BESS-group
  /// centre drag, BESS-group rotation) can translate / rotate the
  /// polygon visuals at 60 fps instead of waiting for the React state
  /// round-trip. Populated only for BESS / Auxiliary sources (WTGs use
  /// the rotor SVG icon, no polygon).
  const polysByIdRef = useRef<Map<string, L.Polygon>>(new Map());
  /// Selection set kept in a ref so drag handlers (bound at marker-effect
  /// time) read the latest set without needing the effect to re-run.
  const selectedIdsRef = useRef<Set<string>>(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; });
  /// Lets the marker drag handlers signal the box-select code to stand down.
  const cancelBoxSelectRef = useRef<() => void>(() => {});

  // Stash every callback in a ref so the marker render effect doesn't re-fire
  // on every prop identity change (cursor mousemove updates ProjectScreen
  // state on every frame, which would otherwise rebuild markers — and a
  // marker rebuilt mid-drag drops the drag interaction).
  const callbacksRef = useRef({
    onAddSource, onAddReceiver, onAddBarrierPolyline, onUpdateBarrier, onMoveSource, onMoveReceiver,
    onResizeCalcArea, onMoveCalcArea, onCursorMove, onSelect, onBoxSelect, addMode,
    onOpenBessGroupWizard, onMoveBessGroup, onRotateBessGroup,
    onTranslateGroup, onRotateGroup,
  });
  useEffect(() => {
    callbacksRef.current = {
      onAddSource, onAddReceiver, onAddBarrierPolyline, onUpdateBarrier, onMoveSource, onMoveReceiver,
      onResizeCalcArea, onMoveCalcArea, onCursorMove, onSelect, onBoxSelect, addMode,
      onOpenBessGroupWizard, onMoveBessGroup, onRotateBessGroup,
      onTranslateGroup, onRotateGroup,
    };
  });
  // ProjectScreen needs to know the lat/lng of every source/receiver to
  // resolve box-select hits — read from the latest project via a ref so the
  // event handler doesn't need re-binding.
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; });

  // Init map.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const initial = project.calculationArea?.centerLatLng ?? project.sources[0]?.latLng ?? [-33.6, 138.7];
    const map = L.map(containerRef.current, {
      center: initial, zoom: 12,
      // Allow zooming past the basemap's native max — Leaflet auto-
      // upscales the deepest available tile so the basemap stays visible
      // (pixelated) instead of going blank when the user wants to
      // inspect close-up geometry.
      maxZoom: 24,
      // Custom MapControls panel replaces Leaflet's default zoom widget.
      zoomControl: false,
      // Disable Leaflet's default left-mouse drag — we use LMB for box-select
      // and bind middle-mouse to manual pan below.
      dragging: false,
      // Right-click context menu is harmless; LMB box-select reserves left.
      boxZoom: false,
    });
    baseLayerRef.current = makeBaseLayer(baseMap).addTo(map) as L.TileLayer;
    // Reference geometry sits at the bottom (just above base tiles).
    referenceGroupRef.current = L.layerGroup().addTo(map);
    overlayGroupRef.current = L.layerGroup().addTo(map);
    gridDebugGroupRef.current = L.layerGroup().addTo(map);
    barriersGroupRef.current = L.layerGroup().addTo(map);
    measureGroupRef.current = L.layerGroup().addTo(map);
    // BESS-group overlays render UNDER the source markers (so the
    // handles draw on top of the bounding rect, and unit markers stay
    // clickable). Add to map BEFORE the markers layer.
    bessGroupsLayerRef.current = L.layerGroup().addTo(map);
    // Footprint polygons render UNDER the marker icons so the pixel
    // icon (selection halo, group ring, drag affordance) stays on
    // top -- the polygon just adds an accurate metre-true rectangle
    // around the source position so the user sees the real footprint
    // at high zoom. WTG sources don't use this layer (they're point
    // sources acoustically; the existing rotor SVG icon is fine).
    footprintsGroupRef.current = L.layerGroup().addTo(map);
    markersGroupRef.current = L.layerGroup().addTo(map);
    // General-group handles sit on top so the move/rotate grips win clicks.
    groupHandlesLayerRef.current = L.layerGroup().addTo(map);

    // ---- Middle-mouse pan (Leaflet's left-mouse drag is disabled above) ----
    const containerEl = containerRef.current!;
    let panLast: { x: number; y: number } | null = null;
    const onMmbDown = (ev: MouseEvent) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      panLast = { x: ev.clientX, y: ev.clientY };
      containerEl.style.cursor = 'grabbing';
    };
    const onMmbMove = (ev: MouseEvent) => {
      if (!panLast) return;
      const dx = ev.clientX - panLast.x;
      const dy = ev.clientY - panLast.y;
      panLast = { x: ev.clientX, y: ev.clientY };
      map.panBy([-dx, -dy], { animate: false });
    };
    const onMmbUp = (ev: MouseEvent) => {
      if (ev.button !== 1) return;
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
    let boxStart: L.LatLng | null = null;
    let boxStartPx: L.Point | null = null;
    let boxRect: L.Rectangle | null = null;
    cancelBoxSelectRef.current = () => {
      if (boxRect) { boxRect.remove(); boxRect = null; }
      boxStart = null;
      boxStartPx = null;
    };
    const onLmbDown = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      const target = ev.target as HTMLElement;
      if (target.closest('.leaflet-marker-icon, .leaflet-control')) return;
      // Polylines (the barriers) live in the SVG overlay pane and we
      // tag every interactive barrier line with a `bessty-barrier`
      // class so the box-select ignores them — clicks on a wall should
      // select the wall, not start a box-select that immediately clears
      // the selection on mouseup.
      if (target.closest('.bessty-barrier')) return;
      if (callbacksRef.current.addMode !== 'none') return;
      const cr = containerEl.getBoundingClientRect();
      const cx = ev.clientX - cr.left;
      const cy = ev.clientY - cr.top;
      boxStartPx = L.point(cx, cy);
      boxStart = map.containerPointToLatLng(boxStartPx);
    };
    containerEl.addEventListener('mousedown', onLmbDown);
    const onBoxMove = (ev: MouseEvent) => {
      if (!boxStart) return;
      const cr = containerEl.getBoundingClientRect();
      const here = map.containerPointToLatLng([ev.clientX - cr.left, ev.clientY - cr.top]);
      if (boxRect) boxRect.remove();
      boxRect = L.rectangle(L.latLngBounds(boxStart, here), {
        color: '#F2CB00', weight: 2, dashArray: '4 3', fillOpacity: 0.1,
        interactive: false,
      }).addTo(map);
    };
    const onBoxUp = (ev: MouseEvent) => {
      if (!boxStart) return;
      const cr = containerEl.getBoundingClientRect();
      const cx = ev.clientX - cr.left;
      const cy = ev.clientY - cr.top;
      const here = map.containerPointToLatLng([cx, cy]);
      const bounds = L.latLngBounds(boxStart, here);
      const dx = Math.abs((boxStartPx?.x ?? cx) - cx);
      const dy = Math.abs((boxStartPx?.y ?? cy) - cy);
      // < 4 px = treat as click (clear selection unless shift held).
      if (dx < 4 && dy < 4) {
        if (!ev.shiftKey) callbacksRef.current.onSelect(null);
      } else {
        const p = projectRef.current;
        const ids: string[] = [];
        for (const s of p.sources) {
          if (bounds.contains(L.latLng(s.latLng[0], s.latLng[1]))) ids.push(s.id);
        }
        for (const r of p.receivers) {
          if (bounds.contains(L.latLng(r.latLng[0], r.latLng[1]))) ids.push(r.id);
        }
        // Barriers picked up if ANY vertex falls inside the box. Matches
        // the most permissive selection idiom most CAD tools use and
        // doesn't require the user to drag perfectly across both ends.
        for (const b of p.barriers) {
          const hit = b.polylineLatLng.some(([la, ln]) =>
            bounds.contains(L.latLng(la, ln)),
          );
          if (hit) ids.push(b.id);
        }
        callbacksRef.current.onBoxSelect(ids, { shift: ev.shiftKey });
      }
      if (boxRect) { boxRect.remove(); boxRect = null; }
      boxStart = null;
      boxStartPx = null;
    };
    window.addEventListener('mousemove', onBoxMove);
    window.addEventListener('mouseup', onBoxUp);

    // ---- Multi-vertex barrier draw helpers ----
    // The draft (barrierDraftRef) accumulates vertices on each click; the
    // dashed preview rubber-bands from the last vertex to the cursor. These
    // close over `map` + the stable refs, so they're defined once here and
    // reused by the click / dblclick / keydown handlers below.
    const redrawBarrierDraft = () => {
      const draft = barrierDraftRef.current;
      const group = barriersGroupRef.current;
      if (!draft || !group) return;
      if (draft.preview) { draft.preview.remove(); draft.preview = null; }
      const pts = draft.cursor ? [...draft.points, draft.cursor] : draft.points.slice();
      if (pts.length >= 2) {
        draft.preview = L.polyline(pts, {
          color: '#F2CB00', weight: 3, dashArray: '6 4', opacity: 0.95,
        }).addTo(group);
      }
    };
    const clearBarrierDraft = () => {
      const draft = barrierDraftRef.current;
      if (!draft) return;
      if (draft.preview) draft.preview.remove();
      for (const d of draft.dots) d.remove();
      barrierDraftRef.current = null;
    };
    const finishBarrierDraft = () => {
      const draft = barrierDraftRef.current;
      if (!draft) return;
      const pts = draft.points.map((p): [number, number] => [p.lat, p.lng]);
      clearBarrierDraft();
      if (pts.length >= 2) callbacksRef.current.onAddBarrierPolyline?.(pts);
    };
    const undoLastBarrierVertex = () => {
      const draft = barrierDraftRef.current;
      if (!draft || draft.points.length === 0) return;
      draft.points.pop();
      const dot = draft.dots.pop();
      if (dot) dot.remove();
      redrawBarrierDraft();
    };
    // Enter commits the polyline; Backspace removes the last vertex. (Esc is
    // handled by ProjectScreen, which exits barrier mode → the mode-change
    // effect clears the draft.)
    const onBarrierKey = (ev: KeyboardEvent) => {
      if (callbacksRef.current.addMode !== 'barrier' || !barrierDraftRef.current) return;
      if (ev.key === 'Enter') { ev.preventDefault(); finishBarrierDraft(); }
      else if (ev.key === 'Backspace') { ev.preventDefault(); undoLastBarrierVertex(); }
    };
    window.addEventListener('keydown', onBarrierKey);

    map.on('dblclick', () => {
      // doubleClickZoom is disabled while in barrier mode (see the addMode
      // effect), so this only commits the wall.
      if (callbacksRef.current.addMode === 'barrier') finishBarrierDraft();
    });

    map.on('click', (e: L.LeafletMouseEvent) => {
      const { addMode, onAddSource, onAddReceiver } = callbacksRef.current;
      const latLng: [number, number] = [e.latlng.lat, e.latlng.lng];
      if (addMode === 'barrier') {
        const group = barriersGroupRef.current;
        if (!group) return;
        let draft = barrierDraftRef.current;
        if (!draft) {
          draft = { points: [], cursor: null, preview: null, dots: [] };
          barrierDraftRef.current = draft;
        }
        // A double-click fires two `click`s at (almost) the same pixel before
        // the `dblclick`. Drop the near-duplicate so we don't append a
        // zero-length vertex at the finish point.
        const last = draft.points[draft.points.length - 1];
        if (last && map.latLngToContainerPoint(last)
          .distanceTo(map.latLngToContainerPoint(e.latlng)) < 8) {
          return;
        }
        draft.points.push(e.latlng);
        draft.dots.push(
          L.circleMarker(e.latlng, {
            radius: 4, color: '#F2CB00', fillColor: '#F2CB00', fillOpacity: 1, weight: 2,
          }).addTo(group),
        );
        redrawBarrierDraft();
        return;
      }
      if (addMode === 'measure') {
        const pts = measurePointsRef.current;
        const group = measureGroupRef.current;
        if (!group) return;
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
      if (addMode === 'receiver') onAddReceiver?.(latLng);
      else onAddSource?.(latLng);
    });

    // Cursor tracking, throttled to one update per animation frame.
    // Also drives the barrier-draw preview line when the user has just
    // placed the first endpoint and is hovering for the second.
    let pendingCursorUpdate: number | null = null;
    let pendingLatLng: [number, number] | null = null;
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      pendingLatLng = [e.latlng.lat, e.latlng.lng];
      if (pendingCursorUpdate == null) {
        pendingCursorUpdate = requestAnimationFrame(() => {
          callbacksRef.current.onCursorMove?.(pendingLatLng);
          pendingCursorUpdate = null;
        });
      }
      const draft = barrierDraftRef.current;
      if (draft && barriersGroupRef.current && draft.points.length > 0) {
        draft.cursor = e.latlng;
        redrawBarrierDraft();
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
      if (pendingCursorUpdate != null) cancelAnimationFrame(pendingCursorUpdate);
      containerEl.removeEventListener('mousedown', onMmbDown);
      containerEl.removeEventListener('mousedown', onLmbDown);
      window.removeEventListener('mousemove', onMmbMove);
      window.removeEventListener('mouseup', onMmbUp);
      window.removeEventListener('mousemove', onBoxMove);
      window.removeEventListener('mouseup', onBoxUp);
      window.removeEventListener('keydown', onBarrierKey);
      map.remove();
      mapRef.current = null;
      baseLayerRef.current = null;
      markersGroupRef.current = null;
      footprintsGroupRef.current = null;
      overlayGroupRef.current = null;
      gridDebugGroupRef.current = null;
      referenceGroupRef.current = null;
      measureGroupRef.current = null;
      barriersGroupRef.current = null;
      groupHandlesLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch base layer when baseMap changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (baseLayerRef.current) {
      map.removeLayer(baseLayerRef.current);
    }
    baseLayerRef.current = makeBaseLayer(baseMap).addTo(map) as L.TileLayer;
    if (referenceGroupRef.current) { referenceGroupRef.current.remove(); referenceGroupRef.current.addTo(map); }
    if (overlayGroupRef.current) { overlayGroupRef.current.remove(); overlayGroupRef.current.addTo(map); }
    if (barriersGroupRef.current) { barriersGroupRef.current.remove(); barriersGroupRef.current.addTo(map); }
    if (measureGroupRef.current) { measureGroupRef.current.remove(); measureGroupRef.current.addTo(map); }
    if (footprintsGroupRef.current) { footprintsGroupRef.current.remove(); footprintsGroupRef.current.addTo(map); }
    if (markersGroupRef.current) { markersGroupRef.current.remove(); markersGroupRef.current.addTo(map); }
    if (groupHandlesLayerRef.current) { groupHandlesLayerRef.current.remove(); groupHandlesLayerRef.current.addTo(map); }
  }, [baseMap]);

  // Render reference / annotation layers (non-solver geometry). Non-interactive
  // so they never intercept selection or drawing. Redraws whenever the layers,
  // their visibility, or their styling change.
  useEffect(() => {
    const group = referenceGroupRef.current;
    if (!group) return;
    group.clearLayers();
    // Draw in reverse so the FIRST layer in the panel list ends up on top
    // (added last → highest z), matching the "top of list draws on top" hint.
    const refLayers = project.referenceLayers ?? [];
    for (let li = refLayers.length - 1; li >= 0; li--) {
      const layer = refLayers[li];
      if (!layer.visible) continue;
      const s = layer.style;
      for (const f of layer.features) {
        let geom: L.Layer | null = null;
        if (f.type === 'point' && f.coords[0]) {
          geom = refPointLayer(f.coords[0], s);
        } else if (f.type === 'line' && f.coords.length >= 2) {
          // Lines are a single stroke — no fill.
          geom = L.polyline(f.coords, { color: s.stroke, weight: s.weight, opacity: s.opacity, interactive: false });
        } else if (f.type === 'polygon' && f.coords.length >= 3) {
          geom = L.polygon(f.coords, {
            color: s.stroke, weight: s.weight, opacity: s.opacity,
            fillColor: s.fill, fillOpacity: s.fillOpacity, interactive: false,
          });
        }
        if (!geom) continue;
        // Only show a label when there's a real one — never "NaN"/"undefined".
        if (s.showLabels && f.label && f.label !== 'NaN' && f.label !== 'undefined') {
          geom.bindTooltip(f.label, {
            permanent: true,
            direction: f.type === 'point' ? 'top' : 'center',
            className: 'ref-label',
            opacity: 0.95,
          });
        }
        geom.addTo(group);
      }
    }
  }, [project.referenceLayers]);

  // Clear measurement when leaving measure mode.
  useEffect(() => {
    if (addMode !== 'measure' && measureGroupRef.current) {
      measureGroupRef.current.clearLayers();
      measurePointsRef.current = [];
    }
  }, [addMode]);

  // Barrier mode: disable double-click-zoom (dblclick commits the wall) and,
  // when leaving barrier mode (Esc, mode toggle, etc), clear any in-flight
  // draft — vertices, dots and preview. The persistent layers are repainted
  // by the next effect.
  useEffect(() => {
    const map = mapRef.current;
    if (map) {
      if (addMode === 'barrier') map.doubleClickZoom.disable();
      else map.doubleClickZoom.enable();
    }
    if (addMode !== 'barrier') {
      const draft = barrierDraftRef.current;
      if (draft) {
        if (draft.preview) draft.preview.remove();
        for (const d of draft.dots) d.remove();
        barrierDraftRef.current = null;
      }
    }
  }, [addMode]);

  // Render persistent barriers (lines + height label). Selected barriers
  // get a yellow outline. The draft preview lives in the same layer so it
  // sits above other overlays consistently.
  useEffect(() => {
    const map = mapRef.current;
    const group = barriersGroupRef.current;
    if (!map || !group) return;
    // Wipe everything except a live draft — we re-add persistent segments
    // from project.barriers, then restore the in-progress draft's preview
    // line and vertex dots so a mid-draw selection change doesn't erase it.
    const draft = barrierDraftRef.current;
    group.clearLayers();
    if (draft) {
      if (draft.preview) draft.preview.addTo(group);
      for (const d of draft.dots) d.addTo(group);
    }

    // Endpoint drag handle — small yellow square, identical look to the
    // calc-area corners so the affordance reads consistently.
    const endpointIcon = () => L.divIcon({
      className: 'barrier-endpoint',
      html: `<div style="width:10px;height:10px;background:#F2CB00;border:1.5px solid #1f2937;border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,.4)"></div>`,
      iconSize: [12, 12], iconAnchor: [6, 6],
    });
    // (Midpoint translate handle removed — line-body drag now handles
    // translation, see the hit polyline below.)

    for (const b of project.barriers) {
      if (b.polylineLatLng.length < 2) continue;
      const sel = selectedIds.has(b.id);
      const top = b.topHeightsM[0] ?? 0;
      const stroke = sel ? '#F2CB00' : '#1f2937';
      const weight = sel ? 5 : 4;
      const verts = b.polylineLatLng.map(([la, ln]) => L.latLng(la, ln));
      const line = L.polyline(verts, {
        color: stroke, weight, opacity: 0.95,
        // The visible line itself is non-interactive; the hit polyline
        // below catches all clicks / drags. Stops the SVG path from
        // grabbing the mousedown that we want the hit line to handle.
        interactive: false,
      });
      line.addTo(group);

      // Transparent hit-area polyline stacked on top of the visible one.
      // 14 px wide so the wall is comfortably clickable even when its
      // visible weight is just 4 px. Tagged `bessty-barrier` so the LMB
      // box-select handler ignores its mousedowns. We attach the
      // mousedown / drag / click logic here, not on the visible line.
      const hit = L.polyline(verts, {
        color: '#000', weight: 14, opacity: 0,
        interactive: true,
        className: 'bessty-barrier',
      });
      // Mousedown → start tracking. If the cursor moves more than ~3 px
      // before mouseup we treat it as a drag (translate the whole wall);
      // otherwise it's a click (select the wall). Threshold is measured
      // in real container pixels via clientX/Y deltas — no lat/lng-to-px
      // approximation games.
      let dragStart: { lat: number; lng: number; px: number; py: number } | null = null;
      let originalVerts: L.LatLng[] = [];
      let movedPx = 0;
      const onHitMove = (ev: MouseEvent) => {
        if (!dragStart) return;
        const dxPx = ev.clientX - dragStart.px;
        const dyPx = ev.clientY - dragStart.py;
        const distPx = Math.hypot(dxPx, dyPx);
        if (distPx > movedPx) movedPx = distPx;
        const ce = containerRef.current;
        if (!ce) return;
        const cr = ce.getBoundingClientRect();
        const here = map.containerPointToLatLng([ev.clientX - cr.left, ev.clientY - cr.top]);
        const dLat = here.lat - dragStart.lat;
        const dLng = here.lng - dragStart.lng;
        const next = originalVerts.map((v) => L.latLng(v.lat + dLat, v.lng + dLng));
        line.setLatLngs(next);
        hit.setLatLngs(next);
      };
      const onHitUp = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', onHitMove);
        window.removeEventListener('mouseup', onHitUp);
        if (!dragStart) return;
        const dragged = movedPx > 3;        // 3 px = standard click vs drag threshold
        if (dragged) {
          const finalVerts = (line.getLatLngs() as L.LatLng[]);
          callbacksRef.current.onUpdateBarrier?.(
            b.id,
            finalVerts.map((p) => [p.lat, p.lng]),
          );
        } else {
          callbacksRef.current.onSelect(b.id, { shift: !!(ev as MouseEvent).shiftKey });
        }
        dragStart = null;
        movedPx = 0;
      };
      hit.on('mousedown', (ev: L.LeafletMouseEvent) => {
        // Stop the DOM mousedown from bubbling to the container's LMB
        // box-select handler. The `bessty-barrier` className tag on the
        // hit polyline already makes onLmbDown ignore us, but stopping
        // propagation here is belt-and-braces in case Leaflet ever
        // changes the DOM structure.
        const dom = ev.originalEvent as MouseEvent;
        if (dom.button !== 0) return;
        dom.stopPropagation();
        dom.preventDefault();
        dragStart = { lat: ev.latlng.lat, lng: ev.latlng.lng, px: dom.clientX, py: dom.clientY };
        originalVerts = verts.map((v) => L.latLng(v.lat, v.lng));
        movedPx = 0;
        window.addEventListener('mousemove', onHitMove);
        window.addEventListener('mouseup', onHitUp);
      });
      hit.addTo(group);

      // Height label at the polyline's middle — for a multi-vertex wall this
      // is the midpoint of the central segment, not the first one.
      const midSeg = Math.max(0, Math.floor((b.polylineLatLng.length - 1) / 2));
      const a = b.polylineLatLng[midSeg];
      const c = b.polylineLatLng[midSeg + 1] ?? b.polylineLatLng[midSeg];
      const midLatLng = L.latLng((a[0] + c[0]) / 2, (a[1] + c[1]) / 2);
      L.marker(midLatLng, {
        icon: L.divIcon({
          className: 'barrier-label',
          html: `<div style="background:#fff;color:#1f2937;border:1px solid #1f2937;border-radius:3px;padding:1px 5px;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.25)">${top.toFixed(1)} m</div>`,
          iconSize: [40, 16], iconAnchor: [20, 8],
        }),
        interactive: false,
      }).addTo(group);

      // Drag affordances appear only on the selected barrier — keeps the
      // map clean when there are lots of walls but still one click away
      // (click the line → select → drag the line OR drag an endpoint).
      // Translation of the whole wall lives on the hit polyline above
      // (drag anywhere along the line); the handles below only need to
      // cover endpoint moves.
      if (!sel) continue;

      // Endpoint handles — drag = move just that vertex. Live updates
      // BOTH the visible line and the hit polyline so the click target
      // moves with what you see.
      verts.forEach((v, idx) => {
        const m = L.marker(v, { icon: endpointIcon(), draggable: true, zIndexOffset: 850 });
        m.on('drag', () => {
          const ll = m.getLatLng();
          verts[idx] = ll;
          line.setLatLngs(verts);
          hit.setLatLngs(verts);
        });
        m.on('dragend', () => {
          if (!callbacksRef.current.onUpdateBarrier) return;
          const next: Array<[number, number]> = verts.map((p) => [p.lat, p.lng]);
          callbacksRef.current.onUpdateBarrier(b.id, next);
        });
        m.addTo(group);
      });
    }
  }, [project.barriers, selectedIds]);

  // Re-render markers + calc area outline.
  useEffect(() => {
    const map = mapRef.current;
    const group = markersGroupRef.current;
    const footprints = footprintsGroupRef.current;
    if (!map || !group) return;
    group.clearLayers();
    if (footprints) footprints.clearLayers();
    markersByIdRef.current.clear();
    polysByIdRef.current.clear();

    /// Track group-drag state. When a selected marker starts dragging, we
    /// snapshot all sibling positions and translate them in lockstep on
    /// every `drag` event (no React state involved — direct setLatLng).
    /// `polys` carries each affected source's footprint-polygon corner
    /// snapshot so the metre-true rectangle translates alongside the
    /// marker icon during the drag (fix-up to fix #48).
    let dragGroup: {
      leaderId: string;
      leaderStart: L.LatLng;
      siblings: Map<string, L.LatLng>;
      polys: Map<string, L.LatLng[]>;
    } | null = null;

    const anySelected = selectedIds.size > 0;
    const isSelected = (id: string) => selectedIds.has(id);
    const dimNonSelected = (id: string) => (anySelected && !isSelected(id) ? 0.55 : 1);

    function validLatLng(ll: [number, number]): boolean {
      return Number.isFinite(ll[0]) && Number.isFinite(ll[1])
        && Math.abs(ll[0]) <= 90 && Math.abs(ll[1]) <= 180;
    }
    for (const s of project.sources) {
      // Skip rendering objects with broken coords — they remain in the
      // project state and the per-tab list, but Leaflet won't try to place
      // them at NaN (which silently breaks every subsequent group op).
      if (!validLatLng(s.latLng)) continue;
      const sel = isSelected(s.id);

      // ===== Metre-true footprint polygon for BESS / Auxiliary =====
      //
      // Sized from the catalog entry's `footprintM` (falling back to
      // the kind default via footprintFor()), rotated by source.yawDeg
      // (which already folds in segment 'across' orientation, set by
      // the materialiser). Drawn UNDER the marker icon -- the pixel
      // icon stays as the click/drag/selection affordance at all
      // zooms; this polygon just shows the real footprint so the user
      // can SEE the actual unit dimensions at high zoom (e.g. that 8
      // Megapacks in a row span 41 m, not whatever 8 × 18 px happens
      // to project to). WTGs skip this: they're acoustically a point
      // source, and the rotor SVG icon already communicates the
      // visual scale via rotorDiameterM.
      if (footprints && (s.kind === 'bess' || s.kind === 'auxiliary')) {
        const entry = lookupEntry(projectRef.current, s);
        const fpCat = entry
          ? footprintFor(entry)
          : (s.kind === 'bess'
              ? { widthM: 5.1, lengthM: 1.7 }
              : { widthM: 2.0, lengthM: 1.5 });
        // When "Source containers" is on, this rectangle IS the screening box
        // the engine models, so draw the resolved box (per-source overrides
        // included) rather than the bare catalog footprint. Same resolver the
        // solver uses, so the drawing cannot drift from the obstacle.
        // `box.lengthM` is the long axis == the footprint's `widthM`.
        const cset = projectRef.current.settings?.containers;
        const boxModelled = (cset?.receiverCalc ?? false) || (cset?.grid ?? false);
        const box = entry && boxModelled ? resolveContainer(s, entry) : undefined;
        const fp = box ? { widthM: box.lengthM, lengthM: box.widthM } : fpCat;
        // 4 corners in a local metre frame centred on the source,
        // rotated by yawDeg (clockwise from north == screen-clockwise
        // with y pointing south, same convention as the materialiser).
        const yawRad = ((s.yawDeg ?? 0) * Math.PI) / 180;
        const cosY = Math.cos(yawRad);
        const sinY = Math.sin(yawRad);
        const halfW = fp.widthM / 2;
        const halfL = fp.lengthM / 2;
        const corners4 = [
          { x: -halfW, y: -halfL },
          { x:  halfW, y: -halfL },
          { x:  halfW, y:  halfL },
          { x: -halfW, y:  halfL },
        ];
        const R = 6371008.8;
        const cosLat = Math.cos((s.latLng[0] * Math.PI) / 180);
        const polyLatLngs: Array<[number, number]> = corners4.map((c) => {
          const wx = c.x * cosY - c.y * sinY;
          const wy = c.x * sinY + c.y * cosY;
          return [
            s.latLng[0] + (-wy / R) * (180 / Math.PI),
            s.latLng[1] + (wx / (R * cosLat)) * (180 / Math.PI),
          ];
        });
        const kindColor = s.kind === 'bess' ? '#5e35b1' : '#1565c0';
        const fpPoly = L.polygon(polyLatLngs, {
          color: sel ? '#F2CB00' : kindColor,
          weight: sel ? 2.5 : 1.2,
          opacity: 0.95,
          fillColor: kindColor,
          // Mild fill so the polygon is visible at high zoom without
          // visually drowning the centred marker icon. A modelled container
          // reads heavier — the rectangle is now an acoustic obstacle, not
          // just a scale reference.
          fillOpacity: box ? 0.55 : 0.35,
          // Click + select; clicks pass through the marker icon as
          // well, so either target selects the source.
          interactive: true,
          bubblingMouseEvents: false,
        });
        if (box) {
          // Height only shows up here — the plan view can't convey it, and it
          // is what decides whether a unit screens its neighbours.
          fpPoly.bindTooltip(
            `Container ${box.lengthM.toFixed(1)} × ${box.widthM.toFixed(1)} × ${box.heightM.toFixed(1)} m`,
            { direction: 'top', opacity: 0.9 },
          );
        }
        fpPoly.on('click', (e: L.LeafletMouseEvent) => {
          const shift = !!e.originalEvent?.shiftKey;
          callbacksRef.current.onSelect(s.id, { shift });
        });
        if (s.groupId) {
          fpPoly.on('dblclick', () => {
            const g = (projectRef.current.bessGroups ?? []).find((x) => x.id === s.groupId);
            if (g) callbacksRef.current.onOpenBessGroupWizard?.(g);
          });
        }
        fpPoly.addTo(footprints);
        polysByIdRef.current.set(s.id, fpPoly);
      }

      const marker = L.marker(s.latLng, {
        icon: sourceMarker(s, sel, groupColorById.get(s.id),
          s.groupId ? bessGroupRotById.get(s.groupId) : undefined),
        title: s.name,
        opacity: dimNonSelected(s.id),
        draggable: true,
        // Stop mousedown propagating to map so box-select doesn't start.
        bubblingMouseEvents: false,
      });
      markersByIdRef.current.set(s.id, marker);
      marker.on('click', (e: L.LeafletMouseEvent) => {
        const shift = !!e.originalEvent?.shiftKey;
        callbacksRef.current.onSelect(s.id, { shift });
      });
      // Double-click on a group member re-opens the BESS-group wizard
      // for that group. Standalone sources have no double-click action
      // (Leaflet emits both a click and a dblclick; the click selects
      // first, then the wizard opens with that group in edit mode).
      if (s.groupId) {
        marker.on('dblclick', () => {
          const g = (projectRef.current.bessGroups ?? []).find((x) => x.id === s.groupId);
          if (g) callbacksRef.current.onOpenBessGroupWizard?.(g);
        });
      }
      // Per-marker drag snapshot. `dragStart` is the marker's lat/lng
      // at the moment dragstart fired -- used to compute (dLat, dLng)
      // on every drag tick, since marker.getLatLng() returns the
      // CURRENT position (which is the new position by the time the
      // drag callback runs). `polyCorners` holds this source's
      // footprint-polygon corners so the polygon translates with the
      // marker. The multi-select branch below additionally populates
      // dragGroup with sibling marker / polygon snapshots for the
      // lockstep group-drag case.
      let dragStart: L.LatLng | null = null;
      let ownPolyCorners: L.LatLng[] | null = null;
      marker.on('dragstart', () => {
        cancelBoxSelectRef.current();
        dragStart = marker.getLatLng();
        const ownPoly = polysByIdRef.current.get(s.id);
        ownPolyCorners = ownPoly
          ? (ownPoly.getLatLngs()[0] as L.LatLng[]).map((p) => L.latLng(p.lat, p.lng))
          : null;
        const sel = selectedIdsRef.current;
        if (sel.size <= 1 || !sel.has(s.id)) return;
        const siblings = new Map<string, L.LatLng>();
        const polys = new Map<string, L.LatLng[]>();
        for (const id of sel) {
          if (id === s.id) continue;
          const m = markersByIdRef.current.get(id);
          if (m) siblings.set(id, m.getLatLng());
          const poly = polysByIdRef.current.get(id);
          if (poly) {
            polys.set(id, (poly.getLatLngs()[0] as L.LatLng[])
              .map((p) => L.latLng(p.lat, p.lng)));
          }
        }
        dragGroup = { leaderId: s.id, leaderStart: marker.getLatLng(), siblings, polys };
      });
      marker.on('drag', () => {
        if (!dragStart) return;
        const here = marker.getLatLng();
        const dLat = here.lat - dragStart.lat;
        const dLng = here.lng - dragStart.lng;
        // Always translate THIS source's polygon (covers solo drag).
        if (ownPolyCorners) {
          const own = polysByIdRef.current.get(s.id);
          if (own) {
            own.setLatLngs(ownPolyCorners.map((p) =>
              L.latLng(p.lat + dLat, p.lng + dLng)));
          }
        }
        if (!dragGroup || dragGroup.leaderId !== s.id) return;
        // Multi-select: translate every sibling marker + polygon by
        // the same delta.
        for (const [id, orig] of dragGroup.siblings) {
          const m = markersByIdRef.current.get(id);
          if (m) m.setLatLng([orig.lat + dLat, orig.lng + dLng]);
        }
        for (const [id, origCorners] of dragGroup.polys) {
          const poly = polysByIdRef.current.get(id);
          if (poly) {
            poly.setLatLngs(origCorners.map((p) =>
              L.latLng(p.lat + dLat, p.lng + dLng)));
          }
        }
      });
      marker.on('dragend', (e: L.LeafletEvent) => {
        const m = e.target as L.Marker;
        const latLng = m.getLatLng();
        callbacksRef.current.onMoveSource?.(s.id, [latLng.lat, latLng.lng]);
        dragGroup = null;
        dragStart = null;
        ownPolyCorners = null;
      });
      marker.addTo(group);
    }

    const limitMode = limitComparisonFor(project);
    for (const r of project.receivers) {
      if (!validLatLng(r.latLng)) continue;
      const dbA = results?.find((x) => x.receiverId === r.id)?.totalDbA ?? null;
      const sel = isSelected(r.id);
      const activeLimit = limitForPeriod(r, project.scenario.period);
      const marker = L.marker(r.latLng, {
        icon: receiverMarker(
          r, dbA && isFinite(dbA) ? dbA : null, activeLimit, sel,
          groupColorById.get(r.id), limitMode, showReceiverLimits ?? false,
        ),
        title: r.name,
        opacity: dimNonSelected(r.id),
        draggable: true,
        bubblingMouseEvents: false,
      });
      markersByIdRef.current.set(r.id, marker);
      marker.on('click', (e: L.LeafletMouseEvent) => {
        const shift = !!e.originalEvent?.shiftKey;
        onSelect(r.id, { shift });
      });
      marker.on('dragstart', () => {
        cancelBoxSelectRef.current();
        const sel = selectedIdsRef.current;
        if (sel.size <= 1 || !sel.has(r.id)) return;
        const siblings = new Map<string, L.LatLng>();
        const polys = new Map<string, L.LatLng[]>();
        for (const id of sel) {
          if (id === r.id) continue;
          const m = markersByIdRef.current.get(id);
          if (m) siblings.set(id, m.getLatLng());
          // Pick up any selected source's footprint polygon so it
          // tracks during a mixed receiver+source multi-select drag.
          const poly = polysByIdRef.current.get(id);
          if (poly) {
            polys.set(id, (poly.getLatLngs()[0] as L.LatLng[])
              .map((p) => L.latLng(p.lat, p.lng)));
          }
        }
        dragGroup = { leaderId: r.id, leaderStart: marker.getLatLng(), siblings, polys };
      });
      marker.on('drag', () => {
        if (!dragGroup || dragGroup.leaderId !== r.id) return;
        const here = marker.getLatLng();
        const dLat = here.lat - dragGroup.leaderStart.lat;
        const dLng = here.lng - dragGroup.leaderStart.lng;
        for (const [id, orig] of dragGroup.siblings) {
          const m = markersByIdRef.current.get(id);
          if (m) m.setLatLng([orig.lat + dLat, orig.lng + dLng]);
        }
        for (const [id, origCorners] of dragGroup.polys) {
          const poly = polysByIdRef.current.get(id);
          if (poly) {
            poly.setLatLngs(origCorners.map((p) =>
              L.latLng(p.lat + dLat, p.lng + dLng)));
          }
        }
      });
      marker.on('dragend', (e: L.LeafletEvent) => {
        const m = e.target as L.Marker;
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
      const bounds: L.LatLngBoundsExpression = [[south, west], [north, east]];
      L.rectangle(bounds, {
        color: '#F2CB00', weight: 1.5, dashArray: '8 6', fillOpacity: 0, interactive: false,
      }).addTo(group);

      // Corner handles. Dragging a corner resizes the rectangle keeping the
      // centre fixed: width = 2·|Δlng→m|, height = 2·|Δlat→m|.
      const cornerHandle = () =>
        L.divIcon({
          className: 'ca-handle',
          html: `<div style="width:12px;height:12px;background:#F2CB00;border:1.5px solid #1f2937;border-radius:2px;cursor:nwse-resize;box-shadow:0 1px 2px rgba(0,0,0,.4)"></div>`,
          iconSize: [14, 14], iconAnchor: [7, 7],
        });
      const corners: Array<[number, number]> = [
        [south, west], [south, east], [north, east], [north, west],
      ];
      for (const c of corners) {
        const m = L.marker(c, { icon: cornerHandle(), draggable: true, zIndexOffset: 800 });
        m.on('dragend', (e: L.LeafletEvent) => {
          const handle = e.target as L.Marker;
          const ll = handle.getLatLng();
          const cb = callbacksRef.current.onResizeCalcArea;
          if (!cb) return;
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
      cm.on('dragend', (e: L.LeafletEvent) => {
        const handle = e.target as L.Marker;
        const ll = handle.getLatLng();
        callbacksRef.current.onMoveCalcArea?.([ll.lat, ll.lng]);
      });
      cm.addTo(group);
    }
    // `onSelect` deliberately omitted — we read it from callbacksRef inside
    // the click handlers, so we don't want a fresh closure to invalidate the
    // markers (and break in-flight drags) every time the parent re-renders.
  }, [project, results, selectedIds, showReceiverLimits]);

  // ===== BESS-group overlays: bounding rect + rotation handle + centre handle =====
  //
  // For each group: compute the unrotated bbox in metres from the
  // materialised sources' positions back-projected to local coords,
  // then draw the rotated polygon + handles. The handles are
  // draggable Leaflet markers; their drag callbacks fire
  // onMoveBessGroup / onRotateBessGroup so ProjectScreen can
  // re-materialise.
  useEffect(() => {
    const map = mapRef.current;
    const layer = bessGroupsLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!project.bessGroups || project.bessGroups.length === 0) return;

    const R = 6371008.8;
    const dragRefs = new Map<string, { startCentre: L.LatLng; startAngleRad: number; startRotDeg: number }>();

    for (const g of project.bessGroups) {
      const members = project.sources.filter((s) => s.groupId === g.id);
      if (members.length === 0) continue;

      // Project each member back into a local metre-frame centred on
      // group.centerLatLng (NOT the source's own bbox centroid -- they
      // should be the same in practice, but using the parametric
      // centre keeps the rotation handle anchored to the user-set
      // origin when overrides have shifted things).
      const cLatRad = (g.centerLatLng[0] * Math.PI) / 180;
      const cosLat = Math.cos(cLatRad);
      const local: Array<{ x: number; y: number }> = members.map((s) => ({
        x: (s.latLng[1] - g.centerLatLng[1]) * (Math.PI / 180) * R * cosLat,
        y: -(s.latLng[0] - g.centerLatLng[0]) * (Math.PI / 180) * R,
      }));
      // Bounding box in the GROUP'S local frame -- i.e. UNROTATED.
      // Each member's local (x,y) is rotated by g.rotationDeg from the
      // group's local frame, so we de-rotate first to get the bbox.
      const rotRad = (g.rotationDeg * Math.PI) / 180;
      const cosNeg = Math.cos(-rotRad);
      const sinNeg = Math.sin(-rotRad);
      let minLX = Infinity, maxLX = -Infinity, minLY = Infinity, maxLY = -Infinity;
      // Need a footprint to pad the bbox so the rect surrounds the
      // units rather than passing through their centres. Use the
      // largest footprint of any member.
      let maxHalfW = 0, maxHalfH = 0;
      for (let i = 0; i < members.length; i++) {
        const ux = local[i].x * cosNeg - local[i].y * sinNeg;
        const uy = local[i].x * sinNeg + local[i].y * cosNeg;
        if (ux < minLX) minLX = ux;
        if (ux > maxLX) maxLX = ux;
        if (uy < minLY) minLY = uy;
        if (uy > maxLY) maxLY = uy;
        // We don't have the catalog footprint cheaply here -- pad by
        // 3 m which covers the Megapack's longest dimension. Good
        // enough for a visual bounding rect; the wizard preview is
        // the authoritative footprint view.
        maxHalfW = Math.max(maxHalfW, 3);
        maxHalfH = Math.max(maxHalfH, 3);
      }
      const padX = maxHalfW;
      const padY = maxHalfH;
      const corners4Local = [
        { x: minLX - padX, y: minLY - padY },
        { x: maxLX + padX, y: minLY - padY },
        { x: maxLX + padX, y: maxLY + padY },
        { x: minLX - padX, y: maxLY + padY },
      ];
      // Re-rotate each corner back into the world (group rotation) and
      // convert to lat/lng.
      const cosR = Math.cos(rotRad);
      const sinR = Math.sin(rotRad);
      const cornersLatLng: Array<[number, number]> = corners4Local.map((c) => {
        const wx = c.x * cosR - c.y * sinR;
        const wy = c.x * sinR + c.y * cosR;
        return [
          g.centerLatLng[0] + (-wy / R) * (180 / Math.PI),
          g.centerLatLng[1] + (wx / (R * cosLat)) * (180 / Math.PI),
        ];
      });

      // Determine if the group is "selected" -- treat any member's
      // selection as selecting the group. Drives the rect stroke +
      // handle visibility.
      const groupSelected = members.some((m) => selectedIds.has(m.id));

      // Bounding rect is ALWAYS prominent (per fix #5 -- users need to see
      // the group extent + grab handle without having to select first).
      // Selected state just intensifies the highlight slightly.
      const poly = L.polygon(cornersLatLng, {
        color: '#1f2937',
        weight: groupSelected ? 2 : 1.5,
        opacity: groupSelected ? 1.0 : 0.85,
        fillColor: '#f2cb00',
        fillOpacity: groupSelected ? 0.14 : 0.08,
        dashArray: groupSelected ? undefined : '6 3',
        // Clicking the rect (away from any member marker) selects the
        // first member as a proxy for "group selected".
        interactive: true,
        bubblingMouseEvents: false,
      });
      poly.on('click', () => {
        if (members.length > 0) callbacksRef.current.onSelect(members[0].id);
      });
      poly.on('dblclick', () => {
        callbacksRef.current.onOpenBessGroupWizard?.(g);
      });
      poly.addTo(layer);

      // Centre move handle ALWAYS visible -- this is the grab affordance
      // the user uses to drag the whole group. zIndexOffset 1300 puts
      // it above source markers (default 0) AND above the rotation
      // handle (1100, set below) so when both handles overlap visually
      // at low zoom the MOVE handle wins click/drag arbitration -- per
      // user feedback "I should be able to drag, rotate is less
      // important" (fix #22, replacing fix #13's symmetric 1200/1200).
      const alwaysCentreHandle = L.marker(g.centerLatLng, {
        draggable: true,
        bubblingMouseEvents: false,
        zIndexOffset: 1300,
        icon: L.divIcon({
          className: 'bessty-bess-centre-handle',
          // Slightly bigger so it punches through dense BESS marker
          // clusters at low zooms (fix #13 visual companion).
          html: '<div style="width:22px;height:22px;border-radius:50%;background:#f2cb00;border:2px solid #1f2937;display:flex;align-items:center;justify-content:center;font-size:13px;color:#1f2937;cursor:move;box-shadow:0 1px 4px rgba(0,0,0,.4)">✥</div>',
          iconSize: [22, 22], iconAnchor: [11, 11],
        }),
        title: `Drag to move "${g.name}"`,
      });
      // Centre handle's drag handlers are wired up further below, after
      // the rotation stem + handle are created -- the centre drag also
      // translates the rotation overlay so the whole group visibly
      // moves together (fix #21).
      alwaysCentreHandle.addTo(layer);

      // ===== Rotation handle (ALWAYS visible, per fix #9) =====
      //
      // Was previously selected-only -- but the user can't easily
      // discover "click a member to reveal the rotate handle", so
      // it's now drawn unconditionally next to the always-on centre
      // move handle. Slight visual cost: an extra ↻ stem above each
      // group. Acceptable -- there are rarely more than a handful of
      // groups on the map.
      //
      // Rotation handle: 20 m above the top edge of the bounding box,
      // in the group's LOCAL frame, then rotated to world. The old
      // 5 m offset was sub-pixel at typical site-overview zooms,
      // making the handle visually overlap the bbox and effectively
      // un-findable (per fix #15). 20 m + the bigger marker below
      // give clear separation.
      const ROT_OFFSET_M = 20;
      const topMidLocal = { x: (minLX + maxLX) / 2, y: minLY - padY - ROT_OFFSET_M };
      const topMidWX = topMidLocal.x * cosR - topMidLocal.y * sinR;
      const topMidWY = topMidLocal.x * sinR + topMidLocal.y * cosR;
      const rotHandleLatLng: [number, number] = [
        g.centerLatLng[0] + (-topMidWY / R) * (180 / Math.PI),
        g.centerLatLng[1] + (topMidWX / (R * cosLat)) * (180 / Math.PI),
      ];
      // Stem from top-edge centre to handle.
      const topMidEdgeLocal = { x: (minLX + maxLX) / 2, y: minLY - padY };
      const topEdgeWX = topMidEdgeLocal.x * cosR - topMidEdgeLocal.y * sinR;
      const topEdgeWY = topMidEdgeLocal.x * sinR + topMidEdgeLocal.y * cosR;
      const topEdgeLatLng: [number, number] = [
        g.centerLatLng[0] + (-topEdgeWY / R) * (180 / Math.PI),
        g.centerLatLng[1] + (topEdgeWX / (R * cosLat)) * (180 / Math.PI),
      ];
      const rotStem = L.polyline([topEdgeLatLng, rotHandleLatLng], {
        color: '#1f2937', weight: 1.5, opacity: 0.85, interactive: false,
      });
      rotStem.addTo(layer);
      const rotHandle = L.marker(rotHandleLatLng, {
        draggable: true,
        bubblingMouseEvents: false,
        // zIndexOffset 1100 keeps the rotation handle above source
        // markers (default 0) but BELOW the centre move handle (1300)
        // so when the two handles visually overlap at low zoom, MOVE
        // wins click arbitration. Per user feedback "I should be able
        // to drag, rotate is less important" (fix #22).
        zIndexOffset: 1100,
        icon: L.divIcon({
          className: 'bessty-bess-rot-handle',
          // Bigger handle + stroke so it's findable at site-overview
          // zooms (fix #15). The previous 16 px circle with a 1.5 px
          // stroke was easy to miss next to the bounding rect.
          html: '<div style="width:22px;height:22px;border-radius:50%;background:#f2cb00;border:2px solid #1f2937;display:flex;align-items:center;justify-content:center;font-size:13px;color:#1f2937;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,.4)">↻</div>',
          iconSize: [22, 22], iconAnchor: [11, 11],
        }),
        title: 'Rotate group',
      });
      // Live rotation visualisation (fix #16). Mirror the centre-drag
      // pattern: snapshot every member marker's lat/lng + the bounding
      // poly's corners + the stem polyline's endpoints relative to the
      // group centre on dragstart. On each `drag` event, transform
      // each snapshot point by the delta rotation about the group
      // centre and apply via setLatLng / setLatLngs. State write
      // happens only on dragend so the snapshot recompute doesn't fire
      // on every mousemove.
      //
      // Coord model: convert lat/lng -> local metres about
      // g.centerLatLng, rotate by deltaDeg (clockwise from north), and
      // convert back. Same equirectangular shorthand the materialiser
      // uses; sub-cm accuracy at site scale.
      type RotSnapshot = {
        cLL: L.LatLng;
        startAngleRad: number;
        startRotDeg: number;
        members: Map<string, { lx: number; ly: number }>;
        polyCorners: Array<{ lx: number; ly: number }>;
        stemEndpoints: Array<{ lx: number; ly: number }>;
        /// Per-member footprint-polygon corners in local metres
        /// relative to the group centre. Rotating each corner about
        /// the origin by deltaRad rotates the whole rectangle the
        /// right way -- equivalent to translating the marker AND
        /// rotating the rectangle's own frame, which is exactly what
        /// a group rotation does.
        memberFpCorners: Map<string, Array<{ lx: number; ly: number }>>;
      };
      let rotSnap: RotSnapshot | null = null;
      const toLocalM = (cLL: L.LatLng, p: L.LatLng): { lx: number; ly: number } => ({
        lx: (p.lng - cLL.lng) * (Math.PI / 180) * R * cosLat,
        ly: -(p.lat - cLL.lat) * (Math.PI / 180) * R,
      });
      const fromLocalM = (cLL: L.LatLng, lx: number, ly: number): [number, number] => [
        cLL.lat + (-ly / R) * (180 / Math.PI),
        cLL.lng + (lx / (R * cosLat)) * (180 / Math.PI),
      ];

      rotHandle.on('dragstart', () => {
        const cLL = L.latLng(g.centerLatLng[0], g.centerLatLng[1]);
        const here = rotHandle.getLatLng();
        const dx0 = (here.lng - cLL.lng) * cosLat;
        const dy0 = here.lat - cLL.lat;
        const angle0 = Math.atan2(dx0, dy0);  // clockwise from north
        // Snapshot every member marker + footprint polygon + the
        // bounding poly + the stem.
        const memberSnap = new Map<string, { lx: number; ly: number }>();
        const memberFpSnap = new Map<string, Array<{ lx: number; ly: number }>>();
        for (const m of members) {
          const mk = markersByIdRef.current.get(m.id);
          if (mk) memberSnap.set(m.id, toLocalM(cLL, mk.getLatLng()));
          const fp = polysByIdRef.current.get(m.id);
          if (fp) {
            memberFpSnap.set(m.id, (fp.getLatLngs()[0] as L.LatLng[])
              .map((p) => toLocalM(cLL, p)));
          }
        }
        const polyCorners = (poly.getLatLngs()[0] as L.LatLng[]).map((p) => toLocalM(cLL, p));
        const stemEndpoints = (rotStem.getLatLngs() as L.LatLng[]).map((p) => toLocalM(cLL, p));
        rotSnap = {
          cLL,
          startAngleRad: angle0,
          startRotDeg: g.rotationDeg,
          members: memberSnap,
          polyCorners,
          stemEndpoints,
          memberFpCorners: memberFpSnap,
        };
        dragRefs.set(g.id, { startCentre: cLL, startAngleRad: angle0, startRotDeg: g.rotationDeg });
      });
      rotHandle.on('drag', () => {
        const snap = rotSnap;
        if (!snap) return;
        const here = rotHandle.getLatLng();
        const dx = (here.lng - snap.cLL.lng) * cosLat;
        const dy = here.lat - snap.cLL.lat;
        const angleNow = Math.atan2(dx, dy);
        const deltaRad = angleNow - snap.startAngleRad;
        // Rotation of a point (lx, ly) about origin by deltaRad
        // CLOCKWISE (matching the materialiser's screen-clockwise
        // convention with y pointing south). Standard 2D rotation
        // matrix with the sign convention consistent with materialiser:
        //   x' =  lx * cos - ly * sin
        //   y' =  lx * sin + ly * cos
        const cosD = Math.cos(deltaRad), sinD = Math.sin(deltaRad);
        const rot = (p: { lx: number; ly: number }): { lx: number; ly: number } => ({
          lx: p.lx * cosD - p.ly * sinD,
          ly: p.lx * sinD + p.ly * cosD,
        });
        // Apply to every member marker.
        for (const [id, pt] of snap.members) {
          const r = rot(pt);
          const mk = markersByIdRef.current.get(id);
          if (mk) mk.setLatLng(fromLocalM(snap.cLL, r.lx, r.ly));
        }
        // Apply to every member footprint polygon. Rotating each
        // corner about the group centre by deltaRad gives both the
        // translated centre AND the rotated rectangle (since the
        // four corners define the rectangle's orientation as well as
        // its position).
        for (const [id, corners] of snap.memberFpCorners) {
          const fp = polysByIdRef.current.get(id);
          if (fp) {
            fp.setLatLngs(corners.map((p) => {
              const r = rot(p);
              return fromLocalM(snap.cLL, r.lx, r.ly);
            }));
          }
        }
        // Apply to bounding poly + stem.
        poly.setLatLngs(snap.polyCorners.map((p) => {
          const r = rot(p);
          return fromLocalM(snap.cLL, r.lx, r.ly);
        }));
        rotStem.setLatLngs(snap.stemEndpoints.map((p) => {
          const r = rot(p);
          return fromLocalM(snap.cLL, r.lx, r.ly);
        }));
        // Title tooltip for numeric feedback.
        const deltaDeg = (deltaRad * 180) / Math.PI;
        rotHandle.options.title = `${(snap.startRotDeg + deltaDeg).toFixed(0)}°`;
      });
      rotHandle.on('dragend', () => {
        const ref = dragRefs.get(g.id);
        if (!ref) return;
        const here = rotHandle.getLatLng();
        const dx = (here.lng - ref.startCentre.lng) * cosLat;
        const dy = here.lat - ref.startCentre.lat;
        const angleNow = Math.atan2(dx, dy);
        const deltaDeg = ((angleNow - ref.startAngleRad) * 180) / Math.PI;
        let nextDeg = ref.startRotDeg + deltaDeg;
        // Normalise to [-180, 180].
        while (nextDeg > 180) nextDeg -= 360;
        while (nextDeg < -180) nextDeg += 360;
        rotSnap = null;
        callbacksRef.current.onRotateBessGroup?.(g.id, +nextDeg.toFixed(1));
        dragRefs.delete(g.id);
      });
      rotHandle.addTo(layer);

      // ===== Centre-handle drag handlers (fix #14 + fix #21) =====
      //
      // Wired up here -- AFTER rotHandle / rotStem / poly all exist --
      // because the centre drag also translates the rotation overlay
      // (handle + stem) and the bounding poly. Previously (fix #14)
      // only member markers tracked the cursor, so the rotation handle
      // appeared to "stay behind" while everything else moved. State
      // (project doc) updates only on dragend so the snapshot
      // recompute doesn't fire on every mousemove.
      let centreDragStart: L.LatLng | null = null;
      const memberMarkerSnapshots = new Map<string, L.LatLng>();
      // Per-member footprint-polygon corner snapshots (parallel map to
      // memberMarkerSnapshots). On each drag tick we translate each
      // polygon's corners by the same (dLat, dLng) as its marker so
      // the metre-true rectangles slide with the cursor instead of
      // jumping at dragend.
      const memberPolySnapshots = new Map<string, L.LatLng[]>();
      let rotHandleSnap: L.LatLng | null = null;
      let rotStemSnap: L.LatLng[] | null = null;
      let polySnap: L.LatLng[] | null = null;
      alwaysCentreHandle.on('dragstart', () => {
        centreDragStart = alwaysCentreHandle.getLatLng();
        memberMarkerSnapshots.clear();
        memberPolySnapshots.clear();
        for (const m of members) {
          const mk = markersByIdRef.current.get(m.id);
          if (mk) memberMarkerSnapshots.set(m.id, mk.getLatLng());
          const fp = polysByIdRef.current.get(m.id);
          if (fp) {
            memberPolySnapshots.set(m.id, (fp.getLatLngs()[0] as L.LatLng[])
              .map((p) => L.latLng(p.lat, p.lng)));
          }
        }
        rotHandleSnap = rotHandle.getLatLng();
        rotStemSnap = (rotStem.getLatLngs() as L.LatLng[]).map((p) => L.latLng(p.lat, p.lng));
        polySnap = (poly.getLatLngs()[0] as L.LatLng[]).map((p) => L.latLng(p.lat, p.lng));
      });
      alwaysCentreHandle.on('drag', () => {
        if (!centreDragStart) return;
        const here = alwaysCentreHandle.getLatLng();
        const dLat = here.lat - centreDragStart.lat;
        const dLng = here.lng - centreDragStart.lng;
        for (const [id, orig] of memberMarkerSnapshots) {
          const mk = markersByIdRef.current.get(id);
          if (mk) mk.setLatLng([orig.lat + dLat, orig.lng + dLng]);
        }
        for (const [id, corners] of memberPolySnapshots) {
          const fp = polysByIdRef.current.get(id);
          if (fp) {
            fp.setLatLngs(corners.map((p) => L.latLng(p.lat + dLat, p.lng + dLng)));
          }
        }
        if (rotHandleSnap) {
          rotHandle.setLatLng([rotHandleSnap.lat + dLat, rotHandleSnap.lng + dLng]);
        }
        if (rotStemSnap) {
          rotStem.setLatLngs(rotStemSnap.map((p) => L.latLng(p.lat + dLat, p.lng + dLng)));
        }
        if (polySnap) {
          poly.setLatLngs(polySnap.map((p) => L.latLng(p.lat + dLat, p.lng + dLng)));
        }
      });
      alwaysCentreHandle.on('dragend', () => {
        const ll = alwaysCentreHandle.getLatLng();
        centreDragStart = null;
        memberMarkerSnapshots.clear();
        memberPolySnapshots.clear();
        rotHandleSnap = null;
        rotStemSnap = null;
        polySnap = null;
        callbacksRef.current.onMoveBessGroup?.(g.id, [ll.lat, ll.lng]);
      });
      // (Centre translate handle is rendered above the `if (!groupSelected)`
      // block so it's always visible, per fix #5.)
    }
  }, [project, selectedIds]);

  // ===== General-group handles: drag (translate) + rotate about centroid =====
  //
  // Shown only when a saved (general) group is the active selection. Members
  // are arbitrary sources + receivers; unlike BESS groups there's no stored
  // centre/rotation — we transform the member lat/lngs directly. Centre handle
  // translates all members by a lat/lng delta; rotation handle rotates them
  // about the live centroid. Live preview moves markers + source footprint
  // polys; project state writes only on dragend.
  useEffect(() => {
    const map = mapRef.current;
    const layer = groupHandlesLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const gid = selectedGroupId;
    if (!gid) return;
    const group = (project.groups ?? []).find((g) => g.id === gid);
    if (!group) return;

    const idSet = new Set(group.memberIds);
    const members: Array<{ id: string; latLng: [number, number] }> = [];
    for (const s of project.sources) if (idSet.has(s.id)) members.push({ id: s.id, latLng: s.latLng });
    for (const r of project.receivers) if (idSet.has(r.id)) members.push({ id: r.id, latLng: r.latLng });
    if (members.length === 0) return;

    const R = 6371008.8;
    const cLat = members.reduce((a, m) => a + m.latLng[0], 0) / members.length;
    const cLng = members.reduce((a, m) => a + m.latLng[1], 0) / members.length;
    const cosLat = Math.cos((cLat * Math.PI) / 180);
    const cLL = L.latLng(cLat, cLng);

    // World-aligned bbox of members (+ ~12 m pad).
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const m of members) {
      minLat = Math.min(minLat, m.latLng[0]); maxLat = Math.max(maxLat, m.latLng[0]);
      minLng = Math.min(minLng, m.latLng[1]); maxLng = Math.max(maxLng, m.latLng[1]);
    }
    const padLat = (12 / R) * (180 / Math.PI);
    const padLng = (12 / (R * cosLat)) * (180 / Math.PI);
    minLat -= padLat; maxLat += padLat; minLng -= padLng; maxLng += padLng;
    const poly = L.polygon(
      [[minLat, minLng], [minLat, maxLng], [maxLat, maxLng], [maxLat, minLng]] as [number, number][],
      { color: '#1f2937', weight: 1.5, opacity: 0.9, fillColor: '#3b82f6', fillOpacity: 0.06, dashArray: '6 3', interactive: false },
    );
    poly.addTo(layer);

    const centreHandle = L.marker(cLL, {
      draggable: true, bubblingMouseEvents: false, zIndexOffset: 1300,
      icon: L.divIcon({
        className: 'bessty-group-centre',
        html: '<div style="width:22px;height:22px;border-radius:50%;background:#3b82f6;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;cursor:move;box-shadow:0 1px 4px rgba(0,0,0,.4)">✥</div>',
        iconSize: [22, 22], iconAnchor: [11, 11],
      }),
      title: `Drag to move "${group.name}"`,
    });
    centreHandle.addTo(layer);

    // Rotation handle 20 m north of the top edge.
    const ROT_OFFSET_M = 20;
    const rotHandleLatLng: [number, number] = [maxLat + (ROT_OFFSET_M / R) * (180 / Math.PI), cLng];
    const topEdgeLatLng: [number, number] = [maxLat, cLng];
    const rotStem = L.polyline([topEdgeLatLng, rotHandleLatLng], { color: '#1f2937', weight: 1.5, opacity: 0.85, interactive: false });
    rotStem.addTo(layer);
    const rotHandle = L.marker(rotHandleLatLng, {
      draggable: true, bubblingMouseEvents: false, zIndexOffset: 1100,
      icon: L.divIcon({
        className: 'bessty-group-rot',
        html: '<div style="width:22px;height:22px;border-radius:50%;background:#3b82f6;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,.4)">↻</div>',
        iconSize: [22, 22], iconAnchor: [11, 11],
      }),
      title: 'Rotate group',
    });

    const toLocal = (p: L.LatLng) => ({ lx: (p.lng - cLng) * (Math.PI / 180) * R * cosLat, ly: -(p.lat - cLat) * (Math.PI / 180) * R });
    const fromLocal = (lx: number, ly: number): [number, number] => [cLat + (-ly / R) * (180 / Math.PI), cLng + (lx / (R * cosLat)) * (180 / Math.PI)];

    // ----- Rotation about centroid -----
    let rotSnap: {
      startAngle: number;
      members: Map<string, { lx: number; ly: number }>;
      fps: Map<string, Array<{ lx: number; ly: number }>>;
      poly: Array<{ lx: number; ly: number }>;
      stem: Array<{ lx: number; ly: number }>;
    } | null = null;
    rotHandle.on('dragstart', () => {
      const here = rotHandle.getLatLng();
      const startAngle = Math.atan2((here.lng - cLng) * cosLat, here.lat - cLat);
      const mm = new Map<string, { lx: number; ly: number }>();
      const fps = new Map<string, Array<{ lx: number; ly: number }>>();
      for (const m of members) {
        const mk = markersByIdRef.current.get(m.id);
        if (mk) mm.set(m.id, toLocal(mk.getLatLng()));
        const fp = polysByIdRef.current.get(m.id);
        if (fp) fps.set(m.id, (fp.getLatLngs()[0] as L.LatLng[]).map(toLocal));
      }
      rotSnap = {
        startAngle, members: mm, fps,
        poly: (poly.getLatLngs()[0] as L.LatLng[]).map(toLocal),
        stem: (rotStem.getLatLngs() as L.LatLng[]).map(toLocal),
      };
    });
    rotHandle.on('drag', () => {
      const snap = rotSnap;
      if (!snap) return;
      const here = rotHandle.getLatLng();
      const d = Math.atan2((here.lng - cLng) * cosLat, here.lat - cLat) - snap.startAngle;
      const cosD = Math.cos(d), sinD = Math.sin(d);
      const rot = (p: { lx: number; ly: number }) => ({ lx: p.lx * cosD - p.ly * sinD, ly: p.lx * sinD + p.ly * cosD });
      for (const [id, pt] of snap.members) { const r = rot(pt); const mk = markersByIdRef.current.get(id); if (mk) mk.setLatLng(fromLocal(r.lx, r.ly)); }
      for (const [id, cs] of snap.fps) { const fp = polysByIdRef.current.get(id); if (fp) fp.setLatLngs(cs.map((c) => { const r = rot(c); return fromLocal(r.lx, r.ly); })); }
      poly.setLatLngs(snap.poly.map((c) => { const r = rot(c); return fromLocal(r.lx, r.ly); }));
      rotStem.setLatLngs(snap.stem.map((c) => { const r = rot(c); return fromLocal(r.lx, r.ly); }));
      rotHandle.options.title = `${((d * 180) / Math.PI).toFixed(0)}°`;
    });
    rotHandle.on('dragend', () => {
      const snap = rotSnap;
      rotSnap = null;
      if (!snap) return;
      const here = rotHandle.getLatLng();
      const deltaDeg = ((Math.atan2((here.lng - cLng) * cosLat, here.lat - cLat) - snap.startAngle) * 180) / Math.PI;
      if (Math.abs(deltaDeg) > 0.05) callbacksRef.current.onRotateGroup?.(gid, +deltaDeg.toFixed(2));
    });
    rotHandle.addTo(layer);

    // ----- Centre translate -----
    let cStart: L.LatLng | null = null;
    const mSnap = new Map<string, L.LatLng>();
    const fpSnap = new Map<string, L.LatLng[]>();
    let rotHSnap: L.LatLng | null = null, rotSSnap: L.LatLng[] | null = null, polySnap: L.LatLng[] | null = null;
    centreHandle.on('dragstart', () => {
      cStart = centreHandle.getLatLng();
      mSnap.clear(); fpSnap.clear();
      for (const m of members) {
        const mk = markersByIdRef.current.get(m.id);
        if (mk) mSnap.set(m.id, mk.getLatLng());
        const fp = polysByIdRef.current.get(m.id);
        if (fp) fpSnap.set(m.id, (fp.getLatLngs()[0] as L.LatLng[]).map((p) => L.latLng(p.lat, p.lng)));
      }
      rotHSnap = rotHandle.getLatLng();
      rotSSnap = (rotStem.getLatLngs() as L.LatLng[]).map((p) => L.latLng(p.lat, p.lng));
      polySnap = (poly.getLatLngs()[0] as L.LatLng[]).map((p) => L.latLng(p.lat, p.lng));
    });
    centreHandle.on('drag', () => {
      if (!cStart) return;
      const here = centreHandle.getLatLng();
      const dLat = here.lat - cStart.lat, dLng = here.lng - cStart.lng;
      for (const [id, o] of mSnap) { const mk = markersByIdRef.current.get(id); if (mk) mk.setLatLng([o.lat + dLat, o.lng + dLng]); }
      for (const [id, cs] of fpSnap) { const fp = polysByIdRef.current.get(id); if (fp) fp.setLatLngs(cs.map((p) => L.latLng(p.lat + dLat, p.lng + dLng))); }
      if (rotHSnap) rotHandle.setLatLng([rotHSnap.lat + dLat, rotHSnap.lng + dLng]);
      if (rotSSnap) rotStem.setLatLngs(rotSSnap.map((p) => L.latLng(p.lat + dLat, p.lng + dLng)));
      if (polySnap) poly.setLatLngs(polySnap.map((p) => L.latLng(p.lat + dLat, p.lng + dLng)));
    });
    centreHandle.on('dragend', () => {
      if (!cStart) return;
      const here = centreHandle.getLatLng();
      const dLat = here.lat - cStart.lat, dLng = here.lng - cStart.lng;
      cStart = null; mSnap.clear(); fpSnap.clear(); rotHSnap = null; rotSSnap = null; polySnap = null;
      if (Math.abs(dLat) > 1e-9 || Math.abs(dLng) > 1e-9) callbacksRef.current.onTranslateGroup?.(gid, dLat, dLng);
    });
  }, [project, selectedGroupId, selectedIds]);

  // The grid-debug layer draws only the cell centres currently on screen (see
  // I13 in the overlay effect), so it has to redraw when the view moves. Only
  // subscribe while the layer is on — otherwise every pan would rebuild the
  // whole contour overlay for nothing.
  const [viewTick, setViewTick] = useState(0);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showGridDebug) return;
    const bump = () => setViewTick((t) => t + 1);
    map.on('moveend zoomend', bump);
    return () => { map.off('moveend zoomend', bump); };
  }, [showGridDebug]);

  // Render contour overlay (filled raster, iso-lines, or both).
  useEffect(() => {
    const map = mapRef.current;
    const group = overlayGroupRef.current;
    if (!map || !group) return;
    group.clearLayers();
    if (!showContours || !grid) return;

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
      // Pass the raw grid straight through. We previously bicubic-upscaled
      // by 4× before contour generation to smooth visibly blocky lines on
      // coarse rasters — but the upscaled grid doesn't tile the bounds
      // cleanly under the cell-centred convention (cell centres of the
      // upscaled grid don't sit on cell centres of the original) which
      // pushed contours half-a-cell SW. d3-contour's built-in `.smooth(true)`
      // is sufficient for visual quality on grids of ~5k+ cells (typical),
      // and keeps the contour geometry spatially exact.
      const sets = buildContourLines(grid, thresholds);
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

    if (markersGroupRef.current) { markersGroupRef.current.remove(); markersGroupRef.current.addTo(map); }
  }, [grid, showContours, showGridDebug, contourMode, contourOpacity, palette, dbDomain.min, dbDomain.max]);

  // Grid-debug cell centres (I13). A dot at every cell centre, for diagnosing
  // alignment between the raster, the contour lines and the markers.
  // Cell-centred convention: cell (col,row) sits at
  // (sw + (col+0.5)/cols × lngRange, sw + (row+0.5)/rows × latRange).
  //
  // This used to bound the dot count by STRIDING the grid
  // (`ceil(sqrt(cols·rows / 4000))`), so any grid over 4000 cells silently drew
  // every 2nd cell: a 100 m grid over a 10 km area (100×100) rendered as 200 m
  // and read as a spacing bug. A debug layer that misreports spacing is worse
  // than none, so the budget is spent on the VIEWPORT instead — every cell
  // centre actually on screen, redrawn on pan/zoom via `viewTick`. Dots are
  // therefore always at true cell spacing.
  useEffect(() => {
    const map = mapRef.current;
    const group = gridDebugGroupRef.current;
    if (!map || !group) return;
    group.clearLayers();
    if (!showGridDebug || !grid) return;

    const sw = grid.bounds.sw;
    const ne = grid.bounds.ne;
    const lngRange = ne[1] - sw[1];
    const latRange = ne[0] - sw[0];
    const view = map.getBounds().pad(0.15);
    const MAX_DOTS = 20000;
    let drawn = 0;
    let clipped = false;
    for (let row = 0; row < grid.rows && !clipped; row++) {
      const lat = sw[0] + (row + 0.5) / grid.rows * latRange;
      if (lat < view.getSouth() || lat > view.getNorth()) continue;
      for (let col = 0; col < grid.cols; col++) {
        const lng = sw[1] + (col + 0.5) / grid.cols * lngRange;
        if (lng < view.getWest() || lng > view.getEast()) continue;
        if (drawn >= MAX_DOTS) { clipped = true; break; }
        drawn++;
        L.circleMarker([lat, lng], {
          radius: 1.5,
          color: '#ff3399',
          weight: 1,
          fill: true,
          fillOpacity: 1,
          interactive: false,
        }).addTo(group);
      }
    }
    if (clipped) {
      // Only reachable zoomed out far enough that 20k cells are on screen,
      // where the dots are sub-pixel anyway. Say so rather than silently
      // drawing a partial grid.
      console.warn(
        `[grid debug] ${MAX_DOTS} cell centres drawn, more are in view — zoom in to see the rest.`,
      );
    }
  }, [grid, showGridDebug, viewTick]);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.style.cursor = addMode === 'none' ? '' : 'crosshair';
  }, [addMode]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
