//! Scene validation + Session transactionality (review fixes A2, A3).

use iso9613_core::iso9613::terrain::Heightfield;
use iso9613_core::scene::{
    solve, solve_json, Atmosphere, Ground, GroundRegion, Receiver, Scene, SceneError, Session,
    Settings, Source, SourceKind, Standard, Terrain, SCHEMA_VERSION,
};

/// A polygon covering the whole S→R corridor of `base_scene`.
fn full_region(g: f64) -> GroundRegion {
    GroundRegion { polygon: vec![[-50.0, -50.0], [150.0, -50.0], [150.0, 50.0], [-50.0, 50.0]], g }
}

fn lw10() -> Vec<f64> {
    let mut lw = vec![-100.0; 10];
    for b in lw.iter_mut().skip(2) {
        *b = 95.0;
    }
    lw
}

fn base_scene() -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_1996,
        atmosphere: Atmosphere { temperature_c: 15.0, relative_humidity_pct: 70.0, pressure_kpa: 101.325 },
        ground: Ground { default_g: 0.5, regions: vec![] },
        terrain: None,
        sources: vec![Source { id: "s".into(), kind: SourceKind::General, position: [0.0, 0.0, 4.0], height_agl: 4.0, lw: lw10() }],
        extended_sources: vec![],
        receivers: vec![Receiver { id: "r".into(), position: [80.0, 0.0, 1.5], height_agl: 1.5 }],
        obstacles: vec![],
        reflectors: vec![],
        cylinders: vec![],
        amisc: Default::default(),
        settings: Settings::default(),
    }
}

fn hf(nx: usize, ny: usize, heights: Vec<f64>) -> Terrain {
    Terrain::Heightfield(Heightfield { origin: [-10.0, -10.0], spacing: 5.0, nx, ny, heights })
}

// ---- A2: terrain validation ----

#[test]
fn valid_heightfield_solves() {
    let mut s = base_scene();
    s.terrain = Some(hf(4, 4, vec![0.0; 16]));
    assert!(solve(&s).is_ok());
}

#[test]
fn short_heights_is_rejected_not_panic() {
    let mut s = base_scene();
    s.terrain = Some(hf(10, 10, vec![0.0])); // 1 cell for a 100-cell grid
    match solve(&s) {
        Err(SceneError::DegenerateTerrain { .. }) => {}
        other => panic!("expected DegenerateTerrain, got {other:?}"),
    }
    // Same through the JSON seam (no panic, a clean error string).
    let json = serde_json::to_string(&s).unwrap();
    assert!(solve_json(&json).is_err());
}

#[test]
fn nonfinite_terrain_is_rejected() {
    let mut s = base_scene();
    let mut heights = vec![0.0; 16];
    heights[5] = f64::NAN;
    s.terrain = Some(hf(4, 4, heights));
    assert!(matches!(solve(&s), Err(SceneError::DegenerateTerrain { .. })));

    let mut s2 = base_scene();
    s2.terrain = Some(Terrain::Heightfield(Heightfield {
        origin: [0.0, 0.0], spacing: 0.0, nx: 2, ny: 2, heights: vec![0.0; 4],
    }));
    assert!(matches!(solve(&s2), Err(SceneError::DegenerateTerrain { .. })));

    // Pathological dimensions whose product overflows usize must be rejected, not
    // wrap to a small value in release and slip a short heights array past the
    // length check into an out-of-bounds panic.
    let mut s3 = base_scene();
    s3.terrain = Some(Terrain::Heightfield(Heightfield {
        origin: [0.0, 0.0], spacing: 1.0, nx: usize::MAX, ny: 2, heights: vec![],
    }));
    assert!(matches!(solve(&s3), Err(SceneError::DegenerateTerrain { .. })));
}

// ---- E4: WindTurbine now honours terrain/building screening ----

#[test]
fn ground_level_source_honours_region_g_at_zero_height() {
    // Source at height_agl == 0 over a g=0 region covering the whole path. Its
    // source region collapses to zero length, but its G must still be SAMPLED from
    // the region (0), not fall back to default_g. So the result equals a uniform
    // hard-ground (default_g=0) scene of identical geometry. (Before E1 the
    // collapsed region returned default_g=1 → the two differed by several dB.)
    let bands = |sc: &Scene| solve(sc).unwrap().per_receiver[0].per_source[0].bands.clone();
    let mut region = base_scene();
    region.sources[0].height_agl = 0.0;
    region.ground = Ground { default_g: 1.0, regions: vec![full_region(0.0)] };
    let mut uniform = base_scene();
    uniform.sources[0].height_agl = 0.0;
    uniform.ground = Ground { default_g: 0.0, regions: vec![] };
    let (rb, ub) = (bands(&region), bands(&uniform));
    for i in 0..rb.len() {
        assert!((rb[i] - ub[i]).abs() < 1e-9, "region G must be sampled at h=0 @ band {i}: {} vs {}", rb[i], ub[i]);
    }
}

