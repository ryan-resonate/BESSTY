// The QLD source decides, on its own and with no UI, whether a Queensland
// project stands on metre-scale LiDAR or falls through to the 30 m national
// DEM. Both failure modes are silent: claiming coverage it does not have would
// serve SRTM under a LiDAR label, and probing too eagerly would put five
// network round trips in front of every project in the country.
//
// Nothing here touches the network — `fetch` is replaced for the duration of
// each test, and every test uses its OWN bounds because coverage answers and
// loaded rasters are cached per bounds for the session.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDemGeoTiffBuffer } from '../demUpload';
import { QLD_LIDAR, QLD_LIDAR_SOURCE, qldExportRequest } from './qldLidar';
import type { DemBounds } from './index';

const M_PER_DEG = (Math.PI / 180) * 6371008.8;

/// A box `spanKm` across, centred on a point.
function box(lat: number, lng: number, spanKm = 2): DemBounds {
  const dLat = (spanKm * 500) / M_PER_DEG;
  const dLng = (spanKm * 500) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return { sw: [lat - dLat, lng - dLng], ne: [lat + dLat, lng + dLng] };
}

// ------------------------------------------------------------- fetch harness

interface FetchLog { urls: string[] }

type Handler = (url: string) => unknown;

async function withFetch<T>(handler: Handler, run: (log: FetchLog) => Promise<T>): Promise<T> {
  const log: FetchLog = { urls: [] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    log.urls.push(url);
    return handler(url);
  }) as typeof fetch;
  try {
    return await run(log);
  } finally {
    globalThis.fetch = original;
  }
}

/// The catalog item the mosaic serves at a point, or `null` for "nothing here".
type Item = { name: string; lowps: number } | null;

const identifyBody = (item: Item) => ({
  ok: true,
  headers: { get: () => 'text/plain' },
  json: async () => ({ catalogItems: { features: item ? [{ attributes: item }] : [] } }),
});

/// The (lat, lng) an `identify` URL is asking about.
function probePoint(url: string): [number, number] {
  const geom = JSON.parse(new URL(url).searchParams.get('geometry') ?? '{}');
  return [geom.y, geom.x];
}

const LIDAR: Item = { name: 'Brisbane_2019_LGA_DTM_1m', lowps: 1 };
const SRTM: Item = { name: 'QLD_SRTM_1SEC_DEM_H_V2', lowps: 30.92 };

// -------------------------------------------------------------- coverage

test('QLD: coverage means every probe landed on LiDAR', async () => {
  const bounds = box(-27.47, 153.02);
  const covered = await withFetch(() => identifyBody(LIDAR), async (log) => {
    const answer = await QLD_LIDAR.covers(bounds);
    // Centre plus four corners: a site half on a capture would otherwise be
    // exported half at 1 m and half at 30 m, with a step between them.
    assert.equal(log.urls.length, 5, 'centre + four corners');
    assert.ok(log.urls.every((u) => u.includes('returnCatalogItems=true')));
    return answer;
  });
  assert.equal(covered, true);
});

test('QLD: one SRTM corner sends the whole site down the cascade', async () => {
  const bounds = box(-27.60, 152.20, 40);   // big enough to run off a capture
  const covered = await withFetch((url) => {
    const [, lng] = probePoint(url);
    return identifyBody(lng < 152.0 ? SRTM : LIDAR);
  }, () => QLD_LIDAR.covers(bounds));
  assert.equal(covered, false);
});

test('QLD: a coarse non-SRTM raster is not LiDAR either', async () => {
  // Nothing in the name says SRTM, but a 10 m product has no advantage over
  // DEM-S and must not be dressed up as a LiDAR DTM in the report.
  const bounds = box(-23.38, 150.51);
  const covered = await withFetch(
    () => identifyBody({ name: 'QLD_AERIAL_DEM_10M', lowps: 10 }),
    () => QLD_LIDAR.covers(bounds),
  );
  assert.equal(covered, false);
});

test('QLD: a point with no catalog item is not coverage', async () => {
  const bounds = box(-19.26, 146.82);
  const covered = await withFetch(() => identifyBody(null), () => QLD_LIDAR.covers(bounds));
  assert.equal(covered, false);
});

test('QLD: a service failure falls through, it does not sink the solve', async () => {
  const down = box(-16.92, 145.77);
  assert.equal(
    await withFetch(() => { throw new Error('ECONNRESET'); }, () => QLD_LIDAR.covers(down)),
    false,
  );
  const erroring = box(-16.93, 145.78);
  // ArcGIS reports its own failures with HTTP 200 and an `error` body.
  assert.equal(
    await withFetch(
      () => ({ ok: true, headers: { get: () => 'text/plain' }, json: async () => ({ error: { message: 'Token Required' } }) }),
      () => QLD_LIDAR.covers(erroring),
    ),
    false,
  );
});

