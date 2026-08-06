// P1 — point-receiver solve worker.
//
// The contour grid moved off the main thread long ago (S1); the point solve
// did not, so every edit fired a synchronous wasm call that blocked input for
// its whole duration. On a site with hundreds of sources that is the jank you
// feel when moving one object straight after another.
//
// Deliberately dumb: it takes already-serialised Scene JSON and hands back
// result JSON. Catalog resolution, terrain sampling and the Annex D.5 concave
// grouping stay on the main thread (they need the DemRaster and the project),
// so this worker imports nothing but the wasm — no catalog, no firebase.
//
// Several scenes per message because one solve is split by concave group.
// Batching them keeps it to a single round trip.

import init, { solve_scene } from '../wasm/iso9613_wasm.js';

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = Promise.resolve(init()).then(() => undefined);
  return ready;
}

export interface SceneSolveRequest {
  id: number;
  scenes: string[];
}

/// One entry per requested scene, in order. A scene the engine rejects fails
/// on its own — a modelling error in one concave group must not lose the
/// results for the others.
export type SceneSolveOutcome =
  | { ok: true; json: string }
  | { ok: false; error: string };

self.onmessage = async (ev: MessageEvent<SceneSolveRequest>) => {
  const { id, scenes } = ev.data;
  try {
    await ensureReady();
    const results: SceneSolveOutcome[] = scenes.map((s) => {
      try {
        return { ok: true, json: solve_scene(s) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    (self as unknown as Worker).postMessage({ id, ok: true, results });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(e) });
  }
};
