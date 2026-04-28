//! Geometry of the diffracted ray over barrier top edges (ISO 9613-2:2024
//! 7.4.1, Figure 8 — the "rubber-band" path in the vertical plane through
//! source and receiver).
//!
//! v0.3 supports straight wall barriers (one polyline segment per barrier)
//! with constant top heights. Multi-segment polylines and per-vertex top
//! heights land in v0.4.

use crate::dual::ADScalar;
use crate::units::Vec3;

/// A point in the vertical plane defined by source and receiver. `x` is the
/// horizontal distance from the source's plan-view position along the SR
/// axis (metres); `z` is the absolute height (metres).
#[derive(Copy, Clone, Debug)]
pub struct DiffractionEdge<T> {
    pub x: T,
    pub z: T,
}

/// A straight vertical wall barrier defined by two plan-view endpoints and
/// a constant top height (m, absolute z).
#[derive(Copy, Clone, Debug)]
pub struct WallBarrier<T> {
    pub a_e: T,
    pub a_n: T,
    pub b_e: T,
    pub b_n: T,
    pub top_z: T,
}

/// The 4 path-length quantities needed for Eqs 18 and 21.
#[derive(Copy, Clone, Debug)]
pub struct PathLengths<T> {
    pub d_direct: T,
    pub d_ss: T,
    pub d_sr: T,
    pub e_total: T,
    /// `Δz = (d_ss + d_sr + e_total) − d_direct`, per Eq 22.
    pub delta_z: T,
}

/// Project `barriers` into the vertical plane through `source` and `receiver`,
/// returning candidate diffracting edges sorted by horizontal distance from
/// the source.
///
/// Selection of which edges are *active* (above the line of sight, on the
/// upper convex hull) happens in `upper_hull_select`.
pub fn project_walls<T: ADScalar>(
    source: Vec3<T>,
    receiver: Vec3<T>,
    barriers: &[WallBarrier<T>],
) -> Vec<DiffractionEdge<T>> {
    // Plan-view direction vector source → receiver, normalised.
    let dx = receiver.e - source.e;
    let dy = receiver.n - source.n;
    let dp = (dx * dx + dy * dy).sqrt();
    let dp_v = dp.to_f64();
    if dp_v < 1e-9 {
        return Vec::new();
    }

    let mut edges: Vec<DiffractionEdge<T>> = Vec::new();

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
        let det_v = det.to_f64();
        if det_v.abs() < 1e-9 {
            // Parallel — no crossing (or coincident; v0.3 ignores).
            continue;
        }

        let t = (wax * (-wby) - (-wbx) * way) / det;
        let s = (dx * way - dy * wax) / det;

        let t_v = t.to_f64();
        let s_v = s.to_f64();
        // Both parameters must lie in [0, 1] for the segments to actually cross.
        if t_v < 0.0 || t_v > 1.0 || s_v < 0.0 || s_v > 1.0 {
            continue;
        }

        // x in the SR plane is t · dp; z is the wall's top height.
        edges.push(DiffractionEdge {
            x: t * dp,
            z: wall.top_z,
        });
    }

    // Sort by x (primal value).
    edges.sort_by(|a, b| a.x.to_f64().partial_cmp(&b.x.to_f64()).unwrap());
    edges
}

/// Andrew's monotone chain — upper convex hull of the source, edges, and
/// receiver in the vertical plane. Returns the edges that lie on the hull
/// (the "active" diffracting edges).
///
/// Selection is computed on primal values only; the resulting active set is
/// what the AD-instrumented `path_lengths` then operates on smoothly.
pub fn upper_hull_select<T: ADScalar>(
    source: DiffractionEdge<T>,
    receiver: DiffractionEdge<T>,
    candidates: &[DiffractionEdge<T>],
) -> Vec<DiffractionEdge<T>> {
    // Working in (x, z) primal space.
    let mut points: Vec<(f64, f64, Option<usize>)> =
        Vec::with_capacity(candidates.len() + 2);
    points.push((source.x.to_f64(), source.z.to_f64(), None));
    for (i, e) in candidates.iter().enumerate() {
        points.push((e.x.to_f64(), e.z.to_f64(), Some(i)));
    }
    points.push((receiver.x.to_f64(), receiver.z.to_f64(), None));

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
pub fn path_lengths<T: ADScalar>(
    source: DiffractionEdge<T>,
    receiver: DiffractionEdge<T>,
    active_edges: &[DiffractionEdge<T>],
) -> PathLengths<T> {
    let dx = receiver.x - source.x;
    let dz = receiver.z - source.z;
    let d_direct = (dx * dx + dz * dz).sqrt();

    if active_edges.is_empty() {
        return PathLengths {
            d_direct,
            d_ss: T::zero(),
            d_sr: T::zero(),
            e_total: T::zero(),
            delta_z: T::zero(),
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

    let mut e_total = T::zero();
    for w in active_edges.windows(2) {
        let a = w[0];
        let b = w[1];
        let dxe = b.x - a.x;
        let dze = b.z - a.z;
        e_total = e_total + (dxe * dxe + dze * dze).sqrt();
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

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    /// Helper: source/receiver as `DiffractionEdge` in the SR plane.
    fn sr_plane(s_pos: Vec3<f64>, r_pos: Vec3<f64>) -> (DiffractionEdge<f64>, DiffractionEdge<f64>) {
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
            top_z: 8.0,
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
                a_e: 30.0, a_n: -50.0, b_e: 30.0, b_n: 50.0, top_z: 7.0,
            },
            WallBarrier {
                a_e: 70.0, a_n: -50.0, b_e: 70.0, b_n: 50.0, top_z: 7.0,
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
            a_e: 50.0, a_n: -50.0, b_e: 50.0, b_n: 50.0, top_z: 2.0,
        };
        let candidates = project_walls(src, rcv, &[wall]);
        let (s, r) = sr_plane(src, rcv);
        let active = upper_hull_select(s, r, &candidates);
        assert_eq!(active.len(), 0);
    }
}
