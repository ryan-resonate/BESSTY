// I15 — assemble the PDF figure: bitmap basemap, vector everything-else.
//
// Kept apart from `pdfExport.ts` (pure geometry, unit-tested) because this half
// needs the DOM for tile fetching and touches project types.

import type { jsPDF } from 'jspdf';
import type { Project } from './types';
import { limitForPeriod } from './types';
import { exceedsLimit, limitComparisonFor } from './limits';
import type { GridResult, ReceiverResult } from './solver';
import { buildContourLines } from './contourLines';
import { makeBandsForRange, paletteCss, type Palette } from './colormap';
import {
  composeBasemap, drawNorthArrow, drawScaleBar, PAGES, startPdf,
  type Extent, type MapFrame,
} from './pdfExport';

export interface PdfOptions {
  pageId: keyof typeof PAGES;
  titleBlock: boolean;
  legend: boolean;
  scaleBar: boolean;
  northArrow: boolean;
  showReceiverLimits: boolean;
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = {
  pageId: 'a4-landscape',
  titleBlock: true,
  legend: true,
  scaleBar: true,
  northArrow: true,
  showReceiverLimits: false,
};

export interface PdfInput {
  project: Project;
  results: ReceiverResult[] | null;
  grid: GridResult | null;
  extent: Extent;
  palette: Palette;
  dbDomain: { min: number; max: number };
  contourStepDb: number;
  showContours: boolean;
  tileUrl(z: number, x: number, y: number): string;
  options: PdfOptions;
}

/// `#rrggbb` → jsPDF's 0–255 triple.
function rgb(css: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css.trim());
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  const f = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(css);
  if (f) return [+f[1], +f[2], +f[3]];
  return [0, 0, 0];
}

export async function buildPdf(input: PdfInput): Promise<jsPDF> {
  const { project, results, grid, extent, options: o } = input;
  const page = PAGES[o.pageId] ?? PAGES['a4-landscape'];
  const topPad = o.titleBlock ? 16 : 0;
  const { doc, frame } = startPdf(page, extent, topPad);

  // ---- basemap ----
  const base = await composeBasemap(extent, input.tileUrl);
  if (base) {
    doc.addImage(base.dataUrl, 'JPEG', frame.x, frame.y, frame.w, frame.h, undefined, 'FAST');
  } else {
    doc.setFillColor(240, 240, 240);
    doc.rect(frame.x, frame.y, frame.w, frame.h, 'F');
  }
  doc.setDrawColor(60, 60, 60);
  doc.setLineWidth(0.3);
  doc.rect(frame.x, frame.y, frame.w, frame.h);

  // ---- contours (vector) ----
  if (input.showContours && grid) {
    const bands = makeBandsForRange(input.dbDomain.min, input.dbDomain.max, input.contourStepDb);
    const thresholds = bands.map((b) => b.lo)
      .concat([bands[bands.length - 1]?.hi ?? input.dbDomain.max]);
    doc.setLineWidth(0.25);
    for (const set of buildContourLines(grid, thresholds)) {
      const t = Math.max(0, Math.min(1,
        (set.threshold - input.dbDomain.min) / (input.dbDomain.max - input.dbDomain.min || 1)));
      const [r, g, b] = rgb(paletteCss(input.palette, t));
      doc.setDrawColor(r, g, b);
      for (const line of set.lines) {
        if (line.length < 2) continue;
        // One path per polyline keeps the PDF vector and small.
        const pts = line.map(([lat, lng]) => frame.toPage(lat, lng));
        doc.lines(
          pts.slice(1).map((p, i) => [p[0] - pts[i][0], p[1] - pts[i][1]] as [number, number]),
          pts[0][0], pts[0][1],
        );
      }
    }
  }

  drawBarriers(doc, project, frame);
  drawSources(doc, project, frame);
  drawCalcArea(doc, project, frame);
  drawReceivers(doc, project, results, frame, o.showReceiverLimits);

  if (o.legend && input.showContours && grid) drawLegend(doc, input, frame);
  if (o.scaleBar) drawScaleBar(doc, frame);
  if (o.northArrow) drawNorthArrow(doc, frame);
  if (o.titleBlock) drawTitle(doc, project, page.marginMm);

  return doc;
}

function drawTitle(doc: jsPDF, project: Project, margin: number) {
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(13);
  doc.text(project.name || 'Untitled project', margin, margin + 5);
  doc.setFontSize(8);
  doc.setTextColor(90, 90, 90);
  const sc = project.scenario;
  doc.text(
    `${sc.period} · ${sc.windSpeed} m/s · ${sc.bandSystem === 'oneThirdOctave' ? '1/3 octave' : 'octave'}`
    + `  —  ISO 9613-2:${project.settings?.standard ?? '2024'}`
    + `  —  exported ${new Date().toLocaleDateString()}`,
    margin, margin + 10,
  );
}

function drawCalcArea(doc: jsPDF, project: Project, frame: MapFrame) {
  const ca = project.calculationArea;
  if (!ca) return;
  const corners = calcAreaCorners(ca);
  doc.setDrawColor(242, 203, 0);
  doc.setLineWidth(0.4);
  doc.setLineDashPattern([1.5, 1.2], 0);
  const pts = corners.map(([lat, lng]) => frame.toPage(lat, lng));
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    doc.line(a[0], a[1], b[0], b[1]);
  }
  doc.setLineDashPattern([], 0);
}

