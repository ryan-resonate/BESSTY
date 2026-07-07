//! WASM bindings for `iso9613-core` — the flat compat API consumed by BEESTY.
//!
//! Function names and argument lists are IDENTICAL to the pre-split
//! `beesty-solver` exports (minus the unused forward-AD gradient variants),
//! so the web app only changes its import path. The typed `Scene`/`Session`
//! bindings replace this shim when BEESTY migrates (Phase 6).

use iso9613_core::iso9613::annex_d::WtgRules;
use iso9613_core::iso9613::atmosphere::Atmosphere;
use iso9613_core::iso9613::barrier::{LateralEdge, WallBarrier};
use iso9613_core::iso9613::meteorology::cmet_db;
use iso9613_core::iso9613::{self, annex_d};
use iso9613_core::{BandSpectrum, BandSystem, Vec3};
use wasm_bindgen::prelude::*;

// Wall pack stride: [a_e, a_n, b_e, b_n, base_z_a, base_z_b, height_agl].
// base_z_* are absolute ground elevations under the endpoints; the top
// follows the terrain (interpolated base + height) at the diffraction
// crossing — see `WallBarrier`.
fn unpack_walls(flat: &[f64]) -> Vec<WallBarrier> {
    flat.chunks_exact(7)
        .map(|c| WallBarrier {
            a_e: c[0], a_n: c[1], b_e: c[2], b_n: c[3],
            base_z_a: c[4], base_z_b: c[5], height_agl: c[6],
        })
        .collect()
}

