// Geoscience Australia SRTM-derived 1 Second DEM-S v1.0 — the national default.
//
// One 38 GB cloud-optimised GeoTIFF on the DEA public bucket, read by HTTP range
// requests: geotiff.js fetches the header once and then only the 512² tiles a
// project's window touches, so a site costs a few hundred kB, not a download.
//
// Why this and not the AWS terrarium tiles it replaces: DEM-S is bare earth —
// GA filled the voids, removed the vegetation offset and adaptively smoothed the
// SRTM speckle. The terrarium tiles are that same SRTM raw inland in Australia,
// canopy and all. Same nominal 1-arcsecond pitch, materially cleaner surface.
//
// The COG's geometry is fixed and published, so the pixel window is arithmetic —
// no `getBoundingBox()` round trip before we know what to ask for.

import { fromUrl, type GeoTIFF } from 'geotiff';

import type { DemRaster, DemSourceInfo } from '../dem';
import { TERRAIN_MARGIN_M } from '../terrainField';
import type { DemBounds, DemSource } from './index';

const COG_URL =
  'https://dea-public-data.s3.ap-southeast-2.amazonaws.com/projects/elevation/ga_srtm_dem1sv1_0/dems1sv1_0.tif';

// Published grid geometry (EPSG:4326, RasterPixelIsArea: the origin is the
// OUTER corner of pixel 0, so sample points sit at +0.5 px).
const ORIGIN_LNG = 112.99986111;
const ORIGIN_LAT = -10.00013889;
const PIXEL_DEG = 0.000277777778;
const WIDTH_PX = 147600;
const HEIGHT_PX = 122400;

/// Sea is a real 0 in DEM-S and must be kept; only the float32 sentinel
/// (-3.4028235e38) is a hole.
const NODATA_BELOW = -1e30;

/// Refuse windows past ~110 km a side. Reading 4096² float32 is 67 MB over the
/// wire, which is not a terrain raster, it is a download — and the engine caps
/// the heightfield at 2048 cells per axis anyway. Wind-farm and BESS extents sit
/// an order of magnitude below this.
const MAX_WINDOW_PX = 4096;

const EARTH_R_M = 6371008.8;
const M_PER_DEG = (Math.PI / 180) * EARTH_R_M;

export const GA_DEM_S_SOURCE: Omit<DemSourceInfo, 'nativePitchM'> = {
  id: 'ga-dem-s',
  label: 'GA SRTM 1s DEM-S v1.0',
  attribution: 'Elevation: Geoscience Australia, SRTM-derived 1 Second DEM-S v1.0 (CC BY 4.0)',
  licence: 'CC BY 4.0',
};

const east = ORIGIN_LNG + WIDTH_PX * PIXEL_DEG;
const south = ORIGIN_LAT - HEIGHT_PX * PIXEL_DEG;

/// Pixel pitch in metres. The E-W axis is the finer one everywhere in Australia
/// (cos φ < 1), and `resolutionM` must report the finer axis so `terrainField`
/// never samples coarser than the data actually is.
function pitchM(lat: number): number {
  return Math.min(M_PER_DEG * PIXEL_DEG * Math.cos((lat * Math.PI) / 180), M_PER_DEG * PIXEL_DEG);
}

export interface DemSWindow {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/// Pixel window covering `bounds` grown by `marginM` (the same margin
/// `buildTerrainField` pads its heightfield with, so the raster is never short
/// of the ridge just outside the site) plus a pixel of bilinear slack.
export function demSPixelWindow(bounds: DemBounds, marginM = TERRAIN_MARGIN_M): DemSWindow {
  const midLat = (bounds.sw[0] + bounds.ne[0]) / 2;
  const dLat = marginM / M_PER_DEG;
  const dLng = marginM / (M_PER_DEG * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)));
  const x0 = clamp(Math.floor((bounds.sw[1] - dLng - ORIGIN_LNG) / PIXEL_DEG) - 1, 0, WIDTH_PX - 1);
  const x1 = clamp(Math.ceil((bounds.ne[1] + dLng - ORIGIN_LNG) / PIXEL_DEG) + 1, x0 + 2, WIDTH_PX);
  const y0 = clamp(Math.floor((ORIGIN_LAT - (bounds.ne[0] + dLat)) / PIXEL_DEG) - 1, 0, HEIGHT_PX - 1);
  const y1 = clamp(Math.ceil((ORIGIN_LAT - (bounds.sw[0] - dLat)) / PIXEL_DEG) + 1, y0 + 2, HEIGHT_PX);
  return { x0, y0, nx: x1 - x0, ny: y1 - y0 };
}