#[test]
fn wind_turbine_honours_per_region_ground() {
    // A WTG over a g=0 region (default_g=1) must sample the region — capped at 0.5,
    // g=0 stays 0 — matching a uniform g=0 WTG scene, NOT the default_g=1 (→0.5)
    // it used before E4 ignored per-region factors.
    let mk = |default_g: f64, regions: Vec<GroundRegion>| {
        let mut s = base_scene();
        s.sources[0].kind = SourceKind::WindTurbine { rotor_diameter_m: 20.0, apply_concave: false };
        s.sources[0].position = [0.0, 0.0, 30.0];
        s.sources[0].height_agl = 30.0;
        s.receivers[0].position = [150.0, 0.0, 4.0];
        s.receivers[0].height_agl = 4.0;
        s.ground = Ground { default_g, regions };
        s
    };
    let bands = |sc: &Scene| solve(sc).unwrap().per_receiver[0].per_source[0].bands.clone();
    let region = bands(&mk(1.0, vec![full_region(0.0)]));
    let uniform_hard = bands(&mk(0.0, vec![]));
    let uniform_soft = bands(&mk(1.0, vec![]));
    let mut differs = false;
    for i in 0..region.len() {
        assert!((region[i] - uniform_hard[i]).abs() < 1e-9, "WTG per-region G must match uniform-hard @ band {i}");
        if (region[i] - uniform_soft[i]).abs() > 1e-6 {
            differs = true;
        }
    }
    assert!(differs, "the region case must differ from ignoring it (default_g=1)");
}

#[test]
fn wind_turbine_is_screened_by_terrain() {
    let mut s = base_scene();
    s.sources[0].kind = SourceKind::WindTurbine { rotor_diameter_m: 20.0, apply_concave: false };
    s.sources[0].position = [0.0, 0.0, 30.0];
    s.sources[0].height_agl = 30.0;
    s.receivers[0].position = [300.0, 0.0, 4.0];
    s.receivers[0].height_agl = 4.0;
    let open = solve(&s).unwrap().per_receiver[0].total_dba.unwrap();

    // A ~40 m terrain ridge midway now diffracts the WTG ray (previously terrain
    // edges were dropped entirely for WTG sources — the flagship "turbine behind a
    // ridge" case got no terrain attenuation).
    let mut heights = vec![0.0; 21]; // 7 cols × 3 rows
    for row in 0..3 {
        heights[row * 7 + 3] = 40.0; // ridge column at x = 150
    }
    s.terrain = Some(hf(7, 3, heights));
    if let Some(Terrain::Heightfield(h)) = &mut s.terrain {
        h.origin = [0.0, -50.0];
        h.spacing = 50.0;
    }
    let screened = solve(&s).unwrap().per_receiver[0].total_dba.unwrap();
    assert!(screened < open - 0.5, "WTG must be screened by terrain: {screened} vs open {open}");
}

// ---- C1: validation sweep ----

#[test]
fn out_of_range_entities_are_rejected() {
    use iso9613_core::scene::{ExtendedSource, ExtentGeometry, Reflector};

    // Reflector alpha < 0 would AMPLIFY the reflection.
    let mut s = base_scene();
    s.reflectors = vec![Reflector {
        segment: [[10.0, -5.0], [10.0, 5.0]], base_z: 0.0, top_z: 5.0, alpha: -0.1, alpha_bands: None,
    }];
    assert!(matches!(solve(&s), Err(SceneError::OutOfRange { .. })), "alpha<0 must be rejected");

    // Impossible atmosphere.
    let mut s = base_scene();
    s.atmosphere.pressure_kpa = 0.0;
    assert!(matches!(solve(&s), Err(SceneError::OutOfRange { .. })), "pressure 0 must be rejected");

    // Ground factor out of [0,1].
    let mut s = base_scene();
    s.ground.default_g = 1.5;
    assert!(matches!(solve(&s), Err(SceneError::OutOfRange { .. })), "G=1.5 must be rejected");

    // A non-General extended source is not honoured — reject rather than silently
    // evaluate it as General.
    let mut s = base_scene();
    s.extended_sources = vec![ExtendedSource {
        id: "line".into(),
        kind: SourceKind::ChimneyStack { opening_radius_m: 0.3 },
        geometry: ExtentGeometry::Line { vertices: vec![[5.0, 0.0], [5.0, 10.0]] },
        z: 4.0, height_agl: 4.0, lw: lw10(),
    }];
    assert!(matches!(solve(&s), Err(SceneError::OutOfRange { .. })), "non-General extended kind must be rejected");
}

