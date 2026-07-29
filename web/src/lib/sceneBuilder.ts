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
  reflectors: [];
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

  for (const b of input.barriers ?? []) {
    const wall = wallFromBarrier(b, origin, dem);
    if (wall) obstacles.push(wall);
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
      obstacles.push({
        type: 'building',
        footprint: containerFootprint([e, n], container.lengthM, container.widthM, container.bearingDeg),
        base_z: ground,
        height_agl: container.heightM,
      });
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
    reflectors: [],
    cylinders: [],
    amisc: {},
    settings: {
      dz_cap_db: settings.dzCapDb,
      c0_db: settings.c0Db,
      ground_method: 'general',
      max_reflection_order: 1,
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

/** Project origin — the local-metres datum. Must match everywhere. */
export function projectOrigin(project: Project): [number, number] {
  return (
    project.calculationArea?.centerLatLng
    ?? project.receivers[0]?.latLng
    ?? project.sources[0]?.latLng
    ?? [0, 0]
  );
}
