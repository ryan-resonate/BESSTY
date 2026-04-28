// Common front-end for the three location-list import formats: CSV, KML,
// and shapefile bundles. Each parser produces the same `ImportResult`:
// a list of features with lat/lng + a flat properties bag, plus the
// distinct attribute names found across features. The ImportObjectsModal
// then runs a single attribute-mapping UI on top.
//
// Coordinate handling:
//   - CSV     — defaults to WGS84 lat/lng (X = lng, Y = lat). The user can
//               supply any registered projected CRS (UTM, MGA, NZTM, …)
//               via `parseLocations(file, { csvEpsg: 28355 })`; columns
//               are then projected back to WGS84 at apply time.
//   - KML     — always WGS84 (per the OGC spec).
//   - .shp/.zip — uses shpjs which auto-reprojects to WGS84 when the .prj
//                 sidecar is present. Without .prj, the data lands in its
//                 native coords and `nativeEpsg` on the result is null —
//                 the modal then asks the user to pick a CRS, and we
//                 re-project on apply.

import * as toGeoJson from '@tmcw/togeojson';
import * as shpjs from 'shpjs';
import { parseCsv, type ParsedCsv } from './csvImport';
import { toWgs84 } from './projections';

export type ImportFormat = 'csv' | 'kml' | 'shapefile';

export interface ImportFeature {
  /// WGS84 [lat, lng]. NaN/NaN if the feature still needs CRS mapping
  /// (CSV before X/Y/EPSG selection; shapefile without a .prj sidecar).
  latLng: [number, number];
  properties: Record<string, string | number>;
}

export interface ImportResult {
  format: ImportFormat;
  features: ImportFeature[];
  attributeNames: string[];
  warnings: string[];
  /// Best guess at the source CRS:
  ///   - 'csv'   → null (user picks via the modal; defaults to 4326)
  ///   - 'kml'   → 4326 (always)
  ///   - 'shp'   → 4326 if shpjs reported the .prj was present, else null
  nativeEpsg: number | null;
  /// True if shpjs found and applied a .prj-driven reprojection. Used by
  /// the modal to suppress the CRS picker for shapefile bundles.
  shapefileHadPrj?: boolean;
}

export interface ParseOptions {
  /// Override the CRS of the source file. Currently honoured for CSV and
  /// shapefile-without-prj. Defaults to WGS84 if not supplied.
  csvEpsg?: number;
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
export async function parseLocations(file: File, _opts: ParseOptions = {}): Promise<ImportResult> {
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
  // the modal converts to actual latLng once columns + CRS are mapped.
  const features: ImportFeature[] = parsed.rows.map((row) => ({
    latLng: [NaN, NaN],
    properties: row,
  }));
  return {
    format: 'csv',
    features,
    attributeNames: parsed.headers,
    warnings: [],
    nativeEpsg: null,
  };
}

// ---------- KML ----------

async function parseKmlLocations(file: File): Promise<ImportResult> {
  const text = await file.text();
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const geojson = toGeoJson.kml(xml) as GeoJSON.FeatureCollection;
  return geojsonToImportResult(geojson, 'kml', [], 4326);
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
  // Heuristic: if all coordinates fall inside [-180,180] × [-90,90] then
  // the data is geographic (either shpjs reprojected via .prj, or it was
  // already WGS84). Otherwise the file lacked a usable .prj and the coords
  // are in some projected CRS the user has to identify.
  const looksGeographic = featuresLookGeographic(fc);
  if (looksGeographic) {
    return geojsonToImportResult(fc, 'shapefile', warnings, 4326, true);
  }
  warnings.push(
    'Shapefile coordinates appear to be in a projected CRS (no .prj sidecar found, ' +
    'or the CRS is unknown to BEESTY). Pick a CRS below to reproject.',
  );
  return geojsonToImportResult(fc, 'shapefile', warnings, null, false);
}

function featuresLookGeographic(fc: GeoJSON.FeatureCollection): boolean {
  // Sample at most ~50 points to keep this O(1) for big files.
  let checked = 0;
  for (const f of fc.features) {
    if (!f.geometry || checked > 50) break;
    const pt = pickRepresentativePoint(f.geometry);
    if (!pt) continue;
    const [lng, lat] = pt;
    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return false;
    checked += 1;
  }
  return true;
}

// ---------- GeoJSON → ImportResult ----------

function geojsonToImportResult(
  fc: GeoJSON.FeatureCollection,
  format: ImportFormat,
  warnings: string[],
  nativeEpsg: number | null,
  shapefileHadPrj?: boolean,
): ImportResult {
  const features: ImportFeature[] = [];
  const attrSet = new Set<string>();
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const props = (f.properties ?? {}) as Record<string, string | number>;
    for (const k of Object.keys(props)) attrSet.add(k);
    // Pull a representative point — first vertex / centroid of any geometry.
    const pt = pickRepresentativePoint(f.geometry);
    if (!pt) continue;
    if (nativeEpsg === 4326) {
      // GeoJSON Position is [lng, lat]; flip to our [lat, lng].
      features.push({ latLng: [pt[1], pt[0]], properties: props });
    } else {
      // Projected coords — store native (x, y) in latLng for now and
      // reproject at apply time once the user has picked a CRS.
      features.push({ latLng: [pt[1], pt[0]], properties: { ...props, __native_x: pt[0], __native_y: pt[1] } });
    }
  }
  if (features.length === 0) warnings.push('No point-like geometry found in this file.');
  return {
    format, features,
    attributeNames: Array.from(attrSet),
    warnings,
    nativeEpsg,
    shapefileHadPrj,
  };
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

/// Project a feature stored in projected coords (via `__native_x` /
/// `__native_y`) into WGS84 using the supplied CRS. Returns the WGS84
/// (lat, lng) or null if the feature has no projected coords (e.g. KML,
/// or shapefile that already had a .prj).
export function reprojectShapefileFeature(
  f: ImportFeature,
  epsg: number,
): [number, number] | null {
  const x = f.properties.__native_x;
  const y = f.properties.__native_y;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return toWgs84(epsg, x, y);
}

// ---------- Default attribute mapping ----------

/// Default attribute mapping — name-based, kind-aware.
///
/// Matching is conservative on purpose: short, ambiguous tokens like "day"
/// or "h" are NOT auto-matched because real CSVs frequently use them for
/// unrelated things (day-of-year, hour, header). Anything ambiguous is left
/// unmapped — the user can pick it explicitly in the modal.
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
      // Avoid matching a bare "h" — too easily a "header" or "hour" column.
      heightAboveGroundM: find('height', 'height_m', 'height_above_ground', 'z'),
      // Limits: require an explicit "limit" or "_dba" suffix so that columns
      // like "day" (day-of-year) or "night" (boolean flag) don't get parsed
      // as numeric noise limits and produce NaN downstream.
      limitDayDbA: find('limit_day', 'day_limit', 'l_day', 'limit_day_dba', 'day_dba'),
      limitEveningDbA: find('limit_evening', 'evening_limit', 'l_eve', 'limit_evening_dba', 'evening_dba'),
      limitNightDbA: find('limit_night', 'night_limit', 'l_night', 'limit_night_dba', 'night_dba'),
    };
  }
  return {
    ...xy,
    name: find('name', 'id', 'source', 'turbine', 'label', 'point_name'),
    modelId: find('model', 'modelid', 'type'),
    mode: find('mode', 'noise_mode', 'op_mode'),
    // Avoid bare "h" — same reason as above.
    hubHeight: find('hub_height', 'hub', 'hubheight'),
  };
}
