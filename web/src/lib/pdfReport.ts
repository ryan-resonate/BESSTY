// I15 — assemble the PDF figure: bitmap basemap, vector everything-else.
//
// Kept apart from `pdfExport.ts` (pure geometry, unit-tested) because this half
// needs the DOM for tile fetching and touches project types.

import type { jsPDF } from 'jspdf';
import type { CustomContourLine, Project } from './types';
import { limitForPeriod } from './types';
import { calcAreaCorners } from './geo';
import { assessedLevel, exceedsLimit, limitComparisonFor } from './limits';
import type { GridResult, ReceiverResult } from './solver';
import {
  buildContourLines, customTracesFrom, steppedTracesFrom, unionContourLevels,
} from './contourLines';
import {
  ANNOTATION_PT, annotationsOf, dimensionLabel, dimensionMidpoint, dimensionTiltDeg,
  leaderAttachOffset,
} from './annotations';
import { PDF_FONT, useHouseFont } from './pdfFont';
import { weightingFor, weightingLabel } from './weighting';
import { makeBandsForRange, paletteCss, type Palette } from './colormap';
import {
  beginFrameClip, clipPolylineToRect, composeBasemap, drawAttribution, drawNorthArrow,
  drawScaleBar, endFrameClip, PAGES, startPdf, type Extent, type MapFrame,
} from './pdfExport';

export interface PdfOptions {
  pageId: keyof typeof PAGES;
  titleBlock: boolean;
  legend: boolean;
  scaleBar: boolean;
  northArrow: boolean;
  showReceiverLimits: boolean;
  /// Draw the receiver name under each marker.
  showReceiverNames: boolean;
  /// Draw the project's notes and dimension lines.
  annotations: boolean;
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = {
  pageId: 'a4-landscape',
  titleBlock: true,
  legend: true,
  scaleBar: true,
  northArrow: true,
  showReceiverLimits: false,
  showReceiverNames: true,
  annotations: true,
};

export interface PdfInput {
  project: Project;
  results: ReceiverResult[] | null;
  grid: GridResult | null;
  extent: Extent;
  palette: Palette;
  dbDomain: { min: number; max: number };
  contourStepDb: number;
  /// User-named compliance lines. Only those with `export` set are drawn, and
  /// like on the map they are drawn whether or not the stepped contours are.
  customContours?: CustomContourLine[];
  showContours: boolean;
  tileUrl(z: number, x: number, y: number): string;
  /// Basemap credit — REQUIRED by both providers, so it is not optional.
  attribution: string;
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

  // House typeface for EVERY string on the page, not just annotations — a
  // figure set half in Arial and half in Helvetica reads as a mistake.
  // `useHouseFont` leaves it as the active face, so every later `doc.text`
  // picks it up; it falls back to Helvetica if registration fails.
  const family = (await useHouseFont(doc)) ? PDF_FONT : 'helvetica';

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

