//! Per-octave-band shape functions a'(h), b'(h), c'(h), d'(h) from
//! ISO 9613-2 Table 3 (identical in the 1996 and 2024 editions).
//!
//! These appear in the AS / AR component formulae as multipliers on the
//! ground factor G:
//!
//!   AS = -1.5 + G · a'(h)         at 125 Hz
//!   AS = -1.5 + G · b'(h)         at 250 Hz
//!   AS = -1.5 + G · c'(h)         at 500 Hz
//!   AS = -1.5 + G · d'(h)         at 1 kHz
//!
//! `h` is the height of the source or receiver above local ground (m); `dp`
//! is the source-to-receiver distance projected onto the ground plane (m).

/// Shape function used at the 125 Hz octave band.
///
/// `a'(h) = 1.5 + 3.0·exp(-0.12·(h-5)²)·(1 - exp(-dp/50))`
/// `       + 5.7·exp(-0.09·h²)·(1 - exp(-2.8e-6·dp²))`
pub fn a_prime(h: f64, dp: f64) -> f64 {
    let h_minus_5 = h - 5.0;
    let term1 = 3.0
        * (-0.12 * h_minus_5 * h_minus_5).exp()
        * (1.0 - (-dp / 50.0).exp());
    let term2 = 5.7
        * (-0.09 * h * h).exp()
        * (1.0 - (-2.8e-6 * dp * dp).exp());
    1.5 + term1 + term2
}

/// Shape function used at the 250 Hz octave band.
/// `b'(h) = 1.5 + 8.6·exp(-0.09·h²)·(1 - exp(-dp/50))`
pub fn b_prime(h: f64, dp: f64) -> f64 {
    1.5 + 8.6 * (-0.09 * h * h).exp() * (1.0 - (-dp / 50.0).exp())
}

/// Shape function used at the 500 Hz octave band.
/// `c'(h) = 1.5 + 14.0·exp(-0.46·h²)·(1 - exp(-dp/50))`
pub fn c_prime(h: f64, dp: f64) -> f64 {
    1.5 + 14.0 * (-0.46 * h * h).exp() * (1.0 - (-dp / 50.0).exp())
}

/// Shape function used at the 1 kHz octave band.
/// `d'(h) = 1.5 + 5.0·exp(-0.9·h²)·(1 - exp(-dp/50))`
pub fn d_prime(h: f64, dp: f64) -> f64 {
    1.5 + 5.0 * (-0.9 * h * h).exp() * (1.0 - (-dp / 50.0).exp())
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    // Hand-calculated values for h = 5 m, dp = 200 m (case 02 source region).
    #[test]
    fn shape_functions_at_h5_dp200() {
        let h = 5.0_f64;
        let dp = 200.0_f64;
        assert_relative_eq!(a_prime(h, dp), 4.509, epsilon = 0.01);
        assert_relative_eq!(b_prime(h, dp), 2.390, epsilon = 0.01);
        assert_relative_eq!(c_prime(h, dp), 1.500, epsilon = 0.01);
        assert_relative_eq!(d_prime(h, dp), 1.500, epsilon = 0.01);
    }

    // Hand-calculated values for h = 1.5 m, dp = 200 m (case 02 receiver region).
    #[test]
    fn shape_functions_at_h1_5_dp200() {
        let h = 1.5_f64;
        let dp = 200.0_f64;
        assert_relative_eq!(a_prime(h, dp), 2.671, epsilon = 0.01);
        assert_relative_eq!(b_prime(h, dp), 8.395, epsilon = 0.01);
        assert_relative_eq!(c_prime(h, dp), 6.381, epsilon = 0.01);
        assert_relative_eq!(d_prime(h, dp), 2.148, epsilon = 0.01);
    }
}
