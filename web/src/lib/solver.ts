// Wraps the Rust + WASM solver into a typed, project-shaped API.
//
// The engine takes a whole `Scene` — sources, receivers, ground, terrain,
// obstacles, atmosphere, settings — and returns per-receiver / per-source band
// levels. `sceneBuilder.ts` owns that mapping; this module resolves catalog data
// into it, drives the solve, and shapes the results back for the UI.
//
// Two outputs share the path: point receivers solve the whole project in one
// `solve_scene` call (per Annex D.5 receiver group), and the contour grid runs a
// `WasmSession` on a Web Worker, swapping receivers tile by tile so obstacles
// and terrain are decomposed once. The solve is fast enough that source drags
// simply re-evaluate.
//
// Terrain is the engine's job now: the app hands over a DEM-sampled Heightfield
// (`terrainField.ts`) instead of pre-reducing each path to synthetic barriers.
//
// `DΩ` (the solid-angle correction) has no place in the ISO model, so it is not
// part of the Scene — it is added here, after the solve, exactly as before.

import init, {
  solve_scene,
  octave_a_weighting,
  octave_centres,
} from '../wasm/iso9613_wasm.js';

import type {
  Source,
  Project,
} from './types';
import { lookupEntry, resolveContainer, sourceHeightFor, spectrumFor } from './catalog';
import { type DemRaster, type DemRegion, captureDemRegion } from './dem';
import {
  propagationSettings,
  type EffectiveSource,
} from './propagation';
import { buildSourceTree, walkSourceTreeForRegion } from './sourceTree';
import {
  buildScene,
  groupReceiversByConcave,
  projectOrigin,
  sceneSettingsFor,
  withConcave,
  type ResolvedSource,
  type SceneResults,
} from './sceneBuilder';
import { buildTerrainField } from './terrainField';
import { Diagnostics } from './diagnostics';
import { approxDistanceM } from './geo';
import {
  concaveCorrectionMet,
  mergeShard,
  runBatchedGrid,
  shardTiles,
  type GridJob,
  type GridTile,
  type GridResult,

} from './gridCore';

// Re-export so downstream consumers (contourLines, exporters) keep importing
// these from './solver'.
export type { GridResult, GridJob } from './gridCore';
export { latLngToLocalMetres } from './gridCore';

/// Project-wide DΩ correction (dB). Defaults to 0 dB (strict ISO 9613-2
/// / IEC 61400-11), which matches SoundPlan-style validation tools.
/// Override per-project to +3 dB when the source catalog reports
/// un-weighted Lw and you want the +3 dB hemispherical ground-reflection
/// boost added on top. Centralised so every site that adds DΩ uses
/// the same fallback.
export function projectDOmegaDb(project: Project): number {
  return project.settings?.dOmegaDb ?? 0;
}

/// Band count for the solver, given a scenario's band system.
/// Matches the Rust crate's `OCTAVE_CENTRES_HZ.len()` (10) and
/// `ONE_THIRD_OCTAVE_CENTRES_HZ.len()` (31).
export function bandCount(bs: 'octave' | 'oneThirdOctave'): number {
  return bs === 'oneThirdOctave' ? 31 : 10;
}
// A-weighting convention used throughout BESSTY:
//
//   - The Rust solver always works in Z-weighted (un-weighted) per-band
//     space. Catalog `LwA per band` data is converted to `Lw per band`
//     by `lib/catalog::spectrumFor` BEFORE the WASM call (see the
//     `weighting` field on `CatalogModeData`).
//   - Per-band Lp out of the solver is therefore Z-weighted; we apply
//     the IEC 61672-1 A-weighting offsets here when energy-summing into
//     a total LpA in dB(A).

/// A-weighting offsets per IEC 61672-1 — separate tables for the two band
/// systems so we don't hand the wrong-length weights to a downstream sum.
const OCTAVE_AW = new Float64Array([-56.7, -39.4, -26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1]);
const THIRD_OCT_AW = new Float64Array([
  -70.4, -63.4, -56.7, -50.5, -44.7, -39.4, -34.6,
  -30.2, -26.2, -22.5, -19.1, -16.1, -13.4, -10.9, -8.6, -6.6, -4.8,
  -3.2,  -1.9,  -0.8,   0.0,   0.6,   1.0,   1.2,   1.3,   1.2,
   1.0,   0.5,  -0.1,  -1.1,  -2.5,
]);
function aWeights(bs: 'octave' | 'oneThirdOctave'): Float64Array {
  return bs === 'oneThirdOctave' ? THIRD_OCT_AW : OCTAVE_AW;
}

let initialized: Promise<void> | null = null;

export function ensureSolverReady(): Promise<void> {
  // Wrap in an explicit `Promise<void>` rather than relying on the chained
  // `.then(() => undefined)` to settle the type. When CI couldn't resolve
  // the WASM module (because the artefacts hadn't been generated yet),
  // `init()`'s inferred return type collapsed to `unknown`, and the
  // resulting `unknown.then(...)` was no longer a `Promise<void>`. The
  // explicit `Promise.resolve(init()).then(...)` keeps the type pinned.
  if (!initialized) {
    initialized = Promise.resolve(init()).then(() => undefined);
  }
  return initialized;
}

