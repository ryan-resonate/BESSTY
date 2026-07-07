//! Validation case 04 — see `validation/case-04-multi-edge-barrier.md`.
//!
//! Source (0,0,5), receiver (100,0,1.5), two thin walls at x=30 and x=70
//! both with top z=7. Expected LAT(DW) = 36.58 dB(A).

use approx::assert_relative_eq;
use iso9613_core::iso9613::atmosphere::Atmosphere;
use iso9613_core::iso9613::barrier::WallBarrier;
use iso9613_core::iso9613::evaluate_with_barriers;
use iso9613_core::{BandSpectrum, BandSystem, Vec3};

fn case_04_setup() -> (Vec3, Vec3, Vec<WallBarrier>) {
    let s = Vec3::new(0.0, 0.0, 5.0);
    let r = Vec3::new(100.0, 0.0, 1.5);
    let walls = vec![
        WallBarrier { a_e: 30.0, a_n: -1000.0, b_e: 30.0, b_n: 1000.0, base_z_a: 0.0, base_z_b: 0.0, height_agl: 7.0 },
        WallBarrier { a_e: 70.0, a_n: -1000.0, b_e: 70.0, b_n: 1000.0, base_z_a: 0.0, base_z_b: 0.0, height_agl: 7.0 },
    ];
    (s, r, walls)
}

fn flat_100_db_octave() -> BandSpectrum {
    BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat_n(100.0, 10))
}

#[test]
fn case_04_a_weighted_total() {
    let (s, r, walls) = case_04_setup();
    let lw = flat_100_db_octave();
    let lp = evaluate_with_barriers(
        &lw, s, r, s.z, r.z, 0.5, &walls, &[], None,
        Atmosphere::iso_reference(),
    );
    // 36.18 dB(A) — independently computed (scratchpad oracle.py) with the
    // corrected 2024 barrier formula (incl. the frequency-dependent C3 = 5λ/e).
    assert_relative_eq!(lp.a_weighted_total(), 36.18, epsilon = 0.5);
}

#[test]
fn case_04_8khz_hits_25db_multi_edge_cap() {
    use iso9613_core::iso9613::barrier::{diffraction, path, BarrierVariant};
    let (s, r, walls) = case_04_setup();
    let candidates = path::project_walls(s, r, &walls);
    let s_in = path::DiffractionEdge { x: 0.0, z: s.z };
    let r_in = path::DiffractionEdge { x: 100.0, z: r.z };
    let active = path::upper_hull_select(s_in, r_in, &candidates);
    assert_eq!(active.len(), 2);
    let lengths = path::path_lengths(s_in, r_in, &active);

    // 8 kHz uncapped (25.0+) exceeds the multi-edge cap of 25 dB.
    let dz = diffraction::dz_uncapped(&lengths, 340.0 / 8000.0, BarrierVariant::V2024);
    let dz_capped = diffraction::cap(dz, lengths.e_total, None);
    assert_relative_eq!(dz_capped, 25.0, epsilon = 1e-9);
}

#[test]
fn case_04_more_attenuation_than_case_03() {
    let (s, r, walls_4) = case_04_setup();
    let walls_3 = vec![WallBarrier {
        a_e: 50.0, a_n: -1000.0, b_e: 50.0, b_n: 1000.0, base_z_a: 0.0, base_z_b: 0.0, height_agl: 8.0,
    }];
    let lw = flat_100_db_octave();
    let lp_4 = evaluate_with_barriers(
        &lw, s, r, s.z, r.z, 0.5, &walls_4, &[], None,
        Atmosphere::iso_reference(),
    );
    let lp_3 = evaluate_with_barriers(
        &lw, s, r, s.z, r.z, 0.5, &walls_3, &[], None,
        Atmosphere::iso_reference(),
    );
    assert!(lp_4.a_weighted_total() < lp_3.a_weighted_total(),
        "two edges should give more attenuation than one — got 4: {}, 3: {}",
        lp_4.a_weighted_total(), lp_3.a_weighted_total());
}
