//! ISO 9613-2 Annex A — miscellaneous attenuation `Amisc` (foliage, industrial
//! sites, housing). Informative; identical (simplified form) in the 1996 and
//! 2024 editions. These kernels are edition-independent and **off by default**
//! (a scene contributes 0 unless it supplies foliage / site / housing extents).
//!
//! Band layout is the crate's 10-band octave set (16 Hz – 8 kHz); Annex A
//! tabulates 63 Hz – 8 kHz, so the sub-63 Hz octaves reuse the 63 Hz entry.

/// Attenuation through dense foliage `Afol` per octave (dB), Table A.1.
/// `df` is the path length through foliage (m): `< 10 m` → 0; `10–20 m` → the
/// fixed dB row; `20–200 m` → the per-metre row × `df`; `> 200 m` → the 200 m
/// value.
pub fn afol(df: f64) -> [f64; 10] {
    if df < 10.0 {
        return [0.0; 10];
    }
    if df <= 20.0 {
        // 16/31.5/63 → 63's 0; 125,250,500,1k,2k,4k,8k = 0,1,1,1,1,2,3.
        return [0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 2.0, 3.0];
    }
    // Per-metre (dB/m) for 63…8k, sub-63 reuses 63.
    let per_m = [0.02, 0.02, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.09, 0.12];
    let d = df.min(200.0);
    per_m.map(|x| x * d)
}

/// Attenuation through an industrial site `Asite` per octave (dB), Table A.7:
/// per-metre coefficients × the path length `ds` (m) through installations,
/// each band capped at 10 dB.
pub fn asite(ds: f64) -> [f64; 10] {
    // 16/31.5/63 → 63's 0; 125,250,500,1k,2k,4k,8k = .015,.025,.025,.02,.02,.015,.015.
    let per_m = [0.0, 0.0, 0.0, 0.015, 0.025, 0.025, 0.02, 0.02, 0.015, 0.015];
    per_m.map(|x| (x * ds).min(10.0))
}

/// A-weighted housing attenuation `Ahous` (dB), Eqs A.4–A.6, capped at 10 dB.
///
/// - `Ahous,1 = 0.1·B·db` where `B` is the building plan-density (0…1) and `db`
///   the path length through the built-up region (m);
/// - `Ahous,2 = −10·lg(1 − p/100)` for well-defined façade rows, `p` = façade
///   percentage along the corridor (≤ 90 %); 0 if not applicable.
///
/// Frequency-independent (an A-weighted correction).
pub fn ahous(b_density: f64, db: f64, facade_pct: f64) -> f64 {
    let a1 = 0.1 * b_density * db;
    let a2 = if facade_pct > 0.0 {
        let p = facade_pct.min(90.0);
        -10.0 * (1.0 - p / 100.0).log10()
    } else {
        0.0
    };
    (a1 + a2).min(10.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn afol_bands_and_ranges() {
        assert_eq!(afol(5.0), [0.0; 10]); // below 10 m → nothing
        // 15 m (10–20 band): fixed dB row.
        assert_eq!(afol(15.0), [0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 2.0, 3.0]);
        // 100 m: per-metre × 100 → 1 kHz (0.06/m) = 6 dB.
        assert_relative_eq!(afol(100.0)[6], 6.0, epsilon = 1e-9);
        // > 200 m clamps to the 200 m value → 8 kHz (0.12/m × 200) = 24 dB.
        assert_relative_eq!(afol(500.0)[9], 24.0, epsilon = 1e-9);
    }

    #[test]
    fn asite_scales_and_caps() {
        // 250 Hz: 0.025/m × 100 = 2.5 dB.
        assert_relative_eq!(asite(100.0)[4], 2.5, epsilon = 1e-9);
        // 10 dB cap: 0.025/m × 1000 = 25 → capped to 10.
        assert_relative_eq!(asite(1000.0)[4], 10.0, epsilon = 1e-9);
    }

    #[test]
    fn ahous_density_facade_and_cap() {
        // B = 0.4, db = 100 → Ahous,1 = 0.1·0.4·100 = 4 dB (no facades).
        assert_relative_eq!(ahous(0.4, 100.0, 0.0), 4.0, epsilon = 1e-9);
        // facades p = 50 % → Ahous,2 = −10·lg(0.5) = 3.0103 dB (B = 0).
        assert_relative_eq!(ahous(0.0, 0.0, 50.0), 3.0103, epsilon = 1e-3);
        // Cap at 10 dB.
        assert_relative_eq!(ahous(1.0, 500.0, 0.0), 10.0, epsilon = 1e-9);
    }
}
