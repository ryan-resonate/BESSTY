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

  /// How many pairs were skipped because the code line was not a number.
  malformed = 0;

  /// Advance to the next pair. False at end of file.
  ///
  /// A line that is not a number is RESYNCED past rather than treated as the
  /// end of the file: one stray blank line used to truncate the parse silently,
  /// leaving the user with a plausible-looking layer list holding half their
  /// drawing.
  next(): boolean {
    for (;;) {
      const codeLine = this.readLine();
      if (codeLine === null) return false;
      const code = Number.parseInt(codeLine.trim(), 10);
      if (!Number.isFinite(code)) {
        if (codeLine.trim() !== '') this.malformed++;
        continue;
      }
      const valueLine = this.readLine();
      if (valueLine === null) return false;
      this.code = code;
      this.value = valueLine;
      return true;
    }
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
  /// Each block's base point — the origin its geometry is drawn about, and the
  /// point an INSERT positions. Kept per block because a drawing may use many.
  const blockBases = new Map<string, DxfPoint>();
  let blockBase: DxfPoint = { x: 0, y: 0 };
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
  /// MTEXT chunks seen on group 3, held so the final group-1 chunk appends to
  /// them rather than replacing them.
  let labelHead = '';
  let blockRef = '';
  let scaleX = 1;
  let scaleY = 1;
  let rotation = 0;
  /// Group 38 — the single elevation an LWPOLYLINE carries for all its
  /// vertices. This, not a per-vertex 30, is where a 2-D polyline's height
  /// lives, and it is what a contour or a wall crest arrives as.
  let elevation: number | null = null;
  /// Group 67 — 1 means the entity belongs to PAPER space: a title block,
  /// sheet border or legend, drawn in sheet coordinates. Importing those as
  /// site geometry wrecks the extent, and the extent is what the units step
  /// asks the user to judge.
  let paperSpace = false;
  /// Group 42 — a bulge turns the following span into an arc. Not modelled,
  /// but counted so the summary can say the shape was straightened.
  let bulges = 0;
  /// POLYLINE collects its points from following VERTEX entities.
  let polylineOpen = false;
  let polylineLayer = '';
  let polylineClosed = false;
  let polylinePaper = false;
  /// Polyface / 3-D mesh (flags 64 / 16). Their VERTEX records are mesh data,
  /// not a path: face records carry no coordinates and would otherwise inject a
  /// vertex at the origin, dragging the drawing's extent to (0, 0).
  let polylineMesh = false;
  let polylinePts: DxfPoint[] = [];

  const flushPoint = () => {
    if (cur.x !== undefined && cur.y !== undefined) {
      pts.push({ x: cur.x, y: cur.y, z: cur.z });
    }
    cur = {};
  };

  const note = (kind: string) => { skipped[kind] = (skipped[kind] ?? 0) + 1; };

  const emit = () => {
    flushPoint();
    // Paper space is the printed SHEET — title block, border, legend, north
    // arrow — drawn in sheet coordinates alongside the model in the same
    // section. Importing it would put a 300 mm border next to a 6 250 000 m
    // easting and blow the extent apart, which is exactly the measurement the
    // units step asks the user to judge.
    if (paperSpace && type && type !== 'SEQEND' && type !== 'VERTEX') {
      note(`${type} (paper space)`);
      type = '';
    }
    switch (type) {
      case 'LINE':
        if (pts.length >= 2) sink.push({ kind: 'polyline', layer, points: pts, closed: false });
        break;
      case 'LWPOLYLINE':
        if (pts.length >= 2) {
          // Group 38 is the polyline's single elevation; there is no per-vertex
          // Z on an LWPOLYLINE.
          const withZ = elevation == null ? pts : pts.map((p) => ({ ...p, z: elevation! }));
          sink.push({ kind: 'polyline', layer, points: withZ, closed: (flags & 1) === 1 });
          if (bulges) note('LWPOLYLINE arc segment (bulge, straightened)');
        }
        break;
      case 'VERTEX':
        // A mesh's VERTEX records are face indices, not a path: they carry no
        // coordinates, so taking them would add a vertex at the origin.
        if (polylineOpen && !polylineMesh && pts.length) polylinePts.push(pts[0]);
        break;
      case 'SEQEND':
        if (polylineOpen) {
          if (!polylineMesh && !polylinePaper && polylinePts.length >= 2) {
            sink.push({
              kind: 'polyline', layer: polylineLayer, points: polylinePts, closed: polylineClosed,
            });
          }
          if (polylineMesh) note('POLYLINE mesh');
          else if (polylinePaper) note('POLYLINE (paper space)');
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
          // Recorded as a point for now and resolved against the block table
          // once the whole file is read — a block may legally be defined after
          // the INSERT that uses it. If it does resolve, this placeholder is
          // dropped so the block's own geometry is not shadowed by a marker.
          sink.push({ kind: 'point', layer, at: pts[0], block: blockRef });
          insertTransforms.push({
            block: blockRef, layer,
            at: pts[0], scaleX, scaleY, rotation,
            marker: sink[sink.length - 1], intoBlock: sink === entities ? null : blockName,
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
    labelHead = '';
    blockRef = '';
    scaleX = 1;
    scaleY = 1;
    rotation = 0;
    elevation = null;
    paperSpace = false;
    bulges = 0;
  };

  const insertTransforms: Array<{
    block: string; layer: string; at: DxfPoint;
    scaleX: number; scaleY: number; rotation: number;
    marker: DxfEntity; intoBlock: string | null;
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
      if (v === 'BLOCK') { type = 'BLOCK'; blockBase = { x: 0, y: 0 }; continue; }
      if (v === 'ENDBLK') { sink = entities; blockName = ''; blockBase = { x: 0, y: 0 }; continue; }
      if (section === 'ENTITIES' || section === 'BLOCKS') {
        if (HANDLED.has(v)) {
          type = v;
          if (v === 'POLYLINE') {
            // EVERY per-polyline field is reset here. Leaving `polylineLayer`
            // and `polylineClosed` from a previous POLYLINE put every one in
            // the file on the first one's layer — which silently collapsed the
            // layer list the whole mapping UI is built on.
            polylineOpen = true;
            polylinePts = [];
            polylineLayer = '';
            polylineClosed = false;
            polylineMesh = false;
            polylinePaper = false;
          }
        } else {
          note(v);
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
      // Block definitions: name on 2, then the entities up to ENDBLK. The 10/20
      // base point is the origin the block's own geometry is drawn about, and
      // an INSERT places THAT point — ignoring it offsets every copy by the
      // base, which also drags the drawing's extent and hence the unit guess.
      //
      // The base point follows the NAME in the header, so `type` stays 'BLOCK'
      // until the next 0-code and the map entry is rewritten as each coordinate
      // arrives. Clearing `type` on the name dropped the base entirely.
      if (code === 2) {
        blockName = value.trim();
        const list: DxfEntity[] = [];
        blocks.set(blockName, list);
        blockBases.set(blockName, blockBase);
        sink = list;
      } else if (code === 10) {
        blockBase = { ...blockBase, x: num(value) };
        if (blockName) blockBases.set(blockName, blockBase);
      } else if (code === 20) {
        blockBase = { ...blockBase, y: num(value) };
        if (blockName) blockBases.set(blockName, blockBase);
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
      case 38: elevation = num(value); break;             // LWPOLYLINE elevation
      case 40: radius = num(value); break;
      case 41: scaleX = num(value) || 1; break;
      case 42:
        // 42 is a bulge on a polyline vertex and the Y scale on an INSERT.
        if (type === 'INSERT') scaleY = num(value) || 1;
        else if (num(value) !== 0) bulges++;
        break;
      case 50:
        if (type === 'ARC') a0 = num(value); else rotation = num(value);
        break;
      case 51: a1 = num(value); break;
      case 67:
        paperSpace = Number.parseInt(value.trim(), 10) === 1;
        if (polylineOpen && type === 'POLYLINE') polylinePaper = paperSpace;
        break;
      case 70:
        flags = Number.parseInt(value.trim(), 10) || 0;
        if (type === 'POLYLINE') {
          polylineClosed = (flags & 1) === 1;
          // 64 = polyface mesh, 16 = 3-D polygon mesh. Both use VERTEX records
          // as mesh data rather than a path.
          polylineMesh = (flags & 64) !== 0 || (flags & 16) !== 0;
        }
        break;
      // MTEXT longer than 250 characters puts its LEADING chunks on 3 and the
      // final one on 1, so the 3s have to be kept and the 1 appended — reading
      // 1 as the whole string keeps only the tail.
      // Trimming happens once at the end, not per chunk: MTEXT splits mid-
      // sentence, so trimming each piece welds the words either side together.
      case 1: label = (labelHead + mtextPlain(value)).trim(); break;
      case 3: labelHead += mtextPlain(value); label = labelHead.trim(); break;
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
  /// Placeholders whose block did resolve — dropped below, so an expanded
  /// INSERT does not also leave a marker sitting on its own geometry.
  const consumed = new Set<DxfEntity>();
  for (const t of insertTransforms) {
    if (t.intoBlock !== null) continue;              // nested — left as a point
    const def = blocks.get(t.block);
    if (!def?.length) continue;
    consumed.add(t.marker);
    const base = blockBases.get(t.block) ?? { x: 0, y: 0 };
    const rad = (t.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const place = (p: DxfPoint): DxfPoint => {
      // Geometry is measured from the block's BASE point, then scaled, rotated
      // and dropped at the insertion point.
      const sx = (p.x - base.x) * t.scaleX;
      const sy = (p.y - base.y) * t.scaleY;
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
  // Built by iteration, never by spreading: `push(...expanded)` passes one
  // argument per element and overflows the call stack around 150 000 — well
  // inside the range a site plan full of symbol blocks reaches.
  const out: DxfEntity[] = [];
  for (const e of entities) if (!consumed.has(e)) out.push(e);
  for (const e of expanded) out.push(e);

  if (insUnits === null) warnings.push('The drawing does not state its units ($INSUNITS).');
  if (!out.length) warnings.push('No geometry this importer understands was found.');
  if (r.malformed) {
    warnings.push(`${r.malformed} malformed line${r.malformed === 1 ? '' : 's'} skipped — the drawing may be truncated or corrupt.`);
  }

  return { entities: out, insUnits, skipped, warnings };
}

/// Strip the formatting codes MTEXT wraps text in — `\P` line breaks,
/// `{\fArial|b0;...}` font runs — so a label reads as it does on the drawing.
function mtextPlain(s: string): string {
  return s
    .replace(/\\P/g, ' ')
    .replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '');
}

/// Turn an arc or circle into a polyline whose sagitta stays within `tolerance`
/// (same units as the radius). Fewer segments on a gentle curve, more on a
/// tight one, rather than a fixed step that is wrong at both ends.
export function tessellateArc(
  centre: DxfPoint, radius: number, startDeg: number, endDeg: number, tolerance: number,
): DxfPoint[] {
  if (!Number.isFinite(startDeg) || !Number.isFinite(endDeg) || !(radius > 0)) return [];
  // DXF arcs run counter-clockwise from start to end. Normalised by modulo, not
  // by adding 360 in a loop: `-1e300 + 360` is still `-1e300`, so a corrupt
  // angle used to spin forever — on the main thread, inside the import click.
  const raw = endDeg - startDeg;
  let sweep = raw === 360 ? 360 : ((raw % 360) + 360) % 360;
  // A zero sweep is a degenerate arc, not a full circle. Callers asking for a
  // circle pass 0→360 explicitly, which the line above preserves.
  if (sweep === 0) return [];
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
