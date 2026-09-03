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
  octave_centres,
} from '../wasm/iso9613_wasm.js';

import type {
  Period,
  Source,
  Project,
} from './types';
import { projectDOmegaDb } from './types';
import { weightedTotal, weightingFor, weightsFor } from './weighting';
import {
  assessmentLevel, screenTonality, tonalityPenaltyDb, tonalitySettingsFor,
  type TonalityResult,
} from './tonality';
import { lookupEntry, resolveContainer, sourceHeightFor, spectrumFor } from './catalog';
import { groupPeriodsBySolve, sourceIsOff, sourceModeName } from './modes';
import { type DemRaster, type DemRegion, captureDemRegion, terrainSourceNote } from './dem';
import {
  propagationSettings,
  type EffectiveSource,
} from './propagation';
import { buildSourceTree, walkSourceTreeForRegion, type LatLngBbox } from './sourceTree';
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
  barriersForRegion,
  concaveCorrectionMet,
  mergeShard,
  planIncrementalGrid,
  runBatchedGrid,
  shardTiles,
  type GridCacheEntry,
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
// Defined in `types.ts` alongside the other settings accessors; re-exported
// here because the solver is where callers expect to find it.
export { projectDOmegaDb };

/// Band count for the solver, given a scenario's band system.
/// Matches the Rust crate's `OCTAVE_CENTRES_HZ.len()` (10) and
/// `ONE_THIRD_OCTAVE_CENTRES_HZ.len()` (31).
export function bandCount(bs: 'octave' | 'oneThirdOctave'): number {
  return bs === 'oneThirdOctave' ? 31 : 10;
}
// Weighting convention used throughout BESSTY:
//
//   - The Rust solver always works in Z-weighted (un-weighted) per-band
//     space. Catalog `LwA per band` data is converted to `Lw per band`
//     by `lib/catalog::spectrumFor` BEFORE the WASM call (see the
//     `weighting` field on `CatalogModeData`).
//   - Per-band Lp out of the solver is therefore Z-weighted; the assessment
//     weighting is applied here when energy-summing into a total.
//
// The curves live in `lib/weighting.ts` — they used to be written out by hand
// in this file, the grid and the exporters, and the three copies had already
// drifted apart.

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
  /// The band system this result was SOLVED in. Kept on the result because the
  /// project's setting can change without a re-solve, and a consumer that
  /// assumes they agree writes 31 headers over 10 numbers.
  bandSystem?: 'octave' | 'oneThirdOctave';
  /// The solved level, in the project's assessment weighting. What the user is
  /// shown as "the level".
  totalDbA: number;
  /// Tonality screen over the RECEIVED spectrum. Absent on rows that did not
  /// solve.
  tonality?: TonalityResult;
  /// What the tonality settings add to the level, in dB. Zero unless the
  /// penalty is switched on AND a tone was flagged.
  tonalityPenaltyDb?: number;
  /// The level actually compared with the limit: `totalDbA` plus any penalty.
  /// Equal to `totalDbA` whenever no penalty applies, which is the default.
  assessedDbA?: number;
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
///   - `export` — the extra period solves a receiver export needs. Queued for
///     the same reason as `study`, and in its OWN lane so an export isn't left
///     waiting behind a long factorial sweep. On `live` a background re-solve
///     would cancel it and the download would simply never arrive.
export type SolveChannel = 'live' | 'study' | 'export';

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
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        reject(new Error(`scene worker error: ${e.message || 'load failed'}`));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      this.active = { id, cleanup, reject };
      timer = window.setTimeout(() => {
        // TERMINATE, don't just reject. Leaving the worker alive meant a wedged
        // solve kept the lane occupied: the next call skipped `cancel()` (no
        // `active`) and queued behind the stuck job, so every later solve timed
        // out too and only a page reload recovered. Dropping the worker forces
        // the next call to build a clean one.
        cleanup();
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        reject(new Error('scene worker stopped responding'));
      }, TIMEOUT_MS);
      worker.postMessage({ id, scenes });
    });
  }
}

