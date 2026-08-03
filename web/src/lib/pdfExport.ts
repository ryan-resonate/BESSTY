// I15 — report-quality PDF snapshot of the map.
//
// The basemap goes in as a bitmap, everything computed goes in as TRUE VECTORS
// on top: contour lines and receiver values stay crisp and selectable at any
// zoom, which is the difference between a report figure and a screenshot.
//
// The basemap is composed by FETCHING tile URLs for the export extent rather
// than screenshotting Leaflet's canvas. Screenshotting would taint the canvas
// (cross-origin tiles) and lock us to screen resolution; fetching lets us
// render at 2x for print and keeps the projection ours, so the vector overlays
// land exactly where the raster says they should.

import { jsPDF } from 'jspdf';

/// Web Mercator, normalised to [0,1] over the whole world. Everything here maps
/// through this so the raster and the vectors cannot disagree.
export function project(lat: number, lng: number): { x: number; y: number } {
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
  };
}

export interface Extent {
  sw: [number, number];
  ne: [number, number];
}

export interface PageSpec {
  /// Page size in mm.
  widthMm: number;
  heightMm: number;
  marginMm: number;
}

export const PAGES: Record<string, PageSpec> = {
  'a4-landscape': { widthMm: 297, heightMm: 210, marginMm: 10 },
  'a4-portrait': { widthMm: 210, heightMm: 297, marginMm: 10 },
  'a3-landscape': { widthMm: 420, heightMm: 297, marginMm: 12 },
  'a3-portrait': { widthMm: 297, heightMm: 420, marginMm: 12 },
};

/// The drawing box on the page, and the transform from lat/lng into it.
///
/// The map extent is fitted to the box preserving aspect, so the exported
/// figure is never stretched — a stretched scale bar is a wrong scale bar.
export interface MapFrame {
  x: number; y: number; w: number; h: number;   // mm
  toPage(lat: number, lng: number): [number, number];
  /// Metres per mm on the page, at the extent's centre latitude.
  metresPerMm: number;
}

export function fitFrame(extent: Extent, page: PageSpec, topPadMm = 0): MapFrame {
  const a = project(extent.sw[0], extent.sw[1]);
  const b = project(extent.ne[0], extent.ne[1]);
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const spanX = Math.max(maxX - minX, 1e-12);
  const spanY = Math.max(maxY - minY, 1e-12);

  const availW = page.widthMm - page.marginMm * 2;
  const availH = page.heightMm - page.marginMm * 2 - topPadMm;
  const scale = Math.min(availW / spanX, availH / spanY);
  const w = spanX * scale;
  const h = spanY * scale;
  const x = page.marginMm + (availW - w) / 2;
  const y = page.marginMm + topPadMm + (availH - h) / 2;

  const centreLat = (extent.sw[0] + extent.ne[0]) / 2;
  // World circumference at this latitude, over the page width the world spans.
  const worldM = 40075016.686 * Math.cos((centreLat * Math.PI) / 180);
  const metresPerMm = (worldM * spanX) / w;

  return {
    x, y, w, h,
    metresPerMm,
    toPage(lat, lng) {
      const p = project(lat, lng);
      return [
        x + ((p.x - minX) / spanX) * w,
        y + ((p.y - minY) / spanY) * h,
      ];
    },
  };
}

/// A "1, 2, 5 × 10ⁿ" round number at or below `target` — scale bars read as
/// nonsense unless the label is a number people recognise.
export function niceScaleLength(targetM: number): number {
  if (!(targetM > 0)) return 100;
  const pow = Math.pow(10, Math.floor(Math.log10(targetM)));
  const n = targetM / pow;
  const mult = n >= 5 ? 5 : n >= 2 ? 2 : 1;
  return mult * pow;
}

export function formatScale(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `${m.toFixed(0)} m`;
}

// ------------------------------------------------------------------ basemap

/// Slippy-tile coordinates covering an extent at a zoom.
export function tileRange(extent: Extent, zoom: number) {
  const n = Math.pow(2, zoom);
  const a = project(extent.sw[0], extent.sw[1]);
  const b = project(extent.ne[0], extent.ne[1]);
  return {
    x0: Math.floor(Math.min(a.x, b.x) * n),
    x1: Math.floor(Math.max(a.x, b.x) * n),
    y0: Math.floor(Math.min(a.y, b.y) * n),
    y1: Math.floor(Math.max(a.y, b.y) * n),
    n,
  };
}

