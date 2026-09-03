// V2 against three elevation sources — the Phase 1 gate for `demSources/`.
//
//   node validation/run_v2_dem.mjs
//
// `run_v2.mjs` / `run_validation.mjs` replay terrain barriers RECORDED from the
// old app, so they compare engines and cannot compare DEMs: the elevations are
// baked into the JSON. This script rebuilds the V2 case from its source data —
// the shapefiles, the SoundPLAN reference, the recorded source spectrum — and
// solves it three times through the SHIPPING pipeline (`buildTerrainField` →
// `buildScene` → `solve_scene`), swapping only the DEM underneath:
//
//   (a) the uploaded Vicmap 10 m GeoTIFF (validation/V2/DEM.tif)
//   (b) GA SRTM 1s DEM-S       — the new national default
//   (c) AWS Terrain Tiles       — what DEM-S replaces
//
// Gate: (b) inside the V2 limits (all |Δ| ≤ 3 dB, mean ≤ 1.4, worst ≤ 3.8) and
// its mean absolute delta no worse than (c).
//
// Because the whole pipeline is rebuilt here, the absolute numbers are NOT
// comparable to `run_validation.mjs`'s parity variant — that one hands the
// engine 100 m barrier stubs, this one hands it a heightfield.

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import initWasm, { solve_scene } from '../web/src/wasm/iso9613_wasm.js';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const v2Dir = fileURLToPath(new URL('./V2/', import.meta.url));
const require = createRequire(join(webRoot, 'package.json'));

await initWasm({
  module_or_path: readFileSync(new URL('../web/src/wasm/iso9613_wasm_bg.wasm', import.meta.url)),
});

// ------------------------------------------------------------------ constants

const AW = [-56.7, -39.4, -26.2, -16.1, -8.6, -3.2, 0, 1.2, 1, -1.1];
const SRC_HAGL = 1.5;
const RX_HAGL = 1.5;
const SETTINGS = {
  standard: 'iso9613-2:2024',
  defaultG: 0.5,
  atmosphere: { temperatureC: 10, relativeHumidityPct: 70, pressureKpa: 101.325 },
  dzCapDb: null,
  c0Db: 0,
};
const V2_REF = {
  R1: 6.9, R2: -8.9, R3: -0.8, R4: 1.7, R5: 15.6, R6: -2.6, R7: 10,
  R8: 8.6, R9: 9.2, R10: 13.8, R11: 5.3, R12: 15.8, R13: -5.9,
};
const LW = JSON.parse(readFileSync(new URL('./v2_calls.json', import.meta.url))).lw;

const dba = (bands) => {
  let s = 0;
  for (let i = 0; i < bands.length; i++) if (Number.isFinite(bands[i])) s += 10 ** ((bands[i] + AW[i]) / 10);
  return s > 0 ? 10 * Math.log10(s) : -Infinity;
};
const energySum = (perSource) => {
  const acc = new Float64Array(10);
  for (const { bands } of perSource) {
    for (let i = 0; i < 10; i++) if (Number.isFinite(bands[i])) acc[i] += 10 ** (bands[i] / 10);
  }
  return Array.from(acc, (e) => (e > 0 ? 10 * Math.log10(e) : -Infinity));
};

// ------------------------------------------------ node shims for the browser bits

// `dem.ts` decodes terrarium PNGs with createImageBitmap + OffscreenCanvas,
// which node has neither of. Shimming them here runs the SHIPPING decoder
// rather than a re-implementation of it. `fast-png` is pulled in by jspdf, so
// it needs no new dependency; leg (c) is skipped if it ever stops being there.
let pngDecode = null;
try {
  // The CommonJS build: `lib-esm/` is ESM source in a package with no
  // `"type": "module"`, so node parses it as CJS and chokes.
  const png = await import(
    pathToFileURL(join(webRoot, 'node_modules', 'fast-png', 'lib', 'index.js')).href
  );
  pngDecode = png.decode ?? png.default?.decode ?? null;
} catch { /* reported below */ }
if (!pngDecode) console.warn('fast-png not resolvable — leg (c) AWS Terrain Tiles will be skipped.');