/// Bilinear `DemRaster` over one window of the DEM-S grid, in degrees.
/// `values` is row-major, north-to-south, west-to-east — geotiff.js window order.
export function demSWindowRaster(win: DemSWindow, values: ArrayLike<number>): DemRaster {
  const { x0, y0, nx, ny } = win;
  const heights = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    const v = +values[i];
    heights[i] = v < NODATA_BELOW || !Number.isFinite(v) ? NaN : v;
  }
  // Cell CENTRES bound the sampled area; the outer half-pixel has no stencil.
  const west = ORIGIN_LNG + (x0 + 0.5) * PIXEL_DEG;
  const north = ORIGIN_LAT - (y0 + 0.5) * PIXEL_DEG;
  const bounds = {
    sw: [north - (ny - 1) * PIXEL_DEG, west] as [number, number],
    ne: [north, west + (nx - 1) * PIXEL_DEG] as [number, number],
  };
  const nativePitchM = pitchM((bounds.sw[0] + bounds.ne[0]) / 2);
  return {
    resolutionM: nativePitchM,
    source: { ...GA_DEM_S_SOURCE, nativePitchM },
    bounds,
    tilesLoaded: 1,
    elevation(lat: number, lng: number): number {
      const fi = (lng - west) / PIXEL_DEG;
      const fj = (north - lat) / PIXEL_DEG;
      if (!(fi >= 0 && fi <= nx - 1 && fj >= 0 && fj <= ny - 1)) return 0;
      const i0 = Math.floor(fi);
      const j0 = Math.floor(fj);
      const i1 = Math.min(i0 + 1, nx - 1);
      const j1 = Math.min(j0 + 1, ny - 1);
      const fx = fi - i0;
      const fy = fj - j0;
      return (
        heights[j0 * nx + i0] * (1 - fx) * (1 - fy)
        + heights[j0 * nx + i1] * fx * (1 - fy)
        + heights[j1 * nx + i0] * (1 - fx) * fy
        + heights[j1 * nx + i1] * fx * fy
      );
    },
  };
}

/// One GeoTIFF handle per session: the header is ~1.3 s and never changes.
let handle: Promise<GeoTIFF> | null = null;

function cog(): Promise<GeoTIFF> {
  if (!handle) {
    handle = fromUrl(COG_URL);
    handle.catch(() => { handle = null; });   // a transient failure must not stick
  }
  return handle;
}

/// Window cache, keyed by the requested bounds to ~10 m. A project re-reads the
/// same extent every time the calc area is nudged below that.
const windows = new Map<string, Promise<DemRaster>>();

const boundsKey = (b: DemBounds) =>
  [b.sw[0], b.sw[1], b.ne[0], b.ne[1]].map((v) => v.toFixed(4)).join(',');

export const GA_DEM_S: DemSource = {
  id: 'ga-dem-s',
  label: GA_DEM_S_SOURCE.label,

  async covers(bounds: DemBounds): Promise<boolean> {
    return bounds.sw[0] >= south && bounds.ne[0] <= ORIGIN_LAT
      && bounds.sw[1] >= ORIGIN_LNG && bounds.ne[1] <= east;
  },

  load(bounds: DemBounds): Promise<DemRaster> {
    const key = boundsKey(bounds);
    const hit = windows.get(key);
    if (hit) return hit;
    const promise = (async () => {
      const win = demSPixelWindow(bounds);
      if (win.nx > MAX_WINDOW_PX || win.ny > MAX_WINDOW_PX) {
        throw new Error(
          `DEM-S window ${win.nx}×${win.ny} px exceeds the ${MAX_WINDOW_PX} px cap `
          + '(~110 km); falling back to the tiled source.',
        );
      }
      // Image 0 only — the overviews are decimated, and the engine wants the
      // native pitch, not a pretty one.
      const image = await (await cog()).getImage(0);
      const rasters = await image.readRasters({
        window: [win.x0, win.y0, win.x0 + win.nx, win.y0 + win.ny],
      });
      const band0 = (Array.isArray(rasters) ? rasters[0] : rasters) as unknown as ArrayLike<number>;
      return demSWindowRaster(win, band0);
    })();
    windows.set(key, promise);
    promise.catch(() => { if (windows.get(key) === promise) windows.delete(key); });
    return promise;
  },
};
