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

/// Swap the Firebase SDK for a stub while bundling tests.
///
/// The real SDK is CommonJS that requires node builtins at load time, so the
/// ESM output throws `Dynamic require of "process"` as soon as a test
/// transitively imports `lib/catalog` — which is most of the app. Nothing under
/// test wants a real Firebase; the stub throws only if something CALLS it, so a
/// test that genuinely reached the network would still fail loudly.
const firebaseStub = {
  name: 'firebase-test-stub',
  setup(build) {
    build.onResolve({ filter: /^firebase(\/|$)/ }, () => ({
      path: join(root, 'scripts', 'firebase-test-stub.mjs'),
    }));
  },
};

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
    // The `highs` package joins them: an emscripten CommonJS bundle that
    // requires node builtins at load time; inlining it breaks the ESM output.
    // The MILP tests resolve it from BEESTY_WEB_ROOT and inject it instead.
    external: ['node:*', '*.wasm', 'highs'],
    plugins: [firebaseStub],
    // Vite's `import.meta.env` does not exist under node, and `lib/firebase`
    // reads its config from it at module scope. Empty is right: the tests have
    // no Firebase config and must not pick one up from the environment.
    define: { 'import.meta.env': '{}' },
    logLevel: 'warning',
  });
  // Bundled tests run from a temp dir, so `import.meta.url` no longer points at
  // the repo — hand any test that needs the built wasm an absolute path.
  const res = spawnSync(process.execPath, ['--test', outdir], {
    stdio: 'inherit',
    env: {
      ...process.env,
      BEESTY_WASM_PATH: join(root, 'src', 'wasm', 'iso9613_wasm_bg.wasm'),
      // Lets a bundled test resolve packages against the real project rather
      // than the temp dir it is running from.
      BEESTY_WEB_ROOT: root,
    },
  });
  process.exit(res.status ?? 1);
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
