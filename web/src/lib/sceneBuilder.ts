// BEESTY project model → solver `Scene` JSON.
//
// The wasm engine is driven entirely by a serialisable Scene (sources,
// receivers, ground, terrain, obstacles, atmosphere, settings). This module is
// the ONLY place that shape is assembled — see `web/src/wasm/README.md` for the
// schema conventions it targets.
//
// Deliberately **worker-safe and pure**: it imports types and geo helpers only,
// never the catalog (which drags in firebase) and never the wasm module. Callers
// resolve catalog data into `ResolvedSource`s first (`solver.ts`), so both the
// main-thread receiver path and the grid worker can share this builder.
//
// Two datums, both required by the engine and easy to confuse:
//   • `position[2]` = z_abs — ABSOLUTE elevation (DEM ground + height above
//     ground). Drives divergence, atmospheric absorption and all diffraction
//     geometry, and must share the datum of barrier/terrain elevations.
//   • `height_agl`  = height above LOCAL ground. Drives the ground-effect
//     (Table 3) shape functions only.
// On flat ground at elevation 0 they coincide, which is why mixing them up
// survives casual testing.

import type { Barrier, BandSystem, Project } from './types';
import type { DemRaster } from './dem';
import { latLngToLocalMetres } from './geo';
import { cullFacades, facadesFromFootprint, type Facade } from './reflectors';

// ---------------------------------------------------------------- Scene JSON

/** `[e, n, z_abs]` in local metres relative to the project origin. */
export type ScenePos = [number, number, number];

export interface SceneSourceKind {
  type: 'general' | 'wind_turbine' | 'chimney_stack';
  rotor_diameter_m?: number;
  apply_concave?: boolean;
  opening_radius_m?: number;
}

export interface SceneSource {
  id: string;
  kind: SceneSourceKind;
  position: ScenePos;
  height_agl: number;
  lw: number[];
}

export interface SceneReceiver {
  id: string;
  position: ScenePos;
  height_agl: number;
}

/** Thin screen: plan polyline + absolute ground under each vertex. When
 *  `top_z` is present it IS the crest (absolute) and `height_agl` is ignored. */
export interface SceneWall {
  type: 'wall';
  polyline: Array<[number, number]>;
  base_z: number[];
  height_agl: number;
  top_z: number[] | null;
}

/** Closed footprint extruded to a flat roof (used for source containers). */
export interface SceneBuilding {
  type: 'building';
  footprint: Array<[number, number]>;
  base_z: number;
  height_agl: number;
}

export type SceneObstacle = SceneWall | SceneBuilding;

/** A reflecting vertical facade (§7.5). `alpha` 0 = perfectly reflecting. */
export interface SceneReflector {
  segment: [[number, number], [number, number]];
  base_z: number;
  top_z: number;
  alpha: number;
}

export interface SceneHeightfield {
  type: 'heightfield';
  origin: [number, number];
  spacing: number;
  nx: number;
  ny: number;
  heights: number[];
}

export interface Scene {
  schema_version: number;
  standard: 'iso9613-2:1996' | 'iso9613-2:2024';
  atmosphere: { temperature_c: number; relative_humidity_pct: number; pressure_kpa: number };
  ground: { default_g: number; regions: [] };
  terrain: SceneHeightfield | null;
  sources: SceneSource[];
  extended_sources: [];
  receivers: SceneReceiver[];
  obstacles: SceneObstacle[];
  /// I18: reflecting facades. Kept SEPARATE from `obstacles` by the engine's
  /// design, so a reflected ray isn't also diffracted by the same surface — a
  /// wall that both screens and reflects appears in both lists.
  reflectors: SceneReflector[];
  cylinders: [];
  amisc: Record<string, never>;
  settings: {
    dz_cap_db: number | null;
    c0_db: number;
    ground_method: 'general';
    max_reflection_order: number;
  };
}

/**
 * Per-receiver / per-source results as returned by the engine.
 *
 * Note there is no per-receiver band array: the engine reports each source's
 * contribution, and the caller energy-sums them (which is also where BEESTY's
 * `DΩ` term is applied). `total_dba` is `null` when nothing contributes (−∞).
 */
