// Minimal TS test runner: esbuild-bundles every `src/**/*.test.ts` to ESM in a
// temp dir, then hands them to node's built-in test runner.
//
// Deliberately dependency-free — esbuild already ships with vite, and node 20's
// `node:test` needs no framework. Run with `npm test`.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Recursively collect `*.test.ts` under `dir`. */
function findTests(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findTests(p));
    else if (name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const entryPoints = findTests(join(root, 'src'));
if (entryPoints.length === 0) {
  console.log('no *.test.ts files found');
  process.exit(0);
}
console.log(`bundling ${entryPoints.length} test file(s):`);
for (const e of entryPoints) console.log('  ' + relative(root, e));

const outdir = mkdtempSync(join(tmpdir(), 'beesty-tests-'));
try {
  await build({
    entryPoints,
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: 'inline',
    // The temp dir has no package.json, so node would treat a bare `.js` as
    // CommonJS and choke on the ESM output.
    outExtension: { '.js': '.mjs' },
    // Node builtins and the generated wasm glue stay external — pure-logic
    // modules under test must not pull the wasm binary into the bundle.
    external: ['node:*', '*.wasm'],
    logLevel: 'warning',
  });
  // Bundled tests run from a temp dir, so `import.meta.url` no longer points at
  // the repo — hand any test that needs the built wasm an absolute path.
  const res = spawnSync(process.execPath, ['--test', outdir], {
    stdio: 'inherit',
    env: { ...process.env, BEESTY_WASM_PATH: join(root, 'src', 'wasm', 'iso9613_wasm_bg.wasm') },
  });
  process.exit(res.status ?? 1);
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
