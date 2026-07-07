//! ISO 9613-2:2024 — Annex B, directivity correction `Dc` for chimney stacks.
//!
//! A chimney / upward-facing open pipe radiates non-omnidirectionally. The
//! directivity `Dc` (dB, added to `LW` in Eq 3) depends on the downwind emission
//! angle `ϑ` (B.1, `ϑ = 0` straight up) and on `ka` (wave number × opening
//! radius, B.3). Values are Table B.1, bilinearly interpolated, with the Annex B
//! range-extension rules.

/// Discrete direction angles ϑ (degrees) of Table B.1.
const THETA: [f64; 7] = [30.0, 45.0, 60.0, 75.0, 90.0, 105.0, 120.0];
/// Discrete `ka` support points of Table B.1 (`4·2^(n/3)`).
const KA: [f64; 10] = [4.0, 5.0, 6.3, 8.0, 10.0, 12.7, 16.0, 20.2, 25.4, 32.0];
/// `Dc` (dB) — rows are `THETA`, columns are `KA`.
const DC: [[f64; 10]; 7] = [
    [2.4, 2.1, 1.9, 2.0, 2.1, 2.6, 3.1, 3.4, 3.4, 3.3],
    [4.0, 3.4, 3.1, 3.1, 3.4, 4.0, 4.4, 4.6, 4.6, 4.5],
    [4.0, 3.4, 3.1, 3.1, 3.4, 4.0, 4.4, 4.6, 4.6, 4.5],
    [2.4, 2.1, 1.9, 2.0, 2.1, 2.6, 3.1, 3.4, 3.4, 3.3],
    [-2.4, -2.2, -2.0, -1.9, -1.9, -1.9, -1.9, -2.1, -2.3, -2.7],
    [-4.3, -4.6, -5.0, -5.4, -5.9, -6.4, -6.9, -7.3, -7.6, -7.9],
    [-6.3, -7.0, -7.7, -8.2, -8.7, -9.1, -9.6, -10.2, -11.0, -12.1],
];

/// Linear interpolation of `vals` over the monotone `grid`, clamped at the ends.
fn interp(grid: &[f64], vals: &[f64], x: f64) -> f64 {
    if x <= grid[0] {
        return vals[0];
    }
    let n = grid.len();
    if x >= grid[n - 1] {
        return vals[n - 1];
    }
    for i in 1..n {
        if x <= grid[i] {
            let t = (x - grid[i - 1]) / (grid[i] - grid[i - 1]);
            return vals[i - 1] + t * (vals[i] - vals[i - 1]);
        }
    }
    vals[n - 1]
}

/// Directivity correction `Dc` (dB) for direction `theta_deg` and `ka`
/// (Table B.1 + extensions: `ϑ` clamped to [30, 120]; `ka > 32` → 32; `ka ≤ 1`
/// → 0; `1 < ka < 4` interpolated from 0 at `ka = 1` to the `ka = 4` value).
pub fn chimney_dc(theta_deg: f64, ka: f64) -> f64 {
    let row_dc = |ti: usize| -> f64 {
        if ka >= 4.0 {
            interp(&KA, &DC[ti], ka) // clamps ka > 32 to the ka = 32 column
        } else if ka <= 1.0 {
            0.0
        } else {
            // Interpolate 0 (at ka = 1) → Dc(ϑ, 4) (at ka = 4).
            (ka - 1.0) / 3.0 * DC[ti][0]
        }
    };
    let rows: Vec<f64> = (0..THETA.len()).map(row_dc).collect();
    interp(&THETA, &rows, theta_deg) // clamps ϑ to [30, 120]
}

/// Downwind emission angle `ϑ` (degrees) per Formula (B.1): the curved-ray
/// direction from a chimney opening to the receiver. `dp` is the horizontal
/// source→receiver distance, `d` the 3-D distance, `zs`/`zr` the absolute
/// source/receiver heights. `ϑ = 0` is straight up; the ray curves with a 5 km
/// radius (the `arcsin(d/2r)` term, B.2).
pub fn emission_angle(dp: f64, d: f64, zs: f64, zr: f64) -> f64 {
    let r = 5000.0;
    let dz = zs - zr;
    // arctan(dp / (zs − zr)) taken as the angle from the upward vertical; use
    // atan2 so a receiver at/above the source (dz ≤ 0) stays in [90°, 180°].
    let arctan = dp.atan2(dz); // radians, in (−π, π]; dp ≥ 0 ⇒ [0, π]
    let arcsin = (d / (2.0 * r)).min(1.0).asin();
    (std::f64::consts::PI - arctan - arcsin).to_degrees()
}

/// `ka` = wave number × opening radius per Formula (B.3): `2π·a·f / c`, with the
/// speed of sound `c = 331.4·√(1 + T/273)` at the chimney-mouth temperature `T`.
pub fn ka(opening_radius_m: f64, freq_hz: f64, temp_c: f64) -> f64 {
    let c = 331.4 * (1.0 + temp_c / 273.0).sqrt();
    2.0 * std::f64::consts::PI * opening_radius_m * freq_hz / c
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn table_lookup_at_support_points() {
        // Exact grid points (θ=90 row, ka=8 col → −1.9; θ=120, ka=32 → −12.1).
        assert_relative_eq!(chimney_dc(90.0, 8.0), -1.9, epsilon = 1e-9);
        assert_relative_eq!(chimney_dc(120.0, 32.0), -12.1, epsilon = 1e-9);
        assert_relative_eq!(chimney_dc(30.0, 4.0), 2.4, epsilon = 1e-9);
    }

    #[test]
    fn extensions_clamp_and_fade() {
        // ϑ < 30 clamps to the 30° row; ϑ > 120 clamps to 120°.
        assert_relative_eq!(chimney_dc(10.0, 8.0), chimney_dc(30.0, 8.0), epsilon = 1e-9);
        assert_relative_eq!(chimney_dc(170.0, 8.0), chimney_dc(120.0, 8.0), epsilon = 1e-9);
        // ka > 32 clamps; ka ≤ 1 fades to 0; midway ka=2.5 is half the ka=4 value.
        assert_relative_eq!(chimney_dc(45.0, 100.0), chimney_dc(45.0, 32.0), epsilon = 1e-9);
        assert_relative_eq!(chimney_dc(45.0, 1.0), 0.0, epsilon = 1e-9);
        assert_relative_eq!(chimney_dc(45.0, 2.5), 0.5 * 4.0, epsilon = 1e-9);
    }

    #[test]
    fn emission_angle_straight_down_and_horizontal() {
        // Receiver directly below the source (dp→0, source above) → ϑ ≈ 180°.
        assert!(emission_angle(0.01, 50.0, 50.0, 0.0) > 179.0);
        // Receiver far and level with the source (dz=0) → arctan = 90° → ϑ ≈ 90°
        // minus the small ray-curvature term.
        let th = emission_angle(200.0, 200.0, 10.0, 10.0);
        assert!((70.0..90.0).contains(&th), "θ = {th}");
    }
}
