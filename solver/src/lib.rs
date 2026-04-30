//! BEESTY noise solver — ISO 9613-2:2024 implementation with forward-mode AD.
//!
//! See `docs/solver-design.md` for the architecture and `validation/` for the
//! reference test cases.
//!
//! v0.4 status: Adiv + Aatm + Agr (General method 7.3.1) + Abar (7.4.1
//! over-top) + Annex D wind turbine rules. Reflections and lateral
//! diffraction land in subsequent versions.

pub mod dual;
pub mod iso9613;
pub mod spectrum;
pub mod units;

pub use dual::{ADScalar, Dual};
pub use spectrum::{BandSpectrum, BandSystem};
pub use units::{Decibels, Hz, Metres, Vec3};

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use crate::iso9613::annex_d::WtgRules;
    use crate::iso9613::atmosphere::Atmosphere;
    use crate::iso9613::barrier::{BarrierConvention, WallBarrier};
    use wasm_bindgen::prelude::*;

    fn unpack_walls(flat: &[f64]) -> Vec<WallBarrier<f64>> {
        flat.chunks_exact(5)
            .map(|c| WallBarrier {
                a_e: c[0], a_n: c[1], b_e: c[2], b_n: c[3], top_z: c[4],
            })
            .collect()
    }

    /// Pick a band system from the input array length: 10 → octave (16 Hz – 8 kHz),
    /// 31 → one-third octave (10 Hz – 10 kHz). Lets one set of WASM functions
    /// serve both systems — caller passes the right-sized array.
    fn band_system_for(n: usize) -> BandSystem {
        match n {
            10 => BandSystem::Octave,
            31 => BandSystem::OneThirdOctave,
            _ => panic!("unsupported band count: {} (expected 10 or 31)", n),
        }
    }

    /// Helper: parse the JS-side `barrierConvention` int (0 = ISO Eq16,
    /// 1 = Dz − max(Agr, 0)) into the Rust enum. Default to ISO Eq16
    /// when callers haven't been updated yet.
    fn barrier_conv(flag: u32) -> BarrierConvention {
        if flag == 1 { BarrierConvention::DzMinusMaxAgr0 } else { BarrierConvention::IsoEq16 }
    }

    /// Helper: turn the JS-side `dz_cap_db` float into `Option<f64>`.
    /// Negative or non-finite (sentinel `-1.0` from JS) → no override
    /// (use the standard ISO §7.4 20 / 25 dB caps); a finite non-negative
    /// value overrides those caps uniformly across bands.
    fn dz_cap(v: f64) -> Option<f64> {
        if v.is_finite() && v >= 0.0 { Some(v) } else { None }
    }

    /// General point source (BESS, auxiliary, generic). Output length matches
    /// input length: 10 for octave, 31 for one-third octave.
    ///
    /// `barriers_flat` is `[a_e, a_n, b_e, b_n, top_z, ...]` — five values
    /// per straight wall.
    /// Atmosphere is passed as 3 floats (T °C, RH %, p kPa) — pass
    /// (10, 70, 101.325) for the ISO 9613-2 reference.
    #[wasm_bindgen]
    pub fn evaluate_general_octave(
        lw: &[f64],
        src_e: f64, src_n: f64, src_z: f64,
        rx_e: f64, rx_n: f64, rx_z: f64,
        g: f64,
        barriers_flat: &[f64],
        atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
        barrier_convention: u32,
        dz_cap_db: f64,
    ) -> Vec<f64> {
        let bs = band_system_for(lw.len());
        let lw_spec = BandSpectrum::from_iter(bs, lw.iter().copied());
        let s = Vec3::new(src_e, src_n, src_z);
        let r = Vec3::new(rx_e, rx_n, rx_z);
        let walls = unpack_walls(barriers_flat);
        let atm = Atmosphere {
            temperature_c: atm_temp_c,
            relative_humidity_pct: atm_rh_pct,
            pressure_kpa: atm_pres_kpa,
        };
        let out = iso9613::evaluate_with_barriers(
            &lw_spec, s, r, g, &walls, dz_cap(dz_cap_db), atm, barrier_conv(barrier_convention),
        );
        out.bands.into_iter().collect()
    }

    /// Wind turbine source (Annex D rules). Octave or third-octave by lw length.
    #[wasm_bindgen]
    pub fn evaluate_wtg_octave(
        lw: &[f64],
        hub_e: f64, hub_n: f64, hub_z: f64,
        rx_e: f64, rx_n: f64, rx_z: f64,
        g: f64,
        barriers_flat: &[f64],
        rotor_diameter_m: f64,
        apply_concave: bool,
        atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
        barrier_convention: u32,
    ) -> Vec<f64> {
        let bs = band_system_for(lw.len());
        let lw_spec = BandSpectrum::from_iter(bs, lw.iter().copied());
        let hub = Vec3::new(hub_e, hub_n, hub_z);
        let r = Vec3::new(rx_e, rx_n, rx_z);
        let walls = unpack_walls(barriers_flat);
        let atm = Atmosphere {
            temperature_c: atm_temp_c,
            relative_humidity_pct: atm_rh_pct,
            pressure_kpa: atm_pres_kpa,
        };
        let out = iso9613::annex_d::evaluate_wtg(
            &lw_spec, hub, r, g, &walls,
            WtgRules::default(), apply_concave, rotor_diameter_m,
            atm, barrier_conv(barrier_convention),
        );
        out.bands.into_iter().collect()
    }

    /// Energy-sum a vector of per-band Lp arrays into one A-weighted total
    /// dB(A) value. 10 bands → octave; 31 → one-third octave.
    #[wasm_bindgen]
    pub fn a_weighted_total(lp_summed: &[f64]) -> f64 {
        let bs = band_system_for(lp_summed.len());
        let s = BandSpectrum::from_iter(bs, lp_summed.iter().copied());
        s.a_weighted_total()
    }

    /// Octave-band centre frequencies (Hz) — 8 values.
    #[wasm_bindgen]
    pub fn octave_centres() -> Vec<f64> {
        crate::spectrum::OCTAVE_CENTRES_HZ.to_vec()
    }

    /// Octave-band A-weighting offsets (dB) — 8 values.
    #[wasm_bindgen]
    pub fn octave_a_weighting() -> Vec<f64> {
        crate::spectrum::OCTAVE_A_WEIGHTING_DB.to_vec()
    }

    // ---------- Gradient-bearing variants for fast Taylor updates ----------
    //
    // These use forward-mode dual numbers to return BOTH the per-band Lp at
    // the snapshot point AND the partial derivatives ∂Lp/∂(source.{e,n,z}).
    //
    // Output layout (length 40):
    //   [0..10]  : per-band Lp values (dB) — 10 octave bands
    //   [10..40] : per-band gradient — for band i (0-indexed), indices
    //              10 + 3·i + {0,1,2} give ∂Lp_i/∂src_e, ∂Lp_i/∂src_n,
    //              ∂Lp_i/∂src_z (dB/m)
    //
    // The orchestrator caches both, then extrapolates a moved source via
    //   Lp_new[i] ≈ Lp[i] + ∂Lp_i/∂e · Δe + ∂Lp_i/∂n · Δn + ∂Lp_i/∂z · Δz
    //
    // Receivers don't move during a typical drag (and grid cells never do),
    // so we don't include receiver gradients here. Receiver-drag falls back
    // to the existing exact evaluator until that gradient is added.

    fn unpack_walls_dual<const N: usize>(flat: &[f64]) -> Vec<WallBarrier<crate::dual::Dual<N>>> {
        flat.chunks_exact(5)
            .map(|c| WallBarrier {
                a_e: crate::dual::Dual::<N>::constant(c[0]),
                a_n: crate::dual::Dual::<N>::constant(c[1]),
                b_e: crate::dual::Dual::<N>::constant(c[2]),
                b_n: crate::dual::Dual::<N>::constant(c[3]),
                top_z: crate::dual::Dual::<N>::constant(c[4]),
            })
            .collect()
    }

    fn pack_dual_grad(out: &BandSpectrum<crate::dual::Dual<3>>) -> Vec<f64> {
        let n = out.bands.len();
        let mut result = Vec::with_capacity(n + n * 3);
        for band in &out.bands { result.push(band.v); }
        for band in &out.bands {
            result.push(band.d[0]);
            result.push(band.d[1]);
            result.push(band.d[2]);
        }
        result
    }

    /// General point source with source-position gradient. Output length:
    /// (lw.len()) primal + (lw.len() × 3) gradient = 4 × lw.len() floats.
    #[wasm_bindgen]
    pub fn evaluate_general_with_grad_src_octave(
        lw: &[f64],
        src_e: f64, src_n: f64, src_z: f64,
        rx_e: f64, rx_n: f64, rx_z: f64,
        g: f64,
        barriers_flat: &[f64],
        atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
        barrier_convention: u32,
        dz_cap_db: f64,
    ) -> Vec<f64> {
        type D = crate::dual::Dual<3>;
        let bs = band_system_for(lw.len());
        let lw_spec = BandSpectrum::from_iter(bs, lw.iter().map(|&v| D::constant(v)));
        let s = Vec3::new(D::variable(src_e, 0), D::variable(src_n, 1), D::variable(src_z, 2));
        let r = Vec3::new(D::constant(rx_e), D::constant(rx_n), D::constant(rx_z));
        let walls = unpack_walls_dual::<3>(barriers_flat);
        let atm = Atmosphere {
            temperature_c: atm_temp_c,
            relative_humidity_pct: atm_rh_pct,
            pressure_kpa: atm_pres_kpa,
        };
        let out = iso9613::evaluate_with_barriers(
            &lw_spec, s, r, D::constant(g), &walls, dz_cap(dz_cap_db), atm, barrier_conv(barrier_convention),
        );
        pack_dual_grad(&out)
    }

    /// Wind turbine source with source-position gradient.
    #[wasm_bindgen]
    pub fn evaluate_wtg_with_grad_src_octave(
        lw: &[f64],
        hub_e: f64, hub_n: f64, hub_z: f64,
        rx_e: f64, rx_n: f64, rx_z: f64,
        g: f64,
        barriers_flat: &[f64],
        rotor_diameter_m: f64,
        apply_concave: bool,
        atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
        barrier_convention: u32,
    ) -> Vec<f64> {
        type D = crate::dual::Dual<3>;
        let bs = band_system_for(lw.len());
        let lw_spec = BandSpectrum::from_iter(bs, lw.iter().map(|&v| D::constant(v)));
        let hub = Vec3::new(D::variable(hub_e, 0), D::variable(hub_n, 1), D::variable(hub_z, 2));
        let r = Vec3::new(D::constant(rx_e), D::constant(rx_n), D::constant(rx_z));
        let walls = unpack_walls_dual::<3>(barriers_flat);
        let atm = Atmosphere {
            temperature_c: atm_temp_c,
            relative_humidity_pct: atm_rh_pct,
            pressure_kpa: atm_pres_kpa,
        };
        let out = iso9613::annex_d::evaluate_wtg(
            &lw_spec, hub, r, D::constant(g), &walls,
            WtgRules::default(), apply_concave, rotor_diameter_m,
            atm, barrier_conv(barrier_convention),
        );
        pack_dual_grad(&out)
    }
}
