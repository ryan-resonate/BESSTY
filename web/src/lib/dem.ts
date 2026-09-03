// DEM auto-loader using the public AWS Terrain Tiles "terrarium" PNG
// encoding. Free, no key required.
//
// Pixel decode (per Mapzen / AWS spec):
//   elevation_m = (R * 256 + G + B / 256) - 32768
//
// Tile URL: https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png
//
// We pick a zoom level that gives roughly 30 m ground resolution at the
// project latitude (z=12 ≈ 38 m at the equator, finer toward the poles).

const TILE_BASE = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';
const TILE_SIZE = 256;
const DEFAULT_ZOOM = 13;

interface Tile {
  z: number;
  x: number;
  y: number;
}

interface DemTile {
  data: Float32Array;        // length 256·256, row-major, elevation in metres
  /// SW and NE lat/lng of the tile.
  bounds: [[number, number], [number, number]];
}

const tileCache = new Map<string, Promise<DemTile>>();

function tileKey(t: Tile): string {
  return `${t.z}/${t.x}/${t.y}`;
}

function lng2tileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * Math.pow(2, z);
}

function lat2tileY(lat: number, z: number): number {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  return ((1 - Math.log((1 + sinLat) / (1 - sinLat)) / (2 * Math.PI)) / 2) * Math.pow(2, z);
}

function tileX2lng(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

function tileY2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

async function loadTile(t: Tile): Promise<DemTile> {
  const key = tileKey(t);
  if (tileCache.has(key)) return tileCache.get(key)!;

  const promise = (async () => {
    const url = `${TILE_BASE}/${t.z}/${t.x}/${t.y}.png`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`DEM tile ${t.z}/${t.x}/${t.y} fetch failed: ${resp.status}`);
    }
    const blob = await resp.blob();
    const img = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;

    const data = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      const r = px[i * 4];
      const g = px[i * 4 + 1];
      const b = px[i * 4 + 2];
      data[i] = r * 256 + g + b / 256 - 32768;
    }

    const lngW = tileX2lng(t.x, t.z);
    const lngE = tileX2lng(t.x + 1, t.z);
    const latN = tileY2lat(t.y, t.z);
    const latS = tileY2lat(t.y + 1, t.z);
    const bounds: [[number, number], [number, number]] = [[latS, lngW], [latN, lngE]];
    return { data, bounds };
  })();

  tileCache.set(key, promise);
  // A rejected promise must not stay cached: one transient tile failure would
  // otherwise poison that tile for the whole session, so every DEM retry
  // (nudging the calc area, reopening the project) re-failed instantly from
  // cache and only a full page reload recovered.
  promise.catch(() => { if (tileCache.get(key) === promise) tileCache.delete(key); });
  return promise;
}

/// The elevation datasets BEESTY can stand on. `upload` is the user's own
/// GeoTIFF and always wins; the rest are tried in cascade order (see
/// `demSources/index.ts`).
export type DemSourceId = 'qld-lidar' | 'ga-dem-s' | 'terrarium' | 'upload';

/// Provenance of a `DemRaster`. Terrain screening moves levels by several dB,
/// so the dataset behind it is never anonymous: it is named in the diagnostics,
/// on the map credit and in the PDF.
export interface DemSourceInfo {
  id: DemSourceId;
  /// Short human name, e.g. `GA SRTM 1s DEM-S v1.0`.
  label: string;
  /// Credit the licence requires, verbatim.
  attribution: string;
  licence: string;
  /// Ground pitch of the underlying data (m). The pitch a solve actually
  /// samples at can be coarser — `terrainField.ts` caps the grid.
  nativePitchM: number;
}

export interface DemRaster {
  /// Return interpolated elevation (m above sea level) at a lat/lng point.
  /// Returns 0 if the point falls outside the loaded tile coverage.
  elevation(lat: number, lng: number): number;
  bounds: { sw: [number, number]; ne: [number, number] };
  tilesLoaded: number;
  /// Native ground resolution (m per cell) of the underlying data, so callers
  /// can sample profiles at the DEM's own spacing rather than an arbitrary
  /// count. Approximate; computed from the tile zoom + latitude (tile raster)
  /// or the region span ÷ grid size (worker raster).
  resolutionM?: number;
  /// Where the data came from. Absent only on the synthetic rasters tests and
  /// the grid worker build from a transferred snapshot.
  source?: DemSourceInfo;
}

/// Credit for the AWS Terrain Tiles cascade fallback. The pitch varies with
/// latitude, hence a function rather than a constant.
export function terrariumSourceInfo(nativePitchM: number): DemSourceInfo {
  return {
    id: 'terrarium',
    label: 'AWS Terrain Tiles (SRTM/NASADEM blend)',
    attribution: 'Elevation: AWS Terrain Tiles (Mapzen terrarium)',
    licence: 'Public-domain and openly licensed sources; see the AWS Terrain Tiles attribution',
    nativePitchM,
  };
}

