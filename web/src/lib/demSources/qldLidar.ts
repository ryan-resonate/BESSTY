// Queensland Government `Elevation/QldDem` ImageServer — the best automatic
// terrain BESSTY can reach, where it reaches.
//
// The service is a mosaic of the latest public LiDAR DTMs (0.5–1 m) over
// Queensland, falling back to GA's 30 m SRTM-derived DEM everywhere they do not
// cover. That fallback is the whole difficulty: the service answers for the
// entire state, so "does it cover this site?" is not a bounding-box question
// but "is the thing under this site actually LiDAR?". `identify` names the
// raster serving a point and gives its cell size (`lowps`), so coverage is
// decided by probing the site rather than by trusting the extent — an SRTM
// answer here is strictly worse than DEM-S (raw SRTM, no vegetation offset
// removed) and must fall through, not win.
//
// One `exportImage` then returns the window as a georeferenced float32 GeoTIFF,
// parsed through the SAME code path as a user upload so the georeferencing
// comes from the file's own tie point and pixel scale, not from the bbox we
// asked for.

import type { DemRaster, DemSourceInfo } from '../dem';
import { parseDemGeoTiffBuffer } from '../demUpload';
import { TERRAIN_MARGIN_M } from '../terrainField';
import type { DemBounds, DemSource } from './index';

const BASE =
  'https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer';

/// Published service extent, in the service's own EPSG:3857 metres.
const EXTENT_3857 = { xmin: 15352710, ymin: -3449670, xmax: 17810238, ymax: -1021912 };

// Web Mercator → WGS84, done here rather than pasting a degree box, so the
// numbers in this file are the ones the service publishes and a future extent
// change is a two-line edit. Gives ≈ 137.92…159.99 °E, −29.54…−9.14 °S.
const WEBMERC_R = 6378137;
const merc2lng = (x: number) => (x / (Math.PI * WEBMERC_R)) * 180;
const merc2lat = (y: number) => (Math.atan(Math.sinh(y / WEBMERC_R)) * 180) / Math.PI;
const EXTENT = {
  west: merc2lng(EXTENT_3857.xmin),
  east: merc2lng(EXTENT_3857.xmax),
  south: merc2lat(EXTENT_3857.ymin),
  north: merc2lat(EXTENT_3857.ymax),
};

/// Coarsest cell size (m) still worth calling LiDAR. The state's DTM capture is
/// 0.5–1 m; the SRTM fallback reports 30.92. Anything between is a coarse
/// aerial product with no advantage over DEM-S, so 5 m is a generous line that
/// no plausible SRTM answer can sneak under.
const MAX_LIDAR_PITCH_M = 5;

/// Never export finer than this. A 1 m grid over a wind farm is tens of
/// millions of samples the engine caps away anyway (`TERRAIN_MAX_CELLS_PER_AXIS`),
/// and acoustic screening does not turn on a 1 m furrow.
const MIN_EXPORT_PITCH_M = 2;

/// Hard ceiling on the export, per axis. The service allows 7680 × 4100, but
/// 2048 is where the engine's heightfield caps out and 2048² float32 is already
/// a 16.8 MB download.
const MAX_EXPORT_PX = 2048;

/// The sentinel we ASK the service for. Anything outside the mosaic comes back
/// as this and becomes NaN, which `terrainField` fills from its neighbours.
const NO_DATA_VALUE = -9999;

const M_PER_DEG = (Math.PI / 180) * 6371008.8;

/// Credit, from the service's own `copyrightText`. The Australian Hydrographic
/// Office and deepreef.org halves of that string credit the BATHYMETRY in the
/// mosaic, which a land DTM export never touches, so they are left out rather
/// than printed on every figure.
export const QLD_LIDAR_SOURCE: Omit<DemSourceInfo, 'nativePitchM'> = {
  id: 'qld-lidar',
  label: 'QLD LiDAR DTM (Queensland Government)',
  attribution:
    'Elevation: © State of Queensland (Department of Natural Resources and Mines, '
    + 'Manufacturing, and Regional and Rural Development); © Commonwealth of Australia '
    + '(Geoscience Australia)',
  // The QSpatial/data.qld.gov.au records for the sibling public elevation
  // services say CC BY 3.0 (portal) and CC BY-SA (ISO metadata) — no record
  // naming THIS endpoint was found, and the two disagree. The service's own
  // terms say the copyright text must travel with the data, which `attribution`
  // does; the licence name itself stays unclaimed until someone confirms it.
  licence: 'see service metadata',
};

/// What one `identify` probe found: the raster the mosaic actually serves at a
/// point.
interface CatalogItem {
  name: string;
  /// Source pixel size in the service's units (m).
  lowps: number;
}

