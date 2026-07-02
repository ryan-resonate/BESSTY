//! ISO 9613-2:2024 — 7.4.1 Barrier diffraction (Eqs 18–21).
//!
//! ⚠ KNOWN DEVIATIONS (preserved verbatim through the Phase-0 restructure so
//! the golden gate stays byte-identical; fixed in Phase 1 with hand-calculated
//! expected values — see `docs/iso9613-solver-phase01-execution.md` §2.3 and
//! `docs/iso9613-2-1996-vs-2024-differences.md` §8.1):
//!   1. `dz_uncapped` uses bracket constant 3 — the 2024 standard (Eq 18,
//!      printed p.16) specifies 2: `Dz = 10·lg[1 + (2 + (C2/λ)C3·z)·Kmet]`.
//!   2. `z_min` returns `−λ/(C2·C3)` — Eq 19 specifies `−2λ/(C2·C3)`.
//!   3. `cap` is applied by the caller to lateral paths too — ISO/TR 17534-3
//!      §5.3 restricts the 20/25 dB caps to over-top diffraction only.

use super::path::PathLengths;

/// `C2` per Eq 18: 20 in the standard configuration (ground reflections
/// already accounted for in `Agr`). 40 if reflections are tracked separately
/// via image sources — not used yet.
pub const C2: f64 = 20.0;

/// `C3` per Eq 20.
///   - 1 for single diffraction (e = 0).
///   - `(1 + (5λ/e)²) / (1/3 + (5λ/e)²)` for multi-edge.
pub fn c3(e_total: f64) -> f64 {
    if e_total < 1e-9 {
        1.0
    } else {
        let r = 5.0 / e_total;
        let r_sq = r * r;
        (1.0 + r_sq) / (1.0 / 3.0 + r_sq)
    }
}

/// `zmin` per Eq 19. ⚠ Deviation #2 above — Phase 1 corrects to −2λ/(C2·C3).
pub fn z_min(lambda: f64, c3_val: f64) -> f64 {
    -lambda / (C2 * c3_val)
}

/// Meteorological correction `Kmet` per Eq 21.
///
/// Eq 21 is defined for the whole `z > zmin` domain (where `Dz` is non-zero),
/// not just `z > 0`. As `z → zmin⁺` the denominator `2(z − zmin) → 0`, the
/// argument → ∞, and `Kmet → 0`, so `Dz = 10·log10(1 + inner·Kmet) → 0`
/// continuously into the `z ≤ zmin → Dz = 0` branch. Guarding at `z ≤ zmin`
/// keeps the value continuous and avoids the division by zero at `z = zmin`
/// (where `Dz` is 0 regardless of `Kmet`).
pub fn k_met(lengths: &PathLengths, z_min_val: f64) -> f64 {
    if lengths.delta_z <= z_min_val {
        // At or below zmin Dz is 0 anyway; return 1 to avoid the 0/0 in the
        // denominator. The caller (`dz_uncapped`) already short-circuits here.
        return 1.0;
    }
    let max_dss_dsr = if lengths.d_ss >= lengths.d_sr {
        lengths.d_ss
    } else {
        lengths.d_sr
    };
    let min_dss_dsr = if lengths.d_ss <= lengths.d_sr {
        lengths.d_ss
    } else {
        lengths.d_sr
    };
    let numerator = (max_dss_dsr + lengths.e_total) * min_dss_dsr * lengths.d_direct;
    let denominator = 2.0 * (lengths.delta_z - z_min_val);
    let arg = (numerator / denominator).sqrt();
    (-arg / 2000.0).exp()
}

/// `Dz` per Eq 18 (without the 20/25 dB cap — caller applies that).
/// ⚠ Deviation #1 above — Phase 1 corrects the bracket constant to 2.
pub fn dz_uncapped(lengths: &PathLengths, lambda: f64) -> f64 {
    let c3_val = c3(lengths.e_total);
    let z_min_val = z_min(lambda, c3_val);
    if lengths.delta_z <= z_min_val {
        return 0.0;
    }
    let kmet = k_met(lengths, z_min_val);
    let inner = 3.0 + C2 * c3_val * lengths.delta_z / lambda;
    10.0 * (1.0 + inner * kmet).log10()
}

/// Cap `Dz` to the per-mode maximum:
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
        assert_relative_eq!(c3(0.0), 1.0, epsilon = 1e-12);
    }

    #[test]
    fn c3_for_e_40m_matches_case_04() {
        // C3 = (1 + (5/40)²) / (1/3 + (5/40)²) = 1.0156 / 0.3490 = 2.911
        assert_relative_eq!(c3(40.0), 2.911, epsilon = 0.01);
    }

    #[test]
    fn z_min_at_500hz_single_edge() {
        // Current (deviating) form: λ = 340/500 = 0.680, C3 = 1,
        // zmin = -0.680/20 = -0.034. Phase 1 corrects to -0.068 (Eq 19).
        let z = z_min(0.680, 1.0);
        assert_relative_eq!(z, -0.034, epsilon = 1e-3);
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
        assert_relative_eq!(dz_uncapped(&lengths, 0.680), 0.0, epsilon = 1e-12);
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