/// Diagnostics line naming the terrain a solve actually stood on (I20). The
/// pitch reported is the one SAMPLED, which the cell cap can make coarser than
/// the source's own — `terrain.resampled` says so separately.
export function terrainSourceNote(
  dem: DemRaster,
  field: { spacing: number; nx: number; ny: number },
): string {
  const label = dem.source?.label ?? 'unknown source';
  return `Terrain: ${label}, ${field.spacing.toFixed(1)} m cells, ${field.nx}×${field.ny} raster`;
}

/// Outcome of the terrain QA pass over the sampled raster (`terrainField.ts`).
/// Declared here so the reporting helpers below can be written against it
/// without `dem.ts` depending on the sampler that produces it.
export interface TerrainQaSummary {
  /// Cells flagged as DEM blunders rather than terrain.
  count: number;
  /// Largest |cell − ring median| over those cells (m).
  maxDevM: number;
  /// Non-null only when `qaCorrect` was on and something was flagged.
  correction: { changed: number; maxChangeM: number } | null;
}

/// Diagnostics line for flagged terrain (I20). Suspect cells are `material`:
/// a 60 m blunder under a path screens it like a hill that isn't there, whether
/// or not the user asked for it to be corrected.
export function terrainSuspectNote(dem: DemRaster, qa: TerrainQaSummary): string {
  const label = dem.source?.label ?? 'the DEM';
  const outcome = qa.correction
    ? `corrected: ${qa.correction.changed} cell${qa.correction.changed === 1 ? '' : 's'} replaced by `
      + `their neighbourhood median, largest change ${qa.correction.maxChangeM.toFixed(1)} m`
    : 'not corrected — they are still in the terrain these levels stand on';
  return `${qa.count} suspect terrain cell${qa.count === 1 ? '' : 's'} in ${label}, up to `
    + `${qa.maxDevM.toFixed(1)} m off the surrounding ground; ${outcome}. `
    + 'They are marked on the map (Layers → Suspect terrain cells).';
}

/// Report line for the PDF title block. Carries the credit, so the figure
/// satisfies the licence on its own. The QA tail appears only when something
/// was flagged — an unqualified figure is the normal case.
export function terrainReportLine(
  dem: DemRaster | null,
  rasterPitchM: number | null,
  qa?: TerrainQaSummary | null,
): string | null {
  const src = dem?.source;
  if (!src) return null;
  const pitches = rasterPitchM != null && Math.abs(rasterPitchM - src.nativePitchM) > 0.05
    ? `${src.nativePitchM.toFixed(1)} m native, ${rasterPitchM.toFixed(1)} m sampled`
    : `${src.nativePitchM.toFixed(1)} m cells`;
  const suspect = qa && qa.count > 0
    ? ` · ${qa.count} suspect cell${qa.count === 1 ? '' : 's'} `
      + `(max ${qa.maxDevM.toFixed(1)} m, ${qa.correction ? 'corrected' : 'not corrected'})`
    : '';
  return `Terrain: ${src.label} · ${pitches}${suspect} · ${src.attribution}`;
}

/// Metres-per-pixel of a web-mercator tile raster at the given zoom + latitude.
function tileResolutionM(zoom: number, lat: number): number {
  const EARTH_CIRCUM_M = 40075016.686;
  return (EARTH_CIRCUM_M * Math.cos((lat * Math.PI) / 180)) / (Math.pow(2, zoom) * TILE_SIZE);
}

/// A serializable elevation snapshot over a lat/lng rectangle — a dense grid
/// sampled from a `DemRaster`. Plain typed-array data, so it transfers cleanly
/// to a Web Worker (the tile-closure `DemRaster` can't). Row 0 = north edge,
/// col 0 = west edge; both axes linear in lat/lng.
export interface DemRegion {
  data: Float32Array;   // ny rows × nx cols, row-major
  sw: [number, number];
  ne: [number, number];
  nx: number;
  ny: number;
}

/// Sample a `DemRaster` into a `DemRegion` covering `[sw, ne]`. `nx`/`ny`
/// default to ~tile density (256²); over a few-km project that's tens of
/// metres per sample — comparable to the source tiles and ample for ridge
/// path sampling.
export function captureDemRegion(
  dem: DemRaster,
  sw: [number, number],
  ne: [number, number],
  nx = 256,
  ny = 256,
): DemRegion {
  const data = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const lat = ne[0] + (sw[0] - ne[0]) * (j / (ny - 1)); // north → south
    for (let i = 0; i < nx; i++) {
      const lng = sw[1] + (ne[1] - sw[1]) * (i / (nx - 1)); // west → east
      data[j * nx + i] = dem.elevation(lat, lng);
    }
  }
  return { data, sw, ne, nx, ny };
}

