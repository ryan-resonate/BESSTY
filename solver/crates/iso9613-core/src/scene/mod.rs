//! Typed, serializable scene model — the public "what to compute" API.
//!
//! Phase-0 scope: types + validation + a one-shot `solve()` for point
//! receivers, wrapping the existing 2024 evaluators. The stateful `Session`
//! (incremental updates, grids) arrives in Phase 6; terrain, ground regions,
//! buildings and reflections extend these types in Phase 3 — extension is by
//! ADDING fields/variants, never by repurposing existing ones.
//!
//! Coordinates are Cartesian metres (e, n, z-absolute); heights are metres
//! above local ground. Callers own all geodetic work.

use serde::{Deserialize, Serialize};

use crate::iso9613::annex_d::WtgRules;
use crate::iso9613::atmosphere::Atmosphere as CoreAtmosphere;
use crate::iso9613::barrier::{LateralEdge, WallBarrier};
use crate::iso9613::meteorology::cmet_db;
use crate::iso9613::{evaluate_with_barriers, annex_d::evaluate_wtg};
use crate::spectrum::{BandSpectrum, BandSystem};
use crate::units::Vec3;

pub const SCHEMA_VERSION: u32 = 1;

/// Calculation standard. `#[non_exhaustive]`: future editions/standards are
/// added as new variants without breaking consumers.
#[non_exhaustive]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Standard {
    #[serde(rename = "iso9613-2:1996")]
    Iso9613_2_1996,
    #[serde(rename = "iso9613-2:2024")]
    Iso9613_2_2024,
}

#[derive(Copy, Clone, Debug, Serialize, Deserialize)]
pub struct Atmosphere {
    pub temperature_c: f64,
    pub relative_humidity_pct: f64,
    pub pressure_kpa: f64,
}

impl Default for Atmosphere {
    fn default() -> Self {
        Self { temperature_c: 10.0, relative_humidity_pct: 70.0, pressure_kpa: 101.325 }
    }
}

impl From<Atmosphere> for CoreAtmosphere {
    fn from(a: Atmosphere) -> Self {
        CoreAtmosphere {
            temperature_c: a.temperature_c,
            relative_humidity_pct: a.relative_humidity_pct,
            pressure_kpa: a.pressure_kpa,
        }
    }
}

#[derive(Copy, Clone, Debug, Serialize, Deserialize)]
pub struct Ground {
    /// Uniform ground factor G (0 hard … 1 porous). Per-region ground
    /// polygons arrive in Phase 3 as an additional field.
    pub default_g: f64,
}

