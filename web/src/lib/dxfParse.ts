// Minimal ASCII-DXF reader.
//
// DXF is a flat stream of (group code, value) line pairs — a 70 on its own line
// followed by the value on the next. That simplicity is why this is hand-rolled
// rather than pulled from a package, as the shapefile and GeoTIFF writers are:
// a 50 MB drawing is mostly entities we do not model, and a streaming scan can
// drop them as it goes instead of building a tree of the whole file first.
//
// Scope is deliberately small — the geometry a noise model can use:
//   LINE, LWPOLYLINE, POLYLINE  → polylines
//   CIRCLE, ARC                 → polylines (tessellated at import, where the
//                                 scale to metres is known)
//   TEXT, MTEXT                 → labelled points
//   INSERT                      → the referenced block's entities, transformed
// Everything else is counted and skipped, and the count is surfaced so the
// import summary can say what was ignored rather than quietly losing it.

/// Drawing-unit coordinates, exactly as they appear in the file. Converting to
/// metres and then to lat/lng happens later, once the user has confirmed the
/// units and the CRS.
export type DxfPoint = { x: number; y: number; z?: number };

export type DxfEntity =
  | { kind: 'polyline'; layer: string; points: DxfPoint[]; closed: boolean }
  | { kind: 'arc'; layer: string; centre: DxfPoint; radius: number; startDeg: number; endDeg: number }
  | { kind: 'circle'; layer: string; centre: DxfPoint; radius: number }
  | { kind: 'text'; layer: string; at: DxfPoint; text: string }
  | { kind: 'point'; layer: string; at: DxfPoint; block: string };

export interface DxfDocument {
  entities: DxfEntity[];
  /// `$INSUNITS` from the header, or null when the drawing does not say.
  insUnits: number | null;
  /// Entity types seen and skipped, with how many of each.
  skipped: Record<string, number>;
  warnings: string[];
}

/// `$INSUNITS` codes we can interpret, as a factor to metres.
const INSUNIT_METRES: Record<number, number> = {
  1: 0.0254,      // inches
  2: 0.3048,      // feet
  4: 0.001,       // millimetres
  5: 0.01,        // centimetres
  6: 1,           // metres
  7: 1000,        // kilometres
  8: 2.54e-8,     // microinches
  9: 2.54e-5,     // mils
  10: 0.9144,     // yards
  13: 1e-6,       // micrometres
  14: 0.1,        // decimetres
  15: 10,         // decametres
  16: 100,        // hectometres
};

export function insUnitsToMetres(code: number | null): number | null {
  if (code == null) return null;
  return INSUNIT_METRES[code] ?? null;
}

export function insUnitsName(code: number | null): string {
  if (code == null) return 'not stated';
  return ({
    0: 'unitless', 1: 'inches', 2: 'feet', 3: 'miles', 4: 'millimetres',
    5: 'centimetres', 6: 'metres', 7: 'kilometres', 10: 'yards', 14: 'decimetres',
  } as Record<number, string>)[code] ?? `code ${code}`;
}

/// True for the binary DXF sentinel, which this reader cannot handle.
export function isBinaryDxf(text: string): boolean {
  return text.startsWith('AutoCAD Binary DXF');
}

/// Walks the (code, value) pairs without splitting the whole file into an array
/// of lines — at 50 MB that array alone is millions of strings.
class PairReader {
  private i = 0;
  code = 0;
  value = '';

  constructor(private readonly text: string) {}

  /// Advance to the next pair. False at end of file.
  next(): boolean {
    const codeLine = this.readLine();
    if (codeLine === null) return false;
    const valueLine = this.readLine();
    if (valueLine === null) return false;
    const code = Number.parseInt(codeLine.trim(), 10);
    if (!Number.isFinite(code)) return false;
    this.code = code;
    this.value = valueLine;
    return true;
  }