export interface SceneResults {
  per_receiver: Array<{
    receiver_id: string;
    total_dba: number | null;
    per_source: Array<{ source_id: string; bands: number[] }>;
  }>;
}

// ------------------------------------------------------------------- inputs

/** A source with all catalog lookups already resolved (see `solver.ts`). */
export interface ResolvedSource {
  id: string;
  latLng: [number, number];
  /** Height above local ground of the acoustic centre (m). */
  heightAglM: number;
  /** Z-weighted per-band sound power; length must match the band system. */
  lw: number[];
  /** Wind turbines take the Annex D rules; everything else is a general point. */
  wtg?: { rotorDiameterM: number; applyConcave: boolean };
  /** Optional screening box around the unit (Phase 5). */
  container?: { lengthM: number; widthM: number; heightM: number; bearingDeg: number };
}

export interface SceneReceiverInput {
  id: string;
  latLng: [number, number];
  heightAboveGroundM: number;
}

export interface SceneSettings {
  standard: 'iso9613-2:1996' | 'iso9613-2:2024';
  defaultG: number;
  atmosphere: { temperatureC: number; relativeHumidityPct: number; pressureKpa: number };
  /** `null` = use the standard ISO §7.4 caps (20 dB single / 25 dB multi-edge). */
  dzCapDb: number | null;
  c0Db: number;
}

export interface SceneInput {
  origin: [number, number];
  sources: ResolvedSource[];
  receivers: SceneReceiverInput[];
  barriers: Barrier[];
  dem: DemRaster | null;
  terrain: SceneHeightfield | null;
  settings: SceneSettings;
  /** Emit `Building` obstacles for sources that carry a container. */
  includeContainers?: boolean;
  /// I18: emit reflecting facades for barriers (and containers, when those are
  /// modelled). Off ⇒ `reflectors` stays empty and nothing reflects.
  includeReflections?: boolean;
  /// Requested specular order (1–4). Degraded automatically if the reflector
  /// count would blow the engine's path-enumeration guard.
  maxReflectionOrder?: number;
  /// Receiver positions to CULL reflecting facades against, when the scene's
  /// own `receivers` list is not yet populated.
  ///
  /// The grid builds one Scene per tile with `receivers: []` and swaps the
  /// cells in afterwards via `WasmSession::set_receivers` — so the corridor
  /// cull had no receiver to measure a facade against, every facade scored
  /// `Infinity`, and CONTOURS SILENTLY GOT NO REFLECTIONS AT ALL while point
  /// receivers (which pass real receivers here) worked. The grid now passes
  /// its tile's cell extent.
  cullReceiversLatLng?: Array<[number, number]>;
  /// Absorption for container facades. Fixed at 0 (perfectly reflecting) and
  /// deliberately NOT exposed to users yet — Ryan wants to understand how the
  /// property behaves in the model before it becomes a knob people can turn.
  containerAlpha?: number;
  /** Clearance of the acoustic centre above a container roof (m). */
  roofOffsetM?: number;
}

// ------------------------------------------------------------------ helpers

/** Longest wall sub-segment (m). A drawn polyline is densified to at most this
 *  spacing so each vertex carries its own DEM ground elevation and the crest
 *  follows the terrain, rather than interpolating linearly end-to-end. */
const MAX_WALL_SEGMENT_M = 10;

const SCHEMA_VERSION = 1;

export function bandLength(bs: BandSystem): number {
  return bs === 'oneThirdOctave' ? 31 : 10;
}

/** DEM ground elevation, with the same non-finite → 0 guard the app has always
 *  applied (a DEM hole must not poison the geometry). */
export function groundAt(dem: DemRaster | null, latLng: [number, number]): number {
  if (!dem) return 0;
  const g = dem.elevation(latLng[0], latLng[1]);
  return Number.isFinite(g) ? g : 0;
}

const finiteLatLng = (p: [number, number]): boolean => Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * Rectangle corners (plan, local metres) for a container: `lengthM` along the
 * bearing, `widthM` across it, centred on `centre`.
 *
 * `bearingDeg` is a compass bearing — 0° = long axis pointing north, increasing
 * clockwise — so it matches how rows are described on the map.
 */
