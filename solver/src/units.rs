use crate::dual::ADScalar;

pub type Metres = f64;
pub type Decibels = f64;
pub type Hz = f64;

#[derive(Copy, Clone, Debug)]
pub struct Vec3<T> {
    pub e: T,
    pub n: T,
    pub z: T,
}

impl<T: ADScalar> Vec3<T> {
    pub fn new(e: T, n: T, z: T) -> Self { Self { e, n, z } }

    pub fn sub(self, other: Self) -> Self {
        Self { e: self.e - other.e, n: self.n - other.n, z: self.z - other.z }
    }

    pub fn length_sq(self) -> T {
        self.e * self.e + self.n * self.n + self.z * self.z
    }

    pub fn length(self) -> T {
        self.length_sq().sqrt()
    }

    /// Horizontal (e, n) length only — the projected ground-plane distance.
    pub fn length_horizontal(self) -> T {
        (self.e * self.e + self.n * self.n).sqrt()
    }
}