/// Pick the zoom whose tile grid gives at least `targetPx` across the extent,
/// capped so we never request thousands of tiles for a whole-country extent.
export function chooseZoom(extent: Extent, targetPx: number, maxZoom: number): number {
  const a = project(extent.sw[0], extent.sw[1]);
  const b = project(extent.ne[0], extent.ne[1]);
  const spanX = Math.max(Math.abs(b.x - a.x), 1e-12);
  for (let z = maxZoom; z >= 0; z--) {
    const px = spanX * Math.pow(2, z) * 256;
    // Also bound the tile count so a huge extent can't fire off a thousand
    // requests before anyone notices.
    const tiles = (tileRange(extent, z).x1 - tileRange(extent, z).x0 + 1)
      * (tileRange(extent, z).y1 - tileRange(extent, z).y0 + 1);
    if (px <= targetPx * 1.6 && tiles <= 400) return z;
  }
  return 0;
}

export interface BasemapResult {
  dataUrl: string;
  /// Fractional world coords of the composed image, so the caller can crop.
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/// Compose the visible tiles onto an offscreen canvas and return a PNG data URL
/// cropped exactly to `extent`.
export async function composeBasemap(
  extent: Extent,
  urlFor: (z: number, x: number, y: number) => string,
  opts: { targetPx?: number; maxZoom?: number } = {},
): Promise<BasemapResult | null> {
  const targetPx = opts.targetPx ?? 2400;
  const z = chooseZoom(extent, targetPx, opts.maxZoom ?? 19);
  const r = tileRange(extent, z);
  const cols = r.x1 - r.x0 + 1;
  const rows = r.y1 - r.y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = cols * 256;
  canvas.height = rows * 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  await Promise.all(
    Array.from({ length: cols * rows }, async (_, i) => {
      const cx = r.x0 + (i % cols);
      const cy = r.y0 + Math.floor(i / cols);
      try {
        const res = await fetch(urlFor(z, cx, cy), { mode: 'cors' });
        if (!res.ok) return;
        const bmp = await createImageBitmap(await res.blob());
        ctx.drawImage(bmp, (cx - r.x0) * 256, (cy - r.y0) * 256);
      } catch {
        // A missing tile leaves a blank square rather than failing the export —
        // a figure with one grey tile beats no figure at all.
      }
    }),
  );

  // Crop to the exact extent.
  const a = project(extent.sw[0], extent.sw[1]);
  const b = project(extent.ne[0], extent.ne[1]);
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const sx = (minX * r.n - r.x0) * 256;
  const sy = (minY * r.n - r.y0) * 256;
  const sw = (maxX - minX) * r.n * 256;
  const sh = (maxY - minY) * r.n * 256;

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw));
  out.height = Math.max(1, Math.round(sh));
  const octx = out.getContext('2d');
  if (!octx) return null;
  octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);

  return { dataUrl: out.toDataURL('image/jpeg', 0.85), bounds: { minX, minY, maxX, maxY } };
}

// -------------------------------------------------------------------- report

export interface PdfDoc {
  doc: jsPDF;
  frame: MapFrame;
}

export function startPdf(page: PageSpec, extent: Extent, topPadMm: number): PdfDoc {
  const doc = new jsPDF({
    orientation: page.widthMm >= page.heightMm ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [page.widthMm, page.heightMm],
  });
  return { doc, frame: fitFrame(extent, page, topPadMm) };
}

/// Scale bar in the bottom-left of the map frame.
export function drawScaleBar(doc: jsPDF, frame: MapFrame) {
  const targetMm = Math.min(50, frame.w * 0.25);
  const lengthM = niceScaleLength(targetMm * frame.metresPerMm);
  const barMm = lengthM / frame.metresPerMm;
  const x = frame.x + 4;
  const y = frame.y + frame.h - 6;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(30, 30, 30);
  doc.setLineWidth(0.3);
  doc.rect(x - 1.5, y - 5, barMm + 3, 8.5, 'FD');
  doc.setFillColor(30, 30, 30);
  doc.rect(x, y, barMm, 1.2, 'F');
  doc.setFontSize(7);
  doc.setTextColor(30, 30, 30);
  doc.text(formatScale(lengthM), x, y - 1.2);
}

