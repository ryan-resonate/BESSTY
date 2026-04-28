//! ISO 9613-2:2024 — 7.3 Ground attenuation.
//!
//! Sub-modules:
//! - `functions` — per-octave shape functions a', b', c', d' (Table 3).
//! - `general`   — General method computing AS, AR, Am and combining via
//!                 Eqs 10–13 into per-band Agr.
//!
//! The Simplified method (7.3.2) is intentionally not implemented — Annex D
//! requires the General method for wind turbines, and the project scope
//! restricts general point sources to the General method as well.

pub mod functions;
pub mod general;

pub use general::agr_spectrum;