export function containerFootprint(
  centre: [number, number],
  lengthM: number,
  widthM: number,
  bearingDeg: number,
): Array<[number, number]> {
  const th = (bearingDeg * Math.PI) / 180;
  // Long axis (bearing) and its perpendicular, in (east, north).
  const ax: [number, number] = [Math.sin(th), Math.cos(th)];
  const px: [number, number] = [Math.cos(th), -Math.sin(th)];
  const hl = lengthM / 2;
  const hw = widthM / 2;
  return ([[+1, +1], [+1, -1], [-1, -1], [-1, +1]] as Array<[number, number]>).map(
    ([sl, sw]) => [
      centre[0] + ax[0] * hl * sl + px[0] * hw * sw,
      centre[1] + ax[1] * hl * sl + px[1] * hw * sw,
    ] as [number, number],
  );
}

/**
 * One BEESTY barrier → one `Wall` obstacle.
 *
 * The polyline is densified to ≤ `MAX_WALL_SEGMENT_M` so each vertex samples the
 * DEM under itself; `top_z` is the absolute crest (ground + the interpolated
 * per-vertex top height). Emitting ONE wall per barrier (rather than a wall per
 * 10 m piece) matters now that lateral diffraction is live: the engine takes
 * around-the-end paths from the polyline's two real ENDS, which is the physical
 * behaviour — a chain of independent stubs would invent interior end edges.
 *
 * Note `Barrier.baseFromGroundM` is intentionally unused, matching the previous
 * engine behaviour (walls are founded on the ground under them).
 */
/**
 * Reflecting facades for a barrier — **one per DRAWN edge**, not per densified
 * sub-segment.
 *
 * This distinction is load-bearing, and getting it wrong is invisible in the
 * output. Screening needs the polyline densified to [`MAX_WALL_SEGMENT_M`] so
 * each vertex samples its own DEM elevation; reflection must NOT inherit that
 * densification, for two reasons:
 *
 *  - **The Fresnel size gate.** ISO 9613-2 Eq 26/27 accepts a specular
 *    reflection only where the facade is large enough to be specular at that
 *    wavelength, via `leff = min(a·cos αa, h·cos αh)` over the facade's FULL
 *    extent. Chopping a 320 m wall into 10 m pieces collapses `a` from 320 to
 *    10, and at the grazing incidence typical of a wall running alongside a
 *    path `cos αa` is small too — so a long, obviously-reflective wall was
 *    silently rejected in every band but the very highest. The wall a user drew
 *    is the surface the gate must judge.
 *  - **The reflector budget.** The engine enumerates ≤ 100 000 paths, which is
 *    46 surfaces at order 3 (see `reflectors.ts`). One 320 m wall was spending
 *    32 of them, so a single long barrier could crowd out every other reflector
 *    or force the whole scene's order down.
 *
 * Ground elevation still comes from the densified samples: the facade's base
 * takes the lowest ground along the edge and its top the mean crest, so a wall
 * over undulating ground reflects off a sensible rectangle rather than one
 * pinned to whichever elevation its two end vertices happened to land on.
 */
