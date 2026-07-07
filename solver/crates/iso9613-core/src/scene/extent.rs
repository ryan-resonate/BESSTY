//! Extended (line / area) source subdivision into point sub-sources (§4).
//!
//! ISO 9613-2 replaces an extended source by point sub-sources, each small
//! enough relative to its distance to the receiver that its propagation is
//! representative. The subdivision is **receiver-dependent** (finer near the
//! receiver). We use the 2024 raster factor `k = 0.5` (§4: a well-proven
//! value). Each sub-source carries the fraction of the total sound power of the
//! section it represents (`10·lg(fraction)` added to the total `LW`).
//!
//! (The 1996 `d ≥ 2·Hmax` criterion and area/screening projection refinements
//! are documented in the differences doc §2; ISO 17534-1 widens acceptance
//! intervals for implementation-dependent partitioning, and no ISO/TR 17534-3
//! case uses an extended source.)

/// Raster factor (2024 §4): a section is representative when its extent does
/// not exceed `k ×` its centre-to-receiver distance.
const K: f64 = 0.5;

/// A point sub-source: plan position and the `LW` offset (dB) for its share of
/// the extended source's total sound power.
pub type SubSource = ([f64; 2], f64);

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

fn midpoint(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0]
}

/// Recursively split segment `a→b` until each piece is `≤ K ×` its midpoint's
/// distance to the receiver (or hits the 0.5 m floor / depth cap), collecting
/// `(midpoint, length)` pieces.
fn split_segment(a: [f64; 2], b: [f64; 2], rx: [f64; 2], depth: u32, out: &mut Vec<([f64; 2], f64)>) {
    let mid = midpoint(a, b);
    let len = dist(a, b);
    let d = dist(mid, rx).max(1.0);
    if len <= K * d || len < 0.5 || depth >= 20 {
        out.push((mid, len));
    } else {
        split_segment(a, mid, rx, depth + 1, out);
        split_segment(mid, b, rx, depth + 1, out);
    }
}

/// Subdivide a line source (polyline `vertices`) for a receiver at `rx`.
/// Returns point sub-sources with `LW` offsets summing (in energy) to 0 dB.
pub fn subdivide_line(vertices: &[[f64; 2]], rx: [f64; 2]) -> Vec<SubSource> {
    let mut pieces = Vec::new();
    for w in vertices.windows(2) {
        split_segment(w[0], w[1], rx, 0, &mut pieces);
    }
    let total: f64 = pieces.iter().map(|(_, l)| l).sum();
    if total < 1e-9 {
        return Vec::new();
    }
    pieces
        .into_iter()
        .map(|(p, l)| (p, 10.0 * (l / total).log10()))
        .collect()
}

/// Even–odd point-in-polygon test (implicitly closed polygon).
fn inside(p: [f64; 2], poly: &[[f64; 2]]) -> bool {
    let n = poly.len();
    let mut c = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i][0], poly[i][1]);
        let (xj, yj) = (poly[j][0], poly[j][1]);
        if ((yi > p[1]) != (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) {
            c = !c;
        }
        j = i;
    }
    c
}

/// Subdivide an area source (polygon) for a receiver at `rx`: sample a grid at
/// spacing `h = K × (nearest approach)` over the polygon's interior. Each
/// interior sample is one equal-power sub-source. The grid count is capped so a
/// very close receiver can't explode the sub-source count.
pub fn subdivide_area(polygon: &[[f64; 2]], rx: [f64; 2]) -> Vec<SubSource> {
    if polygon.len() < 3 {
        return Vec::new();
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    let mut nearest = f64::MAX;
    for v in polygon {
        min_x = min_x.min(v[0]); min_y = min_y.min(v[1]);
        max_x = max_x.max(v[0]); max_y = max_y.max(v[1]);
        nearest = nearest.min(dist(*v, rx));
    }
    let (w, d) = (max_x - min_x, max_y - min_y);
    if w <= 0.0 || d <= 0.0 {
        return Vec::new();
    }
    // Grid spacing from the raster criterion, capped to ≤ ~40 cells per side.
    let mut h = (K * nearest.max(1.0)).max(0.5);
    h = h.max(w / 40.0).max(d / 40.0);
    let nx = (w / h).ceil().max(1.0) as usize;
    let ny = (d / h).ceil().max(1.0) as usize;

    let mut pts = Vec::new();
    for iy in 0..ny {
        for ix in 0..nx {
            let p = [
                min_x + (ix as f64 + 0.5) * (w / nx as f64),
                min_y + (iy as f64 + 0.5) * (d / ny as f64),
            ];
            if inside(p, polygon) {
                pts.push(p);
            }
        }
    }
    if pts.is_empty() {
        // Degenerate/thin polygon — fall back to the centroid.
        let c = [(min_x + max_x) / 2.0, (min_y + max_y) / 2.0];
        return vec![(c, 0.0)];
    }
    let offset = 10.0 * (1.0 / pts.len() as f64).log10();
    pts.into_iter().map(|p| (p, offset)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    fn energy_sum_offsets(subs: &[SubSource]) -> f64 {
        10.0 * subs.iter().map(|(_, db)| 10f64.powf(db / 10.0)).sum::<f64>().log10()
    }

    #[test]
    fn line_offsets_conserve_energy() {
        // A 100 m line 50 m from the receiver → several pieces whose power
        // offsets energy-sum back to 0 dB (the total LW is preserved).
        let subs = subdivide_line(&[[0.0, 0.0], [100.0, 0.0]], [50.0, 50.0]);
        assert!(subs.len() > 1);
        assert_relative_eq!(energy_sum_offsets(&subs), 0.0, epsilon = 1e-9);
    }

    #[test]
    fn line_subdivides_finer_when_closer() {
        let far = subdivide_line(&[[0.0, 0.0], [100.0, 0.0]], [50.0, 1000.0]);
        let near = subdivide_line(&[[0.0, 0.0], [100.0, 0.0]], [50.0, 5.0]);
        assert!(near.len() > far.len());
    }

    #[test]
    fn area_offsets_conserve_energy_and_stay_inside() {
        let square = [[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]];
        let subs = subdivide_area(&square, [10.0, 100.0]);
        assert!(!subs.is_empty());
        assert_relative_eq!(energy_sum_offsets(&subs), 0.0, epsilon = 1e-9);
        for (p, _) in &subs {
            assert!(inside(*p, &square), "sub-source {p:?} outside polygon");
        }
    }
}