/// Outcome of probing a site. `nativePitchM` is the COARSEST cell size found
/// across the probes — a site straddling a 0.5 m and a 1 m capture is only as
/// good as its worse half, and exporting finer than that invents detail.
interface Coverage {
  covered: boolean;
  nativePitchM: number;
}

const NO_COVERAGE: Coverage = { covered: false, nativePitchM: 0 };

const inExtent = (b: DemBounds) =>
  b.sw[0] >= EXTENT.south && b.ne[0] <= EXTENT.north
  && b.sw[1] >= EXTENT.west && b.ne[1] <= EXTENT.east;

const boundsKey = (b: DemBounds) =>
  [b.sw[0], b.sw[1], b.ne[0], b.ne[1]].map((v) => v.toFixed(4)).join(',');

async function identify(lat: number, lng: number): Promise<CatalogItem | null> {
  const geometry = JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } });
  const url = `${BASE}/identify?geometry=${encodeURIComponent(geometry)}`
    + '&geometryType=esriGeometryPoint&returnCatalogItems=true&returnGeometry=false&f=pjson';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`QLD identify failed: ${resp.status}`);
  const body = await resp.json() as {
    error?: { message?: string };
    catalogItems?: { features?: Array<{ attributes?: Record<string, unknown> }> };
  };
  // ArcGIS reports service-side failures with HTTP 200 and an `error` body.
  if (body.error) throw new Error(body.error.message ?? 'QLD identify returned an error');
  // Feature 0 is the item the mosaic rule serves, i.e. the one `exportImage`
  // will hand back. Later features are the older/coarser rasters underneath it,
  // and requiring THOSE to be LiDAR too would reject every real LiDAR site
  // (SRTM is under all of them).
  const attrs = body.catalogItems?.features?.[0]?.attributes;
  if (!attrs) return null;
  return { name: String(attrs.name ?? ''), lowps: Number(attrs.lowps) };
}

/// Probe the centre and the four corners. One point is not enough: a site can
/// sit half on a LiDAR capture and half off it, and the export would then be
/// half 1 m ground and half 30 m SRTM with a step between them.
async function probeCoverage(bounds: DemBounds): Promise<Coverage> {
  const { sw, ne } = bounds;
  const points: Array<[number, number]> = [
    [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2],
    [sw[0], sw[1]], [sw[0], ne[1]], [ne[0], sw[1]], [ne[0], ne[1]],
  ];
  try {
    const items = await Promise.all(points.map(([la, ln]) => identify(la, ln)));
    let pitch = 0;
    for (const item of items) {
      if (!item || !Number.isFinite(item.lowps) || item.lowps <= 0) return NO_COVERAGE;
      if (item.lowps > MAX_LIDAR_PITCH_M || /SRTM/i.test(item.name)) return NO_COVERAGE;
      pitch = Math.max(pitch, item.lowps);
    }
    return { covered: true, nativePitchM: pitch };
  } catch (err) {
    // A state service being down must cost the user DEM-S, not the solve.
    // eslint-disable-next-line no-console
    console.warn('[BESSTY] QLD elevation coverage probe failed, falling through:', err);
    return NO_COVERAGE;
  }
}

/// Coverage answers for the session, keyed by bounds rounded to ~10 m. Five
/// `identify` round trips is not a per-keystroke cost, and the answer only
/// changes when the state flies new LiDAR.
const coverage = new Map<string, Promise<Coverage>>();

function coverageFor(bounds: DemBounds): Promise<Coverage> {
  const key = boundsKey(bounds);
  const hit = coverage.get(key);
  if (hit) return hit;
  const promise = probeCoverage(bounds);
  coverage.set(key, promise);
  return promise;
}

export interface QldExportRequest {
  url: string;
  widthPx: number;
  heightPx: number;
  /// Ground pitch (m) the export is sampled at — never finer than the source
  /// data, never fine enough to blow [`MAX_EXPORT_PX`].
  pitchM: number;
  /// The padded box actually requested.
  bounds: DemBounds;
}

