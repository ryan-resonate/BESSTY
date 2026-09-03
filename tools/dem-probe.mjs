// Live probe for the automatic DEM sources. Network; deliberately NOT part of
// `npm test` — a unit suite that fails when an S3 bucket hiccups is a suite
// people learn to ignore.
//
//   node tools/dem-probe.mjs [lat] [lng] [spanKm]
//
// Leg 1 — GA DEM-S: pixel window, elevation statistics and the two timings that
// matter: the one-off COG header read, and the per-project window read the user
// actually waits for (gate: < 2 s for a ~6 km window).
//
// Leg 2 — QLD LiDAR: coverage must be REFUSED at Tarong (the mosaic serves SRTM
// there, which is worse than DEM-S) and taken over Brisbane, plus the cost of
// the main-thread work a 10 km site at metre pitch actually pays —
// `buildTerrainField` and the grid worker's `captureDemRegion` snapshot.

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const require = createRequire(join(webRoot, 'package.json'));
const { build } = require('esbuild');

const [, , latArg, lngArg, spanArg] = process.argv;
const lat = Number(latArg ?? -26.78);      // Tarong
const lng = Number(lngArg ?? 151.90);
const spanKm = Number(spanArg ?? 5);       // + the 500 m terrain margin each side

const M_PER_DEG = (Math.PI / 180) * 6371008.8;
const half = (spanKm * 1000) / 2;
const dLat = half / M_PER_DEG;
const dLng = half / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
const bounds = { sw: [lat - dLat, lng - dLng], ne: [lat + dLat, lng + dLng] };
// A second window far enough away (1°, ~111 km) to miss every 512² COG block
// the first one pulled: with the handle already open, its read time is the
// per-project window read alone.
const shifted = {
  sw: [bounds.sw[0] + 1, bounds.sw[1] + 1],
  ne: [bounds.ne[0] + 1, bounds.ne[1] + 1],
};