// ---- A3: Session transactionality ----

// ---- B4: coincident source/receiver; B8: reflection-order cap ----

#[test]
fn coincident_point_source_receiver_is_rejected() {
    let mut s = base_scene();
    s.receivers[0].position = s.sources[0].position; // exactly on the source
    match solve(&s) {
        Err(SceneError::CoincidentSourceReceiver { .. }) => {}
        other => panic!("expected CoincidentSourceReceiver, got {other:?}"),
    }
}

#[test]
fn excessive_reflection_order_is_rejected() {
    let mut s = base_scene();
    s.settings.max_reflection_order = 5;
    assert!(matches!(solve(&s), Err(SceneError::OutOfRange { .. })));
    // Order 2–4 with a couple of reflectors is fine (bounded enumeration).
    s.settings.max_reflection_order = 3;
    assert!(solve(&s).is_ok());
}

#[test]
fn session_set_source_lw_roundtrips_and_rolls_back() {
    let mut sess = Session::new(base_scene()).unwrap();

    // A successful retune matches a fresh one-shot solve of the same scene.
    let mut lw2 = lw10();
    lw2[4] = 88.0;
    assert!(sess.set_source_lw("s", lw2.clone()).unwrap());
    let mut oneshot = base_scene();
    oneshot.sources[0].lw = lw2;
    let a = sess.solve().per_receiver[0].per_source[0].bands.clone();
    let b = solve(&oneshot).unwrap().per_receiver[0].per_source[0].bands.clone();
    for (x, y) in a.iter().zip(b.iter()) {
        assert!((x - y).abs() < 1e-12, "session lw retune must match one-shot: {x} vs {y}");
    }

    // A rejected edit (wrong band count) leaves the session solving identically.
    let before = sess.solve().per_receiver[0].total_dba;
    assert!(sess.set_source_lw("s", vec![1.0, 2.0, 3.0]).is_err());
    let after = sess.solve().per_receiver[0].total_dba;
    assert_eq!(before, after, "rejected set_source_lw must leave the session unchanged");
}

#[test]
fn session_rejected_receivers_and_atmosphere_roll_back() {
    let mut sess = Session::new(base_scene()).unwrap();
    let before = sess.solve().per_receiver[0].total_dba;

    // NaN receiver rejected; session unchanged & still solvable.
    let bad = vec![Receiver { id: "r".into(), position: [f64::NAN, 0.0, 1.5], height_agl: 1.5 }];
    assert!(sess.set_receivers(bad).is_err());
    assert_eq!(sess.solve().per_receiver[0].total_dba, before);

    // Non-finite atmosphere rejected (set_atmosphere is now transactional).
    let bad_atm = Atmosphere { temperature_c: f64::NAN, relative_humidity_pct: 70.0, pressure_kpa: 101.325 };
    assert!(sess.set_atmosphere(bad_atm).is_err());
    assert_eq!(sess.solve().per_receiver[0].total_dba, before);
}

#[test]
fn session_failed_update_leaves_scene_and_decomposition_intact() {
    let mut sess = Session::new(base_scene()).unwrap();
    let before = sess.solve().per_receiver[0].total_dba;

    // A closure that corrupts the scene then fails validation must NOT commit —
    // neither the corrupt source nor any obstacle edit survives.
    let res = sess.update(|s| {
        s.obstacles.push(iso9613_core::scene::Obstacle::Building {
            footprint: vec![[10.0, -5.0], [20.0, -5.0], [20.0, 5.0], [10.0, 5.0]],
            base_z: 0.0,
            height_agl: 6.0,
        });
        s.sources[0].position[0] = f64::INFINITY; // makes validate() fail
    });
    assert!(res.is_err());
    // Scene untouched: same result, and the phantom building did not stick.
    assert_eq!(sess.solve().per_receiver[0].total_dba, before);
    assert!(sess.scene().obstacles.is_empty());
}
