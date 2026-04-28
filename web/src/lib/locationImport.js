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
import { parseCsv } from './csvImport';
import { toWgs84 } from './projections';
/// Detect format by file extension. `.zip` is treated as a shapefile
/// bundle (the most common reason to upload a zip in this context).
export function detectFormat(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.txt'))
        return 'csv';
    if (name.endsWith('.kml'))
        return 'kml';
    if (name.endsWith('.zip') || name.endsWith('.shp'))
        return 'shapefile';
    return null;
}
/// Read any supported file into the common ImportResult shape.
export async function parseLocations(file, _opts = {}) {
    const fmt = detectFormat(file);
    if (!fmt)
        throw new Error(`Unsupported file extension: ${file.name}`);
    if (fmt === 'csv')
        return parseCsvLocations(file);
    if (fmt === 'kml')
        return parseKmlLocations(file);
    return parseShapefileLocations(file);
}
// ---------- CSV ----------
async function parseCsvLocations(file) {
    const text = await file.text();
    const parsed = parseCsv(text);
    // We don't yet know which columns are X / Y — the modal asks the user.
    // For CSV, every row becomes a "feature" but with placeholder coords;
    // the modal converts to actual latLng once columns + CRS are mapped.
    const features = parsed.rows.map((row) => ({
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
async function parseKmlLocations(file) {
    const text = await file.text();
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const geojson = toGeoJson.kml(xml);
    return geojsonToImportResult(geojson, 'kml', [], 4326);
}
// ---------- Shapefile ----------
async function parseShapefileLocations(file) {
    // shpjs accepts a zip ArrayBuffer (containing .shp/.dbf/.prj) or a single
    // .shp ArrayBuffer (no attribute table). The latter is rarer in practice.
    const buf = await file.arrayBuffer();
    const warnings = [];
    let geojson;
    try {
        geojson = (await shpjs.default(buf));
    }
    catch (e) {
        throw new Error(`Shapefile parse failed: ${e}`);
    }
    // Some shapefile zips contain multiple layers — flatten into a single
    // feature collection (warn the user).
    let fc;
    if (Array.isArray(geojson)) {
        warnings.push(`Multi-layer shapefile (${geojson.length} layers) — flattened.`);
        fc = {
            type: 'FeatureCollection',
            features: geojson.flatMap((g) => g.features),
        };
    }
    else {
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
    warnings.push('Shapefile coordinates appear to be in a projected CRS (no .prj sidecar found, ' +
        'or the CRS is unknown to BEESTY). Pick a CRS below to reproject.');
    return geojsonToImportResult(fc, 'shapefile', warnings, null, false);
}
function featuresLookGeographic(fc) {
    // Sample at most ~50 points to keep this O(1) for big files.
    let checked = 0;
    for (const f of fc.features) {
        if (!f.geometry || checked > 50)
            break;
        const pt = pickRepresentativePoint(f.geometry);
        if (!pt)
            continue;
        const [lng, lat] = pt;
        if (Math.abs(lng) > 180 || Math.abs(lat) > 90)
            return false;
        checked += 1;
    }
    return true;
}
// ---------- GeoJSON → ImportResult ----------
function geojsonToImportResult(fc, format, warnings, nativeEpsg, shapefileHadPrj) {
    const features = [];
    const attrSet = new Set();
    for (const f of fc.features) {
        if (!f.geometry)
            continue;
        const props = (f.properties ?? {});
        for (const k of Object.keys(props))
            attrSet.add(k);
        // Pull a representative point — first vertex / centroid of any geometry.
        const pt = pickRepresentativePoint(f.geometry);
        if (!pt)
            continue;
        if (nativeEpsg === 4326) {
            // GeoJSON Position is [lng, lat]; flip to our [lat, lng].
            features.push({ latLng: [pt[1], pt[0]], properties: props });
        }
        else {
            // Projected coords — store native (x, y) in latLng for now and
            // reproject at apply time once the user has picked a CRS.
            features.push({ latLng: [pt[1], pt[0]], properties: { ...props, __native_x: pt[0], __native_y: pt[1] } });
        }
    }
    if (features.length === 0)
        warnings.push('No point-like geometry found in this file.');
    return {
        format, features,
        attributeNames: Array.from(attrSet),
        warnings,
        nativeEpsg,
        shapefileHadPrj,
    };
}
function pickRepresentativePoint(g) {
    if (g.type === 'Point')
        return g.coordinates;
    if (g.type === 'MultiPoint')
        return g.coordinates[0] ?? null;
    if (g.type === 'LineString')
        return g.coordinates[0] ?? null;
    if (g.type === 'MultiLineString')
        return g.coordinates[0]?.[0] ?? null;
    if (g.type === 'Polygon') {
        // Use the centroid of the first ring (rough — fine for placement).
        const ring = g.coordinates[0];
        if (!ring || ring.length === 0)
            return null;
        let lat = 0, lng = 0;
        for (const c of ring) {
            lng += c[0];
            lat += c[1];
        }
        return [lng / ring.length, lat / ring.length];
    }
    if (g.type === 'MultiPolygon') {
        const ring = g.coordinates[0]?.[0];
        if (!ring || ring.length === 0)
            return null;
        let lat = 0, lng = 0;
        for (const c of ring) {
            lng += c[0];
            lat += c[1];
        }
        return [lng / ring.length, lat / ring.length];
    }
    return null;
}
/// Project a feature stored in projected coords (via `__native_x` /
/// `__native_y`) into WGS84 using the supplied CRS. Returns the WGS84
/// (lat, lng) or null if the feature has no projected coords (e.g. KML,
/// or shapefile that already had a .prj).
export function reprojectShapefileFeature(f, epsg) {
    const x = f.properties.__native_x;
    const y = f.properties.__native_y;
    if (typeof x !== 'number' || typeof y !== 'number')
        return null;
    return toWgs84(epsg, x, y);
}
// ---------- Default attribute mapping ----------
/// Default attribute mapping — name-based, kind-aware.
export function guessLocationMapping(attributeNames, kind, format) {
    const lower = attributeNames.map((h) => h.toLowerCase());
    function find(...candidates) {
        for (const cand of candidates) {
            const idx = lower.indexOf(cand.toLowerCase());
            if (idx >= 0)
                return attributeNames[idx];
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
