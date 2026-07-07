//! Phase-0 golden regression gate.
//!
//! Captures the exact (`{:.17e}`) per-band output of the public evaluators for
//! a fixed scenario set, so the workspace split + autodiff removal can be
//! proven numerically inert. See `docs/iso9613-solver-phase01-execution.md`
//! §1.1 — this file may only be regenerated in a documented physics-fix
//! commit (`GOLDEN_WRITE=1 cargo test --test golden_phase0`).

use iso9613_core::iso9613::atmosphere::Atmosphere;
use iso9613_core::iso9613::barrier::{LateralEdge, WallBarrier};
use iso9613_core::iso9613::{annex_d, evaluate_free_field, evaluate_with_barriers, evaluate_with_ground};
use iso9613_core::{BandSpectrum, BandSystem, Vec3};

const GOLDEN_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden_phase0.txt");

fn flat_lw(system: BandSystem, level: f64) -> BandSpectrum {
    BandSpectrum::from_iter(system, std::iter::repeat_n(level, system.n_bands()))
}

/// Every scenario appends its per-band Lp values (plus the A-weighted total)
/// to `out`, prefixed by a label line for diff-friendliness.
fn run_all(out: &mut Vec<String>) {
    let atm_ref = Atmosphere::iso_reference();
    let atm_warm = Atmosphere { temperature_c: 25.0, relative_humidity_pct: 40.0, pressure_kpa: 100.0 };

    let mut push = |label: &str, lp: &BandSpectrum| {
        out.push(format!("# {label}"));
        for b in &lp.bands {
            out.push(format!("{:.17e}", b));
        }
        out.push(format!("{:.17e}", lp.a_weighted_total()));
    };

    // S1: free field, octave.
    let s = Vec3::new(0.0, 0.0, 100.0);
    let r = Vec3::new(200.0, 50.0, 101.5);
    push("free_field_octave", &evaluate_free_field(&flat_lw(BandSystem::Octave, 100.0), s, r, atm_ref));

    // S2: ground, octave, mixed G, unequal heights.
    let s = Vec3::new(0.0, 0.0, 5.0);
    let r = Vec3::new(200.0, 0.0, 1.5);
    push(
        "ground_octave_g05",
        &evaluate_with_ground(&flat_lw(BandSystem::Octave, 100.0), s, r, 5.0, 1.5, 0.5, atm_ref),
    );

    // S3: ground, third-octave, porous G, warm atmosphere.
    push(
        "ground_third_g1_warm",
        &evaluate_with_ground(&flat_lw(BandSystem::OneThirdOctave, 95.0), s, r, 5.0, 1.5, 1.0, atm_warm),
    );

    // S4: barriers on elevated terrain (split z-datum), one finite wall with
    // lateral end edges + one long topo-like wall.
    let s = Vec3::new(0.0, 0.0, 152.0);   // ground 150 + hagl 2
    let r = Vec3::new(300.0, 0.0, 151.5); // ground 150 + hagl 1.5
    let walls = [
        WallBarrier { a_e: 120.0, a_n: -40.0, b_e: 120.0, b_n: 40.0, base_z_a: 150.0, base_z_b: 151.0, height_agl: 6.0 },
        WallBarrier { a_e: 200.0, a_n: -500.0, b_e: 200.0, b_n: 500.0, base_z_a: 153.0, base_z_b: 153.0, height_agl: 2.0 },
    ];
    let lateral = [
        LateralEdge { e: 120.0, n: -40.0, base_z: 150.0, top_z: 156.0 },
        LateralEdge { e: 120.0, n: 40.0, base_z: 151.0, top_z: 157.0 },
    ];
    let lw = flat_lw(BandSystem::Octave, 105.0);
    push(
        "barrier_elevated",
        &evaluate_with_barriers(&lw, s, r, 2.0, 1.5, 0.6, &walls, &lateral, None, atm_ref),
    );

    // S5: dz-cap override (2 dB), no lateral.
    push(
        "barrier_capped_2db",
        &evaluate_with_barriers(&lw, s, r, 2.0, 1.5, 0.6, &walls, &[], Some(2.0), atm_ref),
    );

    // S6: WTG per Annex D — flat + concave variants, terrain barrier between.
    let hub = Vec3::new(0.0, 0.0, 110.0); // ground 0 + hub 110
    let rx = Vec3::new(800.0, 100.0, 1.5);
    let topo = [WallBarrier { a_e: 400.0, a_n: -300.0, b_e: 400.0, b_n: 300.0, base_z_a: 20.0, base_z_b: 20.0, height_agl: 0.0 }];
    let lw_wtg = flat_lw(BandSystem::Octave, 106.0);
    for (label, concave) in [("wtg_flat", false), ("wtg_concave", true)] {
        push(
            label,
            &annex_d::evaluate_wtg(
                &lw_wtg, hub, rx, 110.0, 1.5, 1.0, &topo, &[],
                annex_d::WtgRules::default(), concave, 120.0,
                atm_ref,
            ),
        );
    }
}

#[test]
fn golden_phase0() {
    let mut lines: Vec<String> = Vec::new();
    run_all(&mut lines);

    if std::env::var("GOLDEN_WRITE").is_ok() {
        std::fs::write(GOLDEN_PATH, lines.join("\n") + "\n").expect("write golden file");
        eprintln!("golden file regenerated: {GOLDEN_PATH}");
        return;
    }

    let expected = std::fs::read_to_string(GOLDEN_PATH)
        .expect("golden file missing — run once with GOLDEN_WRITE=1");
    let expected: Vec<&str> = expected.lines().collect();
    assert_eq!(expected.len(), lines.len(), "golden line count changed");
    for (i, (exp, got)) in expected.iter().zip(lines.iter()).enumerate() {
        if exp.starts_with('#') {
            assert_eq!(*exp, got.as_str(), "scenario label mismatch at line {i}");
        } else {
            let e: f64 = exp.parse().expect("golden parse");
            let g: f64 = got.parse().expect("output parse");
            assert!(
                e == g || (e.is_nan() && g.is_nan()),
                "golden mismatch at line {i}: expected {e:?}, got {g:?}",
            );
        }
    }
}