// Lateral-edge pack stride: [e, n, base_z, top_z] — one vertical END edge
// per finite (man-made) wall endpoint, for around-the-end diffraction
// (§7.4.3). Terrain virtual barriers emit NONE (they model infinite ridges).
fn unpack_lateral(flat: &[f64]) -> Vec<LateralEdge> {
    flat.chunks_exact(4)
        .map(|c| LateralEdge { e: c[0], n: c[1], base_z: c[2], top_z: c[3] })
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

// NOTE: the `barrier_convention` int is still accepted on every exported
// function for call-site compatibility with the current web app, but it is now
// IGNORED. Phase 1 collapsed the two barrier/ground conventions to the single
// literal-ISO behaviour (see `barrier::abar_spectrum`); the web arg is a no-op
// pending removal when BEESTY migrates to the typed Scene API (Phase 6).

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
/// Source/receiver carry TWO heights each: `*_z_abs` (absolute elevation,
/// used for divergence + barrier diffraction geometry — must share the
/// barrier `top_z` datum) and `*_hagl` (height above local ground, used by
/// the ground-attenuation shape functions). On flat ground at elevation 0
/// the two are equal.
///
/// `barriers_flat` is `[a_e, a_n, b_e, b_n, base_z_a, base_z_b, height_agl,
/// ...]` — seven values per straight wall.
/// Atmosphere is passed as 3 floats (T °C, RH %, p kPa) — pass
/// (10, 70, 101.325) for the ISO 9613-2 reference.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn evaluate_general_octave(
    lw: &[f64],
    src_e: f64, src_n: f64, src_z_abs: f64, src_hagl: f64,
    rx_e: f64, rx_n: f64, rx_z_abs: f64, rx_hagl: f64,
    g: f64,
    barriers_flat: &[f64],
    atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
    _barrier_convention: u32, // ignored (see note at top); kept for call-site compat
    dz_cap_db: f64,
    c0: f64,
    lateral_flat: &[f64],
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
    let lateral = unpack_lateral(lateral_flat);
    let out = iso9613::evaluate_with_barriers(
        &lw_spec, s, r, src_hagl, rx_hagl, g, &walls, &lateral, dz_cap(dz_cap_db), atm,
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
#[allow(clippy::too_many_arguments)]
pub fn evaluate_wtg_octave(
    lw: &[f64],
    hub_e: f64, hub_n: f64, hub_z_abs: f64, hub_hagl: f64,
    rx_e: f64, rx_n: f64, rx_z_abs: f64, rx_hagl: f64,
    g: f64,
    barriers_flat: &[f64],
    rotor_diameter_m: f64,
    apply_concave: bool,
    atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
    _barrier_convention: u32, // ignored (see note at top); kept for call-site compat
    c0: f64,
    lateral_flat: &[f64],
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
    let lateral = unpack_lateral(lateral_flat);
    let out = annex_d::evaluate_wtg(
        &lw_spec, hub, r, hub_hagl, rx_hagl, g, &walls, &lateral,
        WtgRules::default(), apply_concave, rotor_diameter_m,
        atm,
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

/// Octave-band centre frequencies (Hz) — 10 values.
#[wasm_bindgen]
pub fn octave_centres() -> Vec<f64> {
    iso9613_core::spectrum::OCTAVE_CENTRES_HZ.to_vec()
}

/// Octave-band A-weighting offsets (dB) — 10 values.
#[wasm_bindgen]
pub fn octave_a_weighting() -> Vec<f64> {
    iso9613_core::spectrum::OCTAVE_A_WEIGHTING_DB.to_vec()
}

// ---------- Batched grid evaluator (S2) ----------
//
// The per-cell-per-source call path crosses the JS↔WASM boundary and
// allocates a return Vec once per (cell, source) — ~1.2M times for a
// 200×200 grid × 30 sources. `GridEvaluator` stores the source set + env
// ONCE, then evaluates a whole cell (all sources, energy-summed) in a
// single call returning one dB(A) float. That cuts the crossings to one
// per cell and removes the per-source return allocation. Each worker
// owns its own instance, so the stored state is not shared.

struct SourceRec {
    is_wtg: bool,
    pos: Vec3,      // absolute (e, n, z_abs)
    hagl: f64,      // height above local ground
    rotor_d: f64,
    lw: BandSpectrum,
}

#[wasm_bindgen]
pub struct GridEvaluator {
    bs: BandSystem,
    sources: Vec<SourceRec>,
    atm: Atmosphere,
    dz_cap: Option<f64>,
    g: f64,
    c0: f64,
    user_barriers: Vec<WallBarrier>,
    user_lateral: Vec<LateralEdge>,
}

#[wasm_bindgen]
impl GridEvaluator {
    /// `sources_flat` is packed per source as
    /// `[is_wtg, e, n, z_abs, hagl, rotor_d, lw_0 … lw_{nb-1}]`
    /// (stride `6 + nb`). `is_wtg` is `1.0`/`0.0`. `user_barriers_flat`
    /// is the shared 7-stride wall pack (absolute base z).
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sources_flat: &[f64],
        n_bands: usize,
        g: f64,
        user_barriers_flat: &[f64],
        atm_temp_c: f64, atm_rh_pct: f64, atm_pres_kpa: f64,
        _barrier_convention: u32, // ignored (see note at top); kept for call-site compat
        dz_cap_db: f64,
        c0: f64,
        user_lateral_flat: &[f64],
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
            dz_cap: dz_cap(dz_cap_db),
            g,
            c0,
            user_barriers: unpack_walls(user_barriers_flat),
            user_lateral: unpack_lateral(user_lateral_flat),
        }
    }

    pub fn n_sources(&self) -> usize {
        self.sources.len()
    }

    /// Evaluate one grid cell against every stored source and energy-sum
    /// the A-weighted per-band Lp into a single dB(A) total (Z+A weighted,
    /// WITHOUT the uniform DΩ term — the caller adds that). Sources beyond
    /// `cutoff_m` horizontally are skipped (`0` disables the cutoff).
    ///
    /// `topo_offsets` (len `n_sources + 1`, or empty for "no topo at all")
    /// gives source `i`'s topography barriers as
    /// `topo_barriers[7·topo_offsets[i] .. 7·topo_offsets[i+1]]`.
    /// `concave_flags` (length n_sources, or empty for "none") carries the
    /// Annex D.5 concave-ground verdict per source — 1 = apply the −3 dB
    /// correction (WTG sources only; ignored for general sources).
    #[allow(clippy::too_many_arguments)]
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
        let mut scratch: Vec<WallBarrier> = Vec::new();
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
}

impl GridEvaluator {
    /// Build the wall list for source `i` at this cell: shared user
    /// barriers plus that source's topography barriers (if any). Avoids a
    /// clone when the source has no topo barriers (the common case).
    fn walls_for<'a>(
        &'a self,
        i: usize,
        topo_offsets: &[u32],
        topo_barriers: &[f64],
        scratch: &'a mut Vec<WallBarrier>,
    ) -> &'a [WallBarrier] {
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
        r: Vec3,
        cell_hagl: f64,
        walls: &[WallBarrier],
        apply_concave: bool,
    ) -> BandSpectrum {
        if src.is_wtg {
            annex_d::evaluate_wtg(
                &src.lw, src.pos, r, src.hagl, cell_hagl, self.g, walls, &self.user_lateral,
                WtgRules::default(), apply_concave, src.rotor_d, self.atm,
            )
        } else {
            iso9613::evaluate_with_barriers(
                &src.lw, src.pos, r, src.hagl, cell_hagl, self.g, walls, &self.user_lateral,
                self.dz_cap, self.atm,
            )
        }
    }
}