const outdir = mkdtempSync(join(tmpdir(), 'beesty-dem-probe-'));
try {
  await build({
    entryPoints: [
      join(webRoot, 'src', 'lib', 'demSources', 'gaDemS.ts'),
      join(webRoot, 'src', 'lib', 'demSources', 'qldLidar.ts'),
      join(webRoot, 'src', 'lib', 'dem.ts'),
      join(webRoot, 'src', 'lib', 'terrainField.ts'),
    ],
    outdir,
    // Entry-point paths are mirrored under `outdir` relative to this, so the
    // two source adapters land in `demSources/`.
    outbase: join(webRoot, 'src', 'lib'),
    bundle: true,
    // One copy of every shared module, so `buildTerrainField` and
    // `captureDemRegion` are the same code the app runs, not four private
    // copies of it.
    splitting: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['node:*'],
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  });
  const load = (name) => import(pathToFileURL(join(outdir, name)).href);
  const { GA_DEM_S, demSPixelWindow } = await load('demSources/gaDemS.mjs');
  const { QLD_LIDAR, qldExportRequest } = await load('demSources/qldLidar.mjs');
  const { captureDemRegion } = await load('dem.mjs');
  const { buildTerrainField } = await load('terrainField.mjs');

  console.log(`DEM-S probe — ${lat.toFixed(4)}, ${lng.toFixed(4)}, ${spanKm} km box`);
  console.log(`  covers: ${await GA_DEM_S.covers(bounds)}`);
  const win = demSPixelWindow(bounds);
  console.log(`  window: ${win.nx} × ${win.ny} px at (${win.x0}, ${win.y0})`
    + `  = ${(win.nx * win.ny * 4 / 1024 / 1024).toFixed(2)} MB float32`);

  const t0 = performance.now();
  const cold = await GA_DEM_S.load(bounds);
  const t1 = performance.now();
  await GA_DEM_S.load(shifted);
  const t2 = performance.now();

  const stats = sample(cold, win.nx, win.ny);
  console.log(`  z: ${stats.min.toFixed(1)} … ${stats.max.toFixed(1)} m `
    + `(mean ${stats.mean.toFixed(1)}), ${stats.nan} NaN of ${stats.n} samples`);
  console.log(`  pitch: ${cold.resolutionM.toFixed(2)} m  (source: ${cold.source.label})`);
  console.log(`  header + first window: ${(t1 - t0).toFixed(0)} ms`);
  console.log(`  window read (warm handle): ${(t2 - t1).toFixed(0)} ms`
    + `   ${t2 - t1 < 2000 ? 'PASS' : 'FAIL'} (< 2000 ms)`);
  const demSPass = t2 - t1 < 2000;

  // ---------------------------------------------------------- QLD LiDAR leg
  console.log('\nQLD LiDAR probe');
  // Tarong is inside the service extent but the mosaic serves SRTM there, so
  // this source must decline it and let DEM-S answer.
  const tarong = boxAround(-26.78, 151.90, 5);
  const tq0 = performance.now();
  const tarongCovers = await QLD_LIDAR.covers(tarong);
  console.log(`  Tarong (SRTM area): covers=${tarongCovers} `
    + `in ${(performance.now() - tq0).toFixed(0)} ms   `
    + `${tarongCovers === false ? 'PASS' : 'FAIL'} (must fall through to DEM-S)`);

  // Brisbane is flown at 1 m; this is the case the whole source exists for.
  const brisbane = boxAround(-27.47, 153.02, 10);
  const bq0 = performance.now();
  const brisbaneCovers = await QLD_LIDAR.covers(brisbane);
  const bq1 = performance.now();
  console.log(`  Brisbane CBD, 10 km box: covers=${brisbaneCovers} `
    + `in ${(bq1 - bq0).toFixed(0)} ms (5 identify calls)   `
    + `${brisbaneCovers === true ? 'PASS' : 'FAIL'} (must be used)`);

  let qldPass = tarongCovers === false && brisbaneCovers === true;
  // The service rejects a share of exports under load ("General function
  // failure", returned as HTTP 200 with a JSON body labelled image/tiff), so a
  // failed export here is a service observation, not a broken adapter — the
  // cascade falls through to DEM-S exactly as it should. Report it and finish.
  const dem = brisbaneCovers ? await QLD_LIDAR.load(brisbane).catch((e) => e) : null;
  if (dem instanceof Error) {
    console.log(`  export: REFUSED by the service — ${dem.message.slice(0, 160)}`);
  } else if (dem) {
    const bq2 = performance.now();
    const req = qldExportRequest(brisbane, dem.source.nativePitchM);
    console.log(`  export: ${req.widthPx} × ${req.heightPx} px at ${req.pitchM.toFixed(2)} m `
      + `= ${((req.widthPx * req.heightPx * 4) / 1024 / 1024).toFixed(1)} MB float32, `
      + `${(bq2 - bq1).toFixed(0)} ms`);
    console.log(`  pitch: ${dem.source.nativePitchM.toFixed(2)} m native, `
      + `${dem.resolutionM.toFixed(2)} m sampled  (${dem.source.label})`);
    const s = sample(dem, 256, 256);
    console.log(`  z: ${s.min.toFixed(1)} … ${s.max.toFixed(1)} m `
      + `(mean ${s.mean.toFixed(1)}), ${s.nan} NaN of ${s.n} samples`);

    // The main-thread bill for a 10 km site at metre pitch. Both of these run
    // on the UI thread before any worker starts, so this is what a QLD project
    // freezes for.
    const origin = [-27.47, 153.02];
    const corners = [
      [brisbane.sw[0], brisbane.sw[1]], [brisbane.sw[0], brisbane.ne[1]],
      [brisbane.ne[0], brisbane.sw[1]], [brisbane.ne[0], brisbane.ne[1]],
    ];
    const f0 = performance.now();
    const field = buildTerrainField(dem, origin, corners, { spacingM: 5 });
    const f1 = performance.now();
    console.log(`  buildTerrainField (10 km box @ 5 m): ${(f1 - f0).toFixed(0)} ms `
      + `→ ${field.nx} × ${field.ny} @ ${field.spacing.toFixed(2)} m`);

    const c0 = performance.now();
    captureDemRegion(dem, brisbane.sw, brisbane.ne, 2048, 2048);
    const c1 = performance.now();
    // …and what it would have cost without the typed-array fast path, which is
    // the whole reason `DemRaster.grid()` exists.
    captureDemRegion({ ...dem, grid: undefined }, brisbane.sw, brisbane.ne, 2048, 2048);
    const c2 = performance.now();
    console.log(`  captureDemRegion 2048²: ${(c1 - c0).toFixed(0)} ms fast path, `
      + `${(c2 - c1).toFixed(0)} ms via elevation()`);
    const mainThreadMs = (f1 - f0) + (c1 - c0);
    console.log(`  main-thread total: ${mainThreadMs.toFixed(0)} ms   `
      + `${mainThreadMs < 1000 ? 'PASS' : 'OVER BUDGET'} (< 1000 ms)`);
    qldPass = qldPass && field != null;
  }

  process.exit(demSPass && qldPass ? 0 : 1);
} finally {
  rmSync(outdir, { recursive: true, force: true });
}

/// A lat/lng box `spanKm` across, centred on a point.
function boxAround(lat, lng, spanKm) {
  const h = (spanKm * 1000) / 2;
  const dLa = h / M_PER_DEG;
  const dLn = h / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return { sw: [lat - dLa, lng - dLn], ne: [lat + dLa, lng + dLn] };
}

/// Elevation statistics over the raster, sampled at its own pitch.
function sample(dem, nx, ny) {
  const { sw, ne } = dem.bounds;
  let min = Infinity; let max = -Infinity; let sum = 0; let nan = 0; let n = 0;
  for (let j = 0; j < ny; j++) {
    const la = ne[0] + ((sw[0] - ne[0]) * j) / (ny - 1);
    for (let i = 0; i < nx; i++) {
      const ln = sw[1] + ((ne[1] - sw[1]) * i) / (nx - 1);
      const z = dem.elevation(la, ln);
      n++;
      if (!Number.isFinite(z)) { nan++; continue; }
      if (z < min) min = z;
      if (z > max) max = z;
      sum += z;
    }
  }
  return { min, max, mean: sum / Math.max(1, n - nan), nan, n };
}
