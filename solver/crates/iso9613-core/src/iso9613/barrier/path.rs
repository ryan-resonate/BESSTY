//! Geometry of the diffracted ray over barrier top edges (ISO 9613-2:2024
//! 7.4.1, Figure 8 — the "rubber-band" path in the vertical plane through
//! source and receiver). This construction is also the ISO/TR 17534-3 §5.2
//! recommended method for the 1996 edition, so it is edition-independent.

use crate::units::Vec3;

/// A point in the vertical plane defined by source and receiver. `x` is the
/// horizontal distance from the source's plan-view position along the SR
/// axis (metres); `z` is the absolute height (metres).
#[derive(Copy, Clone, Debug)]
pub struct DiffractionEdge {
    pub x: f64,
    pub z: f64,
}

/// A straight wall barrier defined by two plan-view endpoints, the absolute
/// ground elevation under each endpoint, and the barrier height above ground.
///
/// The wall **follows the terrain**: at any point along its length the top
/// sits at `ground + height_agl`, where `ground` is linearly interpolated
/// between the two endpoint elevations. The diffraction code samples this at
/// the exact point where the source→receiver line crosses the wall, rather
/// than collapsing the wall to a single flat top (which made screening depend
/// asymmetrically on where the crossing fell). For a flat-ground barrier set
/// `base_z_a = base_z_b = 0` and `height_agl` = the wall height.
#[derive(Copy, Clone, Debug)]
pub struct WallBarrier {
    pub a_e: f64,
    pub a_n: f64,
    pub b_e: f64,
    pub b_n: f64,
    /// Absolute ground elevation under endpoint A (m).
    pub base_z_a: f64,
    /// Absolute ground elevation under endpoint B (m).
    pub base_z_b: f64,
    /// Barrier height above local ground (m), constant along the segment.
    pub height_agl: f64,
}

/// The 4 path-length quantities needed for Eqs 18 and 21.
#[derive(Copy, Clone, Debug)]
pub struct PathLengths {
    pub d_direct: f64,
    pub d_ss: f64,
    pub d_sr: f64,
    pub e_total: f64,
    /// `Δz = (d_ss + d_sr + e_total) − d_direct`, per Eq 22.
    pub delta_z: f64,
}

/// A vertical END edge of a FINITE wall — a polyline endpoint — used for
/// lateral diffraction around the wall's ends (§7.4.3 / §7.4.4). Terrain
/// virtual barriers stand in for *infinite* ridges, so they contribute NO
/// lateral edges. Plan position `(e, n)` plus the absolute base + top elevation
/// of the vertical edge.
#[derive(Copy, Clone, Debug)]
pub struct LateralEdge {
    pub e: f64,
    pub n: f64,
    pub base_z: f64,
    pub top_z: f64,
}