export interface ReceiverResult {
  receiverId: string;
  perBandLp: Float64Array;
  totalDbA: number;
  perSource: Array<{ sourceId: string; perBandLp: Float64Array }>;
}

// ============== P1: point solve off the main thread ==============

/// One entry per scene sent, in order. Mirrors `scene.worker.ts`.
type SceneSolveOutcome =
  | { ok: true; json: string }
  | { ok: false; error: string };

/// Why a point solve is superseded rather than an error.
export const SOLVE_SUPERSEDED = 'solve superseded';

/// Which stream of point solves a call belongs to. Each channel owns a worker,
/// so the two never fight:
///
///   - `live`  — the editor's own solve. Newest-wins: a new request kills the
///     in-flight one, because an edit has already invalidated it.
///   - `study` — the factorial study's sequential sweep. Queued, never
///     superseded: the study runs while the user keeps editing, and its
///     combinations must not be cancelled by the editor's live re-solves.
export type SolveChannel = 'live' | 'study';

/// A single-worker lane for `solve_scene` calls.
class SceneSolveLane {
  private worker: Worker | null = null;
  private seq = 0;
  private active: { id: number; cleanup(): void; reject(e: Error): void } | null = null;
  /// Serialises `study` work so queued calls run one after another rather than
  /// racing for the one worker.
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly supersedes: boolean) {}

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./scene.worker.ts', import.meta.url), { type: 'module' });
    }
    return this.worker;
  }

  /// Drop the in-flight job and rebuild the worker next time. The wasm solve is
  /// a tight loop with no yield point, so a cooperative flag would not be read
  /// until it finished — terminate is the only way to actually stop it.
  cancel(): void {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.seq++;
    if (this.active) {
      const stale = this.active;
      this.active = null;
      stale.cleanup();
      stale.reject(new Error(SOLVE_SUPERSEDED));
    }
  }

  run(scenes: string[]): Promise<SceneSolveOutcome[]> {
    if (this.supersedes) return this.post(scenes);
    // Queued lane: chain behind whatever is already running.
    const next = this.tail.then(() => this.post(scenes), () => this.post(scenes));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private post(scenes: string[]): Promise<SceneSolveOutcome[]> {
    if (this.supersedes && this.active) this.cancel();
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise<SceneSolveOutcome[]>((resolve, reject) => {
      // Dead-man switch: a wedged worker must not hang the editor forever.
      // Generous, because one solve of a very large site is legitimately slow.
      const TIMEOUT_MS = 120000;
      let timer = 0;
      const cleanup = () => {
        if (this.active?.id === id) this.active = null;
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      const onMessage = (ev: MessageEvent) => {
        const data = ev.data as {
          id: number; ok?: boolean; results?: SceneSolveOutcome[]; error?: string;
        };
        if (data.id !== id) return;
        cleanup();
        if (data.ok && data.results) resolve(data.results);
        else reject(new Error(data.error ?? 'scene worker failed'));
      };
      const onError = (e: ErrorEvent) => {
        cleanup();
        this.worker = null;
        reject(new Error(`scene worker error: ${e.message || 'load failed'}`));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      this.active = { id, cleanup, reject };
      timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('scene worker stopped responding'));
      }, TIMEOUT_MS);
      worker.postMessage({ id, scenes });
    });
  }
}

const lanes: Record<SolveChannel, SceneSolveLane> = {
  live: new SceneSolveLane(true),
  study: new SceneSolveLane(false),
};

/// Web Workers don't exist under `node:test`, and the conformance/wasm tests
/// call the solver directly. Fall back to solving inline there — same code
/// path, just on the calling thread.
const workersAvailable = typeof Worker !== 'undefined';

