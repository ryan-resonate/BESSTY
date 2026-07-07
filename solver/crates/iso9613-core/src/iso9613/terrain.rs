//! Terrain — ground-elevation model feeding terrain screening and mean
//! propagation height.
//!
//! Elevated ground breaks the line of sight and diffracts the ray like a
//! barrier top edge (ISO/TR 17534-3 §5.8: a relevant ground ridge is treated
//! as a diffracting edge, and — being unbounded — contributes NO lateral edge).
//! The terrain profile along the source→receiver plan line is sampled into
//! candidate diffraction edges in the vertical SR plane; the path engine's
//! upper-hull selection then keeps the ridges that actually rise above the
//! direct line.
//!
//! First representation: a regular [`Heightfield`] raster (bilinearly sampled).
//! Contour/TIN ingestion is an adapter-layer concern (parse → heightfield).

use super::barrier::path::DiffractionEdge;

/// A regular gridded ground-elevation raster. `heights` is row-major
/// (`ny` rows of `nx` columns); node `(ix, iy)` sits at
/// `(origin.x + ix·spacing, origin.y + iy·spacing)`.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Heightfield {
    pub origin: [f64; 2],
    pub spacing: f64,
    pub nx: usize,
    pub ny: usize,
    pub heights: Vec<f64>,
}

impl Heightfield {
    fn node(&self, ix: usize, iy: usize) -> f64 {
        self.heights[iy * self.nx + ix]
    }

    /// Bilinearly interpolated ground elevation at plan position `(x, y)`.
    /// Outside the grid, clamps to the nearest edge.
    pub fn height_at(&self, x: f64, y: f64) -> f64 {
        if self.nx == 0 || self.ny == 0 || self.spacing <= 0.0 {
            return 0.0;
        }
        let fx = ((x - self.origin[0]) / self.spacing).clamp(0.0, (self.nx - 1) as f64);
        let fy = ((y - self.origin[1]) / self.spacing).clamp(0.0, (self.ny - 1) as f64);
        let ix = fx.floor() as usize;
        let iy = fy.floor() as usize;
        let ix1 = (ix + 1).min(self.nx - 1);
        let iy1 = (iy + 1).min(self.ny - 1);
        let (tx, ty) = (fx - ix as f64, fy - iy as f64);
        let h00 = self.node(ix, iy);
        let h10 = self.node(ix1, iy);
        let h01 = self.node(ix, iy1);
        let h11 = self.node(ix1, iy1);
        let a = h00 * (1.0 - tx) + h10 * tx;
        let b = h01 * (1.0 - tx) + h11 * tx;
        a * (1.0 - ty) + b * ty
    }

    /// Mean propagation height `hm = F/d` (ISO 9613-2:1996 §7.3.2, Figure 3):
    /// `F` is the area between the straight source→receiver line and the ground
    /// profile beneath it, `d` the source→receiver distance (in the vertical
    /// SR-profile plane). Feeds the simplified-method `Agr` over undulating
    /// terrain. `sz`/`rz` are the ABSOLUTE source/receiver elevations.
    pub fn mean_height(&self, s: [f64; 2], r: [f64; 2], sz: f64, rz: f64) -> f64 {
        let dp = ((r[0] - s[0]).powi(2) + (r[1] - s[1]).powi(2)).sqrt();
        let d = (dp * dp + (rz - sz).powi(2)).sqrt();
        if d < 1e-9 {
            return 0.0;
        }
        // Trapezoidal integral of (SR-line − ground) along the plan path.
        let n = ((dp / self.spacing * 2.0).ceil() as usize).clamp(8, 2000);
        let gap = |i: usize| -> f64 {
            let t = i as f64 / n as f64;
            let (x, y) = (s[0] + t * (r[0] - s[0]), s[1] + t * (r[1] - s[1]));
            (sz + t * (rz - sz)) - self.height_at(x, y)
        };
        let mut f = 0.0;
        for i in 0..n {
            f += 0.5 * (gap(i) + gap(i + 1)) * (dp / n as f64);
        }
        f / d
    }