/// Clamp of `v` to `[lo, hi]`.
fn clamp_height(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// Path-length geometry for diffraction around one vertical end edge.
///
/// The ray bends at the height `h*` on the edge that minimises `|S→P| + |P→R|`
/// — a closed form: the straight line in the "unfolded" (horizontal-distance,
/// height) plane crosses the edge at `h* = (zs·dxr + zr·dxs)/(dxs+dxr)`, where
/// `dxs`/`dxr` are the plan-view distances from source/receiver to the edge.
/// `h*` is clamped to the edge's `[base_z, top_z]` extent. The returned
/// `PathLengths` is a single-edge path (`e_total = 0`); its `delta_z` is ≤ 0
/// when the edge doesn't shadow the receiver (sound passes the end freely),
/// which the caller reads as `Dz = 0` (a fully open path).
pub fn lateral_path_lengths(source: Vec3, receiver: Vec3, edge: &LateralEdge) -> PathLengths {
    let dse = source.e - edge.e;
    let dsn = source.n - edge.n;
    let dxs = (dse * dse + dsn * dsn).sqrt();
    let dre = receiver.e - edge.e;
    let drn = receiver.n - edge.n;
    let dxr = (dre * dre + drn * drn).sqrt();
    let zs = source.z;
    let zr = receiver.z;
    let denom = dxs + dxr;
    let h_star = if denom > 1e-9 {
        (zs * dxr + zr * dxs) / denom
    } else {
        (zs + zr) / 2.0
    };
    let h = clamp_height(h_star, edge.base_z, edge.top_z);
    let ls = (dxs * dxs + (h - zs) * (h - zs)).sqrt();
    let lr = (dxr * dxr + (h - zr) * (h - zr)).sqrt();
    let de = receiver.e - source.e;
    let dn = receiver.n - source.n;
    let dz = receiver.z - source.z;
    let d_direct = (de * de + dn * dn + dz * dz).sqrt();
    PathLengths {
        d_direct,
        d_ss: ls,
        d_sr: lr,
        e_total: 0.0,
        delta_z: ls + lr - d_direct,
    }
}

/// Project `barriers` into the vertical plane through `source` and `receiver`,
/// returning candidate diffracting edges sorted by horizontal distance from
/// the source.
///
/// Selection of which edges are *active* (above the line of sight, on the
/// upper convex hull) happens in `upper_hull_select`.
pub fn project_walls(source: Vec3, receiver: Vec3, barriers: &[WallBarrier]) -> Vec<DiffractionEdge> {
    // Plan-view direction vector source → receiver, normalised.
    let dx = receiver.e - source.e;
    let dy = receiver.n - source.n;
    let dp = (dx * dx + dy * dy).sqrt();
    if dp < 1e-9 {
        return Vec::new();
    }

    let mut edges: Vec<DiffractionEdge> = Vec::new();

    for wall in barriers {
        // Solve for plan-view intersection of the SR segment with the wall
        // segment. Use parametric form: SR(t) = source + t·(receiver − source)
        // for t ∈ [0,1]; wall(s) = a + s·(b − a) for s ∈ [0,1].
        let wax = wall.a_e - source.e;
        let way = wall.a_n - source.n;
        let wbx = wall.b_e - wall.a_e;
        let wby = wall.b_n - wall.a_n;

        // Solve [dx, -wbx; dy, -wby] · [t; s] = [wax; way]
        // det = dx·(-wby) - (-wbx)·dy = -dx·wby + wbx·dy
        let det = dx * (-wby) - (-wbx) * dy;
        if det.abs() < 1e-9 {
            // Parallel — no crossing (or coincident; ignored).
            continue;
        }

        let t = (wax * (-wby) - (-wbx) * way) / det;
        let s = (dx * way - dy * wax) / det;

        // Both parameters must lie in [0, 1] for the segments to actually cross.
        if !(0.0..=1.0).contains(&t) || !(0.0..=1.0).contains(&s) {
            continue;
        }

        // Terrain-following top at the crossing: interpolate the ground
        // elevation between the two endpoints at the wall parameter `s`, then
        // add the (constant) barrier height. `x` in the SR plane is `t · dp`.
        let base_at_s = wall.base_z_a + s * (wall.base_z_b - wall.base_z_a);
        edges.push(DiffractionEdge {
            x: t * dp,
            z: base_at_s + wall.height_agl,
        });
    }

    // Sort by x.
    edges.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    edges
}

/// Andrew's monotone chain — upper convex hull of the source, edges, and
/// receiver in the vertical plane. Returns the edges that lie on the hull
/// (the "active" diffracting edges).
pub fn upper_hull_select(
    source: DiffractionEdge,
    receiver: DiffractionEdge,
    candidates: &[DiffractionEdge],
) -> Vec<DiffractionEdge> {
    // Working in (x, z) space.
    let mut points: Vec<(f64, f64, Option<usize>)> =
        Vec::with_capacity(candidates.len() + 2);
    points.push((source.x, source.z, None));
    for (i, e) in candidates.iter().enumerate() {
        points.push((e.x, e.z, Some(i)));
    }
    points.push((receiver.x, receiver.z, None));

    let mut hull_indices: Vec<usize> = Vec::new();
    for (idx, &(x, z, _)) in points.iter().enumerate() {
        while hull_indices.len() >= 2 {
            let &i1 = &hull_indices[hull_indices.len() - 2];
            let &i2 = &hull_indices[hull_indices.len() - 1];
            let (x1, z1, _) = points[i1];
            let (x2, z2, _) = points[i2];
            // Cross product of (p2 - p1) × (p - p2). If ≥ 0, p2 isn't on the
            // upper hull (left turn or collinear) — pop it.
            let cross = (x2 - x1) * (z - z2) - (z2 - z1) * (x - x2);
            if cross >= 0.0 {
                hull_indices.pop();
            } else {
                break;
            }
        }
        hull_indices.push(idx);
    }

    // Extract the active edges (excluding source and receiver).
    hull_indices
        .into_iter()
        .filter_map(|i| points[i].2.map(|orig| candidates[orig]))
        .collect()
}

/// Compute path lengths and `Δz` per Eq 22 for a (pre-selected) sequence of
/// active diffracting edges.
pub fn path_lengths(
    source: DiffractionEdge,
    receiver: DiffractionEdge,
    active_edges: &[DiffractionEdge],
) -> PathLengths {
    let dx = receiver.x - source.x;
    let dz = receiver.z - source.z;
    let d_direct = (dx * dx + dz * dz).sqrt();

    if active_edges.is_empty() {
        return PathLengths {
            d_direct,
            d_ss: 0.0,
            d_sr: 0.0,
            e_total: 0.0,
            delta_z: 0.0,
        };
    }

    let first = active_edges[0];
    let last = active_edges[active_edges.len() - 1];

    let dxs = first.x - source.x;
    let dzs = first.z - source.z;
    let d_ss = (dxs * dxs + dzs * dzs).sqrt();

    let dxr = receiver.x - last.x;
    let dzr = receiver.z - last.z;
    let d_sr = (dxr * dxr + dzr * dzr).sqrt();

    let mut e_total = 0.0;
    for w in active_edges.windows(2) {
        let a = w[0];
        let b = w[1];
        let dxe = b.x - a.x;
        let dze = b.z - a.z;
        e_total += (dxe * dxe + dze * dze).sqrt();
    }

    let delta_z = d_ss + d_sr + e_total - d_direct;

    PathLengths {
        d_direct,
        d_ss,
        d_sr,
        e_total,
        delta_z,
    }
}

/// The diffraction geometry of one source→receiver path, ready for a standard
/// evaluator to score: the active over-top rubber-band path plus the selected
/// around-the-end (lateral) paths. This is the output of the "path engine" —
/// pure geometry, edition-independent (per ISO/TR 17534-3 §5.2 both editions
/// use this vertical-plane construction). `None` from `build_geometry` means
/// the line of sight clears every obstacle top (no screening → `Abar = 0`).
#[derive(Clone, Debug)]
pub struct BarrierGeometry {
    /// Over-top path lengths (through the active upper-hull edges).
    pub over_top: PathLengths,
    /// Up to two lateral paths — the most‑transmitting one on each side of the
    /// source→receiver line (ISO/TR 17534-3 §5.2), after the factor‑8 neglect.
    pub lateral: Vec<PathLengths>,
}

/// Perpendicular distance of point `p` from the line through `a` and `b` in the
/// SR vertical plane (`(x, z)` coordinates).
fn perp_distance(a: DiffractionEdge, b: DiffractionEdge, p: DiffractionEdge) -> f64 {
    let (abx, abz) = (b.x - a.x, b.z - a.z);
    let (apx, apz) = (p.x - a.x, p.z - a.z);
    let len = (abx * abx + abz * abz).sqrt();
    if len < 1e-9 { 0.0 } else { (abx * apz - abz * apx).abs() / len }
}

/// Signed side (via the plan-view cross product) and perpendicular plan offset
/// of an edge from the source→receiver line.
fn plan_side_offset(source: Vec3, receiver: Vec3, e: f64, n: f64) -> (f64, f64) {
    let (dx, dy) = (receiver.e - source.e, receiver.n - source.n);
    let (ex, ey) = (e - source.e, n - source.n);
    let cross = dx * ey - dy * ex;
    let len = (dx * dx + dy * dy).sqrt();
    let offset = if len < 1e-9 { 0.0 } else { cross.abs() / len };
    (cross, offset)
}

/// Select the lateral paths per ISO/TR 17534-3 §5.2: at most two — the
/// most‑transmitting (smallest `Δz`) edge on each side of the S–R line — and
/// neglect any whose plan offset from that line exceeds `8×` the over‑top
/// ribbon's `ev_offset` (its max edge height above the direct line).
fn select_lateral(
    source: Vec3,
    receiver: Vec3,
    edges: &[LateralEdge],
    ev_offset: f64,
) -> Vec<PathLengths> {
    let mut best_left: Option<PathLengths> = None;
    let mut best_right: Option<PathLengths> = None;
    for edge in edges {
        let (side, offset) = plan_side_offset(source, receiver, edge.e, edge.n);
        if ev_offset > 1e-9 && offset > 8.0 * ev_offset {
            continue; // factor-8 neglect
        }
        let ll = lateral_path_lengths(source, receiver, edge);
        let slot = if side >= 0.0 { &mut best_left } else { &mut best_right };
        let keep = match slot {
            Some(cur) => ll.delta_z < cur.delta_z,
            None => true,
        };
        if keep {
            *slot = Some(ll);
        }
    }
    best_left.into_iter().chain(best_right).collect()
}

/// Build the diffraction geometry for a source→receiver pair. Returns `None`
/// when no obstacle top rises above the line of sight (unshielded).
///
/// `terrain_edges` are pre-sampled ground-profile diffraction candidates (in
/// the SR vertical plane) — elevated ground that can screen the ray. They emit
/// no lateral edges (unbounded ridges, per ISO/TR 17534-3 §5.8).
pub fn build_geometry(
    source: Vec3,
    receiver: Vec3,
    barriers: &[WallBarrier],
    lateral_edges: &[LateralEdge],
    terrain_edges: &[DiffractionEdge],
) -> Option<BarrierGeometry> {
    let mut candidates = project_walls(source, receiver, barriers);
    candidates.extend_from_slice(terrain_edges);
    candidates.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    let s_in_plane = DiffractionEdge { x: 0.0, z: source.z };
    let dx = receiver.e - source.e;
    let dy = receiver.n - source.n;
    let dp = (dx * dx + dy * dy).sqrt();
    let r_in_plane = DiffractionEdge { x: dp, z: receiver.z };

    let active = upper_hull_select(s_in_plane, r_in_plane, &candidates);
    if active.is_empty() {
        return None;
    }

    let over_top = path_lengths(s_in_plane, r_in_plane, &active);
    // The over-top ribbon's max edge height above the direct S–R line, for the
    // §5.2 factor-8 lateral‑neglect comparison.
    let ev_offset = active
        .iter()
        .map(|e| perp_distance(s_in_plane, r_in_plane, *e))
        .fold(0.0_f64, f64::max);
    let lateral = select_lateral(source, receiver, lateral_edges, ev_offset);
    Some(BarrierGeometry { over_top, lateral })
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    /// Helper: source/receiver as `DiffractionEdge` in the SR plane.
    fn sr_plane(s_pos: Vec3, r_pos: Vec3) -> (DiffractionEdge, DiffractionEdge) {
        let dx = r_pos.e - s_pos.e;
        let dy = r_pos.n - s_pos.n;
        let dp = (dx * dx + dy * dy).sqrt();
        (
            DiffractionEdge { x: 0.0, z: s_pos.z },
            DiffractionEdge { x: dp, z: r_pos.z },
        )
    }

    #[test]
    fn case_03_geometry_single_edge() {
        // Source (0,0,5), receiver (100,0,1.5), wall at x=50 perpendicular to
        // SR with top at z=8 — extends from (50,-50) to (50,50).
        let src = Vec3::new(0.0, 0.0, 5.0);
        let rcv = Vec3::new(100.0, 0.0, 1.5);
        let wall = WallBarrier {
            a_e: 50.0, a_n: -50.0,
            b_e: 50.0, b_n: 50.0,
            base_z_a: 0.0, base_z_b: 0.0, height_agl: 8.0,
        };
        let candidates = project_walls(src, rcv, &[wall]);
        assert_eq!(candidates.len(), 1);
        assert_relative_eq!(candidates[0].x, 50.0, epsilon = 1e-9);
        assert_relative_eq!(candidates[0].z, 8.0, epsilon = 1e-9);

        let (s, r) = sr_plane(src, rcv);
        let active = upper_hull_select(s, r, &candidates);
        assert_eq!(active.len(), 1);

        let lengths = path_lengths(s, r, &active);
        assert_relative_eq!(lengths.d_ss, 50.090, epsilon = 0.01);
        assert_relative_eq!(lengths.d_sr, 50.420, epsilon = 0.01);
        assert_relative_eq!(lengths.e_total, 0.0, epsilon = 1e-9);
        assert_relative_eq!(lengths.delta_z, 0.449, epsilon = 0.01);
    }

    #[test]
    fn case_04_geometry_two_edges() {
        let src = Vec3::new(0.0, 0.0, 5.0);
        let rcv = Vec3::new(100.0, 0.0, 1.5);
        let walls = [
            WallBarrier {
                a_e: 30.0, a_n: -50.0, b_e: 30.0, b_n: 50.0,
                base_z_a: 0.0, base_z_b: 0.0, height_agl: 7.0,
            },
            WallBarrier {
                a_e: 70.0, a_n: -50.0, b_e: 70.0, b_n: 50.0,
                base_z_a: 0.0, base_z_b: 0.0, height_agl: 7.0,
            },
        ];
        let candidates = project_walls(src, rcv, &walls);
        assert_eq!(candidates.len(), 2);
        assert_relative_eq!(candidates[0].x, 30.0, epsilon = 1e-9);
        assert_relative_eq!(candidates[1].x, 70.0, epsilon = 1e-9);

        let (s, r) = sr_plane(src, rcv);
        let active = upper_hull_select(s, r, &candidates);
        assert_eq!(active.len(), 2);

        let lengths = path_lengths(s, r, &active);
        assert_relative_eq!(lengths.d_ss, 30.067, epsilon = 0.01);
        assert_relative_eq!(lengths.d_sr, 30.500, epsilon = 0.01);
        assert_relative_eq!(lengths.e_total, 40.000, epsilon = 0.01);
        assert_relative_eq!(lengths.delta_z, 0.506, epsilon = 0.01);
    }

    #[test]
    fn barrier_below_los_is_dropped() {
        // Wall top z = 2 m, but the LOS at x = 50 passes at z = 3.25 — barrier
        // is below LOS so it shouldn't appear on the upper hull.
        let src = Vec3::new(0.0, 0.0, 5.0);
        let rcv = Vec3::new(100.0, 0.0, 1.5);
        let wall = WallBarrier {
            a_e: 50.0, a_n: -50.0, b_e: 50.0, b_n: 50.0,
            base_z_a: 0.0, base_z_b: 0.0, height_agl: 2.0,
        };
        let candidates = project_walls(src, rcv, &[wall]);
        let (s, r) = sr_plane(src, rcv);
        let active = upper_hull_select(s, r, &candidates);
        assert_eq!(active.len(), 0);
    }

    #[test]
    fn terrain_following_top_interpolates_at_crossing() {
        // Wall along n from -100 to +100 at x = 50, ground sloping 0 → 10 m
        // from endpoint A to endpoint B, barrier 2 m tall.
        let wall = WallBarrier {
            a_e: 50.0, a_n: -100.0, b_e: 50.0, b_n: 100.0,
            base_z_a: 0.0, base_z_b: 10.0, height_agl: 2.0,
        };
        // SR line at n = -50 crosses the wall at s = 0.25 → base 2.5, top 4.5.
        let c1 = project_walls(
            Vec3::new(0.0, -50.0, 1.0), Vec3::new(100.0, -50.0, 1.0), &[wall],
        );
        assert_eq!(c1.len(), 1);
        assert_relative_eq!(c1[0].z, 4.5, epsilon = 1e-6);
        // SR line at n = +50 crosses at s = 0.75 → base 7.5, top 9.5. The
        // barrier top tracks the terrain at the actual crossing, not a single
        // flat value — this is what fixes the off-centre asymmetry.
        let c2 = project_walls(
            Vec3::new(0.0, 50.0, 1.0), Vec3::new(100.0, 50.0, 1.0), &[wall],
        );
        assert_relative_eq!(c2[0].z, 9.5, epsilon = 1e-6);
    }
}
