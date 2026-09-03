// The QLD source decides, on its own and with no UI, whether a Queensland
// project stands on metre-scale LiDAR or falls through to the 30 m national
// DEM. Both failure modes are silent: claiming coverage it does not have would
// serve SRTM under a LiDAR label, and probing too eagerly would put nine
// network round trips in front of every project in the country.
//
// Nothing here touches the network — `fetch` is replaced for the duration of
// each test, and every test uses its OWN bounds because coverage answers and
// loaded rasters are cached per bounds for the session.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDemGeoTiffBuffer } from '../demUpload';
import { QLD_LIDAR, QLD_LIDAR_SOURCE, qldExportRequest } from './qldLidar';
import {
  RAMP_H, RAMP_NORTH, RAMP_PIXEL_DEG, RAMP_W, RAMP_WEST, rampTiff,
} from '../__fixtures__/geotiff';
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
    // A 3 × 3 lattice: a site half on a capture would otherwise be exported
    // half at 1 m and half at 30 m, with a step between them.
    assert.equal(log.urls.length, 9, 'corners, mid-edges and centre');
    assert.ok(log.urls.every((u) => u.includes('returnCatalogItems=true')));
    return answer;
  });
  assert.equal(covered, true);
});

test('QLD: the probes cover the export margin, and the gaps between corners', async () => {
  const bounds = box(-26.10, 152.55, 2);   // its own box: coverage is cached per bounds
  const padded = qldExportRequest(bounds, 1).bounds;
  await withFetch(() => identifyBody(LIDAR), async (log) => {
    await QLD_LIDAR.covers(bounds);
    const points = log.urls.map(probePoint);
    // The export is padded by 500 m and a probe of the bare site says nothing
    // about that ring — a capture that stops at the fence line would be padded
    // with SRTM and pass a site-only test.
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    for (const corner of [padded.sw, padded.ne]) {
      assert.ok(points.some(([la, ln]) => near(la, corner[0]) && near(ln, corner[1])),
        `padded corner ${corner} probed`);
    }
    // …and the mid-edges, because capture boundaries are survey-block edges: a
    // strip down the middle of a site passes a four-corner test untouched.
    const midLat = (padded.sw[0] + padded.ne[0]) / 2;
    const midLng = (padded.sw[1] + padded.ne[1]) / 2;
    for (const p of [[midLat, padded.sw[1]], [midLat, padded.ne[1]],
      [padded.sw[0], midLng], [padded.ne[0], midLng], [midLat, midLng]]) {
      assert.ok(points.some(([la, ln]) => near(la, p[0]) && near(ln, p[1])), `mid point ${p} probed`);
    }
  });
});

