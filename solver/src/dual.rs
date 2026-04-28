//! Forward-mode dual numbers for automatic differentiation.
//!
//! `Dual<N>` carries one primal value and N partial derivatives w.r.t. the
//! tracked input variables. Arithmetic on `Dual<N>` propagates derivatives
//! by the chain rule.
//!
//! `f64` itself implements `ADScalar` so the same kernels run with no AD
//! overhead when gradients aren't needed (idle full-grid recompute).

use std::ops::{Add, Div, Mul, Neg, Sub};

/// Common arithmetic interface implemented by both `f64` and `Dual<N>`.
/// Keeps the solver kernels generic over "with-AD" vs "without-AD".
pub trait ADScalar:
    Copy
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
    + Neg<Output = Self>
{
    fn from_f64(x: f64) -> Self;
    fn to_f64(self) -> f64;
    fn zero() -> Self { Self::from_f64(0.0) }
    fn one() -> Self  { Self::from_f64(1.0) }

    fn sqrt(self) -> Self;
    fn exp(self) -> Self;
    fn ln(self) -> Self;
    fn log10(self) -> Self;
    fn powi(self, n: i32) -> Self;
    fn sin(self) -> Self;
    fn cos(self) -> Self;
}

impl ADScalar for f64 {
    fn from_f64(x: f64) -> Self { x }
    fn to_f64(self) -> f64 { self }
    fn sqrt(self) -> Self  { f64::sqrt(self) }
    fn exp(self)  -> Self  { f64::exp(self) }
    fn ln(self)   -> Self  { f64::ln(self) }
    fn log10(self) -> Self { f64::log10(self) }
    fn powi(self, n: i32) -> Self { f64::powi(self, n) }
    fn sin(self)  -> Self  { f64::sin(self) }
    fn cos(self)  -> Self  { f64::cos(self) }
}

#[derive(Copy, Clone, Debug)]
pub struct Dual<const N: usize> {
    pub v: f64,
    pub d: [f64; N],
}

impl<const N: usize> Dual<N> {
    /// A constant value (zero gradient).
    pub fn constant(v: f64) -> Self { Self { v, d: [0.0; N] } }

    /// An input variable with index `i`: value `v`, gradient is the i-th basis vector.
    pub fn variable(v: f64, i: usize) -> Self {
        let mut d = [0.0; N];
        d[i] = 1.0;
        Self { v, d }
    }
}

impl<const N: usize> Add for Dual<N> {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        let mut d = [0.0; N];
        for i in 0..N { d[i] = self.d[i] + rhs.d[i]; }
        Self { v: self.v + rhs.v, d }
    }
}

impl<const N: usize> Sub for Dual<N> {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        let mut d = [0.0; N];
        for i in 0..N { d[i] = self.d[i] - rhs.d[i]; }
        Self { v: self.v - rhs.v, d }
    }
}

impl<const N: usize> Mul for Dual<N> {
    type Output = Self;
    fn mul(self, rhs: Self) -> Self {
        let mut d = [0.0; N];
        for i in 0..N { d[i] = self.v * rhs.d[i] + rhs.v * self.d[i]; }
        Self { v: self.v * rhs.v, d }
    }
}

impl<const N: usize> Div for Dual<N> {
    type Output = Self;
    fn div(self, rhs: Self) -> Self {
        // d(u/v) = (v·du - u·dv) / v²
        let inv_v2 = 1.0 / (rhs.v * rhs.v);
        let mut d = [0.0; N];
        for i in 0..N { d[i] = (rhs.v * self.d[i] - self.v * rhs.d[i]) * inv_v2; }
        Self { v: self.v / rhs.v, d }
    }
}

impl<const N: usize> Neg for Dual<N> {
    type Output = Self;
    fn neg(self) -> Self {
        let mut d = [0.0; N];
        for i in 0..N { d[i] = -self.d[i]; }
        Self { v: -self.v, d }
    }
}

impl<const N: usize> ADScalar for Dual<N> {
    fn from_f64(x: f64) -> Self { Dual::constant(x) }
    fn to_f64(self) -> f64 { self.v }

    fn sqrt(self) -> Self {
        let v = self.v.sqrt();
        let factor = 0.5 / v;     // d(sqrt(u)) = du/(2·sqrt(u))
        let mut d = [0.0; N];
        for i in 0..N { d[i] = factor * self.d[i]; }
        Self { v, d }
    }

    fn exp(self) -> Self {
        let v = self.v.exp();
        let mut d = [0.0; N];
        for i in 0..N { d[i] = v * self.d[i]; }
        Self { v, d }
    }

    fn ln(self) -> Self {
        let v = self.v.ln();
        let inv = 1.0 / self.v;
        let mut d = [0.0; N];
        for i in 0..N { d[i] = inv * self.d[i]; }
        Self { v, d }
    }

    fn log10(self) -> Self {
        // d(log10(u)) = du / (u·ln(10))
        let v = self.v.log10();
        let factor = 1.0 / (self.v * std::f64::consts::LN_10);
        let mut d = [0.0; N];
        for i in 0..N { d[i] = factor * self.d[i]; }
        Self { v, d }
    }

    fn powi(self, n: i32) -> Self {
        let v = self.v.powi(n);
        // d(u^n) = n·u^(n-1)·du
        let factor = (n as f64) * self.v.powi(n - 1);
        let mut d = [0.0; N];
        for i in 0..N { d[i] = factor * self.d[i]; }
        Self { v, d }
    }

    fn sin(self) -> Self {
        let (s, c) = (self.v.sin(), self.v.cos());
        let mut d = [0.0; N];
        for i in 0..N { d[i] = c * self.d[i]; }
        Self { v: s, d }
    }

    fn cos(self) -> Self {
        let (s, c) = (self.v.sin(), self.v.cos());
        let mut d = [0.0; N];
        for i in 0..N { d[i] = -s * self.d[i]; }
        Self { v: c, d }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn dual_chain_rule_sqrt_log() {
        // f(x) = log10(sqrt(x)) at x = 100 → log10(10) = 1
        // df/dx = 1 / (x · ln(10) · 2) = 1 / (100·2.3026·2) = 0.002171
        let x: Dual<1> = Dual::variable(100.0, 0);
        let y = x.sqrt().log10();
        assert_relative_eq!(y.v, 1.0, epsilon = 1e-12);
        assert_relative_eq!(y.d[0], 1.0 / (100.0 * std::f64::consts::LN_10 * 2.0), epsilon = 1e-12);
    }

    #[test]
    fn finite_difference_check_log10() {
        // Compare AD against finite difference for f(x) = log10(x²)
        let x_val = 7.5;
        let h = 1e-6;
        let fwd = ((x_val + h).powi(2)).log10();
        let bwd = ((x_val - h).powi(2)).log10();
        let fd = (fwd - bwd) / (2.0 * h);

        let x: Dual<1> = Dual::variable(x_val, 0);
        let y = x.powi(2).log10();
        assert_relative_eq!(y.d[0], fd, epsilon = 1e-6);
    }

    #[test]
    fn f64_passes_as_ad_scalar() {
        // Verify that the same kernel works on plain f64 without AD overhead.
        fn squared_log10<T: ADScalar>(x: T) -> T { x.powi(2).log10() }
        let r: f64 = squared_log10(7.5_f64);
        assert_relative_eq!(r, (7.5_f64.powi(2)).log10(), epsilon = 1e-12);
    }
}
