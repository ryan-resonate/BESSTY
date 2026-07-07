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

/// A closed building footprint that diffracts sound around its SIDES: the
/// around-the-side (lateral) path wraps the taut string around the run of
/// vertical corner-edges on each side (a MULTI-edge lateral, unlike a thin
/// wall's single-edge ends). Plan `verts` (implicitly closed) plus the absolute
/// base/top elevation of the vertical faces.
#[derive(Clone, Debug)]
pub struct FootprintLateral {
    pub verts: Vec<(f64, f64)>,
    pub base_z: f64,
    pub top_z: f64,
}

/// The two around-the-side lateral paths (one per side) for a building
/// footprint blocking the direct ray. Each is the shortest taut string wrapping
/// the footprint corners on that side, in 3-D (heights on the vertical edges set
/// by unfolding). Empty when the plan line misses the footprint (no shadow).
///
/// Construction: work in `(t, d)` coordinates — `t` the along-`SR` distance,
/// `d` the signed perpendicular plan offset. The corners on one side (same sign
/// of `d`) plus `S`(t=0,d=0) and `R`(t=dp,d=0) have an outer convex chain (the
/// taut string) given by the monotone-hull that bulges away from the `SR` line;
/// its interior vertices are the active diffracting corners. This reproduces
/// ISO/TR 17534-3's "shortest polygon lines around these edges" (§5.2) and, with
/// the multi-edge `C3` from `e_total`, matches the T11 step values.
pub fn footprint_lateral_paths(
    source: Vec3,
    receiver: Vec3,
    fp: &FootprintLateral,
) -> Vec<PathLengths> {
    let (dx, dy) = (receiver.e - source.e, receiver.n - source.n);
    let dp = (dx * dx + dy * dy).sqrt();
    if dp < 1e-9 || fp.verts.len() < 3 {
        return Vec::new();
    }
    let (ux, uy) = (dx / dp, dy / dp); // unit along SR (plan)

    // (t, d) for each corner: t along SR, d signed perpendicular offset.
    let td: Vec<(f64, f64)> = fp
        .verts
        .iter()
        .map(|&(e, n)| {
            let (rx, ry) = (e - source.e, n - source.n);
            (rx * ux + ry * uy, ux * ry - uy * rx) // (along, cross)
        })
        .collect();

    let mut out = Vec::new();
    for side in [1.0_f64, -1.0] {
        // Corners strictly on this side, in the SR plane, plus the S/R anchors.
        let mut pts: Vec<(f64, f64, usize)> = vec![(0.0, 0.0, usize::MAX)];
        for (i, &(t, d)) in td.iter().enumerate() {
            if d * side > 1e-9 {
                pts.push((t, d * side, i)); // fold to a common (positive-d) side
            }
        }
        pts.push((dp, 0.0, usize::MAX));
        if pts.len() < 3 {
            continue; // no corner shadows this side
        }
        pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

        // Upper hull in (t, d): the taut string over the side's corners.
        let mut hull: Vec<(f64, f64, usize)> = Vec::new();
        for &p in &pts {
            while hull.len() >= 2 {
                let a = hull[hull.len() - 2];
                let b = hull[hull.len() - 1];
                let cross = (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
                if cross >= 0.0 {
                    hull.pop(); // b is below the a→p line → not on the upper hull
                } else {
                    break;
                }
            }
            hull.push(p);
        }
        // Active corners = interior hull vertices (exclude the S/R anchors).
        let corners: Vec<usize> = hull
            .iter()
            .filter(|p| p.2 != usize::MAX)
            .map(|p| p.2)
            .collect();
        if corners.is_empty() {
            continue;
        }
        if let Some(path) = wrap_path_lengths(source, receiver, &corners, fp) {
            out.push(path);
        }
    }
    out
}

/// 3-D taut-string path lengths through an ordered run of footprint corners,
/// with each diffraction height set by unfolding the plan polyline and clamping
/// to the vertical face `[base_z, top_z]`.
fn wrap_path_lengths(
    source: Vec3,
    receiver: Vec3,
    corners: &[usize],
    fp: &FootprintLateral,
) -> Option<PathLengths> {
    // Plan polyline S → corners → R and its cumulative plan length.
    let mut plan: Vec<(f64, f64)> = Vec::with_capacity(corners.len() + 2);
    plan.push((source.e, source.n));
    for &i in corners {
        plan.push(fp.verts[i]);
    }
    plan.push((receiver.e, receiver.n));

    let mut cum = vec![0.0f64; plan.len()];
    for k in 1..plan.len() {
        let (ax, ay) = plan[k - 1];
        let (bx, by) = plan[k];
        cum[k] = cum[k - 1] + ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
    }
    let total = *cum.last().unwrap();
    if total < 1e-9 {
        return None;
    }
    // Unfolded height along the path (linear S.z → R.z). Only the interior
    // CORNERS diffract at the vertical face, so only they clamp to `[base, top]`;
    // the endpoints S and R keep their real heights (clamping R to the roof when
    // it is above the roof would terminate the path at a fake lowered receiver
    // and make Δz negative — an impossible "shortcut" that opened the barrier).
    let unfolded = |k: usize| source.z + (receiver.z - source.z) * cum[k] / total;
    let last = plan.len() - 1;
    let height_at = |k: usize| {
        if k == 0 {
            source.z
        } else if k == last {
            receiver.z
        } else {
            clamp_height(unfolded(k), fp.base_z, fp.top_z)
        }
    };

    // 3-D node positions (plan + unfolded height).
    let node = |k: usize| -> (f64, f64, f64) {
        let (x, y) = plan[k];
        (x, y, height_at(k))
    };
    let dist3 = |a: (f64, f64, f64), b: (f64, f64, f64)| {
        ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2) + (a.2 - b.2).powi(2)).sqrt()
    };

    let n = plan.len();
    let d_ss = dist3(node(0), node(1));
    let d_sr = dist3(node(n - 2), node(n - 1));
    let mut e_total = 0.0;
    for k in 1..n - 2 {
        e_total += dist3(node(k), node(k + 1));
    }
    let d_direct = {
        let (sx, sy, sz) = (source.e, source.n, source.z);
        let (rx, ry, rz) = (receiver.e, receiver.n, receiver.z);
        ((rx - sx).powi(2) + (ry - sy).powi(2) + (rz - sz).powi(2)).sqrt()
    };
    Some(PathLengths {
        d_direct,
        d_ss,
        d_sr,
        e_total,
        delta_z: d_ss + d_sr + e_total - d_direct,
    })
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