  // ---- overlays, kept inside the map frame ----
  //
  // Two independent guards stop ink running onto the page margins:
  //   1. every contour polyline is geometrically clipped to the frame
  //      (Liang–Barsky) before it reaches jsPDF — the grid covers the whole
  //      calculation area, which usually extends past the visible extent;
  //   2. a PDF clip region wraps everything drawn over the basemap, which
  //      also catches barriers / sources / receiver labels lying outside
  //      the exported extent.
  // The clip region alone was tried first and silently did nothing — see
  // `beginFrameClip` for the jsPDF trap involved. Hence both guards.
  beginFrameClip(doc, frame);
  const exportedCustom = (input.customContours ?? [])
    .filter((c) => c.export && Number.isFinite(c.levelDb));
  /// The custom lines that actually reached the page. A level the grid never
  /// crosses draws nothing, and the legend must agree: a compliance figure
  /// whose legend asserts a 40 dB contour that is not plotted is worse than one
  /// with no legend at all.
  let drawnCustom: CustomContourLine[] = [];
  if (grid && (input.showContours || exportedCustom.length > 0)) {
    const frameRect = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
    const bands = makeBandsForRange(input.dbDomain.min, input.dbDomain.max, input.contourStepDb);
    const thresholds = input.showContours
      ? bands.map((b) => b.lo).concat([bands[bands.length - 1]?.hi ?? input.dbDomain.max])
      : [];
    // One trace for both, as on the map: custom levels rarely sit on the step
    // grid, and tracing twice would double the cost of the export.
    const sets = buildContourLines(grid, unionContourLevels(thresholds, exportedCustom));

    /// Emit one path per clipped run — keeps the PDF vector and small.
    const strokeLine = (line: Array<[number, number]>) => {
      if (line.length < 2) return;
      const pts = line.map(([lat, lng]) => frame.toPage(lat, lng));
      for (const run of clipPolylineToRect(pts, frameRect)) {
        doc.lines(
          run.slice(1).map((p, i) => [p[0] - run[i][0], p[1] - run[i][1]] as [number, number]),
          run[0][0], run[0][1],
        );
      }
    };

    doc.setLineWidth(0.25);
    for (const set of steppedTracesFrom(sets, thresholds)) {
      const t = Math.max(0, Math.min(1,
        (set.threshold - input.dbDomain.min) / (input.dbDomain.max - input.dbDomain.min || 1)));
      const [r, g, b] = rgb(paletteCss(input.palette, t));
      doc.setDrawColor(r, g, b);
      for (const line of set.lines) strokeLine(line);
    }

    // Custom lines last so they sit over the stepped contours, in their own
    // colour, weight and dash. Widths are authored in screen px; 0.26 mm per px
    // puts a 2.5 px line at ~0.65 mm, which reads at print size the way it does
    // on screen.
    const traced = customTracesFrom(sets, exportedCustom);
    drawnCustom = traced.map((c) => c.line);
    for (const { line: def, set } of traced) {
      const [r, g, b] = rgb(def.color);
      doc.setDrawColor(r, g, b);
      doc.setLineWidth(Math.max(0.15, Math.min(3, def.widthPx * 0.26)));
      if (def.dashed) doc.setLineDashPattern([1.8, 1.3], 0);
      for (const line of set.lines) strokeLine(line);
      if (def.dashed) doc.setLineDashPattern([], 0);
    }
    doc.setLineWidth(0.25);
  }
  drawBarriers(doc, project, frame);
  drawSources(doc, project, frame);
  drawCalcArea(doc, project, frame);
  drawReceivers(doc, project, results, frame, o.showReceiverLimits, o.showReceiverNames);
  if (o.annotations) drawAnnotations(doc, project, frame);
  endFrameClip(doc);

  // Always drawn: the licence requires it, so it is not a dialog option.
  drawAttribution(doc, frame, input.attribution);
  if (o.legend && grid && (input.showContours || drawnCustom.length > 0)) {
    drawLegend(doc, input, frame, drawnCustom);
  }
  if (o.scaleBar) drawScaleBar(doc, frame);
  if (o.northArrow) drawNorthArrow(doc, frame);
  if (o.titleBlock) drawTitle(doc, project, page.marginMm, family);

