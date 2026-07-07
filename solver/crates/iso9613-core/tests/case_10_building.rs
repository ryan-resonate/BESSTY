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
fn building_screens_over_the_roof() {
    let with = solve(&scene_with(vec![box_building()])).unwrap();
    let without = solve(&scene_with(vec![])).unwrap();

    let t_with = with.per_receiver[0].total_dba.unwrap();
    let t_without = without.per_receiver[0].total_dba.unwrap();

    // Independently computed (oracle.py): 36.98 dB(A), a 16.36 dB drop.
    assert_relative_eq!(t_with, 36.98, epsilon = 0.3);
    assert_relative_eq!(t_without, 53.33, epsilon = 0.3);
    assert_relative_eq!(t_without - t_with, 16.36, epsilon = 0.3);
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
