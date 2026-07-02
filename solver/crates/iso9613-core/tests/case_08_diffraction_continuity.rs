//! Validation case 08 — barrier diffraction continuity across `z = zmin`.
//!
//! Locks finding A5 from `docs/solver-review-2026-06.md`: `Kmet` (Eq 21) is
//! defined for the whole `z > zmin` domain, and as `z → zmin⁺` it must drive
//! `Dz → 0` continuously into the `z ≤ zmin → Dz = 0` branch. The previous
//! `k_met` short-circuited at `z ≤ 0`, returning `Kmet = 1` for `zmin < z ≤ 0`
//! and injecting a ~4.8 dB step (and an AD-gradient kink) at `z = zmin`.
//!
//! This test would FAIL against that old behaviour (Dz just above zmin ≈ 4.8 dB)
//! and PASS with the corrected, continuous form (Dz just above zmin ≈ 0).

use approx::assert_relative_eq;
use iso9613_core::iso9613::barrier::diffraction;
use iso9613_core::iso9613::barrier::path::PathLengths;

/// Realistic single-edge path lengths with a controllable `delta_z`. The
/// component lengths are held fixed (illustrative) so we can sweep `delta_z`
/// straight through `zmin`; only their use inside `Kmet` matters here.
fn lengths_with_dz(delta_z: f64) -> PathLengths {
    PathLengths {
        d_direct: 100.0,
        d_ss: 50.09,
        d_sr: 50.42,
        e_total: 0.0, // single edge → C3 = 1
        delta_z,
    }
}

#[test]
fn dz_is_continuous_across_zmin() {
    let lambda = 340.0 / 1000.0; // 1 kHz, λ = 0.34 m
    let c3 = 1.0;
    let zmin = -lambda / (20.0 * c3); // = -0.017 m
    let eps = 1e-4;

    let below = diffraction::dz_uncapped(&lengths_with_dz(zmin - eps), lambda);
    let above = diffraction::dz_uncapped(&lengths_with_dz(zmin + eps), lambda);

    // Below zmin: hard zero.
    assert_relative_eq!(below, 0.0, epsilon = 1e-12);
    // Just above zmin: Kmet → 0, so Dz must be ~0 (NOT ~4.8 dB). This is the
    // assertion that fails on the pre-A5 short-circuit.
    assert!(above < 0.05, "Dz just above zmin should be ≈0, got {above} dB");
    // No discontinuity at the boundary.
    assert!((above - below).abs() < 0.05, "step at zmin = {} dB", (above - below).abs());
}

#[test]
fn dz_rises_smoothly_with_positive_dz() {
    // For genuine over-top diffraction (z > 0) Dz must be positive and grow
    // monotonically with delta_z — and stay continuous with the near-zmin
    // regime above.
    let lambda = 340.0 / 1000.0;
    let mut prev = 0.0;
    for step in 0..20 {
        let dz = -0.017 + (step as f64) * 0.05; // sweep from ~zmin upward
        let val = diffraction::dz_uncapped(&lengths_with_dz(dz), lambda);
        assert!(val >= -1e-9, "Dz must be non-negative, got {val} at Δz={dz}");
        if dz > 0.05 {
            assert!(val >= prev - 1e-9, "Dz must be monotonic; {val} < {prev} at Δz={dz}");
        }
        prev = val;
    }
}