globalThis.createImageBitmap = async (blob) => {
  const png = pngDecode(new Uint8Array(await blob.arrayBuffer()));
  if (png.channels === 4) return { data: png.data, width: png.width, height: png.height };
  const rgba = new Uint8ClampedArray(png.width * png.height * 4);
  for (let i = 0; i < png.width * png.height; i++) {
    rgba[i * 4] = png.data[i * png.channels];
    rgba[i * 4 + 1] = png.data[i * png.channels + 1];
    rgba[i * 4 + 2] = png.data[i * png.channels + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { data: rgba, width: png.width, height: png.height };
};
globalThis.OffscreenCanvas = class {
  getContext() {
    let img = null;
    return { drawImage: (i) => { img = i; }, getImageData: () => ({ data: img.data }) };
  }
};

// --------------------------------------------------------------- app modules

const outdir = mkdtempSync(join(tmpdir(), 'beesty-v2-dem-'));
const { build } = require('esbuild');
await build({
  stdin: {
    contents: `
      export { buildTerrainField } from './terrainField';
      export { buildScene } from './sceneBuilder';
      export { parseDemGeoTiff } from './demUpload';
      export { loadDemForBounds } from './dem';
      export { GA_DEM_S } from './demSources/gaDemS';
    `,
    resolveDir: join(webRoot, 'src', 'lib'),
    loader: 'ts',
  },
  outfile: join(outdir, 'app.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['node:*', '*.wasm'],
  logLevel: 'warning',
});
const { buildTerrainField, buildScene, parseDemGeoTiff, loadDemForBounds, GA_DEM_S } =
  await import(pathToFileURL(join(outdir, 'app.mjs')).href);

// ------------------------------------------------------------------ geometry

globalThis.self = globalThis;      // shpjs reaches for it at module scope
const shp = (await import(
  pathToFileURL(join(webRoot, 'node_modules', 'shpjs', 'lib', 'index.js')).href
)).default;

async function points(zip) {
  const buf = readFileSync(join(v2Dir, zip));
  const gj = await shp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const fc = Array.isArray(gj) ? gj[0] : gj;
  return fc.features.map((f) => ({
    id: String(f.properties.ID_1),
    latLng: [f.geometry.coordinates[1], f.geometry.coordinates[0]],
  }));
}

const srcPts = await points('Source.zip');
const rxPts = await points('Receivers.zip');
const allLatLng = [...srcPts, ...rxPts].map((p) => p.latLng);
const origin = srcPts[0].latLng;

let minLat = Infinity; let minLng = Infinity; let maxLat = -Infinity; let maxLng = -Infinity;
for (const [la, ln] of allLatLng) {
  minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
  minLng = Math.min(minLng, ln); maxLng = Math.max(maxLng, ln);
}
const bounds = { sw: [minLat, minLng], ne: [maxLat, maxLng] };

// --------------------------------------------------------------------- legs

async function uploadedDem() {
  const buf = readFileSync(join(v2Dir, 'DEM.tif'));
  return parseDemGeoTiff(new File([buf], 'DEM.tif'));
}

const LEGS = [
  { key: 'a', label: 'uploaded Vicmap 10 m GeoTIFF', load: uploadedDem },
  { key: 'b', label: 'GA SRTM 1s DEM-S', load: () => GA_DEM_S.load(bounds) },
  { key: 'c', label: 'AWS Terrain Tiles', load: () => loadDemForBounds(bounds.sw, bounds.ne) },
];

function solveWith(dem) {
  const terrain = buildTerrainField(dem, origin, allLatLng, { despikeStrength: 'off' });
  const scene = buildScene({
    origin,
    sources: srcPts.map((s) => ({ id: s.id, latLng: s.latLng, heightAglM: SRC_HAGL, lw: LW })),
    receivers: rxPts.map((r) => ({ id: r.id, latLng: r.latLng, heightAboveGroundM: RX_HAGL })),
    barriers: [],
    dem,
    terrain,
    settings: SETTINGS,
  });
  const out = JSON.parse(solve_scene(JSON.stringify(scene)));
  const byId = new Map(out.per_receiver.map((r) => [r.receiver_id, r]));
  const levels = {};
  for (const r of rxPts) levels[r.id] = dba(energySum(byId.get(r.id).per_source));
  return { levels, terrain };
}

const results = [];
for (const leg of LEGS) {
  let dem;
  const t0 = performance.now();
  try {
    dem = await leg.load();
  } catch (err) {
    console.warn(`leg (${leg.key}) ${leg.label} unavailable: ${err.message}`);
    continue;
  }
  const tLoad = performance.now() - t0;
  const t1 = performance.now();
  const { levels, terrain } = solveWith(dem);
  results.push({
    ...leg, levels, tLoadMs: tLoad, tSolveMs: performance.now() - t1,
    pitchM: terrain.spacing, nx: terrain.nx, ny: terrain.ny,
    nativePitchM: dem.source?.nativePitchM ?? null,
    resolutionM: dem.resolutionM ?? null,
  });
}

// -------------------------------------------------------------------- report

const stats = (levels) => {
  const d = rxPts.map((r) => Math.abs(V2_REF[r.id] - levels[r.id]));
  return { mean: d.reduce((a, b) => a + b, 0) / d.length, worst: Math.max(...d) };
};

console.log('V2 — same case, same engine, three DEMs. Deltas are BEESTY − SoundPLAN.\n');
console.log(`Rx    SoundPLAN${results.map((r) => `   (${r.key}) level     Δ`).join('')}`);
for (const r of rxPts) {
  let line = `${r.id.padEnd(5)}${V2_REF[r.id].toFixed(1).padStart(9)}`;
  for (const leg of results) {
    line += `${leg.levels[r.id].toFixed(2).padStart(13)}${(leg.levels[r.id] - V2_REF[r.id]).toFixed(2).padStart(7)}`;
  }
  console.log(line);
}

console.log('');
for (const leg of results) {
  const s = stats(leg.levels);
  console.log(
    `(${leg.key}) ${leg.label.padEnd(30)} mean|Δ| ${s.mean.toFixed(2)}  worst|Δ| ${s.worst.toFixed(2)}`
    + `  · raster ${leg.pitchM.toFixed(1)} m ${leg.nx}×${leg.ny}`
    + ` (native ${leg.nativePitchM == null ? '?' : leg.nativePitchM.toFixed(1)} m)`
    + `  · load ${leg.tLoadMs.toFixed(0)} ms, solve ${leg.tSolveMs.toFixed(0)} ms`,
  );
}

const b = results.find((r) => r.key === 'b');
const c = results.find((r) => r.key === 'c');
if (b) {
  const sb = stats(b.levels);
  const gates = [
    ['(b) every receiver within ±3 dB', sb.worst <= 3.0],
    ['(b) mean |Δ| ≤ 1.4 dB', sb.mean <= 1.4],
    ['(b) worst |Δ| ≤ 3.8 dB', sb.worst <= 3.8],
  ];
  if (c) gates.push(['(b) mean |Δ| no worse than (c)', sb.mean <= stats(c.levels).mean + 0.005]);
  console.log('\nGATES');
  let failed = 0;
  for (const [label, ok] of gates) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed++;
  }
  console.log(failed ? `\n${failed} gate(s) FAILED` : '\nall gates pass');
  rmSync(outdir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
rmSync(outdir, { recursive: true, force: true });
