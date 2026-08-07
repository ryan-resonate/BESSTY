// Turning a parsed DXF into project objects.
//
// Two things stand between the drawing and the map, and both are decisions the
// file cannot make for us:
//
//   Units. `$INSUNITS` is often absent or wrong, and reading a millimetre
//   drawing as metres puts the site 1000× too big without anything looking
//   broken until you zoom out. `unitCandidates` measures the site under each
//   interpretation so the dialog can show a 400 km site next to a 400 m one and
//   let the user pick the sane one.
//
//   CRS. DXF has no coordinate system at all, so the user names one and we
//   project through it. The preview draws the result on the map before anything
//   is committed, which is the only real check that the choice was right.

import { toWgs84 } from './projections';
import {
  dxfExtent, insUnitsToMetres, parseDxf, tessellateArc,
  type DxfDocument, type DxfEntity, type DxfPoint,
} from './dxfParse';
import type { Barrier, ReferenceFeature } from './types';

/// Largest file we will attempt. A 50 MB DXF is about 2 million group-code
/// pairs, which the worker handles; past that the browser is likely to run out
/// of memory holding the text, and failing early with a number beats failing
/// later with a blank tab.
export const DXF_MAX_BYTES = 50 * 1024 * 1024;

/// Read and parse a DXF, on a worker when the environment has one.
export async function parseDxfFile(file: File): Promise<DxfDocument> {
  if (file.size > DXF_MAX_BYTES) {
    throw new Error(
      `${(file.size / 1024 / 1024).toFixed(0)} MB is larger than the ${DXF_MAX_BYTES / 1024 / 1024} MB limit. `
      + 'Trim the drawing to the site area and try again.',
    );
  }
  // No text is read here on purpose: the worker reads the Blob itself, so the
  // 50 MB is decoded once, off the main thread, instead of being decoded here
  // and then structured-cloned across.
  if (typeof Worker === 'undefined') return parseDxf(await file.text());
  const worker = new Worker(new URL('./dxf.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<DxfDocument>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent) => {
        const d = ev.data as { ok?: boolean; doc?: DxfDocument; error?: string };
        if (d.ok && d.doc) resolve(d.doc);
        else reject(new Error(d.error ?? 'DXF parse failed'));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'DXF worker failed to load'));
      worker.postMessage({ id: 1, file });
    });
  } finally {
    // One-shot: an import is a rare, user-initiated action, so there is nothing
    // to gain from keeping a worker (and its copy of the file) alive.
    worker.terminate();
  }
}

/// How one DXF layer should land in the project.
export type DxfLayerTarget = 'reference' | 'barriers' | 'skip';

export interface DxfLayerPlan {
  layer: string;
  target: DxfLayerTarget;
  /// Wall top height (m above local ground) for `target: 'barriers'`.
  heightM: number;
  /// Use each vertex's Z as an ABSOLUTE top level instead of `heightM`.
  /// Only offered when the layer's geometry actually carries Z.
  useZ: boolean;
}

export interface DxfPlacement {
  /// Metres per drawing unit.
  unitScale: number;
  /// CRS the drawing's coordinates are in, once scaled to metres.
  epsg: number;
}

/// A unit interpretation, with what the site measures under it. `2400 m` reads
/// as a site; `2 400 000 m` reads as a mistake.
export interface UnitCandidate {
  label: string;
  metresPerUnit: number;
  widthM: number;
  heightM: number;
  /// True for the interpretation the drawing itself claims via $INSUNITS.
  fromHeader: boolean;
  /// True when the resulting extent is a plausible site (1 m … 100 km).
  plausible: boolean;
}

const UNIT_CHOICES: Array<{ label: string; metresPerUnit: number }> = [
  { label: 'millimetres', metresPerUnit: 0.001 },
  { label: 'centimetres', metresPerUnit: 0.01 },
  { label: 'metres', metresPerUnit: 1 },
  { label: 'kilometres', metresPerUnit: 1000 },
  { label: 'feet', metresPerUnit: 0.3048 },
  { label: 'inches', metresPerUnit: 0.0254 },
];