test('QLD: a gap between the corners is not coverage', async () => {
  // LiDAR on every corner, SRTM through the middle — the four-corner test said
  // yes and the export came back with a 30 m band across the site.
  const bounds = box(-24.87, 152.35, 6);
  const midLat = (bounds.sw[0] + bounds.ne[0]) / 2;
  const covered = await withFetch((url) => {
    const [lat] = probePoint(url);
    return identifyBody(Math.abs(lat - midLat) < 1e-6 ? SRTM : LIDAR);
  }, () => QLD_LIDAR.covers(bounds));
  assert.equal(covered, false);
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

test('QLD: catalog attributes are read whatever case the service spells them', async () => {
  // ArcGIS reports mosaic fields in the case the mosaic defines them. Read
  // case-sensitively, a `LowPS` parses as NaN and a `Name` reads as '' — the
  // first is indistinguishable from "no LiDAR here" and would drop every
  // Queensland project to DEM-S, the second lets an SRTM tile through as LiDAR.
  const raw = (attributes: Record<string, unknown>) => () => ({
    ok: true,
    headers: { get: () => 'text/plain' },
    json: async () => ({ catalogItems: { features: [{ attributes }] } }),
  });
  assert.equal(
    await withFetch(raw({ Name: 'Mackay_2021_LGA_DTM_1m', LowPS: 1 }),
      () => QLD_LIDAR.covers(box(-21.14, 149.19))),
    true,
  );
  assert.equal(
    await withFetch(raw({ NAME: 'QLD_SRTM_1SEC_DEM_H_V2', LOWPS: 30.92 }),
      () => QLD_LIDAR.covers(box(-21.15, 149.20))),
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
    assert.equal(log.urls.length, 9, 'the second ask reuses the first answer');
  });
});

test('QLD: a failed probe is not cached as "no coverage"', async () => {
  // "The service did not answer" is not the same answer as "there is no LiDAR
  // here". Cached as one, a single dropped `identify` pinned the project to
  // 30 m DEM-S for the life of the tab, with nothing on screen to say why.
  const bounds = box(-25.54, 152.70);
  assert.equal(
    await withFetch(() => { throw new Error('ECONNRESET'); }, () => QLD_LIDAR.covers(bounds)),
    false,
    'the load that hit the outage still falls through to DEM-S',
  );
  await withFetch(() => identifyBody(LIDAR), async (log) => {
    assert.equal(await QLD_LIDAR.covers(bounds), true, 'the next load probes again');
    assert.equal(log.urls.length, 9);
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

test('QLD: the raster is georeferenced from the file, not from the bbox asked for', async () => {
  const dem = await parseDemGeoTiffBuffer(rampTiff(), { noDataValue: -9999 });
  // The parser reads the tie point and pixel scale, so the footprint is the
  // file's own — 5 × 4 cells of 0.001° from (153.0, −27.40) — bounded by the
  // outer cells' CENTRES, half a pixel inside the file's bbox.
  const near = (a: [number, number], b: [number, number], what: string) => {
    assert.ok(Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12,
      `${what}: ${a} vs ${b}`);
  };
  near(dem.bounds.sw,
    [RAMP_NORTH - (RAMP_H - 0.5) * RAMP_PIXEL_DEG, RAMP_WEST + 0.5 * RAMP_PIXEL_DEG], 'sw');
  near(dem.bounds.ne,
    [RAMP_NORTH - 0.5 * RAMP_PIXEL_DEG, RAMP_WEST + (RAMP_W - 0.5) * RAMP_PIXEL_DEG], 'ne');
  assert.equal(dem.epsg, 4326);

  // PixelIsArea: the bbox names the outer edges, so cell centres sit half a
  // pixel inside it and a column step is the pixel scale itself. The ramp reads
  // back as its column index at those centres.
  const centre = RAMP_WEST + RAMP_PIXEL_DEG / 2;
  const lat = dem.bounds.sw[0];                       // bottom row: no sentinel
  assert.ok(Math.abs(dem.elevation(lat, centre) - 0) < 1e-6);
  assert.ok(Math.abs(dem.elevation(lat, centre + RAMP_PIXEL_DEG) - 1) < 1e-6);
  assert.ok(Math.abs(dem.elevation(lat, centre + RAMP_PIXEL_DEG * 2.5) - 2.5) < 1e-6);
  assert.equal(dem.elevation(lat, RAMP_WEST + 1), 0, 'outside the raster is 0, as everywhere');

  // −9999 is a hole, not a 10 km pit: it must reach `terrainField` as NaN.
  assert.ok(Number.isNaN(dem.elevation(dem.bounds.ne[0], dem.bounds.sw[1])), 'the NW cell');

  // Pitch is the finer axis in metres — E-W here, cells being square in degrees.
  const ns = RAMP_PIXEL_DEG * M_PER_DEG;
  const ew = ns * Math.cos((RAMP_NORTH * Math.PI) / 180);
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
  ), async (log) => {
    await QLD_LIDAR.covers(failing);
    const before = log.urls.length;
    await assert.rejects(() => QLD_LIDAR.load(failing), /Unable to complete operation/);
    assert.equal(
      log.urls.filter((u) => u.includes('/exportImage')).length, 3,
      'three attempts before the cascade is allowed to fall through',
    );
    assert.ok(log.urls.length > before);
    // A rejection must not stay cached, or every retry fails instantly from it.
    await assert.rejects(() => QLD_LIDAR.load(failing), /Unable to complete operation/);
  });
});

test('QLD: a transient export failure is retried, not dropped to DEM-S', async () => {
  // The service answers a third to a half of `exportImage` calls with HTTP 200,
  // `image/tiff`, and "General function failure" in the body. Falling straight
  // through on that put the SAME project on 1 m LiDAR one session and 30 m SRTM
  // the next, with nothing on screen to say which.
  const bounds = box(-27.45, 153.05);
  const busy = new TextEncoder().encode('General function failure.').buffer;
  let exports = 0;
  const dem = await withFetch((url) => {
    if (url.includes('/identify')) return identifyBody(LIDAR);
    exports++;
    if (exports === 1) throw new Error('ECONNRESET');
    return {
      ok: true,
      headers: { get: () => 'image/tiff' },
      arrayBuffer: async () => (exports === 2 ? busy : rampTiff()),
    };
  }, async () => {
    assert.equal(await QLD_LIDAR.covers(bounds), true);
    return QLD_LIDAR.load(bounds);
  });
  assert.equal(exports, 3, 'a dropped connection and a busy answer both retried');
  assert.equal(dem.source?.id, 'qld-lidar', 'the third attempt is the raster the project uses');
});

test('QLD: a deterministic 4xx is not retried', async () => {
  // The request is the same URL every time, so a verdict on it is final —
  // repeating it only makes the fall through to DEM-S two seconds slower.
  const bounds = box(-27.46, 153.09);
  let exports = 0;
  await withFetch((url) => {
    if (url.includes('/identify')) return identifyBody(LIDAR);
    exports++;
    return { ok: false, status: 400, headers: { get: () => 'text/plain' } };
  }, async () => {
    assert.equal(await QLD_LIDAR.covers(bounds), true);
    await assert.rejects(() => QLD_LIDAR.load(bounds), /HTTP 400/);
  });
  assert.equal(exports, 1, 'one attempt, not three');
});

test('QLD: a 429 is the service asking us to wait, so it IS retried', async () => {
  const bounds = box(-27.43, 153.11);
  let exports = 0;
  const dem = await withFetch((url) => {
    if (url.includes('/identify')) return identifyBody(LIDAR);
    exports++;
    if (exports === 1) return { ok: false, status: 429, headers: { get: () => 'text/plain' } };
    return { ok: true, headers: { get: () => 'image/tiff' }, arrayBuffer: async () => rampTiff() };
  }, async () => {
    assert.equal(await QLD_LIDAR.covers(bounds), true);
    return QLD_LIDAR.load(bounds);
  });
  assert.equal(exports, 2, 'the second attempt is the one that lands');
  assert.equal(dem.source?.id, 'qld-lidar');
});