export function facadesFromBarrier(
  barrier: Barrier,
  origin: [number, number],
  dem: DemRaster | null,
  alpha: number,
): Facade[] {
  const poly = barrier.polylineLatLng;
  if (!poly || poly.length < 2) return [];
  const h0 = barrier.topHeightsM?.[0] ?? 0;
  const out: Facade[] = [];

  for (let v = 0; v + 1 < poly.length; v++) {
    const p0 = poly[v];
    const p1 = poly[v + 1];
    if (!finiteLatLng(p0) || !finiteLatLng(p1)) continue;
    if (p0[0] === p1[0] && p0[1] === p1[1]) continue;
    const hStart = barrier.topHeightsM?.[v] ?? h0;
    const hEnd = barrier.topHeightsM?.[v + 1] ?? h0;
    const [e0, n0] = latLngToLocalMetres(p0, origin);
    const [e1, n1] = latLngToLocalMetres(p1, origin);

    // Sample the ground along the edge at the screening pitch, so the facade's
    // base and crest reflect the terrain the wall actually stands on.
    const segLen = Math.hypot(e1 - e0, n1 - n0);
    const nSub = Math.max(1, Math.ceil(segLen / MAX_WALL_SEGMENT_M));
    let baseZ = Infinity;
    let topSum = 0;
    for (let k = 0; k <= nSub; k++) {
      const t = k / nSub;
      const latLng: [number, number] = [
        p0[0] + (p1[0] - p0[0]) * t,
        p0[1] + (p1[1] - p0[1]) * t,
      ];
      const g = groundAt(dem, latLng);
      const h = Math.max(0, hStart + (hEnd - hStart) * t);
      if (g < baseZ) baseZ = g;
      topSum += g + h;
    }
    const topZ = topSum / (nSub + 1);
    if (!Number.isFinite(baseZ) || !(topZ > baseZ)) continue;
    out.push({ segment: [[e0, n0], [e1, n1]], base_z: baseZ, top_z: topZ, alpha });
  }
  return out;
}

export function wallFromBarrier(
  barrier: Barrier,
  origin: [number, number],
  dem: DemRaster | null,
): SceneWall | null {
  const poly = barrier.polylineLatLng;
  if (!poly || poly.length < 2) return null;
  const h0 = barrier.topHeightsM?.[0] ?? 0;

  const latLngs: Array<[number, number]> = [];
  const heights: number[] = [];
  for (let v = 0; v + 1 < poly.length; v++) {
    const p0 = poly[v];
    const p1 = poly[v + 1];
    if (!finiteLatLng(p0) || !finiteLatLng(p1)) return null;
    // A double-clicked vertex would otherwise emit a zero-length segment.
    if (p0[0] === p1[0] && p0[1] === p1[1]) continue;
    const hStart = barrier.topHeightsM?.[v] ?? h0;
    const hEnd = barrier.topHeightsM?.[v + 1] ?? h0;
    const [e0, n0] = latLngToLocalMetres(p0, origin);
    const [e1, n1] = latLngToLocalMetres(p1, origin);
    const segLen = Math.hypot(e1 - e0, n1 - n0);
    const nSub = Math.max(1, Math.ceil(segLen / MAX_WALL_SEGMENT_M));
    // Emit this edge's vertices except the last (the next edge contributes it);
    // the final vertex of the polyline is appended after the loop.
    for (let k = 0; k < nSub; k++) {
      const t = k / nSub;
      latLngs.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]);
      heights.push(hStart + (hEnd - hStart) * t);
    }
  }
  if (latLngs.length === 0) return null;   // every segment was degenerate
  const last = poly[poly.length - 1];
  latLngs.push(last);
  heights.push(barrier.topHeightsM?.[poly.length - 1] ?? h0);

  const polyline: Array<[number, number]> = [];
  const base_z: number[] = [];
  const top_z: number[] = [];
  for (let i = 0; i < latLngs.length; i++) {
    const [e, n] = latLngToLocalMetres(latLngs[i], origin);
    const g = groundAt(dem, latLngs[i]);
    polyline.push([e, n]);
    base_z.push(g);
    top_z.push(g + Math.max(0, heights[i]));
  }
  // `top_z` carries the crest, so `height_agl` is ignored by the engine.
  return { type: 'wall', polyline, base_z, height_agl: 0, top_z };
}

// ------------------------------------------------------------------- builder

/**
 * Assemble the `Scene` for one solve.
 *
 * Pure: no wasm, no network, no catalog. Every position is local metres about
 * `input.origin`; every elevation is absolute and shares the DEM datum.
 */
