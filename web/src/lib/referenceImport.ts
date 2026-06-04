// Reference-geometry import — turns a shapefile bundle into non-solver
// `ReferenceFeature`s (points / lines / polygons) plus the attribute names
// available for labelling. Distinct from `locationImport.ts`, which flattens
// everything to points for sources/receivers; here we keep the real geometry.
//
// Uses shpjs (same as locationImport): it returns GeoJSON, auto-reprojecting
// to WGS84 when a .prj sidecar is present. GeoJSON coordinates are [lng, lat];
// we store [lat, lng] to match the rest of the app.

import * as shpjs from 'shpjs';
import type { ReferenceFeature, ReferenceGeometryType } from './types';

/// A parsed feature still carrying its raw attribute bag, so the caller can
/// apply a label mapping (chosen after parsing) before building the layer.
export interface ParsedReferenceFeature extends ReferenceFeature {
  props: Record<string, unknown>;
}

export interface ParsedReference {
  features: ParsedReferenceFeature[];
  attributeNames: string[];
  counts: { point: number; line: number; polygon: number };
  warnings: string[];
}

function newId(): string {
  try { return `rf-${crypto.randomUUID()}`; } catch { return `rf-${Math.random().toString(36).slice(2)}`; }
}

function ll(coord: number[]): [number, number] {
  return [coord[1], coord[0]]; // [lng,lat] → [lat,lng]
}

function mk(
  type: ReferenceGeometryType,
  coords: Array<[number, number]>,
  props: Record<string, unknown>,
): ParsedReferenceFeature {
  return { id: newId(), type, coords, props };
}

function extract(
  g: GeoJSON.Geometry,
  props: Record<string, unknown>,
  out: ParsedReferenceFeature[],
  counts: { point: number; line: number; polygon: number },
): void {
  switch (g.type) {
    case 'Point':
      out.push(mk('point', [ll(g.coordinates)], props)); counts.point++; break;
    case 'MultiPoint':
      for (const c of g.coordinates) { out.push(mk('point', [ll(c)], props)); counts.point++; }
      break;
    case 'LineString':
      out.push(mk('line', g.coordinates.map(ll), props)); counts.line++; break;
    case 'MultiLineString':
      for (const line of g.coordinates) { out.push(mk('line', line.map(ll), props)); counts.line++; }
      break;
    case 'Polygon':
      // Outer ring only (holes are rare for reference boundaries and would
      // otherwise render as filled polygons).
      if (g.coordinates[0]?.length) { out.push(mk('polygon', g.coordinates[0].map(ll), props)); counts.polygon++; }
      break;
    case 'MultiPolygon':
      for (const poly of g.coordinates) {
        if (poly[0]?.length) { out.push(mk('polygon', poly[0].map(ll), props)); counts.polygon++; }
      }
      break;
    case 'GeometryCollection':
      for (const sub of g.geometries) extract(sub, props, out, counts);
      break;
  }
}

export async function parseReferenceShapefile(file: File): Promise<ParsedReference> {
  return parseReferenceBuffer(await file.arrayBuffer());
}

/// Buffer-based core (also unit-testable outside the browser).
export async function parseReferenceBuffer(buf: ArrayBuffer): Promise<ParsedReference> {
  const warnings: string[] = [];
  let geojson: GeoJSON.FeatureCollection | GeoJSON.FeatureCollection[];
  try {
    geojson = (await shpjs.default(buf)) as GeoJSON.FeatureCollection;
  } catch (e) {
    throw new Error(`Shapefile parse failed: ${e}`);
  }
  const collections = Array.isArray(geojson) ? geojson : [geojson];
  if (Array.isArray(geojson) && geojson.length > 1) {
    warnings.push(`Multi-layer shapefile (${geojson.length} layers) — merged into one layer.`);
  }

  const features: ParsedReferenceFeature[] = [];
  const attrSet = new Set<string>();
  const counts = { point: 0, line: 0, polygon: 0 };
  for (const fc of collections) {
    for (const f of fc.features ?? []) {
      if (!f.geometry) continue;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(props)) attrSet.add(k);
      extract(f.geometry, props, features, counts);
    }
  }

  // Sanity: are coordinates plausibly geographic (WGS84)? If not, the .prj was
  // missing and the shapes will land in the ocean — warn rather than silently
  // misplace them.
  const geographic = features.every((f) =>
    f.coords.every(([la, ln]) => Number.isFinite(la) && Number.isFinite(ln)
      && la >= -90 && la <= 90 && ln >= -180 && ln <= 180));
  if (features.length > 0 && !geographic) {
    warnings.push('Coordinates look projected (no .prj sidecar) — reproject the shapefile to WGS84 before importing.');
  }
  if (features.length === 0) warnings.push('No geometry found in this file.');

  return { features, attributeNames: [...attrSet].sort(), counts, warnings };
}

/// Build the final (solver-invisible) feature list, applying the chosen label
/// attribute and dropping the raw attribute bag.
export function finaliseFeatures(
  parsed: ParsedReferenceFeature[],
  labelAttr: string | null,
): ReferenceFeature[] {
  return parsed.map((f) => {
    let label: string | undefined;
    if (labelAttr) {
      const v = f.props[labelAttr];
      if (v != null && !(typeof v === 'number' && Number.isNaN(v))) {
        const s = String(v).trim();
        // Never label with the literal "NaN" / "undefined" / empty — show
        // nothing instead.
        if (s !== '' && s !== 'NaN' && s !== 'undefined') label = s;
      }
    }
    return { id: f.id, type: f.type, coords: f.coords, label };
  });
}

/// Bounding box of all features, for fit-to-view after import.
export function featuresBounds(
  features: ReferenceFeature[],
): { sw: [number, number]; ne: [number, number] } | null {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const f of features) {
    for (const [la, ln] of f.coords) {
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (ln < minLng) minLng = ln;
      if (ln > maxLng) maxLng = ln;
    }
  }
  if (!Number.isFinite(minLat)) return null;
  return { sw: [minLat, minLng], ne: [maxLat, maxLng] };
}