export function unitCandidates(entities: DxfEntity[], insUnits: number | null): UnitCandidate[] {
  const ext = dxfExtent(entities);
  const w = ext ? ext.maxX - ext.minX : 0;
  const h = ext ? ext.maxY - ext.minY : 0;
  const headerScale = insUnitsToMetres(insUnits);
  return UNIT_CHOICES.map((c) => {
    const widthM = w * c.metresPerUnit;
    const heightM = h * c.metresPerUnit;
    const span = Math.max(widthM, heightM);
    return {
      ...c,
      widthM,
      heightM,
      fromHeader: headerScale != null && Math.abs(headerScale - c.metresPerUnit) < 1e-12,
      plausible: span >= 1 && span <= 100_000,
    };
  });
}

/// The interpretation to preselect.
///
/// Deliberately a short preference order rather than a cleverer score: when two
/// readings are both plausible — a 200 m site in millimetres and a 2 km one in
/// centimetres — nothing in the file distinguishes them, and a scoring function
/// that picks between them only disguises the guess. The dialog shows every
/// candidate with the site size it implies, which is the real answer.
///
///   1. What the drawing claims, if that gives a plausible site.
///   2. Metres — how survey and civil drawings arrive.
///   3. Millimetres — how architectural drawings arrive.
///   4. Any other plausible reading, else metres.
export function suggestedUnit(candidates: UnitCandidate[]): UnitCandidate {
  const metres = candidates.find((c) => c.metresPerUnit === 1)!;
  const header = candidates.find((c) => c.fromHeader);
  if (header?.plausible) return header;
  if (metres.plausible) return metres;
  const mm = candidates.find((c) => c.metresPerUnit === 0.001);
  if (mm?.plausible) return mm;
  return candidates.find((c) => c.plausible) ?? header ?? metres;
}

/// Drawing coordinates → WGS84, through the chosen unit scale and CRS.
export function placePoint(p: DxfPoint, place: DxfPlacement): [number, number] {
  return toWgs84(place.epsg, p.x * place.unitScale, p.y * place.unitScale);
}

/// Every entity on a layer as lat/lng polylines, curves tessellated.
///
/// The tessellation tolerance is given in METRES and converted back to drawing
/// units, so a drawing in millimetres does not get a chord error 1000× tighter
/// than one in metres — which is the difference between a smooth circle and
/// 700 vertices per tank.
export function layerPolylines(
  entities: DxfEntity[], layer: string, place: DxfPlacement, toleranceM = 0.5,
): Array<{ points: Array<[number, number]>; z: number[]; closed: boolean }> {
  const tolUnits = toleranceM / Math.max(1e-9, place.unitScale);
  const out: Array<{ points: Array<[number, number]>; z: number[]; closed: boolean }> = [];
  for (const e of entities) {
    if ((e.layer || '0') !== layer) continue;
    let pts: DxfPoint[] | null = null;
    let closed = false;
    if (e.kind === 'polyline') { pts = e.points; closed = e.closed; }
    else if (e.kind === 'circle') { pts = tessellateArc(e.centre, e.radius, 0, 360, tolUnits); closed = true; }
    else if (e.kind === 'arc') { pts = tessellateArc(e.centre, e.radius, e.startDeg, e.endDeg, tolUnits); }
    if (!pts || pts.length < 2) continue;
    const ring = closed && !samePoint(pts[0], pts[pts.length - 1]) ? [...pts, pts[0]] : pts;
    out.push({
      points: ring.map((p) => placePoint(p, place)),
      z: ring.map((p) => (p.z ?? 0) * place.unitScale),
      closed,
    });
  }
  return out;
}

function samePoint(a: DxfPoint, b: DxfPoint): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
}