test('QLD: outside the service extent costs no network at all', async () => {
  // `covers` runs for every project in the country, so a Victorian or a New
  // Zealand site must not pay five round trips to be told no.
  await withFetch(() => { throw new Error('should not be called'); }, async (log) => {
    assert.equal(await QLD_LIDAR.covers(box(-37.81, 144.96)), false);   // Melbourne
    assert.equal(await QLD_LIDAR.covers(box(-41.29, 174.78)), false);   // Wellington
    assert.equal(await QLD_LIDAR.covers(box(-33.87, 151.21)), false);   // Sydney
    assert.equal(log.urls.length, 0);
  });
  // …and the extent really does reach Queensland's corners.
  await withFetch(() => identifyBody(LIDAR), async () => {
    assert.equal(await QLD_LIDAR.covers(box(-10.68, 142.53)), true);    // Cape York
    assert.equal(await QLD_LIDAR.covers(box(-28.55, 148.79)), true);    // Border, west
  });
});

test('QLD: the coverage answer is cached for the session', async () => {
  const bounds = box(-26.62, 153.09);
  await withFetch(() => identifyBody(LIDAR), async (log) => {
    assert.equal(await QLD_LIDAR.covers(bounds), true);
    assert.equal(await QLD_LIDAR.covers(bounds), true);
    assert.equal(log.urls.length, 5, 'the second ask reuses the first answer');
  });
});

// ---------------------------------------------------------------- export

test('QLD: the export is padded by the terrain margin, in both axes', () => {
  const bounds = box(-27.47, 153.02, 2);
  const req = qldExportRequest(bounds, 1);
  const cosLat = Math.cos((-27.47 * Math.PI) / 180);
  const margins = [
    (req.bounds.ne[0] - bounds.ne[0]) * M_PER_DEG,
    (bounds.sw[0] - req.bounds.sw[0]) * M_PER_DEG,
    (req.bounds.ne[1] - bounds.ne[1]) * M_PER_DEG * cosLat,
    (bounds.sw[1] - req.bounds.sw[1]) * M_PER_DEG * cosLat,
  ];
  // `buildTerrainField` pads its heightfield by TERRAIN_MARGIN_M; a raster that
  // stops at the site reads 0 m for that margin and invents a cliff.
  for (const m of margins) assert.ok(Math.abs(m - 500) < 1, `margin ${m.toFixed(1)} m`);
});

test('QLD: the export pitch is the source pitch, floored at 2 m', () => {
  // A 1 m capture over a small site: 2 m is as fine as this ever asks for.
  // 3 km across (2 km + 500 m each side) → ~1500 samples per axis.
  const req = qldExportRequest(box(-27.47, 153.02, 2), 1);
  assert.equal(req.pitchM, 2);
  assert.ok(Math.abs(req.widthPx - 1501) <= 2, `${req.widthPx}`);
  assert.ok(Math.abs(req.heightPx - 1501) <= 2, `${req.heightPx}`);
  // A coarser capture is not upsampled into detail it does not have.
  assert.equal(qldExportRequest(box(-27.47, 153.02, 2), 4.5).pitchM, 4.5);
});

test('QLD: the export never exceeds 2048 px on either axis', () => {
  // A 10 km site on 1 m LiDAR wants 11000 px a side. The cap, not the source,
  // decides — and it must bind on the LONGER axis, or the other one runs over.
  const wide = { sw: [-27.60, 152.90] as [number, number], ne: [-27.50, 153.30] as [number, number] };
  const req = qldExportRequest(wide, 1);
  assert.ok(req.widthPx <= 2048 && req.heightPx <= 2048, `${req.widthPx}×${req.heightPx}`);
  assert.equal(Math.max(req.widthPx, req.heightPx), 2048, 'the long axis uses the whole budget');
  const spanLngM = (req.bounds.ne[1] - req.bounds.sw[1]) * M_PER_DEG
    * Math.cos((-27.55 * Math.PI) / 180);
  assert.ok(Math.abs(req.pitchM - spanLngM / 2048) < 0.01, `${req.pitchM} m`);
});

test('QLD: the export request asks for the float32 TIFF, not a picture', () => {
  const bounds = box(-27.47, 153.02);
  const { url, bounds: padded, widthPx, heightPx } = qldExportRequest(bounds, 1);
  const q = new URL(url).searchParams;
  // bbox is xmin,ymin,xmax,ymax — LON first. Swapped, the request lands in the
  // Indian Ocean and the service answers with a blank raster, not an error.
  assert.deepEqual(
    q.get('bbox')?.split(',').map(Number),
    [padded.sw[1], padded.sw[0], padded.ne[1], padded.ne[0]],
  );
  assert.equal(q.get('bboxSR'), '4326');
  assert.equal(q.get('imageSR'), '4326');
  assert.equal(q.get('size'), `${widthPx},${heightPx}`);
  assert.equal(q.get('format'), 'tiff');
  assert.equal(q.get('pixelType'), 'F32');
  assert.equal(q.get('noData'), '-9999');
  assert.equal(q.get('interpolation'), 'RSP_BilinearInterpolation');
});

