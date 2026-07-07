//! Validation case 17 — ISO 9613-2:2024 §7.5.4 reflection off a cylinder.
//!
//! A convex cylindrical reflector spreads the reflected ray, so it must add LESS
//! energy than the flat tangent plane at the same reflection point — the
//! difference is the curvature attenuation `Acurv` (Eq 30). The test brackets
//! the cylinder result strictly between "no reflector" and "flat tangent wall".

use iso9613_core::scene::{
    solve, Atmosphere, CylindricalReflector, Ground, Receiver, Reflector, Scene, Settings, Source,
    SourceKind, Standard, SCHEMA_VERSION,
};

fn base_scene() -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_2024,
        atmosphere: Atmosphere::default(),
        ground: Ground { default_g: 0.0, regions: vec![] },
        terrain: None,
        sources: vec![Source {
            id: "s".into(), kind: SourceKind::General,
            position: [-10.0, 20.0, 5.0], height_agl: 5.0, lw: vec![100.0; 10],
        }],
        extended_sources: vec![],
        receivers: vec![Receiver { id: "r".into(), position: [10.0, 20.0, 5.0], height_agl: 5.0 }],
        obstacles: vec![],
        reflectors: vec![],
        cylinders: vec![],
        amisc: Default::default(),
        settings: Settings::default(),
    }
}

#[test]
fn cylinder_adds_a_reflection_weaker_than_the_flat_tangent() {
    let direct = solve(&base_scene()).unwrap().per_receiver[0].total_dba.unwrap();

    // Cylinder centre (0,0) r=5: the reflection point is the top P=(0,5); its
    // tangent plane is the horizontal line y=5.
    let mut cyl = base_scene();
    cyl.cylinders = vec![CylindricalReflector {
        centre: [0.0, 0.0], radius: 5.0, base_z: 0.0, top_z: 20.0, alpha: 0.0, alpha_bands: None,
    }];
    let with_cyl = solve(&cyl).unwrap().per_receiver[0].total_dba.unwrap();

    // The FLAT tangent plane at P (y=5) as a planar reflector — same image,
    // same reflection point, but no curvature spreading.
    let mut flat = base_scene();
    flat.reflectors = vec![Reflector {
        segment: [[-50.0, 5.0], [50.0, 5.0]], base_z: 0.0, top_z: 20.0, alpha: 0.0, alpha_bands: None,
    }];
    let with_flat = solve(&flat).unwrap().per_receiver[0].total_dba.unwrap();

    assert!(with_cyl > direct + 1e-4, "cylinder must add a reflection: {direct} → {with_cyl}");
    assert!(with_cyl < with_flat - 1e-4, "curved must be weaker than flat: {with_cyl} vs {with_flat}");
}

#[test]
fn cylinder_behind_source_gives_no_reflection() {
    // Cylinder off to the side where no convex point faces both S and R.
    let mut scene = base_scene();
    scene.cylinders = vec![CylindricalReflector {
        centre: [0.0, 200.0], radius: 2.0, base_z: 0.0, top_z: 20.0, alpha: 0.0, alpha_bands: None,
    }];
    let with_cyl = solve(&scene).unwrap().per_receiver[0].total_dba.unwrap();
    let direct = solve(&base_scene()).unwrap().per_receiver[0].total_dba.unwrap();
    // The tiny far cylinder either misses or is Fresnel-rejected → ~no change.
    assert!((with_cyl - direct).abs() < 0.2, "far cylinder should barely reflect: {direct} vs {with_cyl}");
}
