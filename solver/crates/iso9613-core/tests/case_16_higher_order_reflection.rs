//! Validation case 16 — ISO 9613-2:2024 §7.5.3 higher-order reflections.
//!
//! Source and receiver between two parallel walls (y = 0 and y = 10). With
//! `max_reflection_order = 2` the solver must add BOTH second-order image-source
//! paths (bounce y=0→y=10 and y=10→y=0) on top of the direct + two first-order
//! paths. The expected level is the independent energy sum of all five paths,
//! each evaluated as a direct path from its (hand-derived) image source — the
//! image-source method is exact, so this is a true cross-check, not a port.

use approx::assert_relative_eq;
use iso9613_core::iso9613::evaluate_with_barriers;
use iso9613_core::iso9613::atmosphere::Atmosphere as CoreAtm;
use iso9613_core::scene::{
    solve, Atmosphere, Ground, Receiver, Reflector, Scene, Settings, Source, SourceKind, Standard,
    SCHEMA_VERSION,
};
use iso9613_core::{BandSpectrum, BandSystem, Vec3};

fn walls() -> Vec<Reflector> {
    vec![
        Reflector { segment: [[-50.0, 0.0], [50.0, 0.0]], base_z: 0.0, top_z: 20.0, alpha: 0.0, alpha_bands: None },
        Reflector { segment: [[-50.0, 10.0], [50.0, 10.0]], base_z: 0.0, top_z: 20.0, alpha: 0.0, alpha_bands: None },
    ]
}

fn scene(max_order: u32) -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_2024,
        atmosphere: Atmosphere::default(),
        ground: Ground { default_g: 0.0, regions: vec![] },
        terrain: None,
        sources: vec![Source {
            id: "s".into(), kind: SourceKind::General,
            position: [0.0, 4.0, 5.0], height_agl: 5.0, lw: vec![100.0; 10],
        }],
        extended_sources: vec![],
        receivers: vec![Receiver { id: "r".into(), position: [30.0, 6.0, 5.0], height_agl: 5.0 }],
        obstacles: vec![],
        reflectors: walls(),
        cylinders: vec![],
        amisc: Default::default(),
        settings: Settings { max_reflection_order: max_order, ..Default::default() },
    }
}

#[test]
fn second_order_matches_five_path_energy_sum() {
    let r = Vec3::new(30.0, 6.0, 5.0);
    let lw = BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat_n(100.0, 10));
    let atm = CoreAtm::iso_reference();

    // The five specular image sources (α = 0 ⇒ no reflection loss), all at z=5:
    //   direct S, 1st off y=0 (y=−4), 1st off y=10 (y=16),
    //   2nd y0→y10 (y=24), 2nd y10→y0 (y=−16).
    let images = [
        Vec3::new(0.0, 4.0, 5.0),
        Vec3::new(0.0, -4.0, 5.0),
        Vec3::new(0.0, 16.0, 5.0),
        Vec3::new(0.0, 24.0, 5.0),
        Vec3::new(0.0, -16.0, 5.0),
    ];
    let mut summed = BandSpectrum::zeros(BandSystem::Octave);
    for img in images {
        let lp = evaluate_with_barriers(&lw, img, r, 5.0, 5.0, 0.0, &[], &[], None, atm);
        for b in 0..10 {
            summed.bands[b] = 10.0 * (10f64.powf(0.1 * summed.bands[b]) + 10f64.powf(0.1 * lp.bands[b])).log10();
        }
    }
    let expected_total = summed.a_weighted_total();

    let got = solve(&scene(2)).unwrap().per_receiver[0].total_dba.unwrap();
    // Exact up to floating-point energy-summation order (~1e-6 dB).
    assert_relative_eq!(got, expected_total, epsilon = 1e-5);
}

#[test]
fn order_two_adds_energy_over_order_one() {
    let t1 = solve(&scene(1)).unwrap().per_receiver[0].total_dba.unwrap();
    let t2 = solve(&scene(2)).unwrap().per_receiver[0].total_dba.unwrap();
    assert!(t2 > t1 + 0.05, "2nd-order paths must add energy: {t1} → {t2}");
}

#[test]
fn order_one_is_first_order_only() {
    // With no reflectors the two must coincide (nothing to bounce off).
    let mut bare = scene(2);
    bare.reflectors.clear();
    let bare1 = {
        let mut s = bare.clone();
        s.settings.max_reflection_order = 1;
        s
    };
    let a = solve(&bare).unwrap().per_receiver[0].total_dba.unwrap();
    let b = solve(&bare1).unwrap().per_receiver[0].total_dba.unwrap();
    assert_relative_eq!(a, b, epsilon = 1e-12);
}
