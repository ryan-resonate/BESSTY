import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

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

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
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
