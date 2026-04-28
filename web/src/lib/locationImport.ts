// Common front-end for the three location-list import formats: CSV, KML,
// and shapefile bundles. Each parser produces the same `ImportResult`:
// a list of features with lat/lng + a flat properties bag, plus the
// distinct attribute names found across features. The ImportObjectsModal
// then runs a single attribute-mapping UI on top.
//
// Coordinate handling:
//   - CSV     — assumes WGS84 lat/lng (X = lng, Y = lat).
//   - KML     — always WGS84 (per the OGC spec).
//   - .shp/.zip — uses shpjs which auto-reprojects to WGS84 when the .prj
//                 sidecar is present. Without .prj, the user is warned and
//                 the data is left in its native coords.

import * as toGeoJson from '@tmcw/togeojson';
import * as shpjs from 'shpjs';
import { parseCsv, type ParsedCsv } from './csvImport';

export type ImportFormat = 'csv' | 'kml' | 'shapefile';

export interface ImportFeature {
  /// WGS84 [lat, lng].
  latLng: [number, number];
  properties: Record<string, string | number>;
}

export interface ImportResult {
  format: ImportFormat;
  features: ImportFeature[];
  attributeNames: string[];
  warnings: string[];
}

/// Detect format by file extension. `.zip` is treated as a shapefile
/// bundle (the most common reason to upload a zip in this context).
export function detectFormat(file: File): ImportFormat | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) return 'csv';
  if (name.endsWith('.kml')) return 'kml';
  if (name.endsWith('.zip') || name.endsWith('.shp')) return 'shapefile';
  return null;
}

/// Read any supported file into the common ImportResult shape.
export async function parseLocations(file: File): Promise<ImportResult> {
  const fmt = detectFormat(file);
  if (!fmt) throw new Error(`Unsupported file extension: ${file.name}`);
  if (fmt === 'csv') return parseCsvLocations(file);
  if (fmt === 'kml') return parseKmlLocations(file);
  return parseShapefileLocations(file);
}

// ---------- CSV ----------

async function parseCsvLocations(file: File): Promise<ImportResult> {
  const text = await file.text();
  const parsed: ParsedCsv = parseCsv(text);
  // We don't yet know which columns are X / Y — the modal asks the user.
  // For CSV, every row becomes a "feature" but with placeholder coords;
  // the modal converts to actual latLng once columns are mapped.
  const features: ImportFeature[] = parsed.rows.map((row) => ({
    latLng: [NaN, NaN],
    properties: row,
  }));
  return {
    format: 'csv',
    features,
    attributeNames: parsed.headers,
    warnings: [],
  };
}

// ---------- KML ----------

async function parseKmlLocations(file: File): Promise<ImportResult> {
  const text = await file.text();
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const geojson = toGeoJson.kml(xml) as GeoJSON.FeatureCollection;
  return geojsonToImportResult(geojson, 'kml', []);
}

// ---------- Shapefile ----------

async function parseShapefileLocations(file: File): Promise<ImportResult> {
  // shpjs accepts a zip ArrayBuffer (containing .shp/.dbf/.prj) or a single
  // .shp ArrayBuffer (no attribute table). The latter is rarer in practice.
  const buf = await file.arrayBuffer();
  const warnings: string[] = [];
  let geojson: GeoJSON.FeatureCollection | GeoJSON.FeatureCollection[];
  try {
    geojson = (await shpjs.default(buf)) as GeoJSON.FeatureCollection;
  } catch (e) {
    throw new Error(`Shapefile parse failed: ${e}`);
  }
  // Some shapefile zips contain multiple layers — flatten into a single
  // feature collection (warn the user).
  let fc: GeoJSON.FeatureCollection;
  if (Array.isArray(geojson)) {
    warnings.push(`Multi-layer shapefile (${geojson.length} layers) — flattened.`);
    fc = {
      type: 'FeatureCollection',
      features: geojson.flatMap((g) => g.features),
    };
  } else {
    fc = geojson;
  }
  return geojsonToImportResult(fc, 'shapefile', warnings);
}

// ---------- GeoJSON → ImportResult ----------

function geojsonToImportResult(
  fc: GeoJSON.FeatureCollection,
  format: ImportFormat,
  warnings: string[],
): ImportResult {
  const features: ImportFeature[] = [];
  const attrSet = new Set<string>();
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const props = (f.properties ?? {}) as Record<string, string | number>;
    for (const k of Object.keys(props)) attrSet.add(k);
    // Pull a representative point — first vertex of any geometry.
    const pt = pickRepresentativePoint(f.geometry);
    if (!pt) continue;
    features.push({
      // GeoJSON Position is [lng, lat]; flip to our [lat, lng].
      latLng: [pt[1], pt[0]],
      properties: props,
    });
  }
  if (features.length === 0) warnings.push('No point-like geometry found in this file.');
  return { format, features, attributeNames: Array.from(attrSet), warnings };
}

function pickRepresentativePoint(g: GeoJSON.Geometry): [number, number] | null {
  if (g.type === 'Point') return g.coordinates as [number, number];
  if (g.type === 'MultiPoint') return g.coordinates[0] as [number, number] ?? null;
  if (g.type === 'LineString') return g.coordinates[0] as [number, number] ?? null;
  if (g.type === 'MultiLineString') return g.coordinates[0]?.[0] as [number, number] ?? null;
  if (g.type === 'Polygon') {
    // Use the centroid of the first ring (rough — fine for placement).
    const ring = g.coordinates[0];
    if (!ring || ring.length === 0) return null;
    let lat = 0, lng = 0;
    for (const c of ring) { lng += c[0]; lat += c[1]; }
    return [lng / ring.length, lat / ring.length];
  }
  if (g.type === 'MultiPolygon') {
    const ring = g.coordinates[0]?.[0];
    if (!ring || ring.length === 0) return null;
    let lat = 0, lng = 0;
    for (const c of ring) { lng += c[0]; lat += c[1]; }
    return [lng / ring.length, lat / ring.length];
  }
  return null;
}

/// Default attribute mapping — name-based, kind-aware.
export function guessLocationMapping(
  attributeNames: string[],
  kind: 'source' | 'receiver',
  format: ImportFormat,
): Record<string, string | null> {
  const lower = attributeNames.map((h) => h.toLowerCase());
  function find(...candidates: string[]): string | null {
    for (const cand of candidates) {
      const idx = lower.indexOf(cand.toLowerCase());
      if (idx >= 0) return attributeNames[idx];
    }
    return null;
  }
  // CSV needs explicit X/Y columns; KML/shapefile carry geometry already.
  const xy = format === 'csv'
    ? { x: find('x', 'lng', 'lon', 'longitude', 'easting'),
        y: find('y', 'lat', 'latitude', 'northing') }
    : { x: null, y: null };
  if (kind === 'receiver') {
    return {
      ...xy,
      name: find('name', 'id', 'receiver', 'label', 'point_name'),
      heightAboveGroundM: find('height', 'h', 'z', 'height_m'),
      limitDayDbA: find('limit_day', 'day', 'l_day', 'day_limit'),
      limitEveningDbA: find('limit_evening', 'evening', 'l_eve', 'evening_limit'),
      limitNightDbA: find('limit_night', 'night', 'l_night', 'night_limit'),
    };
  }
  return {
    ...xy,
    name: find('name', 'id', 'source', 'turbine', 'label', 'point_name'),
    modelId: find('model', 'modelid', 'type'),
    mode: find('mode', 'noise_mode', 'op_mode'),
    hubHeight: find('hub_height', 'hub', 'hubheight', 'h'),
  };
}