function solveScenesInline(scenes: string[]): SceneSolveOutcome[] {
  return scenes.map((s) => {
    try {
      return { ok: true as const, json: solve_scene(s) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

async function solveScenes(scenes: string[], channel: SolveChannel): Promise<SceneSolveOutcome[]> {
  if (scenes.length === 0) return [];
  if (!workersAvailable) {
    await ensureSolverReady();
    return solveScenesInline(scenes);
  }
  return lanes[channel].run(scenes);
}

/// Abandon the in-flight `live` point solve. Used when a newer one is about to
/// start; the loser rejects with [`SOLVE_SUPERSEDED`].
export function cancelLiveSolve(): void {
  if (workersAvailable) lanes.live.cancel();
}

/// Source **height above local ground** (HAG) — the machine height fed to the
/// ground-attenuation shape functions. Independent of terrain elevation.
///
/// Returns null if the catalog entry is missing.
function sourceHagl(source: Source, project: Project): number | null {
  const entry = lookupEntry(project, source);
  if (source.kind === 'wtg') {
    // Per-source `hubHeight` REPLACES the library default (it's the
    // explicit hub-height field, not a delta). Falls back to the
    // catalog's sourceHeightM, then hubHeights[0], then 100 m.
    return source.hubHeight ?? sourceHeightFor(entry);
  }
  // BESS / Aux: library height + per-source elevation delta.
  return sourceHeightFor(entry) + (source.elevationOffset ?? 0);
}

/// Energy-sum Z-weighted per-band Lp values into one total LpA in dB(A),
/// applying the IEC 61672-1 A-weighting offsets at sum time. Per-band Lp
/// out of the WASM solver is Z-weighted — see the A-weighting note above.
/// `dOmegaDb` (default 0) is added uniformly to every band as a frequency-
/// independent solid-angle correction — see ProjectSettings.dOmegaDb.
function aWeightedTotal(perBandLp: Float64Array, aw: Float64Array, dOmegaDb: number = 0): number {
  let aSum = 0;
  const n = Math.min(perBandLp.length, aw.length);
  for (let i = 0; i < n; i++) {
    if (isFinite(perBandLp[i])) aSum += Math.pow(10, (perBandLp[i] + aw[i] + dOmegaDb) / 10);
  }
  return aSum > 0 ? 10 * Math.log10(aSum) : -Infinity;
}

function energySumPerBand(perSource: Array<{ perBandLp: Float64Array }>): Float64Array {
  const n = perSource[0]?.perBandLp.length ?? 10;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (const { perBandLp } of perSource) acc += Math.pow(10, perBandLp[i] / 10);
    out[i] = acc > 0 ? 10 * Math.log10(acc) : -Infinity;
  }
  return out;
}

// ============== Receiver-point evaluation (primal) ==============

/// Resolve a project's sources into the solver-facing form: catalog lookups
/// (sound power, machine height, rotor diameter) done once, geometry left to
/// `sceneBuilder`. Sources whose catalog entry is missing, or whose coordinates
/// are non-finite (busted import / glitched group drag), are dropped rather than
/// fed to the engine as NaN.
export function resolveSources(project: Project): ResolvedSource[] {
  const out: ResolvedSource[] = [];
  for (const source of project.sources) {
    if (!Number.isFinite(source.latLng[0]) || !Number.isFinite(source.latLng[1])) continue;
    const entry = lookupEntry(project, source);
    if (!entry) {
      console.warn(`Catalog entry not found: ${source.catalogScope}/${source.modelId}`);
      continue;
    }
    const modeName = source.modeOverride ?? entry.defaultMode;
    const lw = spectrumFor(entry, modeName, project.scenario.windSpeed, project.scenario.bandSystem);
    const heightAglM = sourceHagl(source, project);
    if (heightAglM == null) continue;
    out.push({
      id: source.id,
      latLng: source.latLng,
      heightAglM,
      lw: Array.from(lw),
      // `applyConcave` is a placeholder: Annex D.5 is a per source→receiver
      // condition, stamped per receiver group below.
      wtg: source.kind === 'wtg'
        ? { rotorDiameterM: source.rotorDiameterM ?? entry.rotorDiameterM ?? 120, applyConcave: false }
        : undefined,
      container: resolveContainer(source, entry),
    });
  }
  return out;
}

/// Ground elevation under a point, with the app's long-standing non-finite → 0
/// guard (a DEM hole must not poison the geometry).
function groundElevation(dem: DemRaster | null, latLng: [number, number]): number {
  if (!dem) return 0;
  const g = dem.elevation(latLng[0], latLng[1]);
  return Number.isFinite(g) ? g : 0;
}

/// Exact point-receiver solve. Every receiver sums every (in-cutoff) source —
/// no Barnes-Hut clustering, since per-source contribution rows need real source
/// ids and there are typically few named receivers.
///
/// The whole project goes to the engine as ONE `Scene` (per Annex D.5 receiver
/// group — see `groupReceiversByConcave`), so obstacles and terrain are
/// decomposed once for all receivers instead of per source→receiver pair.
/// `diagnostics` (I20) collects the approximations this solve applied. Pass one
/// in to surface them; omit it and they're simply not recorded.
///
/// P1: the `solve_scene` calls run on a Web Worker (see `SolveChannel`), so an
/// edit no longer blocks input for the length of the solve. Everything that
/// needs the project or the DEM — catalog resolution, the terrain raster, the
/// Annex D.5 concave grouping — still happens here, on the calling thread.
export async function evaluateProject(
  project: Project,
  dem: DemRaster | null,
  diagnostics: Diagnostics = new Diagnostics(),
  channel: SolveChannel = 'live',
): Promise<ReceiverResult[]> {
  await ensureSolverReady();

  const origin = projectOrigin(project);
  const aw = aWeights(project.scenario.bandSystem);
  const n = bandCount(project.scenario.bandSystem);
  const cutoffM = propagationSettings(project).maxContributionDistanceM;
  const dOmega = projectDOmegaDb(project);

  const sources = resolveSources(project);
  const valid = project.receivers.filter(
    (rx) => Number.isFinite(rx.latLng[0]) && Number.isFinite(rx.latLng[1]),
  );

  const droppedSources = project.sources.length - sources.length;
  if (droppedSources > 0) {
    diagnostics.note(
      'sources.unresolved', 'material',
      `${droppedSources} source${droppedSources === 1 ? '' : 's'} skipped — no catalog entry `
      + 'for the referenced model. They contribute nothing to these levels.',
      droppedSources,
    );
  }

  // Terrain covers every source and receiver; the engine screens against it.
  const terrain = buildTerrainField(
    dem,
    origin,
    [...sources.map((s) => s.latLng), ...valid.map((r) => r.latLng)],
    { despikeStrength: project.settings?.topography?.despikeStrength, diagnostics },
  );
  if (!terrain && dem) {
    diagnostics.note(
      'terrain.absent', 'material',
      'No usable terrain raster — ground treated as flat. Any screening by '
      + 'topography is missing from these levels.',
    );
  }

  const settings = sceneSettingsFor(project);
  const containers = project.settings?.containers;
  const reflections = project.settings?.reflections;
  const results = new Map<string, ReceiverResult>();

  // Annex D.5's concave-ground test is per source→receiver, but a Scene carries
  // `apply_concave` per source — so receivers that disagree can't share a scene.
  // With no turbines this is a single group and costs nothing.
  const groups = groupReceiversByConcave(sources, valid, (s, rx) => {
    const ground = groundElevation(dem, s.latLng);
    const rxGround = groundElevation(dem, rx.latLng);
    return concaveCorrectionMet(
      s.latLng, ground + s.heightAglM,
      rx.latLng, rxGround + rx.heightAboveGroundM,
      s.heightAglM, rx.heightAboveGroundM, dem,
    );
  });

  // Build every concave group's scene, then solve them in ONE worker round
  // trip. (With no turbines there is exactly one group.)
  const sceneJson = groups.map((group) => JSON.stringify(buildScene({
    origin,
    sources: withConcave(sources, group.concaveBySourceId),
    receivers: group.receivers.map((rx) => ({
      id: rx.id, latLng: rx.latLng, heightAboveGroundM: rx.heightAboveGroundM,
    })),
    barriers: project.barriers ?? [],
    dem,
    terrain,
    settings,
    includeContainers: containers?.receiverCalc ?? false,
    roofOffsetM: containers?.roofOffsetM,
    includeReflections: reflections?.receiverCalc ?? false,
    maxReflectionOrder: reflections?.maxOrder ?? 3,
  })));

  const outcomes = await solveScenes(sceneJson, channel);

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const outcome = outcomes[gi];
    if (!outcome || !outcome.ok) {
      // A rejected scene is a modelling error, not a crash: surface it and show
      // "—" rows rather than taking the whole page down.
      console.error('solve failed:', outcome?.error ?? 'no result');
      continue;
    }
    let solved: SceneResults;
    try {
      solved = JSON.parse(outcome.json) as SceneResults;
    } catch (e) {
      console.error('solve returned unparseable results:', e);
      continue;
    }

    for (const rr of solved.per_receiver) {
      const rx = group.receivers.find((r) => r.id === rr.receiver_id);
      const perSource: ReceiverResult['perSource'] = [];
      for (const contribution of rr.per_source) {
        // The cutoff stays a per-PAIR rule, exactly as before: the engine solves
        // every pair in the batch, and contributions from sources beyond the
        // cutoff for THIS receiver are dropped here.
        const src = sources.find((s) => s.id === contribution.source_id);
        if (!src || !rx) continue;
        if (cutoffM > 0 && approxDistanceM(rx.latLng, src.latLng) > cutoffM) {
          // I20: a dropped contribution is a modelling choice, not a non-event.
          diagnostics.note(
            'sources.cutoff', 'info',
            `Source contributions beyond the ${(cutoffM / 1000).toFixed(1)} km cutoff were `
            + 'dropped. Raise "Propagation cutoffs" in settings if distant sources matter here.',
          );
          continue;
        }
        const perBandLp = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const v = contribution.bands[i];
          perBandLp[i] = typeof v === 'number' && Number.isFinite(v) ? v : -Infinity;
        }
        perSource.push({ sourceId: contribution.source_id, perBandLp });
      }
      const summed = energySumPerBand(perSource);
      results.set(rr.receiver_id, {
        receiverId: rr.receiver_id,
        perBandLp: summed,
        totalDbA: aWeightedTotal(summed, aw, dOmega),
        perSource,
      });
    }
  }
  // Preserve the caller's receiver order, and keep a "—" row for anything that
  // didn't solve (non-finite coordinates, or a rejected scene).
  return project.receivers.map((rx) => results.get(rx.id) ?? {
    receiverId: rx.id,
    perBandLp: new Float64Array(n),
    totalDbA: -Infinity,
    perSource: [],
  });
}

// ============== Batched grid evaluation (S2) ==============

/// Resolve one tile's effective sources (real units + Barnes-Hut cluster
/// stand-ins) into the solver-facing form. Sources whose catalog entry is
/// missing are dropped. Clusters carry their summed sound power and never take a
/// container — they are a stand-in for a group, not a physical box.
function resolveTileSources(
  project: Project,
  effRaw: EffectiveSource[],
): ResolvedSource[] {
  const out: ResolvedSource[] = [];
  for (const es of effRaw) {
    let lw: Float64Array | null;
    let heightAglM: number;
    let wtg: ResolvedSource['wtg'];
    let container: ResolvedSource['container'];
    if (es.kind === 'real') {
      const entry = lookupEntry(project, es.source!);
      if (!entry) continue;
      const modeName = es.source!.modeOverride ?? entry.defaultMode;
      lw = spectrumFor(entry, modeName, project.scenario.windSpeed, project.scenario.bandSystem);
      heightAglM = sourceHagl(es.source!, project) ?? 0;
      if (es.source!.kind === 'wtg') {
        wtg = {
          rotorDiameterM: es.source!.rotorDiameterM ?? entry.rotorDiameterM ?? 120,
          applyConcave: false,   // stamped per receiver group (Annex D.5)
        };
      }
      container = resolveContainer(es.source!, entry);
    } else {
      lw = es.lwOverride!;
      heightAglM = es.zAboveGround ?? 1.5;
    }
    if (!lw) continue;
    out.push({
      id: es.kind === 'real' ? es.source!.id : `cluster:${es.latLng[0]},${es.latLng[1]}`,
      latLng: es.latLng,
      heightAglM,
      lw: Array.from(lw),
      wtg,
      container,   // clusters stay bare: a cluster stands in for a group, not a box
    });
  }
  return out;
}

/// Resolve a project into a serializable `GridJob` (catalog + per-source
/// geometry done here, on the main thread). The DEM is consumed for source
/// absolute-z only; cell-by-cell terrain is sampled later in `runBatchedGrid`.
function buildGridJob(
  project: Project,
  dem: DemRaster | null,
  spacingM: number,
  rxHeightAboveGround: number,
  diagnostics?: Diagnostics,
): GridJob {
  const ca = project.calculationArea;
  if (!ca) throw new Error('calculationArea not set; cannot compute grid');
  const origin = ca.centerLatLng;
  const cols = Math.max(2, Math.round(ca.widthM / spacingM));
  const rows = Math.max(2, Math.round(ca.heightM / spacingM));
  const dxM = ca.widthM / cols;
  const dyM = ca.heightM / rows;
  const R = 6371008.8;
  const lat0 = (origin[0] * Math.PI) / 180;
  const dLat = (ca.heightM / 2 / R) * (180 / Math.PI);
  const dLng = (ca.widthM / 2 / (R * Math.cos(lat0))) * (180 / Math.PI);
  const bounds = {
    sw: [origin[0] - dLat, origin[1] - dLng] as [number, number],
    ne: [origin[0] + dLat, origin[1] + dLng] as [number, number],
  };
  const cfg = propagationSettings(project);
  const cutoffM = cfg.maxContributionDistanceM;
  const theta = cfg.treeAcceptanceTheta;

  // Adaptive per-tile clustering. The Barnes-Hut tree is built once; each
  // tile then decides its OWN clustering from the tile footprint (via
  // `walkSourceTreeForRegion`). Tiles far from a group of sources collapse it
  // to a single virtual source; tiles near it keep every source. (The old code
  // walked the tree once at the grid centre and reused that verdict for every
  // cell, so far cells never got to cluster — `θ` had no effect when the grid
  // sat on top of the sources.)
  const tree = buildSourceTree(project, project.scenario.bandSystem, project.scenario.windSpeed);
  const TILE = 16; // cells per tile edge
  const cellLat = (row: number) =>
    origin[0] + (((row - (rows - 1) / 2) * dyM) / R) * (180 / Math.PI);
  const cellLng = (col: number) =>
    origin[1] + (((col - (cols - 1) / 2) * dxM) / (R * Math.cos(lat0))) * (180 / Math.PI);
  const marginLat = ((dyM / 2) / R) * (180 / Math.PI);
  const marginLng = ((dxM / 2) / (R * Math.cos(lat0))) * (180 / Math.PI);

  const tiles: GridTile[] = [];
  for (let row0 = 0; row0 < rows; row0 += TILE) {
    const trows = Math.min(TILE, rows - row0);
    const latLo = cellLat(row0);
    const latHi = cellLat(row0 + trows - 1);
    for (let col0 = 0; col0 < cols; col0 += TILE) {
      const tcols = Math.min(TILE, cols - col0);
      const lngLo = cellLng(col0);
      const lngHi = cellLng(col0 + tcols - 1);
      const region = {
        minLat: Math.min(latLo, latHi) - marginLat,
        maxLat: Math.max(latLo, latHi) + marginLat,
        minLng: Math.min(lngLo, lngHi) - marginLng,
        maxLng: Math.max(lngLo, lngHi) + marginLng,
      };
      const tileEff = tree ? walkSourceTreeForRegion(tree, region, theta, cutoffM) : [];
      // I20: a cluster stands in for several real sources. Cheap and usually
      // harmless, but it IS an approximation and it was invisible.
      if (diagnostics) {
        const clustered = tileEff.filter((es) => es.kind !== 'real').length;
        if (clustered > 0) {
          diagnostics.note(
            'sources.clustered', 'info',
            `Distant sources were merged into Barnes-Hut cluster stand-ins for some `
            + `tiles (θ = ${theta}). Lower "Tree acceptance θ" in Propagation cutoffs `
            + 'for a more literal, slower grid.',
            clustered,
          );
        }
      }
      tiles.push({
        col0, row0, cols: tcols, rows: trows,
        sources: resolveTileSources(project, tileEff),
      });
    }
  }

  // One elevation raster for the whole job: it must cover every cell AND every
  // source, since the engine screens each source→cell path against it.
  const corners: Array<[number, number]> = [
    bounds.sw, bounds.ne, [bounds.sw[0], bounds.ne[1]], [bounds.ne[0], bounds.sw[1]],
  ];
  const sourceLatLngs = tiles.flatMap((t) => t.sources.map((s) => s.latLng));
  const containers = project.settings?.containers;

  return {
    cols, rows, dxM, dyM, origin, bounds,
    nBands: bandCount(project.scenario.bandSystem),
    cutoffM,
    dOmegaDb: projectDOmegaDb(project),
    rxHeightAboveGround,
    barriers: project.barriers ?? [],
    settings: sceneSettingsFor(project),
    topo: project.settings?.topography,
    terrain: buildTerrainField(dem, origin, [...corners, ...sourceLatLngs], {
      despikeStrength: project.settings?.topography?.despikeStrength,
      diagnostics,
    }),
    includeContainers: containers?.grid ?? false,
    roofOffsetM: containers?.roofOffsetM ?? 0.3,
    rotationDeg: ca.rotationDeg ?? 0,
    includeReflections: project.settings?.reflections?.grid ?? false,
    maxReflectionOrder: project.settings?.reflections?.maxOrder ?? 3,
    tiles,
  };
}

// ============== Compatibility: exact grid evaluation ==============

/// Compute the contour grid. One Scene per tile, solved as a batch of receivers
/// through a `WasmSession`, so the obstacle + terrain decomposition happens once
/// per tile rather than once per cell.
export async function evaluateGrid(
  project: Project,
  dem: DemRaster | null,
  spacingM: number,
  rxHeightAboveGround: number,
): Promise<GridResult> {
  await ensureSolverReady();
  return runBatchedGrid(buildGridJob(project, dem, spacingM, rxHeightAboveGround), dem);
}

// ============== Worker offload (S1) ==============

/// Run the contour grid in a Web Worker so the main thread stays responsive
/// (S1). The worker reconstructs the DEM from a transferable region snapshot
/// and runs the SAME `runBatchedGrid` core.
///
/// I12: this is now the ONLY grid path. It used to fall back to running the
/// solve inline on any worker error, which is precisely what made Chrome flag
/// the page as unresponsive — a large grid on the main thread blocks every
/// frame for tens of seconds, and the fallback fired silently, so a broken
/// worker looked like "the app just freezes sometimes". A failed worker now
/// rejects and the caller reports it.
///
/// `onProgress` receives (tilesDone, tilesTotal), throttled to ~10 Hz by the
/// worker.
///
/// CONTRACT for callers: posting a job TERMINATES any in-flight grid job
/// (newest wins), and the loser's promise rejects with [`GRID_CANCELLED`].
/// Both existing callers bump their generation counter before calling and
/// gen-guard their `.catch` — that is what keeps the cancellation silent. A
/// new caller must do the same, or expect its run to be killed by the next
/// background regrid and to see the cancellation surface as an error.
export async function evaluateGridViaWorker(
  project: Project,
  dem: DemRaster | null,
  spacingM: number,
  rxHeightAboveGround: number,
  onProgress?: (tilesDone: number, tilesTotal: number) => void,
  diagnostics?: Diagnostics,
): Promise<GridResult> {
  await ensureSolverReady();
  const job = buildGridJob(project, dem, spacingM, rxHeightAboveGround, diagnostics);
  {
    // The DEM region must cover the calc area AND every (real) source, because
    // ridge sampling walks the whole source→cell line. Expand the snapshot
    // bounds to the union of the calc-area rectangle and the source positions,
    // with a small margin, so the worker's region DEM never reads outside its
    // coverage (which would return 0 / sea level). Resolution is scaled to keep
    // roughly the source-tile density across the (possibly larger) extent.
    //
    // Cached by (DEM identity + region bounds + resolution): a recompute that
    // doesn't move geometry (e.g. wind speed / G / atmosphere change, or a
    // re-run of the same area) reuses the sampled terrain instead of
    // re-sampling ~10⁶ DEM points on the main thread each time.
    const cached = dem ? captureDemRegionCached(dem, sourcePaddedBounds(job)) : null;
    return await runGridJobOnPool(job, cached, onProgress);
  }
}

/// One-entry DEM-region cache. The region is structure-cloned (not transferred)
/// to the worker, so the cached copy stays valid across runs.
let demRegionCache: { key: string; region: DemRegion } | null = null;

function captureDemRegionCached(
  dem: DemRaster,
  bounds: [[number, number], [number, number], number, number],
): { key: string; region: DemRegion } {
  const [sw, ne, nx, ny] = bounds;
  const key = `${dem.bounds.sw}|${dem.bounds.ne}|${dem.tilesLoaded}|${sw}|${ne}|${nx}|${ny}`;
  if (demRegionCache && demRegionCache.key === key) return demRegionCache;
  const region = captureDemRegion(dem, sw, ne, nx, ny);
  demRegionCache = { key, region };
  return demRegionCache;
}

/// SW/NE/nx/ny for a DEM region covering the grid bounds + all sources, sized
/// to ~30 m/sample and capped so the snapshot stays small.
function sourcePaddedBounds(job: GridJob): [[number, number], [number, number], number, number] {
  let minLat = Math.min(job.bounds.sw[0], job.bounds.ne[0]);
  let maxLat = Math.max(job.bounds.sw[0], job.bounds.ne[0]);
  let minLng = Math.min(job.bounds.sw[1], job.bounds.ne[1]);
  let maxLng = Math.max(job.bounds.sw[1], job.bounds.ne[1]);
  // Every source now gets terrain screening (clusters included), so the
  // snapshot must span them all.
  for (const tile of job.tiles) {
    for (const s of tile.sources) {
      const [la, ln] = s.latLng;
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
      if (ln < minLng) minLng = ln; if (ln > maxLng) maxLng = ln;
    }
  }
  const mLat = (maxLat - minLat) * 0.05 + 0.002;
  const mLng = (maxLng - minLng) * 0.05 + 0.002;
  const sw: [number, number] = [minLat - mLat, minLng - mLng];
  const ne: [number, number] = [maxLat + mLat, maxLng + mLng];
  // ~111 km per degree latitude; target ≈ 30 m/sample, clamp to [128, 1024].
  const spanLatM = (ne[0] - sw[0]) * 111_000;
  const spanLngM = (ne[1] - sw[1]) * 111_000 * Math.cos((minLat * Math.PI) / 180);
  const ny = Math.max(128, Math.min(1024, Math.round(spanLatM / 30)));
  const nx = Math.max(128, Math.min(1024, Math.round(spanLngM / 30)));
  return [sw, ne, nx, ny];
}

// ============== P2: grid worker pool ==============
//
// Grid tiles are independent by construction — each carries its own resolved
// source set and writes a disjoint block of cells — so the only reason the grid
// took 5–8 s on an 800-source site was that it ran on ONE core. The job's tiles
// are dealt round-robin across a pool; each worker returns a full-size buffer
// with only its own cells written, and the main thread copies each shard's tile
// rectangles into the final grid. Round-robin rather than contiguous blocks
// because cost per tile varies hugely with distance from the sources (near
// tiles keep every source, far tiles collapse to a cluster), and contiguous
// blocks would hand one worker the whole expensive middle of the site.

/// Leave headroom for the main thread and the point-solve lanes: saturating
/// every core makes the UI worse, not better, which is the opposite of the
/// point. Capped at 8 — beyond that, message and merge overhead dominates.
const GRID_POOL_SIZE = Math.max(
  1,
  Math.min(8, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4) - 2),
);

interface PoolWorker {
  worker: Worker;
  /// Region this worker already holds, so a re-run over the same extent ships
  /// only the job. Cleared whenever the worker is terminated.
  regionKey: string | null;
}

let gridPool: PoolWorker[] = [];
let gridWorkerSeq = 0;

/// The in-flight run, if any. Tracked so a superseding run (or an explicit
/// cancel) can settle the stale promise IMMEDIATELY instead of leaving it to
/// hang until the dead-man timeout — and, more importantly, so a new run can
/// terminate the stale one before posting. Workers QUEUE posted messages:
/// without this, a burst of auto-regrids (one per settled drag) stacked
/// multi-second solves back to back, the newest geometry's grid arrived after
/// every stale one finished, and the machine chewed cores on results nobody
/// would ever see.
let activeGridRun: { cleanup(): void; reject(e: Error): void } | null = null;

function getPoolWorker(i: number): PoolWorker {
  let pw = gridPool[i];
  if (!pw) {
    pw = {
      worker: new Worker(new URL('./grid.worker.ts', import.meta.url), { type: 'module' }),
      regionKey: null,
    };
    gridPool[i] = pw;
  }
  return pw;
}

/// Kill the in-flight grid solve (I12). Workers are terminated rather than
/// asked to stop — `runBatchedGrid` is a tight synchronous loop with no
/// yield point, so a cooperative cancel flag would not be read until it
/// finished, which is the thing we're trying to avoid. The next run lazily
/// rebuilds the pool.
///
/// In-flight promises reject with `GRID_CANCELLED`; callers should treat that
/// as "no result", not an error to surface.
export const GRID_CANCELLED = 'grid cancelled';

export function cancelGridRun(): void {
  for (const pw of gridPool) pw?.worker.terminate();
  gridPool = [];
  // Bump the sequence so any late message from a dead worker is ignored.
  gridWorkerSeq++;
  // Settle the stale promise now rather than letting it hang for the dead-man
  // timeout. Null the slot BEFORE settling so the run's own cleanup (guarded on
  // identity) cannot clobber a newer run registered meanwhile.
  if (activeGridRun) {
    const stale = activeGridRun;
    activeGridRun = null;
    stale.cleanup();
    stale.reject(new Error(GRID_CANCELLED));
  }
}

function runGridJobOnPool(
  job: GridJob,
  cachedRegion: { key: string; region: DemRegion } | null,
  onProgress?: (tilesDone: number, tilesTotal: number) => void,
): Promise<GridResult> {
  // Newest-wins: every caller that reaches here has already superseded the
  // previous run's generation, so a still-running job's result could only be
  // discarded — letting it finish first would just delay this one by its full
  // runtime.
  if (activeGridRun) cancelGridRun();

  const shards = shardTiles(job.tiles, GRID_POOL_SIZE);
  const runId = ++gridWorkerSeq;
  const t0 = performance.now();

  return new Promise<GridResult>((resolve, reject) => {
    const dbA = new Float32Array(job.cols * job.rows).fill(-120);
    const doneByShard = new Array<number>(shards.length).fill(0);
    let outstanding = shards.length;
    let settled = false;

    // The timeout is a DEAD-MAN switch, not a total budget: rearmed by every
    // progress message, so a genuinely long grid that is visibly advancing is
    // never killed, while a wedged pool still fails in 60 s.
    const IDLE_TIMEOUT_MS = 60000;
    let timeout = 0;

    const listeners: Array<() => void> = [];
    const cleanup = () => {
      if (activeGridRun === handle) activeGridRun = null;
      clearTimeout(timeout);
      for (const off of listeners) off();
      listeners.length = 0;
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const arm = () => {
      clearTimeout(timeout);
      timeout = window.setTimeout(() => fail(new Error('grid worker stopped responding')), IDLE_TIMEOUT_MS);
    };
    const handle = { cleanup, reject: fail };

    shards.forEach((shardTilesList, si) => {
      const pw = getPoolWorker(si);
      const { worker } = pw;
      const onMessage = (ev: MessageEvent) => {
        const data = ev.data as {
          id: number; ok?: boolean; result?: GridResult; error?: string;
          progress?: { tilesDone: number; tilesTotal: number };
        };
        if (data.id !== runId || settled) return;
        if (data.progress) {
          arm();
          doneByShard[si] = data.progress.tilesDone;
          onProgress?.(doneByShard.reduce((a, b) => a + b, 0), job.tiles.length);
          return;
        }
        if (!data.ok || !data.result) { fail(new Error(data.error ?? 'grid worker failed')); return; }
        mergeShard(dbA, data.result.dbA, shardTilesList, job.cols, job.rows);
        doneByShard[si] = shardTilesList.length;
        onProgress?.(doneByShard.reduce((a, b) => a + b, 0), job.tiles.length);
        if (--outstanding === 0) {
          settled = true;
          cleanup();
          resolve({
            cols: job.cols, rows: job.rows, bounds: job.bounds, dbA,
            computedMs: performance.now() - t0,
          });
        }
      };
      const onError = (e: ErrorEvent) => {
        // Drop the whole pool: a module-load failure affects every worker.
        gridPool = [];
        fail(new Error(`grid worker error: ${e.message || 'load failed'}`));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      listeners.push(() => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      });

      // Ship the DEM region only to workers that don't already hold it.
      const wantKey = cachedRegion?.key ?? null;
      const sendRegion = cachedRegion != null && pw.regionKey !== cachedRegion.key;
      if (sendRegion) pw.regionKey = cachedRegion.key;
      else if (cachedRegion == null) pw.regionKey = null;
      worker.postMessage({
        id: runId,
        job: { ...job, tiles: shardTilesList },
        region: sendRegion ? cachedRegion.region : null,
        regionKey: wantKey,
      });
    });

    activeGridRun = handle;
    arm();
  });
}

export { octave_centres, octave_a_weighting };