export function buildScene(input: SceneInput): Scene {
  const { origin, dem, settings } = input;
  const roofOffsetM = input.roofOffsetM ?? 0.3;
  const obstacles: SceneObstacle[] = [];
  // I18: candidate reflecting facades, culled to the engine's budget below.
  const candidateFacades: Facade[] = [];
  const wantReflections = input.includeReflections ?? false;

  for (const b of input.barriers ?? []) {
    const wall = wallFromBarrier(b, origin, dem);
    if (!wall) continue;
    obstacles.push(wall);
    // The SAME wall is also listed as reflectors. The engine separates the two
    // lists so a reflected ray isn't re-diffracted by the surface it bounced
    // off; listing twice is the intended usage, not double-counting.
    if (wantReflections) {
      const alpha = Number.isFinite(b.absorptionCoeff)
        ? Math.max(0, Math.min(1, b.absorptionCoeff))
        : 0.1;
      candidateFacades.push(...facadesFromBarrier(b, origin, dem, alpha));
    }
  }

  const sources: SceneSource[] = [];
  for (const s of input.sources) {
    if (!finiteLatLng(s.latLng) || !Number.isFinite(s.heightAglM)) continue;
    const [e, n] = latLngToLocalMetres(s.latLng, origin);
    const ground = groundAt(dem, s.latLng);

    // A container screens its own source unless the acoustic centre sits on or
    // above the roof — clamp it there, and raise `height_agl` by the same amount
    // so the ground-effect heights stay consistent with the geometry.
    let heightAgl = s.heightAglM;
    const container = input.includeContainers ? s.container : undefined;
    if (container) {
      heightAgl = Math.max(heightAgl, container.heightM + roofOffsetM);
      const footprint = containerFootprint(
        [e, n], container.lengthM, container.widthM, container.bearingDeg,
      );
      obstacles.push({
        type: 'building',
        footprint,
        base_z: ground,
        height_agl: container.heightM,
      });
      // A hard-faced container row bouncing sound at a receiver is a real
      // effect, so its four facades are reflector candidates too.
      if (wantReflections) {
        // α = 0: a perfectly reflecting box. Steel container walls are close to
        // that, and holding it fixed means any reflection effect seen in the
        // model is the GEOMETRY, not a tuned absorption number.
        candidateFacades.push(...facadesFromFootprint(
          footprint, ground, container.heightM, input.containerAlpha ?? 0,
        ));
      }
    }

    sources.push({
      id: s.id,
      kind: s.wtg
        ? { type: 'wind_turbine', rotor_diameter_m: s.wtg.rotorDiameterM, apply_concave: s.wtg.applyConcave }
        : { type: 'general' },
      position: [e, n, ground + heightAgl],
      height_agl: heightAgl,
      lw: s.lw,
    });
  }

  const receivers: SceneReceiver[] = [];
  for (const r of input.receivers) {
    if (!finiteLatLng(r.latLng)) continue;
    const [e, n] = latLngToLocalMetres(r.latLng, origin);
    const ground = groundAt(dem, r.latLng);
    receivers.push({
      id: r.id,
      position: [e, n, ground + r.heightAboveGroundM],
      height_agl: r.heightAboveGroundM,
    });
  }

  // I18: fit the candidate facades into the engine's path-enumeration guard,
  // degrading the order rather than emitting a scene the engine will reject.
  // Cull against the scene's receivers, or — when they are added later, as the
  // grid does — against the extent the caller says they will occupy. Culling
  // against an empty list would drop every facade.
  const cullTargets: Array<[number, number]> = input.cullReceiversLatLng
    ? input.cullReceiversLatLng.map((ll) => latLngToLocalMetres(ll, origin))
    : receivers.map((r) => [r.position[0], r.position[1]] as [number, number]);
  const cull = wantReflections && candidateFacades.length > 0 && cullTargets.length > 0
    ? cullFacades(
        candidateFacades,
        sources.map((s) => [s.position[0], s.position[1]] as [number, number]),
        cullTargets,
        { order: input.maxReflectionOrder ?? 1 },
      )
    : null;
  const reflectors: SceneReflector[] = cull ? cull.facades : [];
  const reflectionOrder = cull ? cull.order : 1;

  return {
    schema_version: SCHEMA_VERSION,
    standard: settings.standard,
    atmosphere: {
      temperature_c: settings.atmosphere.temperatureC,
      relative_humidity_pct: settings.atmosphere.relativeHumidityPct,
      pressure_kpa: settings.atmosphere.pressureKpa,
    },
    ground: { default_g: settings.defaultG, regions: [] },
    terrain: input.terrain,
    sources,
    extended_sources: [],
    receivers,
    obstacles,
    reflectors,
    cylinders: [],
    amisc: {},
    settings: {
      dz_cap_db: settings.dzCapDb,
      c0_db: settings.c0Db,
      ground_method: 'general',
      max_reflection_order: reflectionOrder,
    },
  };
}

