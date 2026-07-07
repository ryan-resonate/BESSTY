//! Validation case 10 — building (2D footprint + height) screening.
//!
//! A closed building footprint straddling the source→receiver line diffracts
//! the ray over its near+far walls (multi-edge over the roof). Expected total
//! independently computed (scratchpad `oracle.py`, multi-edge geometry).
//!
//! Buildings screen **over-top** only for now (around-building lateral
//! diffraction is the deferred Fix-4 increment).

use approx::assert_relative_eq;
use iso9613_core::scene::{
    solve, Atmosphere, Ground, Obstacle, Receiver, Scene, Settings, Source, SourceKind, Standard,
    SCHEMA_VERSION,
};

fn scene_with(obstacles: Vec<Obstacle>) -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_2024,
        atmosphere: Atmosphere::default(),
        ground: Ground { default_g: 0.5, regions: vec![] },
        sources: vec![Source {
            id: "s".into(),
            kind: SourceKind::General,
            position: [0.0, 0.0, 2.0],
            height_agl: 2.0,
            lw: vec![100.0; 10],
        }],
        receivers: vec![Receiver { id: "r".into(), position: [120.0, 0.0, 2.0], height_agl: 2.0 }],
        obstacles,
        settings: Settings::default(),
    }
}

/// A 20 m × 30 m box, 6 m tall, base at 0, straddling the S–R line at x∈[40,60].
fn box_building() -> Obstacle {
    Obstacle::Building {
        footprint: vec![[40.0, -15.0], [60.0, -15.0], [60.0, 15.0], [40.0, 15.0]],
        base_z: 0.0,
        height_agl: 6.0,
    }
}

#[test]
fn building_screens_over_top_and_around_the_sides() {
    let with = solve(&scene_with(vec![box_building()])).unwrap();
    let without = solve(&scene_with(vec![])).unwrap();

    let t_with = with.per_receiver[0].total_dba.unwrap();
    let t_without = without.per_receiver[0].total_dba.unwrap();

    // Independently computed (oracle.py): over-top multi-edge diffraction
    // combined (Eq 25) with the best-per-side lateral paths (the near corners,
    // Δz = 3.69) → 38.54 dB(A), a 14.79 dB drop. (Over-top alone would be
    // 36.98 dB(A); the sides leak ~1.6 dB back in.)
    assert_relative_eq!(t_with, 38.54, epsilon = 0.3);
    assert_relative_eq!(t_without, 53.33, epsilon = 0.3);

    // Per-band Lp (oracle.py) — pins down the lateral selection + Eq-25 combine.
    let expected = [48.66, 47.70, 46.38, 41.75, 38.46, 35.41, 33.67, 30.13, 24.36, 11.21];
    let bands = &with.per_receiver[0].per_source[0].bands;
    for (i, exp) in expected.iter().enumerate() {
        assert_relative_eq!(bands[i], *exp, epsilon = 0.15);
    }
}

#[test]
fn building_off_to_the_side_does_not_screen() {
    // Same box shifted well off the S–R line (y ∈ [100,130]) — the ray never
    // crosses the footprint, so there is no screening.
    let off = Obstacle::Building {
        footprint: vec![[40.0, 100.0], [60.0, 100.0], [60.0, 130.0], [40.0, 130.0]],
        base_z: 0.0,
        height_agl: 6.0,
    };
    let with = solve(&scene_with(vec![off])).unwrap();
    let without = solve(&scene_with(vec![])).unwrap();
    assert_relative_eq!(
        with.per_receiver[0].total_dba.unwrap(),
        without.per_receiver[0].total_dba.unwrap(),
        epsilon = 1e-9,
    );
}

#[test]
fn degenerate_building_rejected() {
    let bad = Obstacle::Building { footprint: vec![[0.0, 0.0], [1.0, 0.0]], base_z: 0.0, height_agl: 3.0 };
    assert!(solve(&scene_with(vec![bad])).is_err());
}