  private readLine(): string | null {
    if (this.i >= this.text.length) return null;
    const nl = this.text.indexOf('\n', this.i);
    const end = nl === -1 ? this.text.length : nl;
    // DXF is CRLF in the wild; trailing \r would poison every string compare.
    let stop = end;
    if (stop > this.i && this.text.charCodeAt(stop - 1) === 13) stop--;
    const line = this.text.slice(this.i, stop);
    this.i = nl === -1 ? this.text.length : nl + 1;
    return line;
  }
}

const num = (s: string): number => {
  const v = Number.parseFloat(s);
  return Number.isFinite(v) ? v : 0;
};

/// Entities we understand, plus the containers the scanner walks through.
const HANDLED = new Set([
  'LINE', 'LWPOLYLINE', 'POLYLINE', 'VERTEX', 'SEQEND',
  'CIRCLE', 'ARC', 'TEXT', 'MTEXT', 'INSERT',
]);

export function parseDxf(text: string): DxfDocument {
  if (isBinaryDxf(text)) {
    throw new Error('This is a binary DXF. Re-save it as ASCII DXF and try again.');
  }
  const r = new PairReader(text);
  const entities: DxfEntity[] = [];
  const skipped: Record<string, number> = {};
  const warnings: string[] = [];
  const blocks = new Map<string, DxfEntity[]>();
  let insUnits: number | null = null;

  /// Where entities being read right now should go: the drawing, or the block
  /// currently being defined.
  let sink = entities;
  let section = '';
  let blockName = '';

  // Accumulator for the entity being read. DXF gives an entity's type first and
  // its fields after, terminated by the next 0-code, so state lives out here.
  let type = '';
  let layer = '';
  let pts: DxfPoint[] = [];
  let cur: Partial<DxfPoint> = {};
  let flags = 0;
  let radius = 0;
  let a0 = 0;
  let a1 = 0;
  let label = '';
  let blockRef = '';
  let scaleX = 1;
  let scaleY = 1;
  let rotation = 0;
  /// POLYLINE collects its points from following VERTEX entities.
  let polylineOpen = false;
  let polylineLayer = '';
  let polylineClosed = false;
  let polylinePts: DxfPoint[] = [];

  const flushPoint = () => {
    if (cur.x !== undefined && cur.y !== undefined) {
      pts.push({ x: cur.x, y: cur.y, z: cur.z });
    }
    cur = {};
  };

  const emit = () => {
    flushPoint();
    switch (type) {
      case 'LINE':
        if (pts.length >= 2) sink.push({ kind: 'polyline', layer, points: pts, closed: false });
        break;
      case 'LWPOLYLINE':
        if (pts.length >= 2) {
          sink.push({ kind: 'polyline', layer, points: pts, closed: (flags & 1) === 1 });
        }
        break;
      case 'VERTEX':
        if (polylineOpen && pts.length) polylinePts.push(pts[0]);
        break;
      case 'SEQEND':
        if (polylineOpen) {
          if (polylinePts.length >= 2) {
            sink.push({
              kind: 'polyline', layer: polylineLayer, points: polylinePts, closed: polylineClosed,
            });
          }
          polylineOpen = false;
          polylinePts = [];
        }
        break;
      case 'CIRCLE':
        if (pts.length && radius > 0) sink.push({ kind: 'circle', layer, centre: pts[0], radius });
        break;
      case 'ARC':
        if (pts.length && radius > 0) {
          sink.push({ kind: 'arc', layer, centre: pts[0], radius, startDeg: a0, endDeg: a1 });
        }
        break;
      case 'TEXT':
      case 'MTEXT':
        if (pts.length && label) sink.push({ kind: 'text', layer, at: pts[0], text: label });
        break;
      case 'INSERT':
        if (pts.length && blockRef) {
          // Resolved against the block table after the whole file is read: a
          // block may be defined after the INSERT that uses it.
          sink.push({ kind: 'point', layer, at: pts[0], block: blockRef });
          insertTransforms.push({
            block: blockRef, layer,
            at: pts[0], scaleX, scaleY, rotation,
            index: sink.length - 1, intoBlock: sink === entities ? null : blockName,
          });
        }
        break;
      default:
        break;
    }
    type = '';
    layer = '';
    pts = [];
    cur = {};
    flags = 0;
    radius = 0;
    a0 = 0;
    a1 = 0;
    label = '';
    blockRef = '';
    scaleX = 1;
    scaleY = 1;
    rotation = 0;
  };

  const insertTransforms: Array<{
    block: string; layer: string; at: DxfPoint;
    scaleX: number; scaleY: number; rotation: number;
    index: number; intoBlock: string | null;
  }> = [];

  /// Set when the previous pair was `9 / $INSUNITS`, so the following 70 is its
  /// value rather than some other variable's.
  let pendingHeaderVar = '';

  while (r.next()) {
    const { code, value } = r;

    if (code === 0) {
      emit();
      const v = value.trim().toUpperCase();
      if (v === 'SECTION') { section = ''; continue; }
      if (v === 'ENDSEC') { section = ''; sink = entities; continue; }
      if (v === 'EOF') break;
      if (v === 'BLOCK') { type = 'BLOCK'; continue; }
      if (v === 'ENDBLK') { sink = entities; blockName = ''; continue; }
      if (section === 'ENTITIES' || section === 'BLOCKS') {
        if (HANDLED.has(v)) {
          type = v;
          if (v === 'POLYLINE') { polylineOpen = true; polylinePts = []; }
        } else {
          skipped[v] = (skipped[v] ?? 0) + 1;
        }
      }
      continue;
    }

    if (code === 2 && section === '' ) {
      // The 2-code straight after SECTION names it.
      section = value.trim().toUpperCase();
      continue;
    }

    if (section === 'HEADER') {
      if (code === 9) { pendingHeaderVar = value.trim().toUpperCase(); continue; }
      if (code === 70 && pendingHeaderVar === '$INSUNITS') {
        insUnits = Number.parseInt(value.trim(), 10);
        pendingHeaderVar = '';
      }
      continue;
    }

    if (type === 'BLOCK') {
      // Block definitions: name on 2, then the entities up to ENDBLK.
      if (code === 2) {
        blockName = value.trim();
        const list: DxfEntity[] = [];
        blocks.set(blockName, list);
        sink = list;
        type = '';
      }
      continue;
    }

    if (!type) continue;

    switch (code) {
      case 8: layer = value.trim(); if (polylineOpen && !polylineLayer) polylineLayer = layer; break;
      case 10:
        // A repeated 10 starts a new vertex; LWPOLYLINE lists them back to back.
        if (cur.x !== undefined) flushPoint();
        cur.x = num(value);
        break;
      case 20: cur.y = num(value); break;
      case 30: cur.z = num(value); break;
      case 11: flushPoint(); cur.x = num(value); break;   // LINE end point
      case 21: cur.y = num(value); break;
      case 31: cur.z = num(value); break;
      case 40: radius = num(value); break;
      case 41: scaleX = num(value) || 1; break;
      case 42: scaleY = num(value) || 1; break;
      case 50:
        if (type === 'ARC') a0 = num(value); else rotation = num(value);
        break;
      case 51: a1 = num(value); break;
      case 70:
        flags = Number.parseInt(value.trim(), 10) || 0;
        if (type === 'POLYLINE') polylineClosed = (flags & 1) === 1;
        break;
      case 1: label = mtextPlain(value); break;
      case 3: label += mtextPlain(value); break;   // MTEXT continuation
      default: break;
    }
    // A block reference names its block on 2, which the section-name branch
    // above would otherwise swallow — but that branch only fires when no
    // section is set, so INSERT's own 2 lands here.
    if (code === 2 && type === 'INSERT') blockRef = value.trim();
  }
  emit();

  // Expand block references now that every definition is known. One level only:
  // a block containing another block leaves the inner reference as a point,
  // which is honest about what was and was not expanded.
  const expanded: DxfEntity[] = [];
  for (const t of insertTransforms) {
    if (t.intoBlock !== null) continue;              // nested — left as a point
    const def = blocks.get(t.block);
    if (!def?.length) continue;
    const rad = (t.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const place = (p: DxfPoint): DxfPoint => {
      const sx = p.x * t.scaleX;
      const sy = p.y * t.scaleY;
      return { x: t.at.x + sx * cos - sy * sin, y: t.at.y + sx * sin + sy * cos, z: p.z };
    };
    for (const e of def) {
      // Block content keeps the INSERT's layer when it was drawn on layer 0,
      // which is the AutoCAD convention for "inherit from the reference".
      const lyr = e.layer === '0' || e.layer === '' ? t.layer : e.layer;
      if (e.kind === 'polyline') {
        expanded.push({ kind: 'polyline', layer: lyr, points: e.points.map(place), closed: e.closed });
      } else if (e.kind === 'circle') {
        expanded.push({
          kind: 'circle', layer: lyr, centre: place(e.centre),
          radius: e.radius * Math.abs(t.scaleX),
        });
      } else if (e.kind === 'arc') {
        expanded.push({
          kind: 'arc', layer: lyr, centre: place(e.centre), radius: e.radius * Math.abs(t.scaleX),
          startDeg: e.startDeg + t.rotation, endDeg: e.endDeg + t.rotation,
        });
      } else if (e.kind === 'text') {
        expanded.push({ kind: 'text', layer: lyr, at: place(e.at), text: e.text });
      }
    }
  }
  entities.push(...expanded);

  if (insUnits === null) warnings.push('The drawing does not state its units ($INSUNITS).');
  if (!entities.length) warnings.push('No geometry this importer understands was found.');

  return { entities, insUnits, skipped, warnings };
}

/// Strip the formatting codes MTEXT wraps text in — `\P` line breaks,
/// `{\fArial|b0;...}` font runs — so a label reads as it does on the drawing.
function mtextPlain(s: string): string {
  return s
    .replace(/\\P/g, ' ')
    .replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

/// Turn an arc or circle into a polyline whose sagitta stays within `tolerance`
/// (same units as the radius). Fewer segments on a gentle curve, more on a
/// tight one, rather than a fixed step that is wrong at both ends.
export function tessellateArc(
  centre: DxfPoint, radius: number, startDeg: number, endDeg: number, tolerance: number,
): DxfPoint[] {
  let sweep = endDeg - startDeg;
  while (sweep <= 0) sweep += 360;                  // DXF arcs run counter-clockwise
  const maxStep = radius > tolerance
    ? (2 * Math.acos(1 - tolerance / radius) * 180) / Math.PI
    : 45;
  const steps = Math.max(2, Math.min(720, Math.ceil(sweep / Math.max(1e-6, maxStep))));
  const out: DxfPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((startDeg + (sweep * i) / steps) * Math.PI) / 180;
    out.push({ x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) });
  }
  return out;
}

/// Bounding box of everything parsed, in drawing units. Drives the units
/// confirmation: a site that is 400 000 units across is millimetres, not metres.
export function dxfExtent(entities: DxfEntity[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: DxfPoint) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const e of entities) {
    if (e.kind === 'polyline') e.points.forEach(add);
    else if (e.kind === 'text' || e.kind === 'point') add(e.at);
    else {
      add({ x: e.centre.x - e.radius, y: e.centre.y - e.radius });
      add({ x: e.centre.x + e.radius, y: e.centre.y + e.radius });
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/// Layer names with what each holds, for the mapping UI.
export function dxfLayers(entities: DxfEntity[]): Array<{
  name: string; lines: number; curves: number; texts: number; points: number;
}> {
  const by = new Map<string, { name: string; lines: number; curves: number; texts: number; points: number }>();
  for (const e of entities) {
    const name = e.layer || '0';
    let row = by.get(name);
    if (!row) { row = { name, lines: 0, curves: 0, texts: 0, points: 0 }; by.set(name, row); }
    if (e.kind === 'polyline') row.lines++;
    else if (e.kind === 'arc' || e.kind === 'circle') row.curves++;
    else if (e.kind === 'text') row.texts++;
    else row.points++;
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}
