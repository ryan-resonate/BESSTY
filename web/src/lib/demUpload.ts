// User-supplied DEM via GeoTIFF upload. Builds a `DemRaster` over the
// uploaded raster, replacing the auto-loaded AWS Terrain Tiles for the
// project.
//
// CRS handling:
//   - If the GeoTIFF is in EPSG:4326 (WGS84) or EPSG:4269 (NAD83 — close
//     enough for our purposes), we walk it directly — `(lat,lng)` indexes
//     straight into the raster.
//   - If it's in any other registered EPSG (UTM, MGA, NZTM, …), we
//     project the bounding box back to WGS84 to compute the raster's
//     visible footprint, and transform every elevation query from
//     WGS84 → source CRS at lookup time. proj4 round-trips are cheap.
//   - The user can also pass an `epsgOverride` to force a CRS — useful
//     when the file lacks a CRS tag entirely (some legacy LiDAR exports).

import { fromArrayBuffer, type GeoTIFF, type GeoTIFFImage } from 'geotiff';
import type { DemRaster } from './dem';
import { fromWgs84, isSupportedEpsg, presetForEpsg, toWgs84 } from './projections';

export interface UploadedDem extends DemRaster {
  /// Underlying width/height in raster cells.
  width: number;
  height: number;
  /// Source filename, for display.
  source: string;
  /// EPSG code we ended up using (after override / inference).
  epsg: number;
}

export interface DemUploadOptions {
  /// Explicit CRS override. If provided, the GeoTIFF's own CRS tag is
  /// ignored. Useful when the tag is missing or wrong.
  epsgOverride?: number;
}

/// Parse a GeoTIFF into a DemRaster. Throws if the resolved CRS is not
/// registered with our proj4 instance (see `lib/projections.ts`).
export async function parseDemGeoTiff(file: File, opts: DemUploadOptions = {}): Promise<UploadedDem> {
  const buf = await file.arrayBuffer();
  const tiff: GeoTIFF = await fromArrayBuffer(buf);
  const image: GeoTIFFImage = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();

  // Resolve EPSG: override > inferred from GeoKeys > assume WGS84.
  const inferred = inferEpsg(image);
  const epsg = opts.epsgOverride ?? inferred ?? 4326;
  if (!isSupportedEpsg(epsg)) {
    const known = presetForEpsg(epsg);
    throw new Error(
      `GeoTIFF is in EPSG:${epsg}${known ? ` (${known.label})` : ''}; this CRS isn't registered. ` +
      `Re-project the file or pick a CRS override in the upload dialog.`,
    );
  }

  // GeoTIFF bbox is [west, south, east, north] in the image's CRS — i.e.
  // (xmin, ymin, xmax, ymax). For projected CRSs these are metres.
  const bbox = image.getBoundingBox();
  const [xmin, ymin, xmax, ymax] = bbox;
  const xRange = xmax - xmin;
  const yRange = ymax - ymin;

  // For the DemRaster.bounds field we need WGS84 corners (the rest of the
  // app uses lat/lng everywhere). Project the four corners and take the
  // axis-aligned hull. (For UTM/MGA at our typical site sizes the
  // distortion is tiny — sub-arcsecond.)
  let bounds: { sw: [number, number]; ne: [number, number] };
  if (epsg === 4326 || epsg === 4269) {
    bounds = { sw: [ymin, xmin], ne: [ymax, xmax] };
  } else {
    const corners: Array<[number, number]> = [
      toWgs84(epsg, xmin, ymin),
      toWgs84(epsg, xmax, ymin),
      toWgs84(epsg, xmin, ymax),
      toWgs84(epsg, xmax, ymax),
    ];
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [la, ln] of corners) {
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (ln < minLng) minLng = ln;
      if (ln > maxLng) maxLng = ln;
    }
    bounds = { sw: [minLat, minLng], ne: [maxLat, maxLng] };
  }

  const rasters = await image.readRasters();
  // Multi-band → use band 0; single-band → it's already the data array.
  const band0 = Array.isArray(rasters) ? (rasters[0] as ArrayLike<number>) : (rasters as unknown as ArrayLike<number>);
  const data = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) data[i] = +band0[i];

  // Inner sampler operates in the GeoTIFF's native (x, y) coords — bilinear
  // interpolation, returning 0 outside the raster footprint.
  function sampleNative(x: number, y: number): number {
    if (x < xmin || x > xmax || y < ymin || y > ymax) return 0;
    // GeoTIFF row 0 is the *northernmost* row (top-left origin). Convert
    // (x, y) → fractional (col, row).
    const fx = ((x - xmin) / xRange) * (width - 1);
    const fy = ((ymax - y) / yRange) * (height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const e00 = data[y0 * width + x0];
    const e10 = data[y0 * width + x1];
    const e01 = data[y1 * width + x0];
    const e11 = data[y1 * width + x1];
    return (
      e00 * (1 - tx) * (1 - ty) +
      e10 * tx * (1 - ty) +
      e01 * (1 - tx) * ty +
      e11 * tx * ty
    );
  }

  const elevation = (epsg === 4326 || epsg === 4269)
    ? (lat: number, lng: number) => sampleNative(lng, lat)
    : (lat: number, lng: number) => {
        const [x, y] = fromWgs84(epsg, lat, lng);
        return sampleNative(x, y);
      };

  return {
    width, height, source: file.name, epsg, bounds, tilesLoaded: 1,
    elevation,
  };
}

function inferEpsg(image: GeoTIFFImage): number | null {
  // GeoKeys may carry the projected or geographic CRS code.
  const keys = image.getGeoKeys?.() as Record<string, number | undefined> | undefined;
  if (!keys) return null;
  return keys.ProjectedCSTypeGeoKey
    ?? keys.GeographicTypeGeoKey
    ?? null;
}

/// Read just the CRS tag from a GeoTIFF without materialising the raster.
/// Used by the upload dialog to pre-fill the CRS picker so the user can
/// confirm or override before parsing the (potentially large) file.
export async function inferGeoTiffCrs(file: File): Promise<number | null> {
  const buf = await file.arrayBuffer();
  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  return inferEpsg(image);
}
