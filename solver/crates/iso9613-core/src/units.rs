pub type Metres = f64;
pub type Decibels = f64;
pub type Hz = f64;

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Vec3 {
    pub e: f64,
    pub n: f64,
    pub z: f64,
}

impl Vec3 {
    pub fn new(e: f64, n: f64, z: f64) -> Self { Self { e, n, z } }

    #[allow(clippy::should_implement_trait)] // named after the maths, not std::ops
    pub fn sub(self, other: Self) -> Self {
        Self { e: self.e - other.e, n: self.n - other.n, z: self.z - other.z }
    }

    pub fn length_sq(self) -> f64 {
        self.e * self.e + self.n * self.n + self.z * self.z
    }

    pub fn length(self) -> f64 {
        self.length_sq().sqrt()
    }

    /// Horizontal (e, n) length only — the projected ground-plane distance.
    pub fn length_horizontal(self) -> f64 {
        (self.e * self.e + self.n * self.n).sqrt()
    }
}