// --------------------------------------------------------------- parsing

/// A minimal single-strip float32 GeoTIFF: tie point at the raster's NW corner,
/// `pixelDeg` square cells, EPSG:4326 geokeys.
///
/// Built by hand because geotiff.js's own `writeArrayBuffer` writes one BYTE
/// per sample whatever it is handed (`encodeImage` sizes the strip at
/// width·height·samplesPerPixel), so it cannot produce the float32 raster the
/// QLD service returns.
function floatGeoTiff(
  values: Float32Array,
  width: number,
  height: number,
  west: number,
  north: number,
  pixelDeg: number,
): ArrayBuffer {
  const align = (v: number, n: number) => Math.ceil(v / n) * n;
  const SIZE: Record<number, number> = { 3: 2, 4: 4, 12: 8 };  // SHORT, LONG, DOUBLE
  const STRIP_OFFSETS = 273;
  const entries: Array<[tag: number, type: number, values: number[]]> = [
    [256, 4, [width]],                        // ImageWidth
    [257, 4, [height]],                       // ImageLength
    [258, 3, [32]],                           // BitsPerSample
    [259, 3, [1]],                            // Compression: none
    [262, 3, [1]],                            // PhotometricInterpretation
    [STRIP_OFFSETS, 4, [0]],                  // patched below
    [277, 3, [1]],                            // SamplesPerPixel
    [278, 4, [height]],                       // RowsPerStrip: one strip
    [279, 4, [width * height * 4]],           // StripByteCounts
    [339, 3, [3]],                            // SampleFormat: IEEE float
    [33550, 12, [pixelDeg, pixelDeg, 0]],     // ModelPixelScale
    [33922, 12, [0, 0, 0, west, north, 0]],   // ModelTiepoint
    // GeoKeyDirectory: v1.1.0, 3 keys — geographic model, PixelIsArea, WGS 84.
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]],
  ];

  // Values longer than 4 bytes live after the IFD and are referenced by offset.
  let cursor = align(8 + 2 + entries.length * 12 + 4, 8);
  const offsets = new Map<number, number>();
  for (const [tag, type, vals] of entries) {
    if (SIZE[type] * vals.length <= 4) continue;
    cursor = align(cursor, SIZE[type]);
    offsets.set(tag, cursor);
    cursor += SIZE[type] * vals.length;
  }
  const dataOffset = align(cursor, 4);

  const dv = new DataView(new ArrayBuffer(dataOffset + width * height * 4));
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49);          // "II" — little endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);                            // first IFD
  dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, vals], i) => {
    const o = 10 + i * 12;
    const list = tag === STRIP_OFFSETS ? [dataOffset] : vals;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, list.length, true);
    const inline = SIZE[type] * list.length <= 4;
    const at = inline ? o + 8 : offsets.get(tag)!;
    if (!inline) dv.setUint32(o + 8, at, true);
    list.forEach((v, k) => {
      const p = at + k * SIZE[type];
      if (type === 3) dv.setUint16(p, v, true);
      else if (type === 4) dv.setUint32(p, v, true);
      else dv.setFloat64(p, v, true);
    });
  });
  dv.setUint32(10 + entries.length * 12, 0, true);     // no second IFD
  for (let i = 0; i < values.length; i++) dv.setFloat32(dataOffset + i * 4, values[i], true);
  return dv.buffer;
}

const RAMP_W = 5;
const RAMP_H = 4;
const RAMP_WEST = 153.0;
const RAMP_NORTH = -27.40;
const RAMP_PIXEL_DEG = 0.001;

/// A west→east ramp of 1 m per column, with the NW cell holding the service's
/// no-data sentinel.
function rampTiff(): ArrayBuffer {
  const values = new Float32Array(RAMP_W * RAMP_H);
  for (let j = 0; j < RAMP_H; j++) for (let i = 0; i < RAMP_W; i++) values[j * RAMP_W + i] = i;
  values[0] = -9999;
  return floatGeoTiff(values, RAMP_W, RAMP_H, RAMP_WEST, RAMP_NORTH, RAMP_PIXEL_DEG);
}

