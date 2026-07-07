//! ISO/TR 17534-3:2015 §6 conformance gate — the pre-deploy validation.
//!
//! The Technical Report gives step-by-step reference results for ISO 9613-2
//! (the 1996 edition it was written against) with a stated acceptance rule:
//! a band level or total is correct if it deviates by no more than ±0.05 dB
//! (§6.2, precision 2). These cases assert exactly that, against values
//! TRANSCRIBED from the TR tables — not tuned to pass.
//!
//! Coverage here: T01–T07, the cases "solved by applying ISO 9613-2 exclusively"
//! (§6). T01–T03 flat uniform ground, T04 spatially-varying ground (general
//! method §7.3.1), T05 the same by the alternative method (§7.3.2). T06/T07 add
//! terrain-height variation (contour ground profile) and are wired once the
//! contour→profile ingestion lands. T08–T19 (barriers, buildings, reflectors)
//! follow as their §5-recommendation features are validated.
//!
//! Band note: the TR uses the eight octaves 63 Hz–8 kHz. The crate's octave
//! system spans 16 Hz–8 kHz (indices 2..10); the 16/31.5 Hz bands carry no
//! source power in these cases, so only indices 2..10 are compared.

use approx::assert_relative_eq;
use iso9613_core::scene::{
    solve, Atmosphere, Ground, GroundRegion, Receiver, Scene, Settings, Source, SourceKind,
    Standard, SCHEMA_VERSION,
};
use iso9613_core::iso9613::ground::GroundMethod;

/// TR §6 acceptance tolerance (±0.05 dB).
const TOL: f64 = 0.05;

/// LW = 93 dB in every octave 63 Hz–8 kHz (Table 2); the 16/31.5 Hz bands carry
/// no power (−100 dB ⇒ negligible energy, excluded from the TR's 63–8 kHz sum).
fn lw_93() -> Vec<f64> {
    let mut lw = vec![-100.0; 10];
    for b in lw.iter_mut().skip(2) {
        *b = 93.0;
    }
    lw
}

/// TR meteorological condition: T = 20 °C, F = 70 %, standard pressure.
fn tr_atm() -> Atmosphere {
    Atmosphere { temperature_c: 20.0, relative_humidity_pct: 70.0, pressure_kpa: 101.325 }
}

/// A TR scene: ISO 9613-2:1996, S(10,10,1) → R(200,50,4) (Table 1), 20 °C/70 %.
fn tr_scene(ground: Ground, method: GroundMethod) -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_1996,
        atmosphere: tr_atm(),
        ground,
        terrain: None,
        sources: vec![Source {
            id: "S".into(),
            kind: SourceKind::General,
            position: [10.0, 10.0, 1.0],
            height_agl: 1.0,
            lw: lw_93(),
        }],
        extended_sources: vec![],
        receivers: vec![Receiver { id: "R".into(), position: [200.0, 50.0, 4.0], height_agl: 4.0 }],
        obstacles: vec![],
        reflectors: vec![],
        amisc: Default::default(),
        settings: Settings { ground_method: method, ..Default::default() },
    }
}

/// Solve and return the 63 Hz–8 kHz band levels (8 values) + A-weighted total.
fn run(scene: &Scene) -> (Vec<f64>, f64) {
    let res = solve(scene).unwrap();
    let rx = &res.per_receiver[0];
    let bands = rx.per_source[0].bands[2..10].to_vec();
    (bands, rx.total_dba.unwrap())
}

/// Assert per-band (63 Hz–8 kHz) and total against the TR reference to ±0.05 dB.
#[track_caller]
fn assert_tr(scene: &Scene, ref_bands: [f64; 8], ref_total: f64) {
    let (bands, total) = run(scene);
    for (i, exp) in ref_bands.iter().enumerate() {
        assert_relative_eq!(bands[i], *exp, epsilon = TOL);
    }
    assert_relative_eq!(total, ref_total, epsilon = TOL);
}

/// The three spatially-varying ground areas of T04–T07 (Table 7). Note T06/T07
/// reverse the G assignment; T04/T05 use A1=0.2, A2=0.5, A3=0.9.
fn t04_ground() -> Ground {
    Ground {
        default_g: 0.5,
        regions: vec![
            GroundRegion { polygon: vec![[0.0, 60.0], [50.0, 60.0], [50.0, -10.0], [0.0, -10.0]], g: 0.2 },
            GroundRegion { polygon: vec![[50.0, 60.0], [150.0, 60.0], [150.0, -10.0], [50.0, -10.0]], g: 0.5 },
            GroundRegion { polygon: vec![[150.0, 60.0], [210.0, 60.0], [210.0, -10.0], [150.0, -10.0]], g: 0.9 },
        ],
    }
}

#[test]
fn t01_reflecting_ground_g0() {
    // §6.2.2 — uniform G = 0. Table 4.
    let scene = tr_scene(Ground { default_g: 0.0, regions: vec![] }, GroundMethod::General);
    assert_tr(&scene, [39.90, 39.86, 39.70, 39.37, 38.95, 38.17, 35.47, 25.04], 44.29);
}

#[test]
fn t02_mixed_ground_g05() {
    // §6.2.3 — uniform G = 0.5. Table 5.
    let scene = tr_scene(Ground { default_g: 0.5, regions: vec![] }, GroundMethod::General);
    assert_tr(&scene, [39.90, 36.17, 33.02, 33.20, 36.11, 36.33, 33.63, 23.20], 41.53);
}

#[test]
fn t03_porous_ground_g1() {
    // §6.2.4 — uniform G = 1. Table 6.
    let scene = tr_scene(Ground { default_g: 1.0, regions: vec![] }, GroundMethod::General);
    assert_tr(&scene, [39.90, 32.48, 26.33, 27.03, 33.27, 34.49, 31.79, 21.36], 39.14);
}

#[test]
fn t04_spatially_varying_ground_general() {
    // §6.2.5 — three ground areas, general method §7.3.1. Table 9.
    let scene = tr_scene(t04_ground(), GroundMethod::General);
    assert_tr(&scene, [39.90, 36.24, 35.23, 36.04, 36.95, 36.57, 33.87, 23.45], 42.23);
}

#[test]
fn t05_spatially_varying_ground_simplified() {
    // §6.2.6 — identical to T04 but the alternative method §7.3.2. Table 10.
    let scene = tr_scene(t04_ground(), GroundMethod::Simplified);
    assert_tr(&scene, [34.90, 34.86, 34.71, 34.38, 33.95, 33.17, 30.48, 20.05], 39.30);
}