/// Corners of the (possibly rotated) calc-area rectangle, in lat/lng.
export function calcAreaCorners(ca: NonNullable<Project['calculationArea']>): Array<[number, number]> {
  const R = 6371008.8;
  const [lat0, lng0] = ca.centerLatLng;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const th = ((ca.rotationDeg ?? 0) * Math.PI) / 180;
  const hw = ca.widthM / 2;
  const hh = ca.heightM / 2;
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as Array<[number, number]>).map(([sx, sy]) => {
    const x = sx * hw;
    const y = sy * hh;
    const wx = x * Math.cos(th) - y * Math.sin(th);
    const wy = x * Math.sin(th) + y * Math.cos(th);
    return [
      lat0 + (-wy / R) * (180 / Math.PI),
      lng0 + (wx / (R * cosLat)) * (180 / Math.PI),
    ] as [number, number];
  });
}

function drawBarriers(doc: jsPDF, project: Project, frame: MapFrame) {
  doc.setDrawColor(180, 60, 20);
  doc.setLineWidth(0.6);
  for (const b of project.barriers ?? []) {
    const poly = b.polylineLatLng ?? [];
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = frame.toPage(poly[i][0], poly[i][1]);
      const c = frame.toPage(poly[i + 1][0], poly[i + 1][1]);
      doc.line(a[0], a[1], c[0], c[1]);
    }
  }
}

const KIND_RGB: Record<string, [number, number, number]> = {
  bess: [94, 53, 177],
  auxiliary: [21, 101, 192],
  wtg: [40, 40, 40],
};

function drawSources(doc: jsPDF, project: Project, frame: MapFrame) {
  for (const s of project.sources) {
    if (!Number.isFinite(s.latLng[0]) || !Number.isFinite(s.latLng[1])) continue;
    const [x, y] = frame.toPage(s.latLng[0], s.latLng[1]);
    const [r, g, b] = KIND_RGB[s.kind] ?? [40, 40, 40];
    doc.setFillColor(r, g, b);
    doc.setDrawColor(255, 255, 255);
    doc.setLineWidth(0.15);
    doc.circle(x, y, s.kind === 'wtg' ? 0.9 : 0.6, 'FD');
  }
}

function drawReceivers(
  doc: jsPDF,
  project: Project,
  results: ReceiverResult[] | null,
  frame: MapFrame,
  showLimits: boolean,
) {
  const mode = limitComparisonFor(project);
  doc.setLineWidth(0.2);
  for (const r of project.receivers) {
    if (!Number.isFinite(r.latLng[0]) || !Number.isFinite(r.latLng[1])) continue;
    const [x, y] = frame.toPage(r.latLng[0], r.latLng[1]);
    const res = results?.find((z) => z.receiverId === r.id);
    const dbA = res && Number.isFinite(res.totalDbA) ? res.totalDbA : null;
    const limit = limitForPeriod(r, project.scenario.period);
    // Same rule as every other surface (I17) — a PDF that disagrees with the
    // screen is worse than one with no colours.
    const fail = exceedsLimit(dbA, limit, mode);
    const col: [number, number, number] = fail ? [211, 47, 47] : [46, 125, 50];

    doc.setFillColor(col[0], col[1], col[2]);
    doc.setDrawColor(255, 255, 255);
    doc.circle(x, y, 1.0, 'FD');

    // Label box, offset up-right so the dot stays visible.
    const label = dbA != null ? `${dbA.toFixed(1)} dB(A)` : '—';
    doc.setFontSize(6.5);
    const w = doc.getTextWidth(label) + 2;
    const h = showLimits ? 5.6 : 3.6;
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(40, 40, 40);
    doc.roundedRect(x + 1.6, y - h - 0.8, w, h, 0.6, 0.6, 'FD');
    doc.setTextColor(col[0], col[1], col[2]);
    doc.text(label, x + 2.6, y - h + 1.9);
    if (showLimits && Number.isFinite(limit)) {
      doc.setFontSize(5);
      doc.setTextColor(110, 110, 110);
      doc.text(`limit ${limit.toFixed(0)}`, x + 2.6, y - h + 4.6);
    }
    // Name under the dot.
    doc.setFontSize(5.5);
    doc.setTextColor(30, 30, 30);
    doc.text(r.name ?? r.id, x + 1.6, y + 2.6);
  }
}

function drawLegend(doc: jsPDF, input: PdfInput, frame: MapFrame) {
  const bands = makeBandsForRange(input.dbDomain.min, input.dbDomain.max, input.contourStepDb)
    .slice().reverse();
  const rowH = 3.4;
  const w = 24;
  const h = bands.length * rowH + 6;
  const x = frame.x + frame.w - w - 4;
  const y = frame.y + frame.h - h - 4;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(40, 40, 40);
  doc.setLineWidth(0.3);
  doc.rect(x, y, w, h, 'FD');
  doc.setFontSize(6);
  doc.setTextColor(30, 30, 30);
  doc.text('Lp dB(A)', x + 2, y + 4);
  bands.forEach((b, i) => {
    const t = Math.max(0, Math.min(1,
      ((b.lo + b.hi) / 2 - input.dbDomain.min) / (input.dbDomain.max - input.dbDomain.min || 1)));
    const [r, g, bl] = rgb(paletteCss(input.palette, t));
    const ry = y + 6 + i * rowH;
    doc.setFillColor(r, g, bl);
    doc.rect(x + 2, ry, 4, 2.4, 'F');
    doc.setTextColor(30, 30, 30);
    doc.text(b.label, x + 7.5, ry + 2);
  });
}
