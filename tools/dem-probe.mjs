// Live probe for the GA DEM-S adapter. Network; deliberately NOT part of
// `npm test` — a unit suite that fails when an S3 bucket hiccups is a suite
// people learn to ignore.
//
//   node tools/dem-probe.mjs [lat] [lng] [spanKm]
//
// Prints the pixel window, elevation statistics and the two timings that
// matter: the one-off COG header read, and the per-project window read the
// user actually waits for (gate: < 2 s for a ~6 km window).

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
    entryPoints: [join(webRoot, 'src', 'lib', 'demSources', 'gaDemS.ts')],
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['node:*'],
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  });
  const { GA_DEM_S, demSPixelWindow } = await import(
    pathToFileURL(join(outdir, 'gaDemS.mjs')).href
  );

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
  process.exit(t2 - t1 < 2000 ? 0 : 1);
} finally {
  rmSync(outdir, { recursive: true, force: true });
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