/// North arrow, top-right of the map frame. The map is always north-up, so this
/// is a fixed glyph rather than a rotation.
export function drawNorthArrow(doc: jsPDF, frame: MapFrame) {
  const x = frame.x + frame.w - 10;
  const y = frame.y + 12;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(30, 30, 30);
  doc.setLineWidth(0.3);
  doc.circle(x, y - 2, 7, 'FD');
  doc.setFillColor(30, 30, 30);
  doc.triangle(x, y - 7, x - 2.4, y + 1, x + 2.4, y + 1, 'F');
  doc.setFontSize(7);
  doc.text('N', x - 1.4, y + 4.5);
}

/// Basemap credit, bottom-right inside the map frame.
///
/// Not optional in the export dialog: Esri and OpenStreetMap both require the
/// credit to travel with the imagery, so a report figure needs it exactly as
/// much as the screen does. Making it a checkbox would invite removing it.
export function drawAttribution(doc: jsPDF, frame: MapFrame, text: string) {
  if (!text) return;
  doc.setFontSize(5.5);
  const w = doc.getTextWidth(text) + 2;
  const x = frame.x + frame.w - w - 1;
  const y = frame.y + frame.h - 1;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(255, 255, 255);
  doc.rect(x - 0.5, y - 2.6, w + 1, 3.4, 'F');
  doc.setTextColor(70, 70, 70);
  doc.text(text, x + 0.5, y);
}

// ----------------------------------------------------------------- clipping
//
// Geometric clipping of polylines to the map frame, in page millimetres.
// The PDF's own clip region (`W n`) is also set, but the contour grid covers
// the whole calculation area — usually well past the visible extent — and a
// clip that silently fails (as jsPDF's did when `rect()` was called without
// the `null` style argument) sprays ink across the page margins. Clipping the
// geometry before it reaches jsPDF cannot fail silently, and is testable.

export interface ClipRect { x: number; y: number; w: number; h: number }

/// Begin a PDF clip region equal to the map frame; pair with [`endFrameClip`].
///
/// The `null` style argument to `rect` is LOAD-BEARING: any other value makes
/// jsPDF PAINT and consume the path (`putStyle` early-returns only for a
/// literal null), which turns the sequence into `re S W n` — a stroked
/// rectangle followed by a clip with no current path, which viewers ignore.
/// That one missing argument is exactly why contours originally spilled over
/// the page. The operator-stream test in pdfExport.test.ts targets THIS
/// helper, so the regression cannot return without a test failing.
export function beginFrameClip(doc: jsPDF, frame: ClipRect): void {
  doc.saveGraphicsState();
  doc.rect(frame.x, frame.y, frame.w, frame.h, null);
  doc.clip();
  doc.discardPath();
}

/// End the clip region begun by [`beginFrameClip`].
export function endFrameClip(doc: jsPDF): void {
  doc.restoreGraphicsState();
}

/// Liang–Barsky: the portion of segment p→q inside `r`, or `null` when the
/// segment misses the rectangle entirely.
export function clipSegmentToRect(
  p: [number, number],
  q: [number, number],
  r: ClipRect,
): [[number, number], [number, number]] | null {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  // Each edge as the constraint den·t ≤ num over t ∈ [0,1].
  const edges: Array<[number, number]> = [
    [-dx, p[0] - r.x],          // x ≥ left
    [dx, r.x + r.w - p[0]],     // x ≤ right
    [-dy, p[1] - r.y],          // y ≥ top (page y grows downward)
    [dy, r.y + r.h - p[1]],     // y ≤ bottom
  ];
  let t0 = 0;
  let t1 = 1;
  for (const [den, num] of edges) {
    if (den === 0) {
      if (num < 0) return null;                       // parallel and outside
      continue;
    }
    const t = num / den;
    if (den < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [
    [p[0] + t0 * dx, p[1] + t0 * dy],
    [p[0] + t1 * dx, p[1] + t1 * dy],
  ];
}

function sameVertex(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

/// Split a polyline into the runs that lie inside `r`. Consecutive in-rect
/// segments stitch into one run; where the line exits and re-enters, a new
/// run starts at the re-entry point. Purely-degenerate runs (a segment that
/// only grazes a corner) are dropped.
export function clipPolylineToRect(
  pts: Array<[number, number]>,
  r: ClipRect,
): Array<Array<[number, number]>> {
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> | null = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = clipSegmentToRect(pts[i], pts[i + 1], r);
    if (!seg) { run = null; continue; }
    const [a, b] = seg;
    if (run && sameVertex(run[run.length - 1], a)) {
      run.push(b);
    } else {
      run = [a, b];
      runs.push(run);
    }
  }
  return runs.filter((rn) => rn.length > 2 || !sameVertex(rn[0], rn[1]));
}
