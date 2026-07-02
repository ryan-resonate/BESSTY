//! ISO 9613-2 §8 — long-term meteorological correction Cmet.
//!
//! Identical in the 1996 and 2024 editions (1996 Eqs 21/22 ≡ 2024 Eqs 31/32).

/// Meteorological correction Cmet (dB), subtracted from the downwind level to
/// give the long-term average. Frequency-independent, so it applies equally
/// to every band.
///
/// `c0` is the local-meteorology factor (dB; 0 disables the correction),
/// `hs`/`hr` the source/receiver heights above ground (m), and `dp` the
/// source→receiver distance projected on the ground plane (m).
///
///   Cmet = 0                       if dp ≤ 10·(hs + hr)
///   Cmet = C0·[1 − 10·(hs+hr)/dp]  otherwise
pub fn cmet_db(c0: f64, hs: f64, hr: f64, dp: f64) -> f64 {
    if c0 <= 0.0 || !dp.is_finite() || dp <= 0.0 {
        return 0.0;
    }
    let h = hs + hr;
    if dp <= 10.0 * h {
        return 0.0;
    }
    c0 * (1.0 - 10.0 * h / dp)
}

#[cfg(test)]
mod tests {
    use approx::assert_relative_eq;
    use super::*;

    #[test]
    fn zero_inside_ten_h_sum() {
        // dp = 10·(hs+hr) is the boundary — at or below it, Cmet = 0.
        assert_relative_eq!(cmet_db(3.0, 5.0, 1.5, 65.0), 0.0, epsilon = 1e-12);
        assert_relative_eq!(cmet_db(3.0, 5.0, 1.5, 64.0), 0.0, epsilon = 1e-12);
    }

    #[test]
    fn matches_formula_beyond_boundary() {
        // hs = 5, hr = 1.5, dp = 650 → Cmet = 3·(1 − 65/650) = 2.7 dB.
        assert_relative_eq!(cmet_db(3.0, 5.0, 1.5, 650.0), 2.7, epsilon = 1e-12);
    }

    #[test]
    fn disabled_when_c0_zero_or_bad_dp() {
        assert_relative_eq!(cmet_db(0.0, 5.0, 1.5, 650.0), 0.0, epsilon = 1e-12);
        assert_relative_eq!(cmet_db(3.0, 5.0, 1.5, f64::NAN), 0.0, epsilon = 1e-12);
        assert_relative_eq!(cmet_db(3.0, 5.0, 1.5, 0.0), 0.0, epsilon = 1e-12);
    }
}