/// Does this layer carry any non-zero Z? Gates the "use Z as wall level" offer,
/// which is meaningless on a flat 2-D drawing.
export function layerHasZ(entities: DxfEntity[], layer: string): boolean {
  for (const e of entities) {
    if ((e.layer || '0') !== layer) continue;
    if (e.kind === 'polyline' && e.points.some((p) => (p.z ?? 0) !== 0)) return true;
  }
  return false;
}

/// Text entities on a layer, as labelled reference points.
export function layerLabels(
  entities: DxfEntity[], layer: string, place: DxfPlacement,
): ReferenceFeature[] {
  const out: ReferenceFeature[] = [];
  for (const e of entities) {
    if ((e.layer || '0') !== layer) continue;
    if (e.kind === 'text') {
      out.push({ id: `dxf-t-${out.length}`, type: 'point', coords: [placePoint(e.at, place)], label: e.text });
    } else if (e.kind === 'point') {
      out.push({ id: `dxf-p-${out.length}`, type: 'point', coords: [placePoint(e.at, place)], label: e.block });
    }
  }
  return out;
}

export interface DxfImportResult {
  barriers: Barrier[];
  referenceFeaturesByLayer: Array<{ layer: string; features: ReferenceFeature[] }>;
  /// Human-readable account of what happened, for the summary and the log.
  summary: string[];
}

/// Apply a set of layer plans, producing the objects to merge into the project.
///
/// `groundAt` supplies the local ground level (m) for a lat/lng, used only when
/// a plan asks for absolute Z: barriers are stored as height ABOVE ground, so an
/// absolute crest level has to be reduced by the terrain under it. Without a
/// DEM the caller passes null and Z-mode falls back to the entered height.
export function applyDxfPlan(
  entities: DxfEntity[],
  plans: DxfLayerPlan[],
  place: DxfPlacement,
  opts: { nextBarrierIndex: number; groundAt: ((latLng: [number, number]) => number) | null } = {
    nextBarrierIndex: 1, groundAt: null,
  },
): DxfImportResult {
  const barriers: Barrier[] = [];
  const referenceFeaturesByLayer: Array<{ layer: string; features: ReferenceFeature[] }> = [];
  const summary: string[] = [];
  let barrierNo = opts.nextBarrierIndex;

  for (const plan of plans) {
    if (plan.target === 'skip') continue;
    const polys = layerPolylines(entities, plan.layer, place);

    if (plan.target === 'barriers') {
      let made = 0;
      let zFellBack = false;
      for (const p of polys) {
        if (p.points.length < 2) continue;
        const topHeightsM = p.points.map((ll, i) => {
          if (!plan.useZ) return plan.heightM;
          const ground = opts.groundAt?.(ll);
          if (ground == null) { zFellBack = true; return plan.heightM; }
          // Z is an absolute level; a barrier stores height above local ground.
          return Math.max(0.1, p.z[i] - ground);
        });
        barriers.push({
          id: `B-dxf-${barrierNo}`,
          name: `${plan.layer} ${barrierNo}`,
          type: 'wall',
          polylineLatLng: p.points,
          topHeightsM,
          baseFromGroundM: 0,
          surfaceDensityKgM2: 20,
          absorptionCoeff: 0.1,
        });
        barrierNo++;
        made++;
      }
      summary.push(`${plan.layer}: ${made} wall${made === 1 ? '' : 's'}`);
      if (zFellBack) {
        summary.push(`${plan.layer}: no terrain available, so Z levels fell back to ${plan.heightM} m`);
      }
      continue;
    }

    const features: ReferenceFeature[] = [];
    for (const p of polys) {
      features.push({
        id: `dxf-${plan.layer}-${features.length}`,
        type: p.closed ? 'polygon' : 'line',
        coords: p.points,
      });
    }
    features.push(...layerLabels(entities, plan.layer, place));
    if (features.length) referenceFeaturesByLayer.push({ layer: plan.layer, features });
    summary.push(`${plan.layer}: ${features.length} reference feature${features.length === 1 ? '' : 's'}`);
  }

  return { barriers, referenceFeaturesByLayer, summary };
}
