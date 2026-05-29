import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { execSync } from 'node:child_process';

// Auto-derived build identifiers stamped into the bundle so the deployed
// app can show a tiny version string. SHA is the short git hash at build
// time; date is the wall-clock build date (UTC, YYYY-MM-DD). Failures
// (shallow checkout, no git, dev container with no .git) fall through
// to 'dev' so local `npm run dev` still works.
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}
function buildDateUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// COOP/COEP would be required to use SharedArrayBuffer, but enabling
// `require-corp` blocks third-party tile providers (Esri, OSM) that don't
// send a CORP header. Re-enable when the orchestrator/compute-worker layer
// lands and SharedArrayBuffer becomes load-bearing — at that point we'll
// either proxy tiles, switch to a CORP-friendly provider, or use COEP
// `credentialless` (Chrome 96+).
//
// const crossOriginIsolationHeaders = {
//   'Cross-Origin-Opener-Policy': 'same-origin',
//   'Cross-Origin-Embedder-Policy': 'require-corp',
// };

// GitHub Pages serves project sites from `https://<user>.github.io/<repo>/`,
// so every asset URL has to be prefixed with `/<repo>/`. We read the prefix
// from `BESSTY_BASE` at build time — the GitHub Actions workflow sets it
// to `/${{ github.event.repository.name }}/` automatically. Local `npm run
// dev` and `npm run build` (without the env) leave it as `/`, which is what
// you want when serving from the root.
const BASE = process.env.BESSTY_BASE ?? '/';

export default defineConfig({
  base: BASE,
  plugins: [react(), wasm(), topLevelAwait()],
  define: {
    // String literals are wrapped in JSON.stringify so Vite emits valid
    // JS source (otherwise `__APP_VERSION_SHA__` would become a bare
    // identifier like `a6bbe74`, which is a syntax error).
    __APP_VERSION_SHA__: JSON.stringify(gitShortSha()),
    __APP_VERSION_DATE__: JSON.stringify(buildDateUtc()),
  },
  build: {
    target: 'es2022',
  },
  resolve: {
    // Prefer the .tsx / .ts source over any .js that sneaks in. Vite's
    // default order is ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx',
    // '.json'] — `.js` first — which means a stale `tsc`-emitted `.js`
    // sitting next to a `.tsx` would be served instead of the live
    // TypeScript. Reordering here makes that impossible.
    extensions: ['.mjs', '.tsx', '.ts', '.jsx', '.mts', '.js', '.json'],
  },
  worker: {
    plugins: () => [wasm(), topLevelAwait()],
    format: 'es',
  },
});