/**
 * Read the solver-relevant settings off a project, applying the same defaults
 * the app has always used (ISO reference atmosphere; G = 0.5; standard caps).
 *
 * `standard` defaults to the 2024 edition — the behaviour every pre-existing
 * project was computed with.
 */
export function sceneSettingsFor(project: Project): SceneSettings {
  const s = project.settings;
  const atm = s?.atmosphere;
  const cap = s?.barrierDiffractionCapDb;
  return {
    standard: s?.standard === '1996' ? 'iso9613-2:1996' : 'iso9613-2:2024',
    defaultG: s?.ground?.defaultG ?? 0.5,
    atmosphere: {
      temperatureC: atm?.temperatureC ?? 10,
      relativeHumidityPct: atm?.relativeHumidityPct ?? 70,
      pressureKpa: atm?.pressureKpa ?? 101.325,
    },
    dzCapDb: cap != null && Number.isFinite(cap) && cap >= 0 ? cap : null,
    c0Db: s?.meteorology?.c0Db ?? 0,
  };
}

/**
 * Partition receivers so that every receiver in a group agrees with the others
 * about each wind-turbine source's Annex D.5 concave-ground verdict.
 *
 * Why this exists: D.5 (the −3 dB concave-ground correction) is a per
 * source→RECEIVER condition — it asks whether the ground dips away beneath that
 * particular path. The Scene model carries `apply_concave` on the SOURCE, so one
 * scene can only express one verdict per turbine. Solving a batch of receivers
 * that disagree would silently misapply ±3 dB to some pairs.
 *
 * So: bucket receivers by their verdict vector and solve one scene per bucket.
 * Cost in practice is nil — a project with no turbines yields exactly one group
 * (the overwhelmingly common BESS case), and a wind farm on consistent terrain
 * usually yields one or two.
 *
 * `concaveFor(source, receiver)` supplies the verdict (the app's existing
 * `concaveCorrectionMet`); groups arrive in first-appearance order so results
 * can be reassembled deterministically.
 */
export function groupReceiversByConcave<R>(
  sources: ResolvedSource[],
  receivers: R[],
  concaveFor: (source: ResolvedSource, receiver: R) => boolean,
): Array<{ concaveBySourceId: Map<string, boolean>; receivers: R[] }> {
  const wtgs = sources.filter((s) => s.wtg);
  if (wtgs.length === 0 || receivers.length === 0) {
    return receivers.length ? [{ concaveBySourceId: new Map(), receivers }] : [];
  }
  const groups = new Map<string, { concaveBySourceId: Map<string, boolean>; receivers: R[] }>();
  for (const rx of receivers) {
    const flags = wtgs.map((s) => concaveFor(s, rx));
    const key = flags.map((f) => (f ? '1' : '0')).join('');
    let g = groups.get(key);
    if (!g) {
      g = { concaveBySourceId: new Map(wtgs.map((s, i) => [s.id, flags[i]])), receivers: [] };
      groups.set(key, g);
    }
    g.receivers.push(rx);
  }
  return [...groups.values()];
}

/** Apply a group's concave verdicts to the sources feeding its scene. */
export function withConcave(
  sources: ResolvedSource[],
  concaveBySourceId: Map<string, boolean>,
): ResolvedSource[] {
  if (concaveBySourceId.size === 0) return sources;
  return sources.map((s) =>
    s.wtg && concaveBySourceId.has(s.id)
      ? { ...s, wtg: { ...s.wtg, applyConcave: concaveBySourceId.get(s.id)! } }
      : s,
  );
}

/** Project origin — the local-metres datum. Must match everywhere. */
export function projectOrigin(project: Project): [number, number] {
  return (
    project.calculationArea?.centerLatLng
    ?? project.receivers[0]?.latLng
    ?? project.sources[0]?.latLng
    ?? [0, 0]
  );
}