/// Signed side of an edge relative to the source→receiver line (plan-view cross
/// product): ≥ 0 one side, < 0 the other. Used to keep one lateral edge per side.
fn plan_side(source: Vec3, receiver: Vec3, e: f64, n: f64) -> f64 {
    let (dx, dy) = (receiver.e - source.e, receiver.n - source.n);
    let (ex, ey) = (e - source.e, n - source.n);
    dx * ey - dy * ex
}

/// Select the lateral paths per ISO/TR 17534-3 §5.2: at most two — the
/// most‑transmitting (smallest `Δz`) edge on **each side** of the S–R line
/// (Figure 3, "the two calculation rays in plane EL").
///
/// The TR's factor-8 neglect (drop an edge whose distance from the S–R line
/// exceeds 8× the over-top edges' in-plane distance) is a COMPUTATIONAL
/// shortcut, not a physics step: a far vertical edge has a large path-length
/// difference `Δz`, hence a large `Dz`, hence a near-zero energy term in the
/// Eq-25 combine — it self-suppresses. Applying the neglect too eagerly drops
/// a genuinely-contributing near edge (e.g. ISO/TR T09's second edge at 37 m,
/// `Dz = 20 dB`, which still shifts the combined `Dz` by ~0.09 dB and is part
/// of the reference result). Keeping both best-per-side edges is therefore
/// strictly at-least-as-accurate; the `Dz` energy weighting handles the rest.
fn select_lateral(source: Vec3, receiver: Vec3, edges: &[LateralEdge]) -> Vec<PathLengths> {
    let mut best_left: Option<PathLengths> = None;
    let mut best_right: Option<PathLengths> = None;
    for edge in edges {
        let side = plan_side(source, receiver, edge.e, edge.n);
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
    footprints: &[FootprintLateral],
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
    // Around-the-side paths: thin-wall ends (single-edge, best per side) plus
    // each blocking building's two multi-corner wraps.
    let mut lateral = select_lateral(source, receiver, lateral_edges);
    for fp in footprints {
        lateral.extend(footprint_lateral_paths(source, receiver, fp));
    }
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
    fn building_wrap_is_two_corners_matching_tr_t11() {
        // ISO/TR 17534-3 T11: 10×10 building at [55,65]×[5,15] tall 10, between
        // S(50,10,1) and R(70,10,4). Each side wraps BOTH corners of that side.
        let fp = FootprintLateral {
            verts: vec![(55.0, 5.0), (65.0, 5.0), (65.0, 15.0), (55.0, 15.0)],
            base_z: 0.0,
            top_z: 10.0,
        };
        let paths = footprint_lateral_paths(Vec3::new(50.0, 10.0, 1.0), Vec3::new(70.0, 10.0, 4.0), &fp);
        assert_eq!(paths.len(), 2, "one wrap per side");
        for p in &paths {
            // Multi-edge: the e-segment between the two corners ≈ 10 m.
            assert_relative_eq!(p.e_total, 10.08, epsilon = 0.1);
            assert_relative_eq!(p.delta_z, 4.10, epsilon = 0.05);
            // With the multi-edge C3 the 63 Hz lateral Dz reproduces TR's 12.89.
            let lambda = 340.0 / 63.0957;
            let dz = super::super::diffraction::dz_uncapped_lateral(
                p, lambda, crate::iso9613::barrier::BarrierVariant::V1996,
            );
            assert_relative_eq!(dz, 12.89, epsilon = 0.05);
        }
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
