//! ISO 9613-2 — 7.4 Barrier diffraction `Dz`.
//!
//! The log-argument bracket (2024 Eq 18 / 1996 Eq 14) and the `Kmet` form
//! (2024 Eq 21 / 1996 Eq 18) are **edition-dependent** — selected by
//! [`BarrierVariant`]. `zmin`, `C2`, and `C3` are shared. See
//! `docs/iso9613-2-1996-vs-2024-differences.md` §8.1–8.2 and the 17534-3
//! implementation notes §5.4.

use super::path::PathLengths;
use super::BarrierVariant;

/// `C2` per Eq 18: 20 in the standard configuration (ground reflections
/// already accounted for in `Agr`). 40 if reflections are tracked separately
/// via image sources — not used yet.
pub const C2: f64 = 20.0;

/// `C3` per Eq 20 — **frequency-dependent** (via `λ`):
///   - 1 for single diffraction (e = 0).
///   - `(1 + (5λ/e)²) / (1/3 + (5λ/e)²)` for multi-edge.
///
/// (Fixed 2026-07 — the previous form used `5/e`, dropping the `λ` factor and
/// making `C3` frequency-independent; see differences doc §8.1.)
pub fn c3(e_total: f64, lambda: f64) -> f64 {
    if e_total < 1e-9 {
        1.0
    } else {
        let r = 5.0 * lambda / e_total;
        let r_sq = r * r;
        (1.0 + r_sq) / (1.0 / 3.0 + r_sq)
    }
}

/// `zmin = −2λ / (C2·C3)` per 2024 Eq 19 (and ISO/TR 17534-3 §5.4, which
/// introduced the same two-step clamp for the 1996 edition). Below it the line
/// of sight has risen far enough over the top that `Dz` would go negative;
/// `dz_uncapped` returns 0 there. Edition-independent.
pub fn z_min(lambda: f64, c3_val: f64) -> f64 {
    -2.0 * lambda / (C2 * c3_val)
}

/// Meteorological correction `Kmet`.
///
/// - `V2024` (Eq 21): `exp[−(1/2000)·√((max(dss,dsr)+e)·min(dss,dsr)·d / 2(z−zmin))]`.
///   As `z → zmin⁺` the denominator → 0, the argument → ∞, and `Kmet → 0`, so
///   `Dz → 0` continuously into the `z ≤ zmin → Dz = 0` branch.
/// - `V1996` (Eq 18): `exp[−(1/2000)·√(dss·dsr·d / 2z)]`, with `Kmet = 1` for
///   `z ≤ 0` (the 1996 form is only defined for positive path-length
///   difference; the `zmin` clamp above still bounds `Dz`).
pub fn k_met(lengths: &PathLengths, z_min_val: f64, variant: BarrierVariant) -> f64 {
    match variant {
        BarrierVariant::V1996 => {
            if lengths.delta_z <= 0.0 {
                return 1.0;
            }
            let numerator = lengths.d_ss * lengths.d_sr * lengths.d_direct;
            let denominator = 2.0 * lengths.delta_z;
            (-(numerator / denominator).sqrt() / 2000.0).exp()
        }
        BarrierVariant::V2024 => {
            if lengths.delta_z <= z_min_val {
                // At or below zmin Dz is 0 anyway; return 1 to avoid the 0/0 in
                // the denominator. `dz_uncapped` already short-circuits here.
                return 1.0;
            }
            let max_dss_dsr = lengths.d_ss.max(lengths.d_sr);
            let min_dss_dsr = lengths.d_ss.min(lengths.d_sr);
            let numerator = (max_dss_dsr + lengths.e_total) * min_dss_dsr * lengths.d_direct;
            let denominator = 2.0 * (lengths.delta_z - z_min_val);
            (-(numerator / denominator).sqrt() / 2000.0).exp()
        }
    }
}

/// `Dz` (dB) for the given path, without the 20/25 dB cap (caller applies that
/// to the over-top path only). `X = (C2/λ)·C3·z`.
///
/// - `V2024` (Eq 18): `Dz = 10·lg[1 + (2 + X)·Kmet]`.
/// - `V1996` (Eq 14): `Dz = 10·lg[3 + X·Kmet]`.
///
/// Both give `Dz = 0` for `z ≤ zmin`.
pub fn dz_uncapped(lengths: &PathLengths, lambda: f64, variant: BarrierVariant) -> f64 {
    let c3_val = c3(lengths.e_total, lambda);
    let z_min_val = z_min(lambda, c3_val);
    if lengths.delta_z <= z_min_val {
        return 0.0;
    }
    let kmet = k_met(lengths, z_min_val, variant);
    let x = C2 * c3_val * lengths.delta_z / lambda;
    match variant {
        BarrierVariant::V1996 => 10.0 * (3.0 + x * kmet).log10(),
        BarrierVariant::V2024 => 10.0 * (1.0 + (2.0 + x) * kmet).log10(),
    }
}