/// The one `exportImage` request for a site: bounds grown by the same
/// [`TERRAIN_MARGIN_M`] `buildTerrainField` pads its heightfield with, at a
/// pitch that is honest about the data and small enough to download.
export function qldExportRequest(
  bounds: DemBounds,
  nativePitchM: number,
  marginM = TERRAIN_MARGIN_M,
): QldExportRequest {
  const midLat = (bounds.sw[0] + bounds.ne[0]) / 2;
  const cosLat = Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const dLat = marginM / M_PER_DEG;
  const dLng = marginM / (M_PER_DEG * cosLat);
  const south = bounds.sw[0] - dLat;
  const north = bounds.ne[0] + dLat;
  const west = bounds.sw[1] - dLng;
  const east = bounds.ne[1] + dLng;

  const spanLatM = (north - south) * M_PER_DEG;
  const spanLngM = (east - west) * M_PER_DEG * cosLat;
  // The LONGER axis sets the cap floor: a single pitch drives both sides of the
  // image, so sizing off the shorter one would let the longer one run past
  // MAX_EXPORT_PX.
  const capFloor = Math.max(spanLatM, spanLngM) / MAX_EXPORT_PX;
  const pitchM = Math.max(MIN_EXPORT_PITCH_M, nativePitchM, capFloor);
  const px = (spanM: number) =>
    Math.min(MAX_EXPORT_PX, Math.max(2, Math.round(spanM / pitchM) + 1));
  const widthPx = px(spanLngM);
  const heightPx = px(spanLatM);

  const url = `${BASE}/exportImage?bbox=${west},${south},${east},${north}`
    + `&bboxSR=4326&imageSR=4326&size=${widthPx},${heightPx}`
    + `&format=tiff&pixelType=F32&noData=${NO_DATA_VALUE}`
    + '&interpolation=RSP_BilinearInterpolation&f=image';
  return { url, widthPx, heightPx, pitchM, bounds: { sw: [south, west], ne: [north, east] } };
}

/// TIFF magic: "II*\0" little-endian or "MM\0*" big-endian.
function looksLikeTiff(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 8) return false;
  const b = new Uint8Array(buf, 0, 4);
  return (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00)
    || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a);
}

/// Backoff before the 2nd and 3rd export attempt (ms). Three attempts in all.
const EXPORT_RETRY_DELAYS_MS = [500, 1500];

/// Fetch one `exportImage`, retrying a body that is not a TIFF.
///
/// The service answers a third to a half of requests with HTTP 200,
/// `content-type: image/tiff` and a "General function failure" message in the
/// body — a transient busy-service answer, not a statement about the site. Left
/// unretried it drops the project through to DEM-S, so the SAME project stands
/// on 1 m LiDAR in one session and 30 m SRTM in the next. Only after three
/// attempts does it fall through, and it says why.
async function fetchExport(url: string): Promise<ArrayBuffer> {
  let lastReason = '';
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      // A rejected export comes back as HTTP 200 with `content-type: image/tiff`
      // and a JSON error body, so neither the status nor the content type says
      // anything. Sniff the file itself, and quote the service's own message —
      // handing the bytes to the TIFF parser instead would report "Invalid byte
      // order value" and lose it.
      if (looksLikeTiff(buf)) return buf;
      lastReason = new TextDecoder().decode(buf.slice(0, 300));
    } catch (err) {
      lastReason = String((err as Error)?.message ?? err);
    }
    if (attempt >= EXPORT_RETRY_DELAYS_MS.length) {
      throw new Error(`QLD elevation export returned an error: ${lastReason}`);
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[BESSTY] QLD elevation export attempt ${attempt + 1} failed (${lastReason}); retrying`,
    );
    await new Promise((resolve) => setTimeout(resolve, EXPORT_RETRY_DELAYS_MS[attempt]));
  }
}

/// Loaded rasters, LRU-bounded exactly as DEM-S is: an export is up to 16 MB of
/// float32, and dragging the calc area across the state must not keep every
/// window it passed through for the life of the tab.
const RASTER_CACHE_MAX = 4;
const rasters = new Map<string, Promise<DemRaster>>();

export const QLD_LIDAR: DemSource = {
  id: 'qld-lidar',
  label: QLD_LIDAR_SOURCE.label,

  /// Extent first, and only then the network: outside Queensland this must cost
  /// nothing at all, because it runs for every project in the country.
  async covers(bounds: DemBounds): Promise<boolean> {
    if (!inExtent(bounds)) return false;
    return (await coverageFor(bounds)).covered;
  },

  load(bounds: DemBounds): Promise<DemRaster> {
    const key = boundsKey(bounds);
    const hit = rasters.get(key);
    if (hit) { rasters.delete(key); rasters.set(key, hit); return hit; }
    const promise = (async () => {
      const { covered, nativePitchM } = await coverageFor(bounds);
      if (!covered) throw new Error('QLD LiDAR does not cover this area.');
      const req = qldExportRequest(bounds, nativePitchM);
      const buf = await fetchExport(req.url);
      const raster = await parseDemGeoTiffBuffer(buf, {
        noDataValue: NO_DATA_VALUE,
        sourceInfo: QLD_LIDAR_SOURCE,
      });
      // The parser can only see the pitch of the file it was given — the EXPORT
      // pitch. `nativePitchM` is the underlying capture's own cell size, and the
      // report line wants both ("1.0 m native, 2.0 m sampled").
      return { ...raster, source: { ...QLD_LIDAR_SOURCE, nativePitchM } };
    })();
    rasters.set(key, promise);
    for (const stale of rasters.keys()) {
      if (rasters.size <= RASTER_CACHE_MAX) break;
      rasters.delete(stale);
    }
    promise.catch(() => { if (rasters.get(key) === promise) rasters.delete(key); });
    return promise;
  },
};
