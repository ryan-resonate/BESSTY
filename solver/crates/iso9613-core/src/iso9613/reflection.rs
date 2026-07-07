//! ISO 9613-2 §7.5 — first-order specular reflection via image sources.
//!
//! A reflecting vertical facade produces an image source (the real source
//! mirrored across the facade plane). If the specular reflection point lands on
//! the finite facade, a reflected contribution — the image source radiating
//! `LW + 10·lg(1−α)` — is evaluated through the normal attenuation chain and
//! energy-summed with the direct path (scene layer).
//!
//! The Fresnel size-validity gate ([`fresnel_valid`], Eq 26/27) decides at which
//! bands the reflection is specular enough. Its interpretation of the effective
//! facade dimensions is documented and should be cross-checked against an
//! ISO/TR 17534-3 reflection case (T19) in the conformance phase; the
//! image-source geometry + loss + energy-sum below are unambiguous.

use crate::units::Vec3;

/// A reflecting vertical facade: a plan-view segment A→B over a height band
/// `[base_z, top_z]`, with sound-absorption coefficient `α` (0 = perfectly
/// reflecting; a typical façade default is 0.1).
#[derive(Copy, Clone, Debug)]
pub struct Facade {
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub base_z: f64,
    pub top_z: f64,
    pub alpha: f64,
}

/// A geometrically valid first-order reflection.
pub struct Reflection {
    /// Image source position (real source mirrored across the facade plane).
    pub image_source: Vec3,
    /// Reflection point on the facade.
    pub refl_point: Vec3,
    /// Source→point and point→receiver leg lengths (m).
    pub dso: f64,
    pub dor: f64,
    /// Reflection loss `10·lg(1−α)` (dB, ≤ 0) added to the image source LW.
    pub loss_db: f64,
}

/// Mirror a point across the vertical plane of the facade segment (plan
/// reflection; `z` unchanged).
fn mirror(s: Vec3, a: [f64; 2], b: [f64; 2]) -> Vec3 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-12 {
        return s;
    }
    let t = ((s.e - a[0]) * dx + (s.n - a[1]) * dy) / len2;
    let foot = [a[0] + t * dx, a[1] + t * dy];
    Vec3::new(2.0 * foot[0] - s.e, 2.0 * foot[1] - s.n, s.z)
}

/// First-order reflection of `source` off `facade` toward `receiver`, if the
/// specular point lies on the finite facade (within the segment and its height
/// band). `None` otherwise.
pub fn reflect(source: Vec3, receiver: Vec3, facade: &Facade) -> Option<Reflection> {
    let img = mirror(source, facade.a, facade.b);
    // Plan intersection of img→receiver with segment A→B.
    let (dx, dy) = (receiver.e - img.e, receiver.n - img.n);
    let (wx, wy) = (facade.b[0] - facade.a[0], facade.b[1] - facade.a[1]);
    let det = dx * (-wy) - (-wx) * dy;
    if det.abs() < 1e-9 {
        return None;
    }
    let ax = facade.a[0] - img.e;
    let ay = facade.a[1] - img.n;
    let t = (ax * (-wy) - (-wx) * ay) / det; // along img→receiver
    let s = (dx * ay - dy * ax) / det; // along A→B
    if !(0.0..=1.0).contains(&t) || !(0.0..=1.0).contains(&s) {
        return None;
    }
    // z at the reflection point (interpolate along img→receiver; img.z == source.z).
    let z_p = img.z + t * (receiver.z - img.z);
    if z_p < facade.base_z || z_p > facade.top_z {
        return None;
    }
    let refl_point = Vec3::new(img.e + t * (receiver.e - img.e), img.n + t * (receiver.n - img.n), z_p);
    Some(Reflection {
        image_source: img,
        dso: source.sub(refl_point).length(),
        dor: receiver.sub(refl_point).length(),
        refl_point,
        loss_db: 10.0 * (1.0 - facade.alpha).log10(),
    })
}

/// Fresnel size validity at wavelength `lambda` (Eq 26/27):
/// `1/λ > (2/leff²)·(dso·dor/(dso+dor))`, with `leff = min(a·cos αa, h·cos αh)`.
/// Per Eq 27 `a` is the FULL horizontal extension of the reflecting surface and
/// `h` its FULL vertical extension (NOT the half-extents from the reflection
/// point — that made the gate far too strict; cross-checked against ISO/TR
/// 17534-3 T19). `αa`/`αh` are the horizontal/vertical incidence angles of the
/// S→reflection-point ray.
pub fn fresnel_valid(refl: &Reflection, facade: &Facade, source: Vec3, lambda: f64) -> bool {
    let p = refl.refl_point;
    let (wx, wy) = (facade.b[0] - facade.a[0], facade.b[1] - facade.a[1]);
    let a_ext = (wx * wx + wy * wy).sqrt().max(1e-9); // full horizontal extension
    let h_ext = (facade.top_z - facade.base_z).max(0.0); // full vertical extension
    let sp = source.sub(p);
    let sp_horiz = (sp.e * sp.e + sp.n * sp.n).sqrt();
    let sp_len = sp.length().max(1e-9);
    let cos_ah = sp_horiz / sp_len; // elevation incidence (vertical-plane angle)
    // Incident-ray horizontal component vs facade normal (−wy, wx).
    let cos_aa = ((sp.e * (-wy) + sp.n * wx).abs() / (sp_horiz.max(1e-9) * a_ext)).min(1.0);
    let leff = (a_ext * cos_aa).min(h_ext * cos_ah);
    if leff <= 0.0 {
        return false;
    }
    (1.0 / lambda) > (2.0 / (leff * leff)) * (refl.dso * refl.dor / (refl.dso + refl.dor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn image_and_reflection_point_on_facade() {
        // Facade along y=0, x∈[20,80]. S(30,20,4) R(70,20,4) both above it.
        let f = Facade { a: [20.0, 0.0], b: [80.0, 0.0], base_z: 0.0, top_z: 10.0, alpha: 0.1 };
        let refl = reflect(Vec3::new(30.0, 20.0, 4.0), Vec3::new(70.0, 20.0, 4.0), &f).unwrap();
        // Image = S mirrored across y=0 → (30,-20,4).
        assert_relative_eq!(refl.image_source.n, -20.0, epsilon = 1e-9);
        // Reflection point at x=50, y=0 (by symmetry).
        assert_relative_eq!(refl.refl_point.e, 50.0, epsilon = 1e-9);
        assert_relative_eq!(refl.refl_point.n, 0.0, epsilon = 1e-9);
        // Legs equal, path length = |image−receiver|.
        assert_relative_eq!(refl.dso, refl.dor, epsilon = 1e-9);
        assert_relative_eq!(refl.dso + refl.dor, 56.5685, epsilon = 1e-3);
        // α = 0.1 → loss = 10·lg(0.9) = −0.458 dB.
        assert_relative_eq!(refl.loss_db, -0.4576, epsilon = 1e-3);
    }

    #[test]
    fn no_reflection_when_point_misses_segment() {
        // Facade too short (x∈[0,10]); the specular point at x=50 is off it.
        let f = Facade { a: [0.0, 0.0], b: [10.0, 0.0], base_z: 0.0, top_z: 10.0, alpha: 0.1 };
        assert!(reflect(Vec3::new(30.0, 20.0, 4.0), Vec3::new(70.0, 20.0, 4.0), &f).is_none());
    }
}
