// Wind-direction-dependent correction between a source and a receiver.
//
// ISO 9613-2 is a DOWNWIND method: every receiver is treated as if the wind
// were blowing straight at it. That is deliberately conservative and it is what
// BESSTY does everywhere else — but a curtailment schedule computed that way
// curtails for a wind direction that only occurs some of the time. Knowing
// which way the wind is blowing lets a receiver upwind of a turbine be credited
// with the reduction it actually gets, which is the whole point of directional
// curtailment.
//
// This is an APPROXIMATION applied on top of an unchanged solve — no
// re-propagation, just a per-pair dB offset. It follows the rule used in
// Resonate's standalone curtailment tool so the two agree:
//
//     receiver within ±60° of downwind → no adjustment
//     otherwise                        → −2 dB
//
// The structure is deliberately more general than that rule needs, because the
// rule is expected to grow: a distinct sidewind value, and an upwind treatment
// following the standard rather than a flat −2 dB. Sectors, per-band results
// and distance are all already in the shape, so that change is a new model
// rather than a new plumbing.
//
// CONVENTION, and the one thing here that is easy to get exactly backwards:
// `windFromDeg` is METEOROLOGICAL — the direction the wind blows FROM, which is
// how every wind rose and met file states it. A receiver is downwind when it
// lies opposite that, at `windFromDeg + 180`.

/// Compass bearing from `a` to `b`, degrees clockwise from true north.
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const lat1 = a[0] * toRad;
  const lat2 = b[0] * toRad;
  const dLng = (b[1] - a[1]) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/// Smallest angle between two bearings, 0–180°.
export function angleBetweenDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/// How far off downwind a receiver is: 0° means the wind blows straight from
/// the source towards it, 180° means straight away from it.
export function offDownwindDeg(bearingSourceToReceiver: number, windFromDeg: number): number {
  const downwind = (windFromDeg + 180) % 360;
  return angleBetweenDeg(bearingSourceToReceiver, downwind);
}

export type WindSector = 'downwind' | 'crosswind' | 'upwind';

/// Everything a directivity model might need about one source→receiver pair.
///
/// `distanceM` and the heights are unused by the sector model but are part of
/// the contract: an upwind treatment that follows the standard is expected to
/// depend on geometry, not just on angle.
export interface DirectivityContext {
  bearingDeg: number;
  windFromDeg: number;
  distanceM: number;
  sourceHeightM: number;
  receiverHeightM: number;
}

/// A dB offset for a pair. A scalar applies to every band; an array is per
/// band, for a model that varies with frequency.
export type DirectivityAdjustment = number | Float64Array;

/// The three-sector approximation.
///
/// With `crosswindHalfAngleDeg` at 180 there is no upwind sector at all and
/// this is exactly the current rule: downwind or not. Narrowing it splits the
/// remainder into sidewind and upwind without touching anything else.
export interface SectorDirectivity {
  kind: 'sector';
  /// Half-width of the downwind sector. Inside it, no adjustment.
  downwindHalfAngleDeg: number;
  /// Half-width of the crosswind sector, measured from the DOWNWIND direction
  /// (so it must exceed `downwindHalfAngleDeg`). 180 = no upwind sector.
  crosswindHalfAngleDeg: number;
  crosswindDb: number;
  upwindDb: number;
}

export type DirectivityModel = { kind: 'none' } | SectorDirectivity;

/// The rule the standalone tool applies, and the default here: nothing within
/// ±60° of downwind, −2 dB everywhere else.
export const DEFAULT_DIRECTIVITY: SectorDirectivity = {
  kind: 'sector',
  downwindHalfAngleDeg: 60,
  crosswindHalfAngleDeg: 180,
  crosswindDb: -2,
  upwindDb: -2,
};

export function sectorFor(model: SectorDirectivity, offDownwind: number): WindSector {
  if (offDownwind <= model.downwindHalfAngleDeg) return 'downwind';
  if (offDownwind <= model.crosswindHalfAngleDeg) return 'crosswind';
  return 'upwind';
}

/// The dB offset for one pair. Negative reduces the received level.
export function directivityAdjustmentDb(
  model: DirectivityModel,
  ctx: DirectivityContext,
): DirectivityAdjustment {
  if (model.kind === 'none') return 0;
  const off = offDownwindDeg(ctx.bearingDeg, ctx.windFromDeg);
  switch (sectorFor(model, off)) {
    case 'downwind': return 0;
    case 'crosswind': return model.crosswindDb;
    case 'upwind': return model.upwindDb;
  }
}

/// Read one band out of an adjustment, whichever form it took.
export function adjustmentAtBand(adj: DirectivityAdjustment | undefined, band: number): number {
  if (adj === undefined) return 0;
  return typeof adj === 'number' ? adj : (adj[band] ?? 0);
}

/// Compass points for labelling a swept direction.
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/// "270° (W)" — the direction the wind is coming FROM.
export function describeWindFrom(deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return `${Math.round(deg)}° (${COMPASS[i]})`;
}

/// Wind directions to sweep, in degrees FROM, at the given step.
export function sweepDirections(stepDeg: number): number[] {
  const step = Math.max(1, Math.round(stepDeg));
  const out: number[] = [];
  for (let d = 0; d < 360; d += step) out.push(d);
  return out;
}