    /// Sample the terrain profile between source and receiver plan positions
    /// into candidate diffraction edges (`x` = distance along the SR line,
    /// `z` = absolute ground elevation). Interior samples only — the endpoints
    /// are the ground under the (elevated) source/receiver and never diffract.
    pub fn profile_edges(&self, s: [f64; 2], r: [f64; 2], dp: f64) -> Vec<DiffractionEdge> {
        if dp < 1e-6 || self.spacing <= 0.0 {
            return Vec::new();
        }
        // ~2 samples per grid cell along the path, clamped to a sane range.
        let n = ((dp / self.spacing * 2.0).ceil() as usize).clamp(4, 1000);
        (1..n)
            .map(|i| {
                let t = i as f64 / n as f64;
                let x = s[0] + t * (r[0] - s[0]);
                let y = s[1] + t * (r[1] - s[1]);
                DiffractionEdge { x: t * dp, z: self.height_at(x, y) }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn bilinear_sampling() {
        // 3×1 grid at spacing 10: heights 0, 10, 0 → a peak at x=10.
        let hf = Heightfield { origin: [0.0, 0.0], spacing: 10.0, nx: 3, ny: 1, heights: vec![0.0, 10.0, 0.0] };
        assert_relative_eq!(hf.height_at(0.0, 0.0), 0.0, epsilon = 1e-9);
        assert_relative_eq!(hf.height_at(10.0, 0.0), 10.0, epsilon = 1e-9);
        assert_relative_eq!(hf.height_at(5.0, 0.0), 5.0, epsilon = 1e-9); // midway up
        assert_relative_eq!(hf.height_at(20.0, 0.0), 0.0, epsilon = 1e-9);
        assert_relative_eq!(hf.height_at(100.0, 0.0), 0.0, epsilon = 1e-9); // clamps
    }

    #[test]
    fn mean_height_matches_area_over_distance() {
        // Ground flat (0) over x∈[0,80], ramping 0→10 over x∈[80,100]. Ray from
        // S(0, abs 1) to R(100, abs 14). Hand integral of (line − ground):
        //   [0,80]:  ∫(1 + 13x/100)dx      = (1 + 11.4)/2·80 = 496
        //   [80,100]: line 11.4→14, gnd 0→10, gap 11.4→4 → (11.4+4)/2·20 = 154
        //   F = 650, d = hypot(100,13) = 100.841 → hm = 6.446 m.
        let nx = 21; // x = 0,5,…,100
        let heights: Vec<f64> = (0..nx)
            .map(|i| {
                let x = i as f64 * 5.0;
                if x <= 80.0 { 0.0 } else { 10.0 * (x - 80.0) / 20.0 }
            })
            .collect();
        let hf = Heightfield { origin: [0.0, 0.0], spacing: 5.0, nx, ny: 1, heights };
        let hm = hf.mean_height([0.0, 0.0], [100.0, 0.0], 1.0, 14.0);
        assert_relative_eq!(hm, 6.446, epsilon = 0.01);
    }

    #[test]
    fn mean_height_flat_ground_is_source_receiver_mean() {
        // Over flat ground hm = F/d reduces to (hS + hR)/2 when the heights are
        // small vs the distance (d ≈ dp). S at 2 m, R at 4 m over z=0 → ~3 m.
        let hf = Heightfield { origin: [0.0, 0.0], spacing: 10.0, nx: 21, ny: 1, heights: vec![0.0; 21] };
        let hm = hf.mean_height([0.0, 0.0], [200.0, 0.0], 2.0, 4.0);
        assert_relative_eq!(hm, 3.0, epsilon = 0.01);
    }

    #[test]
    fn profile_captures_a_ridge() {
        // Triangular ridge peaking at x=100 (z=10), zero at x=50 and x=150.
        // Nodes every 5 m from 0..200.
        let nx = 41;
        let heights: Vec<f64> = (0..nx)
            .map(|i| {
                let x = i as f64 * 5.0;
                if (50.0..=150.0).contains(&x) { 10.0 - (x - 100.0).abs() * 0.2 } else { 0.0 }
            })
            .collect();
        let hf = Heightfield { origin: [0.0, 0.0], spacing: 5.0, nx, ny: 1, heights };
        let edges = hf.profile_edges([0.0, 0.0], [200.0, 0.0], 200.0);
        let peak = edges.iter().map(|e| e.z).fold(0.0, f64::max);
        assert_relative_eq!(peak, 10.0, epsilon = 0.2);
    }
}