test('QLD: the raster is georeferenced from the file, not from the bbox asked for', async () => {
  const dem = await parseDemGeoTiffBuffer(rampTiff(), { noDataValue: -9999 });
  // The parser reads the tie point and pixel scale, so the footprint is the
  // file's own — 5 × 4 cells of 0.001° from (153.0, −27.40).
  assert.deepEqual(dem.bounds.sw, [RAMP_NORTH - RAMP_H * RAMP_PIXEL_DEG, RAMP_WEST]);
  assert.deepEqual(dem.bounds.ne, [RAMP_NORTH, RAMP_WEST + RAMP_W * RAMP_PIXEL_DEG]);
  assert.equal(dem.epsg, 4326);

  // Sampling maps the bbox onto (width − 1) intervals, so a column step is
  // span/(w − 1) = 0.00125°, and the ramp reads back as its column index.
  const step = (RAMP_W * RAMP_PIXEL_DEG) / (RAMP_W - 1);
  const lat = dem.bounds.sw[0];                       // bottom row: no sentinel
  assert.ok(Math.abs(dem.elevation(lat, RAMP_WEST) - 0) < 1e-6);
  assert.ok(Math.abs(dem.elevation(lat, RAMP_WEST + step) - 1) < 1e-6);
  assert.ok(Math.abs(dem.elevation(lat, RAMP_WEST + step * 2.5) - 2.5) < 1e-6);
  assert.equal(dem.elevation(lat, RAMP_WEST + 1), 0, 'outside the raster is 0, as everywhere');

  // −9999 is a hole, not a 10 km pit: it must reach `terrainField` as NaN.
  assert.ok(Number.isNaN(dem.elevation(dem.bounds.ne[0], RAMP_WEST)));

  // Pitch is the finer axis in metres — E-W here, cells being square in degrees.
  const ns = ((RAMP_H * RAMP_PIXEL_DEG) / (RAMP_H - 1)) * M_PER_DEG;
  const ew = step * M_PER_DEG * Math.cos((RAMP_NORTH * Math.PI) / 180);
  assert.ok(Math.abs((dem.resolutionM ?? 0) - Math.min(ew, ns)) < 0.05, `${dem.resolutionM}`);
});

test('QLD: a loaded raster carries the Queensland credit and both pitches', async () => {
  const bounds = box(-27.42, 153.01);
  const dem = await withFetch((url) => (
    url.includes('/identify')
      ? identifyBody(LIDAR)
      : {
        ok: true,
        headers: { get: () => 'image/tiff' },
        arrayBuffer: async () => rampTiff(),
      }
  ), async () => {
    assert.equal(await QLD_LIDAR.covers(bounds), true);
    return QLD_LIDAR.load(bounds);
  });

  assert.equal(dem.source?.id, 'qld-lidar');
  assert.equal(dem.source?.label, QLD_LIDAR_SOURCE.label);
  assert.match(dem.source?.attribution ?? '', /State of Queensland/);
  // `nativePitchM` is what `identify` reported for the capture; `resolutionM`
  // is what the export was actually sampled at. The report line prints both.
  assert.equal(dem.source?.nativePitchM, 1);
  assert.ok((dem.resolutionM ?? 0) > 1);
  // A regular lat/lng grid, so the grid snapshot can copy it wholesale.
  assert.ok(dem.grid, 'a 4326 raster exposes its grid');
});

test('QLD: a loaded raster is cached, and a service error is not', async () => {
  const bounds = box(-27.43, 153.03);
  await withFetch((url) => (
    url.includes('/identify')
      ? identifyBody(LIDAR)
      : { ok: true, headers: { get: () => 'image/tiff' }, arrayBuffer: async () => rampTiff() }
  ), async (log) => {
    await QLD_LIDAR.covers(bounds);
    await QLD_LIDAR.load(bounds);
    const after = log.urls.length;
    await QLD_LIDAR.load(bounds);
    assert.equal(log.urls.length, after, 'the second load is served from cache');
  });

  const failing = box(-27.44, 153.04);
  // A rejected export is HTTP 200, `content-type: image/tiff`, and a JSON error
  // body — so only the bytes tell the truth. Handing that to the TIFF parser
  // would report "Invalid byte order value" and lose the service's message.
  const errorBody = new TextEncoder().encode(
    '{"error":{"code":400,"message":"Unable to complete operation."}}',
  ).buffer;
  await withFetch((url) => (
    url.includes('/identify')
      ? identifyBody(LIDAR)
      : { ok: true, headers: { get: () => 'image/tiff' }, arrayBuffer: async () => errorBody }
  ), async () => {
    await QLD_LIDAR.covers(failing);
    await assert.rejects(() => QLD_LIDAR.load(failing), /Unable to complete operation/);
    // A rejection must not stay cached, or every retry fails instantly from it.
    await assert.rejects(() => QLD_LIDAR.load(failing), /Unable to complete operation/);
  });
});
