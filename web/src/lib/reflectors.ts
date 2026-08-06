// I18 — reflecting surfaces, and the budget that decides how many survive.
//
// The engine implements specular reflection (§7.5, plus the 2024 higher-order
// and cylindrical cases) and it is conformance-validated. What it needs from us
// is a list of `Reflector` facades, kept SEPARATE from the screening
// `obstacles` — the engine keeps them apart deliberately so a reflected ray is
// not also diffracted by the same surface. A wall that both screens and
// reflects therefore appears in BOTH lists. That looks like duplication and
// is not.
//
// The binding constraint is the engine's path-enumeration guard: for order k it
// enumerates Σ m·(m−1)^(k−1) sequences over m reflectors and REJECTS the scene
// above 100 000. At order 3 that caps a scene at 46 surfaces. A BESS container
// contributes 4 facades, so a naive "reflect everything" dies at ~11 units,
// and a real site has hundreds. Culling is therefore part of the feature, not
// an optimisation, and when culling still can't fit we DEGRADE THE ORDER rather
// than fail — a rejected scene surfaces to the user as a failed solve.

export interface Facade {
  /// Plan-view segment, local metres.
  segment: [[number, number], [number, number]];
  base_z: number;
  top_z: number;
  /// Absorption coefficient; 0 = perfectly reflecting.
  alpha: number;
}

/// The engine's guard (`scene/mod.rs`): Σ_{k=2..order} m·(m−1)^(k−1) ≤ 100 000.
export const MAX_ENUMERATED_PATHS = 100_000;

/// How many sequences `m` reflectors enumerate at `order`.
export function enumeratedPaths(m: number, order: number): number {
  if (order < 2 || m < 2) return 0;
  let count = 0;
  for (let k = 2; k <= order; k++) count += m * Math.pow(m - 1, k - 1);
  return count;
}

/// Largest reflector count that fits the guard at `order`.
export function maxReflectorsFor(order: number): number {
  if (order < 2) return Number.MAX_SAFE_INTEGER;   // first order is unbounded
  let m = 2;
  while (enumeratedPaths(m + 1, order) <= MAX_ENUMERATED_PATHS) m++;
  return m;
}

/// Squared distance from point `p` to segment `ab`, in plan.
function distSqToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  const cx = a[0] + t * vx;
  const cy = a[1] + t * vy;
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  return dx * dx + dy * dy;
}

/// Do segments `ab` and `cd` cross? Used so an intersecting pair scores 0
/// rather than the (positive) endpoint distance.
function segmentsIntersect(
  a: [number, number], b: [number, number], c: [number, number], d: [number, number],
): boolean {
  const cross = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/// Closest approach between two plan segments (m).
export function segmentDistance(
  a: [number, number], b: [number, number], c: [number, number], d: [number, number],
): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  // Non-crossing segments: the minimum is attained at one of the four
  // endpoint-to-other-segment distances.
  return Math.sqrt(Math.min(
    distSqToSegment(a, c, d),
    distSqToSegment(b, c, d),
    distSqToSegment(c, a, b),
    distSqToSegment(d, a, b),
  ));
}

export interface CullOptions {
  /// Half-width of the corridor around each source→receiver line (m).
  corridorM?: number;
  /// Requested reflection order.
  order: number;
}

export interface CullResult {
  facades: Facade[];
  /// The order actually usable — degraded when the budget couldn't take the
  /// requested one.
  order: number;
  /// How many facades were dropped by the budget cap (after corridor culling).
  droppedForBudget: number;
  /// True when `order` is below what was asked for.
  degraded: boolean;
}

/// Keep the facades that could plausibly carry a specular path between any
/// source and any receiver, nearest-first, within the engine's budget.
///
/// Three filters, in order of how much they remove:
///  1. **Corridor** — a facade whose plan segment lies far from every
///     source→receiver line cannot host a reflection point on the useful part
///     of the path.
///  2. **Degenerate** — zero-length or zero-height facades, and fully
///     absorptive ones (α ≥ 1 contributes `10·lg(1−α)` = −∞).
///  3. **Budget** — nearest-first truncation, then order degradation.
///
/// Back-facing culling is deliberately NOT done here: whether a facade faces
/// the path depends on the specific source/receiver pair, and the engine
/// already rejects non-specular geometry per pair. Dropping by orientation up
/// front would silently lose valid paths in a multi-receiver scene.
export function cullFacades(
  facades: readonly Facade[],
  sources: ReadonlyArray<[number, number]>,
  receivers: ReadonlyArray<[number, number]>,
  opts: CullOptions,
): CullResult {
  const corridor = opts.corridorM ?? 250;

  const usable = facades.filter((f) => {
    const [a, b] = f.segment;
    if (f.top_z <= f.base_z) return false;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return false;
    return f.alpha < 1;
  });

  // Score each facade by how close it comes to the nearest source→receiver
  // line; anything outside the corridor is dropped.
  const scored: Array<{ f: Facade; d: number }> = [];
  for (const f of usable) {
    let best = Infinity;
    for (const s of sources) {
      for (const r of receivers) {
        // SEGMENT-to-SEGMENT distance, and both ends matter.
        //
        // Distance to the SOURCE→RECEIVER segment rather than its infinite
        // line: a specular reflection point lies between source and receiver,
        // so a facade far beyond either endpoint is irrelevant however
        // collinear it happens to be. (Using the infinite line kept a facade
        // 10 km down-range, because its perpendicular distance was zero.)
        //
        // And the whole FACADE rather than its midpoint: facades are now one
        // per drawn wall edge, so a single long wall running alongside a path
        // has a midpoint far from it — a 1 km wall passing 20 m from a 200 m
        // path scores ~300 m on its midpoint and was dropped entirely, taking
        // a reflection whose specular point sits 20 m away with it. Measuring
        // the closest approach of the two segments keeps it.
        const d = segmentDistance(f.segment[0], f.segment[1], s, r);
        if (d < best) best = d;
        if (best === 0) break;
      }
      if (best === 0) break;
    }
    if (best <= corridor) scored.push({ f, d: best });
  }
  scored.sort((x, y) => x.d - y.d);

  // Fit the budget: try the requested order, degrade until the surviving set
  // fits, and only then truncate.
  let order = Math.max(1, Math.min(4, Math.round(opts.order)));
  const requested = order;
  let cap = maxReflectorsFor(order);
  while (order > 1 && scored.length > cap) {
    order--;
    cap = maxReflectorsFor(order);
  }
  const kept = scored.slice(0, Math.min(scored.length, cap));
  return {
    facades: kept.map((s) => s.f),
    order,
    droppedForBudget: scored.length - kept.length,
    degraded: order < requested,
  };
}

/// The four vertical facades of a rectangular container, from its plan corners.
export function facadesFromFootprint(
  corners: ReadonlyArray<[number, number]>,
  baseZ: number,
  heightM: number,
  alpha: number,
): Facade[] {
  const out: Facade[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    out.push({ segment: [a, b], base_z: baseZ, top_z: baseZ + heightM, alpha });
  }
  return out;
}
