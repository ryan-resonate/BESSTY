// Tarong WF example project, solved twice: AWS Terrain Tiles vs GA DEM-S.
//
//   node validation/run_tarong_dem.mjs
//
// Documentation, not a gate. There is no SoundPLAN reference for this project,
// so what it measures is how much the DEM swap MOVES a real 97-turbine site —
// the number Ryan needs to know before existing projects switch silently
// (decision 6 of docs/beesty-dem-source-plan.md).
//
// Runs the shipping `evaluateProject`, not a re-implementation: the only thing
// that differs between the two passes is the `DemRaster` handed in.

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const require = createRequire(join(webRoot, 'package.json'));
const { build } = require('esbuild');

// `dem.ts` decodes terrarium PNGs in the browser; see run_v2_dem.mjs.
const { decode: pngDecode } = await import(
  pathToFileURL(join(webRoot, 'node_modules', 'fast-png', 'lib', 'index.js')).href
);
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

const outdir = mkdtempSync(join(tmpdir(), 'beesty-tarong-dem-'));
await build({
  stdin: {
    contents: `
      export { evaluateProject } from './solver';
      export { makeTarongWfProject } from './demoProject';
      export { Diagnostics } from './diagnostics';
      export { SEED_CATALOG } from './seedCatalog';
      export { calcAreaCorners } from './geo';
      export { loadDemForBounds } from './dem';
      export { GA_DEM_S } from './demSources/gaDemS';
      export { clearTerrainFieldCache } from './terrainField';
      export { default as initWasm } from '../wasm/iso9613_wasm.js';
    `,
    resolveDir: join(webRoot, 'src', 'lib'),
    loader: 'ts',
  },
  outfile: join(outdir, 'app.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['node:*', '*.wasm', 'highs'],
  define: { 'import.meta.env': '{}' },
  plugins: [{
    // Same stub the unit-test runner uses: the Firebase SDK is CommonJS that
    // requires node builtins at load time, and nothing here wants a network.
    name: 'firebase-stub',
    setup(b) {
      b.onResolve({ filter: /^firebase(\/|$)/ }, () => ({
        path: join(webRoot, 'scripts', 'firebase-test-stub.mjs'),
      }));
    },
  }],
  logLevel: 'warning',
});

const app = await import(pathToFileURL(join(outdir, 'app.mjs')).href);
await app.initWasm({
  module_or_path: readFileSync(join(webRoot, 'src', 'wasm', 'iso9613_wasm_bg.wasm')),
});

// The global catalog lives behind a Firestore subscription. Moving the one
// entry this project references onto the project itself resolves it locally —
// `lookupEntry` short-circuits before it ever reaches Firebase.
const base = app.makeTarongWfProject();
const entry = app.SEED_CATALOG.find((e) => e.id === base.sources[0].modelId);
if (!entry) throw new Error(`seed catalog has no ${base.sources[0].modelId}`);
const project = {
  ...base,
  localCatalog: [entry],
  sources: base.sources.map((s) => ({ ...s, catalogScope: 'local' })),
};

const corners = app.calcAreaCorners(project.calculationArea);
const lats = corners.map((c) => c[0]);
const lngs = corners.map((c) => c[1]);
const sw = [Math.min(...lats), Math.min(...lngs)];
const ne = [Math.max(...lats), Math.max(...lngs)];

const LEGS = [
  { key: 'terrarium', label: 'AWS Terrain Tiles', load: () => app.loadDemForBounds(sw, ne) },
  { key: 'dem-s', label: 'GA SRTM 1s DEM-S', load: () => app.GA_DEM_S.load({ sw, ne }) },
];

const runs = [];
for (const leg of LEGS) {
  const t0 = performance.now();
  const dem = await leg.load();
  const tLoad = performance.now() - t0;
  app.clearTerrainFieldCache();
  const diag = new app.Diagnostics();
  const t1 = performance.now();
  // `evaluateProject` returns the terrain record ITS OWN build produced, rather
  // than leaving the caller to read `lastTerrainBuild` back: the contour grid
  // builds last, over a different extent, and would otherwise be what we quote.
  const solve = await app.evaluateProject(project, dem, diag);
  const tSolve = performance.now() - t1;
  runs.push({
    ...leg,
    tLoadMs: tLoad,
    tSolveMs: tSolve,
    pitchM: solve.terrain?.pitchM ?? null,
    suspectCount: solve.terrain?.count ?? 0,
    suspectMaxDevM: solve.terrain?.maxDevM ?? 0,
    nativePitchM: dem.source?.nativePitchM ?? null,
    levels: new Map(solve.results.map((r) => [r.receiverId, r.totalDbA])),
    notes: diag.list(),
  });
}

const [terrarium, demS] = runs;
console.log(`Tarong WF — ${project.sources.length} WTG, ${project.receivers.length} receivers, `
  + `night, ${project.scenario.windSpeed} m/s\n`);
console.log('Receiver              Terrarium      DEM-S      Δ');
const deltas = [];
for (const rx of project.receivers) {
  const a = terrarium.levels.get(rx.id);
  const b = demS.levels.get(rx.id);
  if (a == null || b == null) continue;
  deltas.push({ name: rx.name, a, b, d: b - a });
}
for (const r of deltas) {
  console.log(`${r.name.padEnd(20)}${r.a.toFixed(2).padStart(10)}${r.b.toFixed(2).padStart(11)}`
    + `${r.d.toFixed(2).padStart(7)}`);
}
const abs = deltas.map((r) => Math.abs(r.d));
const mean = abs.reduce((x, y) => x + y, 0) / abs.length;
const worst = deltas.reduce((x, y) => (Math.abs(y.d) > Math.abs(x.d) ? y : x));
const bias = deltas.reduce((x, y) => x + y.d, 0) / deltas.length;
console.log(`\nmean |Δ| ${mean.toFixed(2)} dB · mean Δ ${bias >= 0 ? '+' : ''}${bias.toFixed(2)} dB`
  + ` · largest ${worst.d >= 0 ? '+' : ''}${worst.d.toFixed(2)} dB at ${worst.name}`
  + ` · ${abs.filter((v) => v > 1).length} of ${abs.length} move more than 1 dB`);
for (const r of runs) {
  console.log(`  ${r.label.padEnd(20)} raster ${r.pitchM?.toFixed(1)} m `
    + `(native ${r.nativePitchM?.toFixed(1)} m) · DEM ${r.tLoadMs.toFixed(0)} ms, `
    + `solve ${r.tSolveMs.toFixed(0)} ms · QA flagged ${r.suspectCount} cell(s)`
    + (r.suspectCount ? `, worst ${r.suspectMaxDevM.toFixed(1)} m` : ''));
  for (const n of r.notes) console.log(`      [${n.severity}] ${n.code}: ${n.message}`);
}

rmSync(outdir, { recursive: true, force: true });
