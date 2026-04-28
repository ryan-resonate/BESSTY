//! ISO 9613-2:2024 — 7.4.1 Barrier diffraction (Eqs 18–21).

use crate::dual::ADScalar;

use super::path::PathLengths;

/// `C2` per Eq 18: 20 in the standard configuration (ground reflections
/// already accounted for in `Agr`). 40 if reflections are tracked separately
/// via image sources — not used in v0.3.
pub const C2: f64 = 20.0;

/// `C3` per Eq 20.
///   - 1 for single diffraction (e = 0).
///   - `(1 + (5/e)²) / (1/3 + (5/e)²)` for multi-edge.
pub fn c3<T: ADScalar>(e_total: T) -> T {
    let e_v = e_total.to_f64();
    if e_v < 1e-9 {
        T::one()
    } else {
        let r = T::from_f64(5.0) / e_total;
        let r_sq = r * r;
        (T::one() + r_sq) / (T::from_f64(1.0 / 3.0) + r_sq)
    }
}

/// `zmin` per Eq 19.
pub fn z_min<T: ADScalar>(lambda: f64, c3_val: T) -> T {
    T::from_f64(-lambda) / (T::from_f64(C2) * c3_val)
}

/// Meteorological correction `Kmet` per Eq 21.
pub fn k_met<T: ADScalar>(lengths: &PathLengths<T>, z_min_val: T) -> T {
    let delta_z_v = lengths.delta_z.to_f64();
    if delta_z_v <= 0.0 {
        // Standard treats Kmet = 1 when there is no positive path-length
        // difference (no over-top diffraction).
        return T::one();
    }
    let max_dss_dsr = if lengths.d_ss.to_f64() >= lengths.d_sr.to_f64() {
        lengths.d_ss
    } else {
        lengths.d_sr
    };
    let min_dss_dsr = if lengths.d_ss.to_f64() <= lengths.d_sr.to_f64() {
        lengths.d_ss
    } else {
        lengths.d_sr
    };
    let numerator = (max_dss_dsr + lengths.e_total) * min_dss_dsr * lengths.d_direct;
    let denominator = T::from_f64(2.0) * (lengths.delta_z - z_min_val);
    let arg = (numerator / denominator).sqrt();
    (-arg / T::from_f64(2000.0)).exp()
}

/// `Dz` per Eq 18 (without the 20/25 dB cap — caller applies that).
pub fn dz_uncapped<T: ADScalar>(lengths: &PathLengths<T>, lambda: f64) -> T {
    let c3_val = c3(lengths.e_total);
    let z_min_val = z_min(lambda, c3_val);
    if lengths.delta_z.to_f64() <= z_min_val.to_f64() {
        return T::zero();
    }
    let kmet = k_met(lengths, z_min_val);
    let inner = T::from_f64(3.0) + T::from_f64(C2) * c3_val * lengths.delta_z / T::from_f64(lambda);
    T::from_f64(10.0) * (T::one() + inner * kmet).log10()
}

/// Cap `Dz` to the per-mode maximum:
///   - single edge (`e_total == 0`): 20 dB
///   - multi-edge: 25 dB
///
/// Caller may override with a tighter project-level cap (e.g. 3 dB for the
/// Annex D terrain-screening case).
pub fn cap<T: ADScalar>(dz: T, e_total: T, override_cap_db: Option<f64>) -> T {
    let max_db = override_cap_db.unwrap_or_else(|| {
        if e_total.to_f64() < 1e-9 { 20.0 } else { 25.0 }
    });
    let dz_v = dz.to_f64();
    if dz_v > max_db {
        // Switch to a constant — gradient w.r.t. all inputs becomes 0 above
        // the cap. Orchestrator handles the tripwire.
        T::from_f64(max_db)
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
        assert_relative_eq!(c3(0.0_f64), 1.0, epsilon = 1e-12);
    }

    #[test]
    fn c3_for_e_40m_matches_case_04() {
        // C3 = (1 + (5/40)²) / (1/3 + (5/40)²) = 1.0156 / 0.3490 = 2.911
        assert_relative_eq!(c3(40.0_f64), 2.911, epsilon = 0.01);
    }

    #[test]
    fn z_min_at_500hz_single_edge() {
        // λ = 340/500 = 0.680, C3 = 1, zmin = -0.680/20 = -0.034
        let z = z_min(0.680_f64, 1.0_f64);
        assert_relative_eq!(z, -0.034, epsilon = 1e-3);
    }

    #[test]
    fn dz_below_zmin_is_zero() {
        let lengths = PathLengths {
            d_direct: 100.0_f64,
            d_ss: 0.0,
            d_sr: 0.0,
            e_total: 0.0,
            delta_z: -0.5,
        };
        assert_relative_eq!(dz_uncapped(&lengths, 0.680_f64), 0.0, epsilon = 1e-12);
    }

    #[test]
    fn cap_clamps_above_threshold() {
        // 25 dB single-edge override → 25 dB
        assert_relative_eq!(cap(30.0_f64, 0.0_f64, Some(25.0)), 25.0, epsilon = 1e-12);
        // No override, single edge → 20 dB
        assert_relative_eq!(cap(30.0_f64, 0.0_f64, None), 20.0, epsilon = 1e-12);
        // No override, multi-edge → 25 dB
        assert_relative_eq!(cap(30.0_f64, 40.0_f64, None), 25.0, epsilon = 1e-12);
        // Below cap — pass through
        assert_relative_eq!(cap(15.0_f64, 0.0_f64, None), 15.0, epsilon = 1e-12);
    }
}