  return doc;
}

function drawTitle(doc: jsPDF, project: Project, margin: number, family: string) {
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(13);
  doc.setFont(family, 'bold');
  doc.text(project.name || 'Untitled project', margin, margin + 5);
  doc.setFont(family, 'normal');
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
  showNames: boolean,
) {
  const mode = limitComparisonFor(project);
  const unit = weightingLabel(weightingFor(project));
  doc.setLineWidth(0.2);
  for (const r of project.receivers) {
    if (!Number.isFinite(r.latLng[0]) || !Number.isFinite(r.latLng[1])) continue;
    const [x, y] = frame.toPage(r.latLng[0], r.latLng[1]);
    const res = results?.find((z) => z.receiverId === r.id);
    const dbA = res && Number.isFinite(res.totalDbA) ? res.totalDbA : null;
    const limit = limitForPeriod(r, project.scenario.period);
    // Same rule as every other surface (I17) — a PDF that disagrees with the
    // screen is worse than one with no colours.
    const fail = exceedsLimit(assessedLevel(res), limit, mode);
    const col: [number, number, number] = fail ? [211, 47, 47] : [46, 125, 50];

    doc.setFillColor(col[0], col[1], col[2]);
    doc.setDrawColor(255, 255, 255);
    doc.circle(x, y, 1.0, 'FD');

    // Label box, offset up-right so the dot stays visible.
    const label = dbA != null ? `${dbA.toFixed(1)} ${unit}` : '—';
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
    // Name under the dot, with a white halo so it stays legible over dark
    // imagery — black-on-satellite is unreadable about half the time.
    if (showNames) {
      const nm = r.name ?? r.id;
      doc.setFontSize(5.5);
      doc.setTextColor(255, 255, 255);
      for (const [ox, oy] of [[-0.18, 0], [0.18, 0], [0, -0.18], [0, 0.18],
                              [-0.13, -0.13], [0.13, -0.13], [-0.13, 0.13], [0.13, 0.13]]) {
        doc.text(nm, x + 1.6 + ox, y + 2.6 + oy);
      }
      doc.setTextColor(20, 20, 20);
      doc.text(nm, x + 1.6, y + 2.6);
    }
  }
}

/// Notes and dimensions, in the house typeface at 9 pt.
///
/// Exported for test: the rest of `buildPdf` needs a DOM to fetch basemap
/// tiles, and what is worth checking here — that the note's words and the
/// dimension's measurement actually reach the page — needs no DOM at all.
///
/// Text is drawn with a white buffer — eight offset copies behind the black
/// glyphs — because black on aerial imagery is unreadable about half the time.
/// The same trick the receiver names use, at annotation size.
export function drawAnnotations(doc: jsPDF, project: Project, frame: MapFrame) {
  const items = annotationsOf(project);
  if (!items.length) return;
  doc.setFontSize(ANNOTATION_PT);
  // 9 pt ≈ 3.18 mm; a 0.22 mm buffer is the same visual weight the map uses.
  const halo = 0.22;
  const ring: Array<[number, number]> = [
    [-halo, 0], [halo, 0], [0, -halo], [0, halo],
    [-halo * 0.72, -halo * 0.72], [halo * 0.72, -halo * 0.72],
    [-halo * 0.72, halo * 0.72], [halo * 0.72, halo * 0.72],
  ];
  const buffered = (text: string, x: number, y: number, angle = 0) => {
    const opts = angle ? { angle } : undefined;
    doc.setTextColor(255, 255, 255);
    for (const [ox, oy] of ring) doc.text(text, x + ox, y + oy, opts);
    doc.setTextColor(0, 0, 0);
    doc.text(text, x, y, opts);
  };

  for (const a of items) {
    if (a.kind === 'text') {
      // An empty note prints nothing — but if it has a leader, that IS the
      // annotation, and dropping it left the map showing a pointer the PDF did
      // not.
      if (!a.text && !a.leaderTo) continue;
      const [x, y] = frame.toPage(a.latLng[0], a.latLng[1]);
      // Multi-line notes: one buffered run per line, centred like the map's.
      const lines = a.text.split('\n');
      const lineH = ANNOTATION_PT * 0.352778 * 1.25;   // pt → mm, 1.25 leading
      const textW = lines.reduce((m, ln) => Math.max(m, doc.getTextWidth(ln)), 0);
      const textH = lines.length * lineH;

      if (a.leaderTo) {
        const [lx, ly] = frame.toPage(a.leaderTo[0], a.leaderTo[1]);
        // Stops at the edge of the text rather than the centre, by the same
        // rule the map uses — a leader through the words is unreadable in both.
        // 0.7 mm of clearance so the rule does not touch the glyphs.
        const off = leaderAttachOffset(lx - x, ly - y, textW / 2 + 0.7, textH / 2 + 0.7);
        const ax = x + off.dx;
        const ay = y + off.dy;
        const reach = Math.hypot(lx - x, ly - y);
        if (reach > Math.hypot(off.dx, off.dy) + 0.3) {
          doc.setDrawColor(255, 255, 255);
          doc.setLineWidth(0.55);
          doc.line(ax, ay, lx, ly);
          doc.setDrawColor(0, 0, 0);
          doc.setLineWidth(0.25);
          doc.line(ax, ay, lx, ly);
        }
        doc.setFillColor(0, 0, 0);
        doc.circle(lx, ly, 0.45, 'F');
      }
      lines.forEach((ln, i) => {
        const w = doc.getTextWidth(ln);
        buffered(ln, x - w / 2, y - ((lines.length - 1) / 2 - i) * lineH);
      });
      continue;
    }

    const [x1, y1] = frame.toPage(a.from[0], a.from[1]);
    const [x2, y2] = frame.toPage(a.to[0], a.to[1]);
    doc.setDrawColor(255, 255, 255);
    doc.setLineWidth(0.55);
    doc.line(x1, y1, x2, y2);
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.25);
    doc.line(x1, y1, x2, y2);
    // End ticks perpendicular to the run, so the extent being dimensioned is
    // unambiguous.
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = -((y2 - y1) / len) * 0.9;
    const ny = ((x2 - x1) / len) * 0.9;
    doc.line(x1 - nx, y1 - ny, x1 + nx, y1 + ny);
    doc.line(x2 - nx, y2 - ny, x2 + nx, y2 + ny);

    const label = dimensionLabel(a);
    const [mLat, mLng] = dimensionMidpoint(a);
    const [mx, my] = frame.toPage(mLat, mLng);
    const w = doc.getTextWidth(label);
    const tilt = dimensionTiltDeg(a);
    const rad = (tilt * Math.PI) / 180;
    // Rotate about the midpoint: shift back along the text direction by half
    // its width, and lift it clear of the line.
    const ox = -Math.cos(rad) * (w / 2) - Math.sin(rad) * 1.1;
    const oy = Math.sin(rad) * (w / 2) - Math.cos(rad) * 1.1;
    buffered(label, mx + ox, my + oy, tilt);
  }
}

