//! ISO 9613-2 §7.3.2 — simplified ground method for A-weighted levels.
//!
//! Identical in the 1996 (Eqs 10/11) and 2024 (Eqs 14/15) editions, so this is
//! shared across editions and selected by [`super::GroundMethod::Simplified`].
//! It yields a single (frequency-independent) ground attenuation plus a source
//! correction `D`, valid only over porous/mixed ground for a broadband source.
//!
//! `hm`, the mean height of the propagation path above the ground, is the area
//! `F` between the ground profile and the straight source→receiver line divided
//! by the ground-projected distance `dg` (Figure 5). Over flat ground this
//! reduces to `(hS + hR)/2` (see [`hm_flat`]); the terrain-profile area method
//! arrives with the terrain module in Phase 3.

/// Simplified ground attenuation per Eq 14 (2024) / Eq 10 (1996):
/// `Agr = 4.8 − (2·hm/d)·(17 + 300/d)`, clamped at ≥ 0. `d` is the 3-D
/// source-to-receiver distance (m); `hm` the mean propagation height (m).
pub fn agr(hm: f64, d: f64) -> f64 {
    (4.8 - (2.0 * hm / d) * (17.0 + 300.0 / d)).max(0.0)
}

/// Source correction `D` per Eq 15 (2024) / Eq 11 (1996):
/// `D = 10·lg(1 + Kgeo)`, with `Kgeo = (dp² + (hS−hR)²)/(dp² + (hS+hR)²)`
/// (Eq 13). Added to the source level to restore the near-source ground
/// reflection that the simplified `Agr` omits. `dp` is the ground-projected
/// source-to-receiver distance (m).
pub fn d_correction(dp: f64, hs: f64, hr: f64) -> f64 {
    let kgeo = (dp * dp + (hs - hr).powi(2)) / (dp * dp + (hs + hr).powi(2));
    10.0 * (1.0 + kgeo).log10()
}

/// Flat-ground mean propagation height `hm = (hS + hR)/2` — the mean height of
/// the straight source→receiver line over level ground. Terrain-profile `hm`
/// (Figure 5 area method) arrives in Phase 3.
pub fn hm_flat(hs: f64, hr: f64) -> f64 {
    (hs + hr) / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn agr_clamps_at_zero_for_low_paths() {
        // hm = 3.25 m, d = 200 m: 4.8 − (6.5/200)(17 + 1.5) = 4.8 − 0.601 = 4.199.
        assert_relative_eq!(agr(3.25, 200.0), 4.199, epsilon = 0.005);
        // Short distance with a low path drives Agr negative → clamped to 0.
        // hm = 1 m, d = 50: 4.8 − (2/50)(17 + 6) = 4.8 − 0.92 = 3.88 (still >0).
        assert_relative_eq!(agr(1.0, 50.0), 3.88, epsilon = 0.005);
        // A very high path (large hm) yields a large negative → 0.
        assert_relative_eq!(agr(50.0, 100.0), 0.0, epsilon = 1e-12);
    }

    #[test]
    fn d_correction_matches_kgeo() {
        // dp = 200, hs = 5, hr = 1.5: Kgeo = (40000+12.25)/(40000+42.25)
        //   = 40012.25/40042.25 = 0.999251 → D = 10·lg(1.999251) = 3.0087 dB.
        assert_relative_eq!(d_correction(200.0, 5.0, 1.5), 3.0087, epsilon = 5e-4);
        // Kgeo = 1 exactly requires a zero height (4·hs·hr = 0): hr = 0 →
        // Kgeo = 1 → D = 10·lg 2 = 3.0103 dB.
        assert_relative_eq!(d_correction(100.0, 5.0, 0.0), 3.0103, epsilon = 1e-4);
    }

    #[test]
    fn hm_flat_is_mean_height() {
        assert_relative_eq!(hm_flat(5.0, 1.5), 3.25, epsilon = 1e-12);
    }
}