const lanes: Record<SolveChannel, SceneSolveLane> = {
  live: new SceneSolveLane(true),
  study: new SceneSolveLane(false),
  export: new SceneSolveLane(false),
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

/// Source **height above local ground** (HAG) — the machine height fed to the
/// ground-attenuation shape functions. Independent of terrain elevation.
///
/// Returns null if the catalog entry is missing.
export function sourceHagl(source: Source, project: Project): number | null {
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

/// Energy-sum Z-weighted per-band Lp values into one weighted total.
///
/// Kept as a thin alias over `weightedTotal` so the many call sites here read
/// unchanged; the arithmetic and the curves live in `lib/weighting.ts`.
/// `dOmegaDb` (default 0) is added uniformly to every band as a frequency-
/// independent solid-angle correction — see ProjectSettings.dOmegaDb.
function aWeightedTotal(perBandLp: Float64Array, aw: Float64Array, dOmegaDb: number = 0): number {
  return weightedTotal(perBandLp, aw, dOmegaDb);
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
///
/// A source switched Off for the scenario's period is dropped here too. Note
/// what that means for a BESS modelled with containers: the box goes with it,
/// so a parked unit stops screening its neighbours. Physically the container is
/// still standing, so this errs LOUD (less screening ⇒ higher levels) — the
/// conservative direction, but it is an approximation. Keeping the box while
/// silencing the source needs a screens-only source in the engine, which is
/// solver-side work; see docs/beesty-feature-plans.md.
export function resolveSources(project: Project): ResolvedSource[] {
  const out: ResolvedSource[] = [];
  const period = project.scenario.period;
  for (const source of project.sources) {
    if (!Number.isFinite(source.latLng[0]) || !Number.isFinite(source.latLng[1])) continue;
    const entry = lookupEntry(project, source);
    if (!entry) {
      console.warn(`Catalog entry not found: ${source.catalogScope}/${source.modelId}`);
      continue;
    }
    const modeName = sourceModeName(source, entry, period);
    if (modeName == null) continue;                       // Off this period
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
  const aw = weightsFor(project.scenario.bandSystem, weightingFor(project));
  const tonalityCfg = tonalitySettingsFor(project);
  const n = bandCount(project.scenario.bandSystem);
  const cutoffM = propagationSettings(project).maxContributionDistanceM;
  const dOmega = projectDOmegaDb(project);

  const sources = resolveSources(project);
  const valid = project.receivers.filter(
    (rx) => Number.isFinite(rx.latLng[0]) && Number.isFinite(rx.latLng[1]),
  );

  // Sources Off for this period are dropped DELIBERATELY — they're greyed on
  // the map and are not a problem to warn about. Counting them here made every
  // solve with an Off source raise a false "no catalog entry" warning.
  const offSources = project.sources.filter(
    (s) => sourceIsOff(s, project.scenario.period),
  ).length;
  const droppedSources = project.sources.length - sources.length - offSources;
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
  if (terrain && dem) diagnostics.note('terrain.source', 'info', terrainSourceNote(dem, terrain));
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
      const total = aWeightedTotal(summed, aw, dOmega);
      // Screened here, once, so every consumer — the results dock, the map
      // badge, the PDF and the exports — judges the same number against the
      // limit. A penalty computed independently at each site is a penalty that
      // eventually disagrees with itself.
      const tonality = tonalityCfg.enabled
        ? screenTonality(summed, project.scenario.bandSystem, tonalityCfg.method)
        : undefined;
      const penaltyDb = tonality ? tonalityPenaltyDb(tonality, tonalityCfg) : 0;
      results.set(rr.receiver_id, {
        receiverId: rr.receiver_id,
        perBandLp: summed,
        bandSystem: project.scenario.bandSystem,
        totalDbA: total,
        tonality,
        tonalityPenaltyDb: penaltyDb,
        assessedDbA: assessmentLevel(Number.isFinite(total) ? total : null, penaltyDb) ?? total,
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

/// Receiver results for all three assessment periods.
export type PeriodResults = Record<Period, ReceiverResult[]>;

/// Solve every period, for the receiver export.
///
/// The screen only ever shows the selected period — three sets of contours and
/// three levels per marker is more than anyone can read — but a compliance table
/// has to cover day, evening and night, and with per-period modes those are
/// genuinely different solves.
///
/// Periods whose sources all resolve to the SAME modes share one solve, so a
/// project that doesn't use per-period modes (every project, until someone turns
/// them on) costs exactly one solve and produces three identical columns —
/// the same numbers the export has always shown.
///
/// Accepted-risk note (review 2026-08-09, deferred to Ryan): when periods DO
/// differ, the solves run sequentially against the LIVE catalog caches, so a
/// global-catalog snapshot landing in the milliseconds between them could put
/// adjacent catalog states into one file's day and night columns. Pinning a
/// snapshot means threading a catalog view through resolveSources /
/// buildSourceTree / lookupEntry — a wide seam for a narrow window, and the
/// same window already exists between any two on-screen re-solves.
export async function evaluateAllPeriods(
  project: Project,
  dem: DemRaster | null,
  channel: SolveChannel = 'live',
): Promise<PeriodResults> {
  const out = {} as PeriodResults;
  // Which periods may share a solve is one rule, owned by `modes.ts`, because
  // the wind sweep asks the same question and must answer it identically.
  for (const periods of groupPeriodsBySolve(project)) {
    const solved = await evaluateProject(
      { ...project, scenario: { ...project.scenario, period: periods[0] } },
      dem,
      new Diagnostics(),
      channel,
    );
    for (const p of periods) out[p] = solved;
  }
  return out;
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
      const modeName = sourceModeName(es.source!, entry, project.scenario.period);
      if (modeName == null) continue;                     // Off this period
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

/// Cells per tile edge. A tile is the unit of adaptive clustering: every cell
/// in it shares one effective-source list.
const TILE_CELLS = 16;

/// A grid tile's cell block and the lat/lng footprint the Barnes-Hut walk uses
/// for it.
export interface GridTileRegion {
  col0: number; row0: number; cols: number; rows: number;
  region: LatLngBbox;
}

/// Partition a calculation area into tiles, with each tile's lat/lng footprint.
///
/// Shared by the grid builder and the Barnes-Hut debug layer, so what the
/// debug view draws is by construction the same partition the solver clusters
/// against — a debug view derived independently would eventually drift and then
/// lie, which is worse than having none.
///
/// Note the footprints are AXIS-ALIGNED and ignore `rotationDeg`: the clustering
/// walk itself works in that frame (rotation is applied later, per cell, inside
/// `runBatchedGrid`), so these are the true regions used.
export function gridTileLayout(
  ca: NonNullable<Project['calculationArea']>,
  spacingM: number,
): GridTileRegion[] {
  const origin = ca.centerLatLng;
  const cols = Math.max(2, Math.round(ca.widthM / spacingM));
  const rows = Math.max(2, Math.round(ca.heightM / spacingM));
  const dxM = ca.widthM / cols;
  const dyM = ca.heightM / rows;
  const R = 6371008.8;
  const lat0 = (origin[0] * Math.PI) / 180;
  const cellLat = (row: number) =>
    origin[0] + (((row - (rows - 1) / 2) * dyM) / R) * (180 / Math.PI);
  const cellLng = (col: number) =>
    origin[1] + (((col - (cols - 1) / 2) * dxM) / (R * Math.cos(lat0))) * (180 / Math.PI);
  const marginLat = ((dyM / 2) / R) * (180 / Math.PI);
  const marginLng = ((dxM / 2) / (R * Math.cos(lat0))) * (180 / Math.PI);

  const out: GridTileRegion[] = [];
  for (let row0 = 0; row0 < rows; row0 += TILE_CELLS) {
    const trows = Math.min(TILE_CELLS, rows - row0);
    const latLo = cellLat(row0);
    const latHi = cellLat(row0 + trows - 1);
    for (let col0 = 0; col0 < cols; col0 += TILE_CELLS) {
      const tcols = Math.min(TILE_CELLS, cols - col0);
      const lngLo = cellLng(col0);
      const lngHi = cellLng(col0 + tcols - 1);
      out.push({
        col0, row0, cols: tcols, rows: trows,
        region: {
          minLat: Math.min(latLo, latHi) - marginLat,
          maxLat: Math.max(latLo, latHi) + marginLat,
          minLng: Math.min(lngLo, lngHi) - marginLng,
          maxLng: Math.max(lngLo, lngHi) + marginLng,
        },
      });
    }
  }
  return out;
}

/// What the Barnes-Hut walk did for one tile.
export interface BhTileDebug extends GridTileRegion {
  /// Real sources passed through individually.
  real: number;
  /// Cluster stand-ins, each replacing `memberCount` real sources.
  clusters: number;
  /// Real sources represented by those clusters.
  clustered: number;
  /// Plan-view rectangles of the accepted cluster nodes, for drawing.
  clusterBoxes: Array<{
    bbox: LatLngBbox; centre: [number, number]; members: number; dbA: number;
  }>;
}

export interface BhDebug {
  tiles: BhTileDebug[];
  /// Total real sources with usable positions.
  totalSources: number;
  theta: number;
  cutoffM: number;
}

/// I — describe what the Barnes-Hut clustering is doing, for the debug layer.
///
/// Runs the SAME tree and the SAME per-tile walk the grid uses, so the numbers
/// drawn on the map are the ones the solver acted on. Returns null when there
/// is no calculation area or no usable source.
export function describeBarnesHut(project: Project, spacingM: number): BhDebug | null {
  const ca = project.calculationArea;
  if (!ca) return null;
  const cfg = propagationSettings(project);
  const tree = buildSourceTree(project, project.scenario.bandSystem, project.scenario.windSpeed);
  if (!tree) return null;

  const aw = weightsFor(project.scenario.bandSystem, weightingFor(project));
  const tiles: BhTileDebug[] = [];
  for (const t of gridTileLayout(ca, spacingM)) {
    const eff = walkSourceTreeForRegion(tree, t.region, cfg.treeAcceptanceTheta, cfg.maxContributionDistanceM);
    let real = 0; let clusters = 0; let clustered = 0;
    const clusterBoxes: BhTileDebug['clusterBoxes'] = [];
    for (const es of eff) {
      if (es.kind === 'real') { real++; continue; }
      clusters++;
      clustered += es.memberCount;
      clusterBoxes.push({
        // The accepted quadtree NODE's rectangle — its partition cell, which is
        // what the acceptance test `s/d < θ` measured. That makes it the honest
        // thing to draw: it can be larger than the members it contains, and
        // seeing that is the point. Falls back to the centroid for a node with
        // no recorded bounds.
        bbox: es.bbox ?? {
          minLat: es.latLng[0], maxLat: es.latLng[0],
          minLng: es.latLng[1], maxLng: es.latLng[1],
        },
        centre: es.latLng,
        members: es.memberCount,
        dbA: es.lwOverride ? aWeightedTotal(es.lwOverride, aw, 0) : NaN,
      });
    }
    tiles.push({ ...t, real, clusters, clustered, clusterBoxes });
  }
  // Matches the tree's own filter: an Off source is not in the tree, so a
  // total that counted it would disagree with every per-tile count below it.
  const totalSources = project.sources.filter(
    (s) => Number.isFinite(s.latLng[0]) && Number.isFinite(s.latLng[1])
      && !sourceIsOff(s, project.scenario.period),
  ).length;
  return { tiles, totalSources, theta: cfg.treeAcceptanceTheta, cutoffM: cfg.maxContributionDistanceM };
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

  // P5 — barrier culling inputs. Below a handful of barriers the filter costs
  // more than the screening it saves, so it is skipped entirely.
  const allBarriers = project.barriers ?? [];
  /// Below this, filtering costs more than the screening it saves.
  const BARRIER_CULL_MIN = 8;
  const CULL_MARGIN_M = 250;
  const cullMarginDeg = (CULL_MARGIN_M / R) * (180 / Math.PI);

  const tiles: GridTile[] = [];
  for (const t of gridTileLayout(ca, spacingM)) {
    const { col0, row0, cols: tcols, rows: trows, region } = t;
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
    const tileSources = resolveTileSources(project, tileEff);
    // P5 — cull barriers to this tile once, rather than letting the engine
    // re-test every wall for every (cell × source) pair. Every source→cell
    // path lies inside the bounding box of the tile's cells and its sources,
    // so a wall missing that box can screen nothing here. The margin is
    // generous because the engine's lateral (around-the-end) diffraction can
    // involve a wall whose body sits outside the strict path box.
    let bMinLat = t.region.minLat; let bMaxLat = t.region.maxLat;
    let bMinLng = t.region.minLng; let bMaxLng = t.region.maxLng;
    for (const src of tileSources) {
      const [la, ln] = src.latLng;
      if (la < bMinLat) bMinLat = la;
      if (la > bMaxLat) bMaxLat = la;
      if (ln < bMinLng) bMinLng = ln;
      if (ln > bMaxLng) bMaxLng = ln;
    }
    tiles.push({
      col0, row0, cols: tcols, rows: trows,
      sources: tileSources,
      barriers: allBarriers.length > BARRIER_CULL_MIN
        ? barriersForRegion(allBarriers, bMinLat, bMaxLat, bMinLng, bMaxLng, cullMarginDeg)
        : undefined,
    });
  }

  // One elevation raster for the whole job: it must cover every cell AND every
  // source, since the engine screens each source→cell path against it.
  const corners: Array<[number, number]> = [
    bounds.sw, bounds.ne, [bounds.sw[0], bounds.ne[1]], [bounds.ne[0], bounds.sw[1]],
  ];
  const sourceLatLngs = tiles.flatMap((t) => t.sources.map((s) => s.latLng));
  const containers = project.settings?.containers;
  const terrain = buildTerrainField(dem, origin, [...corners, ...sourceLatLngs], {
    despikeStrength: project.settings?.topography?.despikeStrength,
    diagnostics,
  });
  if (terrain && dem && diagnostics) {
    diagnostics.note('terrain.source', 'info', terrainSourceNote(dem, terrain));
  }

  return {
    cols, rows, dxM, dyM, origin, bounds,
    nBands: bandCount(project.scenario.bandSystem),
    weighting: weightingFor(project),
    cutoffM,
    dOmegaDb: projectDOmegaDb(project),
    rxHeightAboveGround,
    barriers: project.barriers ?? [],
    settings: sceneSettingsFor(project),
    topo: project.settings?.topography,
    terrain,
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
    return await runGridJobOnPool(job, cached, onProgress, diagnostics);
  }
}

/// P4 — the previous grid, for incremental regrids. One entry: the useful case
/// is "the thing I just computed, minus the bit I changed".
let gridCache: GridCacheEntry | null = null;

/// Drop the incremental-regrid cache. Not needed for correctness — the job
/// fingerprint covers every input — but useful to force a clean solve.
export function clearGridCache(): void {
  gridCache = null;
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
/// Reserve grows with core count (Ryan): 2 cores held back up to 8, 3 up to 16,
/// 4 beyond. A bigger machine has more going on — the main thread, the two
/// point-solve lanes, the browser's own compositor — and the marginal tile
/// worker is worth less than the responsiveness it costs. The result is still
/// monotonic in core count, so more cores never means fewer workers.
export function gridPoolSize(cores: number): number {
  const c = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 4;
  const reserve = c > 16 ? 4 : c > 8 ? 3 : 2;
  return Math.max(1, c - reserve);
}

const GRID_POOL_SIZE = gridPoolSize(
  typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4,
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
  diagnostics?: Diagnostics,
): Promise<GridResult> {
  // Newest-wins: every caller that reaches here has already superseded the
  // previous run's generation, so a still-running job's result could only be
  // discarded — letting it finish first would just delay this one by its full
  // runtime.
  if (activeGridRun) cancelGridRun();

  // P4: solve only the tiles whose resolved source list actually changed, and
  // seed the rest from the previous grid. The plan falls back to "everything"
  // on any job-level change, so a stale cell is not reachable without the
  // fingerprint itself being incomplete.
  const plan = planIncrementalGrid(job, gridCache);
  const reusedTiles = job.tiles.length - plan.dirty.length;
  if (reusedTiles > 0 && diagnostics) {
    diagnostics.note(
      'grid.incremental', 'info',
      `${reusedTiles} of ${job.tiles.length} grid tiles were unchanged and were reused `
      + 'from the previous solve rather than recomputed.',
      reusedTiles,
    );
  }

  const shards = shardTiles(plan.dirty, GRID_POOL_SIZE);
  const runId = ++gridWorkerSeq;
  const t0 = performance.now();

  return new Promise<GridResult>((resolve, reject) => {
    const dbA = new Float32Array(job.cols * job.rows).fill(-120);
    // Seed the untouched tiles before any shard lands. Disjoint from every
    // dirty tile, so nothing can be overwritten in either direction.
    if (plan.reuse) mergeShard(dbA, plan.reuse.from, plan.reuse.tiles, job.cols, job.rows);

    const doneByShard = new Array<number>(shards.length).fill(0);
    let outstanding = shards.length;
    let settled = false;

    const finish = () => {
      settled = true;
      gridCache = {
        jobKey: plan.jobKey, tileKeys: plan.tileKeys, dbA, cols: job.cols, rows: job.rows,
      };
      resolve({
        cols: job.cols, rows: job.rows, bounds: job.bounds, dbA,
        computedMs: performance.now() - t0,
      });
    };
    // Nothing changed at all — hand back the reconstructed grid without
    // starting a single worker.
    if (shards.length === 0) { finish(); return; }
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
      // The partially-filled buffer must never become the incremental baseline.
      gridCache = null;
      // Tear the pool down. The other shards are still grinding through work
      // whose result is now unusable; left alive they burn cores and, worse,
      // the NEXT run finds no active run to supersede and queues its messages
      // behind them — so a healthy pool then trips its own dead-man timer.
      for (const pw of gridPool) pw?.worker.terminate();
      gridPool = [];
      gridWorkerSeq++;
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
          onProgress?.(doneByShard.reduce((a, b) => a + b, 0), plan.dirty.length);
          return;
        }
        if (!data.ok || !data.result) { fail(new Error(data.error ?? 'grid worker failed')); return; }
        mergeShard(dbA, data.result.dbA, shardTilesList, job.cols, job.rows);
        doneByShard[si] = shardTilesList.length;
        onProgress?.(doneByShard.reduce((a, b) => a + b, 0), plan.dirty.length);
        if (--outstanding === 0) {
          cleanup();
          finish();
        }
      };
      const onError = (e: ErrorEvent) => {
        // `fail` terminates and clears the pool — a module-load failure affects
        // every worker, and clearing the array without terminating would orphan
        // any that are running.
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

//  is deliberately NOT re-exported: it is the Rust
// crate's own copy of the curve, and the point of lib/weighting.ts is that one
// implementation answers for the whole app.
export { octave_centres };