function drawLegend(
  doc: jsPDF, input: PdfInput, frame: MapFrame, customLines: CustomContourLine[],
) {
  const bands = input.showContours
    ? makeBandsForRange(input.dbDomain.min, input.dbDomain.max, input.contourStepDb)
      .slice().reverse()
    : [];
  const rowH = 3.4;
  // A named line needs room for its label, which is not 2 digits of dB.
  doc.setFontSize(6);
  const rows = customLines.map((c) => `${c.label || `${c.levelDb} dB`} (${c.levelDb} dB)`);
  const customW = rows.reduce((m, s) => Math.max(m, doc.getTextWidth(s) + 11), 0);
  // Clamped to a third of the frame. Nothing else bounds the box: it is drawn
  // AFTER the clip is released, so a long enough name would have pushed it over
  // the scale bar and eventually off the page entirely.
  const w = Math.min(Math.max(24, customW), frame.w / 3);
  // Custom lines sit under the bands behind a rule, so a compliance line is
  // never mistaken for a palette step.
  const customH = customLines.length ? customLines.length * rowH + 3 : 0;
  const h = Math.min(bands.length * rowH + 6 + customH, frame.h - 8);
  const x = frame.x + frame.w - w - 4;
  const y = frame.y + frame.h - h - 4;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(40, 40, 40);
  doc.setLineWidth(0.3);
  doc.rect(x, y, w, h, 'FD');
  doc.setFontSize(6);
  doc.setTextColor(30, 30, 30);
  doc.text(
    bands.length ? `Lp ${weightingLabel(weightingFor(input.project))}` : 'Compliance lines',
    x + 2, y + 4,
  );
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
  if (!customLines.length) return;
  let ry = y + 6 + bands.length * rowH;
  if (bands.length) {
    doc.setDrawColor(150, 150, 150);
    doc.setLineWidth(0.2);
    doc.line(x + 2, ry + 0.6, x + w - 2, ry + 0.6);
    ry += 2.4;
  }
  customLines.forEach((c, i) => {
    const [r, g, b] = rgb(c.color);
    doc.setDrawColor(r, g, b);
    doc.setLineWidth(Math.max(0.15, Math.min(3, c.widthPx * 0.26)));
    if (c.dashed) doc.setLineDashPattern([1.2, 0.9], 0);
    doc.line(x + 2, ry + 1.2, x + 6, ry + 1.2);
    if (c.dashed) doc.setLineDashPattern([], 0);
    doc.setTextColor(30, 30, 30);
    // Clipped to the box rather than overflowing it — the width is capped
    // above, so a long name has to lose its tail somewhere.
    doc.text(rows[i], x + 7.5, ry + 2, { maxWidth: w - 9.5 });
    ry += rowH;
  });
  doc.setLineWidth(0.3);
}