/// Cap `Dz` to the per-mode maximum (ISO/TR 17534-3 §5.3 — applied to the
/// **over-top** path only, never to lateral paths):
///   - single edge (`e_total == 0`): 20 dB
///   - multi-edge: 25 dB
///
/// Caller may override with a tighter project-level cap (e.g. 3 dB for the
/// Annex D terrain-screening case).
pub fn cap(dz: f64, e_total: f64, override_cap_db: Option<f64>) -> f64 {
    let max_db = override_cap_db.unwrap_or({
        if e_total < 1e-9 { 20.0 } else { 25.0 }
    });
    if dz > max_db {
        max_db
    } else {
        dz
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn c3_for_single_edge_is_one() {
        assert_relative_eq!(c3(0.0, 0.34), 1.0, epsilon = 1e-12);
    }

    #[test]
    fn c3_is_frequency_dependent() {
        // e = 40 m. At 1 kHz (λ = 0.34): 5λ/e = 0.0425, (·)² = 0.00181,
        // C3 = 1.00181 / 0.33514 = 2.989.
        assert_relative_eq!(c3(40.0, 0.34), 2.989, epsilon = 0.01);
        // At 63 Hz (λ = 5.397): 5λ/e = 0.6746, (·)² = 0.4551,
        // C3 = 1.4551 / 0.7884 = 1.845 — much lower than the high-freq limit.
        assert_relative_eq!(c3(40.0, 340.0 / 63.0), 1.845, epsilon = 0.01);
    }

    #[test]
    fn z_min_at_500hz_single_edge() {
        // λ = 340/500 = 0.680, C3 = 1, zmin = -2·0.680/20 = -0.068 (Eq 19).
        let z = z_min(0.680, 1.0);
        assert_relative_eq!(z, -0.068, epsilon = 1e-3);
    }

    #[test]
    fn dz_below_zmin_is_zero() {
        let lengths = PathLengths {
            d_direct: 100.0,
            d_ss: 0.0,
            d_sr: 0.0,
            e_total: 0.0,
            delta_z: -0.5,
        };
        assert_relative_eq!(dz_uncapped(&lengths, 0.680, BarrierVariant::V2024), 0.0, epsilon = 1e-12);
        assert_relative_eq!(dz_uncapped(&lengths, 0.680, BarrierVariant::V1996), 0.0, epsilon = 1e-12);
    }

    #[test]
    fn v1996_and_v2024_agree_when_kmet_is_one() {
        // With Kmet = 1 the two brackets coincide: 3 + X = 1 + (2 + X).
        // Kmet = 1 for V1996 requires z ≤ 0; pick z in (zmin, 0] and compare a
        // hand value. λ = 0.34 (1 kHz), C3 = 1, zmin = -0.034; take z = -0.02.
        // X = 20·(-0.02)/0.34 = -1.1765. Dz = 10·lg(3 - 1.1765) = 10·lg(1.8235)
        //    = 2.609 dB. V2024 Kmet at z=-0.02 is NOT 1, so only V1996 checked.
        let lengths = PathLengths { d_direct: 100.0, d_ss: 50.0, d_sr: 50.0, e_total: 0.0, delta_z: -0.02 };
        let dz = dz_uncapped(&lengths, 0.34, BarrierVariant::V1996);
        assert_relative_eq!(dz, 2.609, epsilon = 0.01);
    }

    #[test]
    fn cap_clamps_above_threshold() {
        // 25 dB single-edge override → 25 dB
        assert_relative_eq!(cap(30.0, 0.0, Some(25.0)), 25.0, epsilon = 1e-12);
        // No override, single edge → 20 dB
        assert_relative_eq!(cap(30.0, 0.0, None), 20.0, epsilon = 1e-12);
        // No override, multi-edge → 25 dB
        assert_relative_eq!(cap(30.0, 40.0, None), 25.0, epsilon = 1e-12);
        // Below cap — pass through
        assert_relative_eq!(cap(15.0, 0.0, None), 15.0, epsilon = 1e-12);
    }
}