impl Default for Ground {
    fn default() -> Self { Self { default_g: 0.5 } }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SourceKind {
    General,
    WindTurbine { rotor_diameter_m: f64, apply_concave: bool },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub kind: SourceKind,
    /// Absolute position (e, n, z-absolute) in metres. For a wind turbine,
    /// z is the absolute hub elevation.
    pub position: [f64; 3],
    /// Height above local ground (m) — feeds the ground-attenuation shape
    /// functions independently of the absolute z (split z-datum).
    pub height_agl: f64,
    /// Sound power level per band, dB re 1 pW. Length selects the band
    /// system: 10 = octave (16 Hz – 8 kHz), 31 = one-third octave.
    pub lw: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receiver {
    pub id: String,
    pub position: [f64; 3],
    pub height_agl: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Obstacle {
    /// Thin screen: plan-view polyline with the absolute ground elevation
    /// under each vertex and a constant height above ground. Decomposed into
    /// terrain-following `WallBarrier` segments; the two polyline ENDS emit
    /// vertical `LateralEdge`s for around-the-end diffraction (§7.4.3).
    Wall {
        polyline: Vec<[f64; 2]>,
        base_z: Vec<f64>,
        height_agl: f64,
    },
    // Building / Solid3D variants arrive in Phase 3.
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Settings {
    /// Override for the standard 20/25 dB Dz caps (general sources only;
    /// WTG sources use Annex D's own cap). None = standard caps.
    pub dz_cap_db: Option<f64>,
    /// §8 meteorological-correction factor C0 (dB). 0 disables Cmet.
    pub c0_db: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Scene {
    pub schema_version: u32,
    pub standard: Standard,
    pub atmosphere: Atmosphere,
    pub ground: Ground,
    pub sources: Vec<Source>,
    pub receivers: Vec<Receiver>,
    pub obstacles: Vec<Obstacle>,
    pub settings: Settings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceContribution {
    pub source_id: String,
    /// Z-weighted per-band Lp (dB), Cmet already applied.
    pub bands: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReceiverResult {
    pub receiver_id: String,
    /// A-weighted total of the energy-summed per-band levels, dB(A).
    /// `None` when no source contributes (−∞).
    pub total_dba: Option<f64>,
    pub per_source: Vec<SourceContribution>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Results {
    pub per_receiver: Vec<ReceiverResult>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SceneError {
    UnsupportedSchemaVersion(u32),
    StandardNotImplemented(&'static str),
    NonFinite { entity: String },
    BadLwLength { source_id: String, len: usize },
    MixedBandSystems,
    DegenerateWall { index: usize, reason: &'static str },
}

impl std::fmt::Display for SceneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedSchemaVersion(v) => write!(f, "unsupported scene schema_version {v}"),
            Self::StandardNotImplemented(s) => write!(f, "standard not implemented yet: {s}"),
            Self::NonFinite { entity } => write!(f, "non-finite coordinate or value in {entity}"),
            Self::BadLwLength { source_id, len } => write!(
                f, "source '{source_id}': lw has {len} bands (expected 10 octave or 31 third-octave)"
            ),
            Self::MixedBandSystems => write!(f, "all sources must use the same band system"),
            Self::DegenerateWall { index, reason } => write!(f, "obstacle {index}: {reason}"),
        }
    }
}

impl std::error::Error for SceneError {}

fn band_system_for(len: usize) -> Option<BandSystem> {
    match len {
        10 => Some(BandSystem::Octave),
        31 => Some(BandSystem::OneThirdOctave),
        _ => None,
    }
}

fn all_finite(vals: impl IntoIterator<Item = f64>) -> bool {
    vals.into_iter().all(f64::is_finite)
}

impl Scene {
    /// Structural validation — cheap, no physics. `solve` calls this first.
    pub fn validate(&self) -> Result<BandSystem, SceneError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(SceneError::UnsupportedSchemaVersion(self.schema_version));
        }
        match self.standard {
            Standard::Iso9613_2_2024 => {}
            Standard::Iso9613_2_1996 => {
                return Err(SceneError::StandardNotImplemented("ISO 9613-2:1996 (Phase 2)"));
            }
        }
        if !all_finite([
            self.atmosphere.temperature_c,
            self.atmosphere.relative_humidity_pct,
            self.atmosphere.pressure_kpa,
            self.ground.default_g,
            self.settings.c0_db,
        ]) {
            return Err(SceneError::NonFinite { entity: "scene settings".into() });
        }

        let mut system: Option<BandSystem> = None;
        for src in &self.sources {
            if !all_finite(src.position.iter().copied().chain([src.height_agl]))
                || !all_finite(src.lw.iter().copied())
            {
                return Err(SceneError::NonFinite { entity: format!("source '{}'", src.id) });
            }
            let bs = band_system_for(src.lw.len())
                .ok_or(SceneError::BadLwLength { source_id: src.id.clone(), len: src.lw.len() })?;
            match system {
                None => system = Some(bs),
                Some(prev) if prev != bs => return Err(SceneError::MixedBandSystems),
                _ => {}
            }
        }
        for rx in &self.receivers {
            if !all_finite(rx.position.iter().copied().chain([rx.height_agl])) {
                return Err(SceneError::NonFinite { entity: format!("receiver '{}'", rx.id) });
            }
        }
        for (i, ob) in self.obstacles.iter().enumerate() {
            let Obstacle::Wall { polyline, base_z, height_agl } = ob;
            if polyline.len() < 2 {
                return Err(SceneError::DegenerateWall { index: i, reason: "polyline needs ≥ 2 vertices" });
            }
            if base_z.len() != polyline.len() {
                return Err(SceneError::DegenerateWall { index: i, reason: "base_z length must match polyline" });
            }
            if !height_agl.is_finite() || *height_agl < 0.0 {
                return Err(SceneError::DegenerateWall { index: i, reason: "height_agl must be finite and ≥ 0" });
            }
            if !all_finite(polyline.iter().flat_map(|p| p.iter().copied()).chain(base_z.iter().copied())) {
                return Err(SceneError::NonFinite { entity: format!("obstacle {i}") });
            }
        }
        // Default to octave when there are no sources (empty scene solves to silence).
        Ok(system.unwrap_or(BandSystem::Octave))
    }

    /// Decompose obstacles into solver primitives.
    fn barriers(&self) -> (Vec<WallBarrier>, Vec<LateralEdge>) {
        let mut walls = Vec::new();
        let mut lateral = Vec::new();
        for ob in &self.obstacles {
            let Obstacle::Wall { polyline, base_z, height_agl } = ob;
            for i in 0..polyline.len() - 1 {
                walls.push(WallBarrier {
                    a_e: polyline[i][0], a_n: polyline[i][1],
                    b_e: polyline[i + 1][0], b_n: polyline[i + 1][1],
                    base_z_a: base_z[i], base_z_b: base_z[i + 1],
                    height_agl: *height_agl,
                });
            }
            // Finite screens diffract around their two ends (§7.4.3).
            for v in [0, polyline.len() - 1] {
                lateral.push(LateralEdge {
                    e: polyline[v][0], n: polyline[v][1],
                    base_z: base_z[v], top_z: base_z[v] + height_agl,
                });
            }
        }
        (walls, lateral)
    }
}

/// One-shot point-receiver solve.
pub fn solve(scene: &Scene) -> Result<Results, SceneError> {
    let system = scene.validate()?;
    let atm: CoreAtmosphere = scene.atmosphere.into();
    let (walls, lateral) = scene.barriers();
    let g = scene.ground.default_g;

    let per_receiver = scene
        .receivers
        .iter()
        .map(|rx| {
            let r = Vec3::new(rx.position[0], rx.position[1], rx.position[2]);
            let mut per_source = Vec::with_capacity(scene.sources.len());
            for src in &scene.sources {
                let s = Vec3::new(src.position[0], src.position[1], src.position[2]);
                let lw = BandSpectrum::from_iter(system, src.lw.iter().copied());
                let lp = match &src.kind {
                    SourceKind::General => evaluate_with_barriers(
                        &lw, s, r, src.height_agl, rx.height_agl, g, &walls, &lateral,
                        scene.settings.dz_cap_db, atm,
                    ),
                    SourceKind::WindTurbine { rotor_diameter_m, apply_concave } => evaluate_wtg(
                        &lw, s, r, src.height_agl, rx.height_agl, g, &walls, &lateral,
                        WtgRules::default(), *apply_concave, *rotor_diameter_m, atm,
                    ),
                };
                // §8 long-term meteorological correction (frequency-independent).
                let dp = ((r.e - s.e).powi(2) + (r.n - s.n).powi(2)).sqrt();
                let cmet = cmet_db(scene.settings.c0_db, src.height_agl, rx.height_agl, dp);
                per_source.push(SourceContribution {
                    source_id: src.id.clone(),
                    bands: lp.bands.iter().map(|b| b - cmet).collect(),
                });
            }

            // Energy-sum per band across sources, then A-weight.
            let total_dba = if per_source.is_empty() {
                None
            } else {
                let n = system.n_bands();
                let mut summed = BandSpectrum::zeros(system);
                for i in 0..n {
                    let energy: f64 = per_source
                        .iter()
                        .map(|c| 10f64.powf(0.1 * c.bands[i]))
                        .sum();
                    summed.bands[i] = if energy > 0.0 { 10.0 * energy.log10() } else { f64::NEG_INFINITY };
                }
                let t = summed.a_weighted_total();
                if t.is_finite() { Some(t) } else { None }
            };

            ReceiverResult { receiver_id: rx.id.clone(), total_dba, per_source }
        })
        .collect();

    Ok(Results { per_receiver })
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    fn basic_scene() -> Scene {
        Scene {
            schema_version: SCHEMA_VERSION,
            standard: Standard::Iso9613_2_2024,
            atmosphere: Atmosphere::default(),
            ground: Ground { default_g: 0.5 },
            sources: vec![Source {
                id: "s1".into(),
                kind: SourceKind::General,
                position: [0.0, 0.0, 5.0],
                height_agl: 5.0,
                lw: vec![100.0; 10],
            }],
            receivers: vec![Receiver { id: "r1".into(), position: [200.0, 0.0, 1.5], height_agl: 1.5 }],
            obstacles: vec![],
            settings: Settings::default(),
        }
    }

    #[test]
    fn scene_solve_matches_direct_evaluator() {
        // The typed API must produce exactly what the flat evaluator produces.
        let scene = basic_scene();
        let results = solve(&scene).unwrap();
        let lw = BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat_n(100.0, 10));
        let direct = evaluate_with_barriers(
            &lw,
            Vec3::new(0.0, 0.0, 5.0),
            Vec3::new(200.0, 0.0, 1.5),
            5.0, 1.5, 0.5, &[], &[], None,
            CoreAtmosphere::iso_reference(),
        );
        let got = &results.per_receiver[0].per_source[0].bands;
        for (a, b) in got.iter().zip(direct.bands.iter()) {
            assert!(a == b, "scene path diverged from direct evaluator: {a} vs {b}");
        }
        assert_relative_eq!(
            results.per_receiver[0].total_dba.unwrap(),
            direct.a_weighted_total(),
            epsilon = 1e-12,
        );
    }

    #[test]
    fn iso1996_not_implemented_yet() {
        let mut scene = basic_scene();
        scene.standard = Standard::Iso9613_2_1996;
        assert!(matches!(solve(&scene), Err(SceneError::StandardNotImplemented(_))));
    }

    #[test]
    fn nan_coordinate_rejected() {
        let mut scene = basic_scene();
        scene.receivers[0].position[0] = f64::NAN;
        assert!(matches!(solve(&scene), Err(SceneError::NonFinite { .. })));
    }

    #[test]
    fn wall_obstacle_decomposes_and_screens() {
        let mut scene = basic_scene();
        scene.obstacles.push(Obstacle::Wall {
            polyline: vec![[100.0, -50.0], [100.0, 50.0]],
            base_z: vec![0.0, 0.0],
            height_agl: 8.0,
        });
        let with_wall = solve(&scene).unwrap();
        let no_wall = solve(&basic_scene()).unwrap();
        assert!(
            with_wall.per_receiver[0].total_dba.unwrap()
                < no_wall.per_receiver[0].total_dba.unwrap() - 1.0,
            "wall should attenuate"
        );
    }

    #[test]
    fn scene_round_trips_through_json() {
        let scene = basic_scene();
        let json = serde_json::to_string(&scene).unwrap();
        let back: Scene = serde_json::from_str(&json).unwrap();
        assert_eq!(back.sources[0].id, "s1");
    }
}
