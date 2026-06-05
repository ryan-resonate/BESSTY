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

    // Wall pack stride: [a_e, a_n, b_e, b_n, base_z_a, base_z_b, height_agl].
    // base_z_* are absolute ground elevations under the endpoints; the top
    // follows the terrain (interpolated base + height) at the diffraction
    // crossing — see `WallBarrier`.
    fn unpack_walls(flat: &[f64]) -> Vec<WallBarrier<f64>> {
        flat.chunks_exact(7)
            .map(|c| WallBarrier {
                a_e: c[0], a_n: c[1], b_e: c[2], b_n: c[3],
                base_z_a: c[4], base_z_b: c[5], height_agl: c[6],
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

    /// ISO 9613-2 §8 meteorological correction Cmet (dB). Subtracted from the
    /// downwind octave-band levels to give the long-term average; frequency-
    /// independent, so it applies equally to every band. `c0` is the local-
    /// meteorology factor (dB; 0 disables the correction), `hs`/`hr` the
    /// source/receiver heights above ground (m), and `dp` the source→receiver
    /// distance projected on the ground plane (m).
    ///   Cmet = 0                       if dp ≤ 10·(hs + hr)
    ///   Cmet = C0·[1 − 10·(hs+hr)/dp]  otherwise
    fn cmet_db(c0: f64, hs: f64, hr: f64, dp: f64) -> f64 {
        if c0 <= 0.0 || !dp.is_finite() || dp <= 0.0 {
            return 0.0;
        }
        let h = hs + hr;
        if dp <= 10.0 * h {
            return 0.0;
        }
        c0 * (1.0 - 10.0 * h / dp)
    }

    /// General point source (BESS, auxiliary, generic). Output length matches
    /// input length: 10 for octave, 31 for one-third octave.
    ///
    /// Source/receiver carry TWO heights each: `*_z_abs` (absolute elevation,
    /// used for divergence + barrier diffraction geometry — must share the
    /// barrier `top_z` datum) and `*_hagl` (height above local ground, used by
    /// the ground-attenuation shape functions). On flat ground at elevation 0
    /// the two are equal. See `docs/solver-review-2026-06.md` A1.
    ///
    /// `barriers_flat` is `[a_e, a_n, b_e, b_n, top_z, ...]` — five values
    /// per straight wall; `top_z` is ABSOLUTE (caller adds local ground
    /// elevation to user barrier heights).
    /// Atmosphere is passed as 3 floats (T °C, RH %, p kPa) — pass
    /// (10, 70, 101.325) for the ISO 9613-2 reference.
    #[wasm_bindgen]
    pub fn evaluate_general_octave(
        lw: &[f64],
        src_e: f64, src_n: f64, src_z_abs: f64, src_hagl: f64,
        rx_e: f64, rx_n: f64, rx_z_abs: f64, rx_hagl: f64,
        g: f64,
        barriers_flat: &[f64],
        atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
        barrier_convention: u32,
        dz_cap_db: f64,
        c0: f64,
    ) -> Vec<f64> {
        let bs = band_system_for(lw.len());
        let lw_spec = BandSpectrum::from_iter(bs, lw.iter().copied());
        let s = Vec3::new(src_e, src_n, src_z_abs);
        let r = Vec3::new(rx_e, rx_n, rx_z_abs);
        let walls = unpack_walls(barriers_flat);
        let atm = Atmosphere {
            temperature_c: atm_temp_c,
            relative_humidity_pct: atm_rh_pct,
            pressure_kpa: atm_pres_kpa,
        };
        let out = iso9613::evaluate_with_barriers(
            &lw_spec, s, r, src_hagl, rx_hagl, g, &walls, dz_cap(dz_cap_db), atm, barrier_conv(barrier_convention),
        );
        // §8 long-term meteorological correction (frequency-independent).
        let dp = ((rx_e - src_e).powi(2) + (rx_n - src_n).powi(2)).sqrt();
        let cmet = cmet_db(c0, src_hagl, rx_hagl, dp);
        out.bands.into_iter().map(|b| b - cmet).collect()
    }

    /// Wind turbine source (Annex D rules). Octave or third-octave by lw length.
    ///
    /// `hub_z_abs` is the absolute hub elevation (ground + hub height) used for
    /// geometry; `hub_hagl` is the hub height above ground used by Agr. Same
    /// split for the receiver. See `evaluate_general_octave`.
    #[wasm_bindgen]
    pub fn evaluate_wtg_octave(
        lw: &[f64],
        hub_e: f64, hub_n: f64, hub_z_abs: f64, hub_hagl: f64,
        rx_e: f64, rx_n: f64, rx_z_abs: f64, rx_hagl: f64,
        g: f64,
        barriers_flat: &[f64],
        rotor_diameter_m: f64,
        apply_concave: bool,
        atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
        barrier_convention: u32,
        c0: f64,
    ) -> Vec<f64> {
        let bs = band_system_for(lw.len());
        let lw_spec = BandSpectrum::from_iter(bs, lw.iter().copied());
        let hub = Vec3::new(hub_e, hub_n, hub_z_abs);
        let r = Vec3::new(rx_e, rx_n, rx_z_abs);
        let walls = unpack_walls(barriers_flat);
        let atm = Atmosphere {
            temperature_c: atm_temp_c,
            relative_humidity_pct: atm_rh_pct,
            pressure_kpa: atm_pres_kpa,
        };
        let out = iso9613::annex_d::evaluate_wtg(
            &lw_spec, hub, r, hub_hagl, rx_hagl, g, &walls,
            WtgRules::default(), apply_concave, rotor_diameter_m,
            atm, barrier_conv(barrier_convention),
        );
        let dp = ((rx_e - hub_e).powi(2) + (rx_n - hub_n).powi(2)).sqrt();
        let cmet = cmet_db(c0, hub_hagl, rx_hagl, dp);
        out.bands.into_iter().map(|b| b - cmet).collect()
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
        flat.chunks_exact(7)
            .map(|c| WallBarrier {
                a_e: crate::dual::Dual::<N>::constant(c[0]),
                a_n: crate::dual::Dual::<N>::constant(c[1]),
                b_e: crate::dual::Dual::<N>::constant(c[2]),
                b_n: crate::dual::Dual::<N>::constant(c[3]),
                base_z_a: crate::dual::Dual::<N>::constant(c[4]),
                base_z_b: crate::dual::Dual::<N>::constant(c[5]),
                height_agl: crate::dual::Dual::<N>::constant(c[6]),
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
        src_e: f64, src_n: f64, src_z_abs: f64, src_hagl: f64,
        rx_e: f64, rx_n: f64, rx_z_abs: f64, rx_hagl: f64,
        g: f64,
        barriers_flat: &[f64],
        atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
        barrier_convention: u32,
        dz_cap_db: f64,
    ) -> Vec<f64> {
        type D = crate::dual::Dual<3>;
        let bs = band_system_for(lw.len());
        let lw_spec = BandSpectrum::from_iter(bs, lw.iter().map(|&v| D::constant(v)));
        // Gradient is taken w.r.t. the ABSOLUTE source position (e, n, z_abs):
        // that is what divergence + barrier geometry depend on. The source HAG
        // is a fixed property (machine height) during a drag, so it enters as a
        // constant; the caller extrapolates with Δz_abs (ground-elev change as
        // the source moves over terrain) — see web `extrapolateLpClamped`.
        let s = Vec3::new(D::variable(src_e, 0), D::variable(src_n, 1), D::variable(src_z_abs, 2));
        let r = Vec3::new(D::constant(rx_e), D::constant(rx_n), D::constant(rx_z_abs));
        let walls = unpack_walls_dual::<3>(barriers_flat);
        let atm = Atmosphere {
            temperature_c: atm_temp_c,
            relative_humidity_pct: atm_rh_pct,
            pressure_kpa: atm_pres_kpa,
        };
        let out = iso9613::evaluate_with_barriers(
            &lw_spec, s, r, D::constant(src_hagl), D::constant(rx_hagl),
            D::constant(g), &walls, dz_cap(dz_cap_db), atm, barrier_conv(barrier_convention),
        );
        pack_dual_grad(&out)
    }

    /// Wind turbine source with source-position gradient.
    #[wasm_bindgen]
    pub fn evaluate_wtg_with_grad_src_octave(
        lw: &[f64],
        hub_e: f64, hub_n: f64, hub_z_abs: f64, hub_hagl: f64,
        rx_e: f64, rx_n: f64, rx_z_abs: f64, rx_hagl: f64,
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
        // Gradient w.r.t. absolute hub position; hub HAG is a constant. See the
        // general variant above.
        let hub = Vec3::new(D::variable(hub_e, 0), D::variable(hub_n, 1), D::variable(hub_z_abs, 2));
        let r = Vec3::new(D::constant(rx_e), D::constant(rx_n), D::constant(rx_z_abs));
        let walls = unpack_walls_dual::<3>(barriers_flat);
        let atm = Atmosphere {
            temperature_c: atm_temp_c,
            relative_humidity_pct: atm_rh_pct,
            pressure_kpa: atm_pres_kpa,
        };
        let out = iso9613::annex_d::evaluate_wtg(
            &lw_spec, hub, r, D::constant(hub_hagl), D::constant(rx_hagl),
            D::constant(g), &walls,
            WtgRules::default(), apply_concave, rotor_diameter_m,
            atm, barrier_conv(barrier_convention),
        );
        pack_dual_grad(&out)
    }

    // ---------- Batched grid evaluator (S2) ----------
    //
    // The per-cell-per-source call path crosses the JS↔WASM boundary and
    // allocates a return Vec once per (cell, source) — ~1.2M times for a
    // 200×200 grid × 30 sources. `GridEvaluator` stores the source set + env
    // ONCE, then evaluates a whole cell (all sources, energy-summed) in a
    // single call returning one dB(A) float. That cuts the crossings to one
    // per cell and removes the per-source return allocation. Each worker
    // (Phase 2) owns its own instance, so the stored state is not shared.

    struct SourceRec {
        is_wtg: bool,
        pos: Vec3<f64>, // absolute (e, n, z_abs)
        hagl: f64,      // height above local ground
        rotor_d: f64,
        lw: BandSpectrum<f64>,
    }

    #[wasm_bindgen]
    pub struct GridEvaluator {
        bs: BandSystem,
        sources: Vec<SourceRec>,
        atm: Atmosphere,
        bar_conv: BarrierConvention,
        dz_cap: Option<f64>,
        g: f64,
        c0: f64,
        user_barriers: Vec<WallBarrier<f64>>,
    }

    #[wasm_bindgen]
    impl GridEvaluator {
        /// `sources_flat` is packed per source as
        /// `[is_wtg, e, n, z_abs, hagl, rotor_d, lw_0 … lw_{nb-1}]`
        /// (stride `6 + nb`). `is_wtg` is `1.0`/`0.0`. `user_barriers_flat`
        /// is the shared `[a_e, a_n, b_e, b_n, top_z, …]` pack (absolute z).
        #[wasm_bindgen(constructor)]
        pub fn new(
            sources_flat: &[f64],
            n_bands: usize,
            g: f64,
            user_barriers_flat: &[f64],
            atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
            barrier_convention: u32,
            dz_cap_db: f64,
            c0: f64,
        ) -> GridEvaluator {
            let bs = band_system_for(n_bands);
            let stride = 6 + n_bands;
            let mut sources = Vec::new();
            for chunk in sources_flat.chunks_exact(stride) {
                let lw = BandSpectrum::from_iter(bs, chunk[6..6 + n_bands].iter().copied());
                sources.push(SourceRec {
                    is_wtg: chunk[0] != 0.0,
                    pos: Vec3::new(chunk[1], chunk[2], chunk[3]),
                    hagl: chunk[4],
                    rotor_d: chunk[5],
                    lw,
                });
            }
            GridEvaluator {
                bs,
                sources,
                atm: Atmosphere {
                    temperature_c: atm_temp_c,
                    relative_humidity_pct: atm_rh_pct,
                    pressure_kpa: atm_pres_kpa,
                },
                bar_conv: barrier_conv(barrier_convention),
                dz_cap: dz_cap(dz_cap_db),
                g,
                c0,
                user_barriers: unpack_walls(user_barriers_flat),
            }
        }

        pub fn n_sources(&self) -> usize {
            self.sources.len()
        }

        /// Build the wall list for source `i` at this cell: shared user
        /// barriers plus that source's topography barriers (if any). Avoids a
        /// clone when the source has no topo barriers (the common case).
        fn walls_for<'a>(
            &'a self,
            i: usize,
            topo_offsets: &[u32],
            topo_barriers: &[f64],
            scratch: &'a mut Vec<WallBarrier<f64>>,
        ) -> &'a [WallBarrier<f64>] {
            if topo_offsets.is_empty() {
                return &self.user_barriers;
            }
            let a = topo_offsets[i] as usize;
            let b = topo_offsets[i + 1] as usize;
            if a == b {
                return &self.user_barriers;
            }
            scratch.clear();
            scratch.extend_from_slice(&self.user_barriers);
            for c in topo_barriers[7 * a..7 * b].chunks_exact(7) {
                scratch.push(WallBarrier {
                    a_e: c[0], a_n: c[1], b_e: c[2], b_n: c[3],
                    base_z_a: c[4], base_z_b: c[5], height_agl: c[6],
                });
            }
            scratch
        }

        fn lp_for_source(
            &self,
            src: &SourceRec,
            r: Vec3<f64>,
            cell_hagl: f64,
            walls: &[WallBarrier<f64>],
            apply_concave: bool,
        ) -> BandSpectrum<f64> {
            if src.is_wtg {
                iso9613::annex_d::evaluate_wtg(
                    &src.lw, src.pos, r, src.hagl, cell_hagl, self.g, walls,
                    WtgRules::default(), apply_concave, src.rotor_d, self.atm, self.bar_conv,
                )
            } else {
                iso9613::evaluate_with_barriers(
                    &src.lw, src.pos, r, src.hagl, cell_hagl, self.g, walls,
                    self.dz_cap, self.atm, self.bar_conv,
                )
            }
        }

        /// Evaluate one grid cell against every stored source and energy-sum
        /// the A-weighted per-band Lp into a single dB(A) total (Z+A weighted,
        /// WITHOUT the uniform DΩ term — the caller adds that). Sources beyond
        /// `cutoff_m` horizontally are skipped (`0` disables the cutoff).
        ///
        /// `topo_offsets` (len `n_sources + 1`, or empty for "no topo at all")
        /// gives source `i`'s topography barriers as
        /// `topo_barriers[5·topo_offsets[i] .. 5·topo_offsets[i+1]]`.
        /// `concave_flags` (length n_sources, or empty for "none") carries the
        /// Annex D.5 concave-ground verdict per source — 1 = apply the −3 dB
        /// correction (WTG sources only; ignored for general sources).
        pub fn eval_cell_dba(
            &self,
            cell_e: f64, cell_n: f64, cell_z_abs: f64, cell_hagl: f64,
            cutoff_m: f64,
            topo_offsets: &[u32],
            topo_barriers: &[f64],
            concave_flags: &[u8],
        ) -> f64 {
            let r = Vec3::new(cell_e, cell_n, cell_z_abs);
            let aw = self.bs.a_weighting();
            let cutoff_sq = cutoff_m * cutoff_m;
            let mut scratch: Vec<WallBarrier<f64>> = Vec::new();
            let mut energy = 0.0f64;
            for (i, src) in self.sources.iter().enumerate() {
                if cutoff_m > 0.0 {
                    let dx = src.pos.e - cell_e;
                    let dy = src.pos.n - cell_n;
                    if dx * dx + dy * dy > cutoff_sq {
                        continue;
                    }
                }
                let walls = self.walls_for(i, topo_offsets, topo_barriers, &mut scratch);
                let concave = src.is_wtg && concave_flags.get(i).copied().unwrap_or(0) != 0;
                let lp = self.lp_for_source(src, r, cell_hagl, walls, concave);
                // §8 meteorological correction for this source→cell pair.
                let dpx = src.pos.e - cell_e;
                let dpy = src.pos.n - cell_n;
                let cmet = cmet_db(self.c0, src.hagl, cell_hagl, (dpx * dpx + dpy * dpy).sqrt());
                for (bi, band) in lp.bands.iter().enumerate() {
                    energy += 10f64.powf(0.1 * (band - cmet + aw[bi]));
                }
            }
            if energy > 0.0 { 10.0 * energy.log10() } else { -120.0 }
        }

        /// Gradient pack (n primal + 3n grad, layout matching
        /// `evaluate_*_with_grad_src_octave`) for ONE source at one cell —
        /// used by the lazy single-source drag path (S3). The gradient is
        /// w.r.t. the absolute source position (e, n, z_abs).
        pub fn eval_cell_source_grad(
            &self,
            source_idx: usize,
            cell_e: f64, cell_n: f64, cell_z_abs: f64, cell_hagl: f64,
            topo_offsets: &[u32],
            topo_barriers: &[f64],
        ) -> Vec<f64> {
            type D = crate::dual::Dual<3>;
            let src = &self.sources[source_idx];
            let lw_d = BandSpectrum::from_iter(self.bs, src.lw.bands.iter().map(|&v| D::constant(v)));
            let s = Vec3::new(D::variable(src.pos.e, 0), D::variable(src.pos.n, 1), D::variable(src.pos.z, 2));
            let r = Vec3::new(D::constant(cell_e), D::constant(cell_n), D::constant(cell_z_abs));

            // Topo + user barriers as constant duals.
            let mut walls: Vec<WallBarrier<D>> = self
                .user_barriers
                .iter()
                .map(|w| WallBarrier {
                    a_e: D::constant(w.a_e), a_n: D::constant(w.a_n),
                    b_e: D::constant(w.b_e), b_n: D::constant(w.b_n),
                    base_z_a: D::constant(w.base_z_a), base_z_b: D::constant(w.base_z_b),
                    height_agl: D::constant(w.height_agl),
                })
                .collect();
            if !topo_offsets.is_empty() {
                let a = topo_offsets[source_idx] as usize;
                let b = topo_offsets[source_idx + 1] as usize;
                for c in topo_barriers[7 * a..7 * b].chunks_exact(7) {
                    walls.push(WallBarrier {
                        a_e: D::constant(c[0]), a_n: D::constant(c[1]),
                        b_e: D::constant(c[2]), b_n: D::constant(c[3]),
                        base_z_a: D::constant(c[4]), base_z_b: D::constant(c[5]),
                        height_agl: D::constant(c[6]),
                    });
                }
            }

            let out = if src.is_wtg {
                iso9613::annex_d::evaluate_wtg(
                    &lw_d, s, r, D::constant(src.hagl), D::constant(cell_hagl),
                    D::constant(self.g), &walls, WtgRules::default(), false, src.rotor_d,
                    self.atm, self.bar_conv,
                )
            } else {
                iso9613::evaluate_with_barriers(
                    &lw_d, s, r, D::constant(src.hagl), D::constant(cell_hagl),
                    D::constant(self.g), &walls, self.dz_cap, self.atm, self.bar_conv,
                )
            };
            pack_dual_grad(&out)
        }
    }
}