/// Rebuild a `DemRaster` (bilinear lookup) from a transferred `DemRegion`.
/// Used inside the grid worker. Returns 0 outside the region.
export function regionRaster(region: DemRegion): DemRaster {
  const { data, sw, ne, nx, ny } = region;
  // Effective cell size: region span (m) ÷ grid size. Use the coarser axis so
  // path sampling never claims finer resolution than the data actually has.
  const midLat = (sw[0] + ne[0]) / 2;
  const R = 6371008.8;
  const ewM = (((ne[1] - sw[1]) * Math.PI) / 180) * R * Math.cos((midLat * Math.PI) / 180);
  const nsM = (((ne[0] - sw[0]) * Math.PI) / 180) * R;
  const resolutionM = Math.max(ewM / Math.max(1, nx - 1), nsM / Math.max(1, ny - 1));
  return {
    resolutionM,
    elevation(lat: number, lng: number): number {
      const fi = ((lng - sw[1]) / (ne[1] - sw[1])) * (nx - 1);
      const fj = ((ne[0] - lat) / (ne[0] - sw[0])) * (ny - 1);
      if (!(fi >= 0 && fi <= nx - 1 && fj >= 0 && fj <= ny - 1)) return 0;
      const i0 = Math.floor(fi);
      const j0 = Math.floor(fj);
      const i1 = Math.min(i0 + 1, nx - 1);
      const j1 = Math.min(j0 + 1, ny - 1);
      const fx = fi - i0;
      const fy = fj - j0;
      const e00 = data[j0 * nx + i0];
      const e10 = data[j0 * nx + i1];
      const e01 = data[j1 * nx + i0];
      const e11 = data[j1 * nx + i1];
      return (
        e00 * (1 - fx) * (1 - fy) +
        e10 * fx * (1 - fy) +
        e01 * (1 - fx) * fy +
        e11 * fx * fy
      );
    },
    bounds: { sw, ne },
    tilesLoaded: 0,
  };
}

/// Fetch DEM tiles covering the given lat/lng bounding box, return an
/// elevation lookup raster. Caches tiles in memory so repeated calls within
/// one project session don't re-download.
export async function loadDemForBounds(
  sw: [number, number],
  ne: [number, number],
  zoom: number = DEFAULT_ZOOM,
): Promise<DemRaster> {
  const xMin = Math.floor(lng2tileX(sw[1], zoom));
  const xMax = Math.floor(lng2tileX(ne[1], zoom));
  const yMin = Math.floor(lat2tileY(ne[0], zoom));
  const yMax = Math.floor(lat2tileY(sw[0], zoom));

  const tilesToFetch: Tile[] = [];
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      tilesToFetch.push({ z: zoom, x, y });
    }
  }

  const tiles = await Promise.all(tilesToFetch.map(loadTile));

  // Build a 2D index of tiles for O(1) lookup.
  const grid = new Map<string, DemTile>();
  for (let i = 0; i < tiles.length; i++) {
    const t = tilesToFetch[i];
    grid.set(`${t.x},${t.y}`, tiles[i]);
  }

  const resolutionM = tileResolutionM(zoom, (sw[0] + ne[0]) / 2);
  return {
    resolutionM,
    source: terrariumSourceInfo(resolutionM),
    elevation(lat: number, lng: number): number {
      const tx = lng2tileX(lng, zoom);
      const ty = lat2tileY(lat, zoom);
      const tileX = Math.floor(tx);
      const tileY = Math.floor(ty);
      const tile = grid.get(`${tileX},${tileY}`);
      if (!tile) return 0;
      const localX = (tx - tileX) * TILE_SIZE;
      const localY = (ty - tileY) * TILE_SIZE;
      // Bilinear interpolation across cell.
      const x0 = Math.floor(localX);
      const y0 = Math.floor(localY);
      const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
      const y1 = Math.min(y0 + 1, TILE_SIZE - 1);
      const fx = localX - x0;
      const fy = localY - y0;
      const e00 = tile.data[y0 * TILE_SIZE + x0];
      const e10 = tile.data[y0 * TILE_SIZE + x1];
      const e01 = tile.data[y1 * TILE_SIZE + x0];
      const e11 = tile.data[y1 * TILE_SIZE + x1];
      return (
        e00 * (1 - fx) * (1 - fy) +
        e10 * fx * (1 - fy) +
        e01 * (1 - fx) * fy +
        e11 * fx * fy
      );
    },
    bounds: { sw, ne },
    tilesLoaded: tiles.length,
  };
}
