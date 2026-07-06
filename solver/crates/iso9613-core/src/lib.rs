//! `iso9613-core` — ISO 9613-2 outdoor sound propagation engine.
//!
//! Pure-Rust physics core: no WASM, no JS, plain `f64` kernels with no shared
//! mutable state (parallel-driver friendly by construction). WASM bindings
//! live in the sibling `iso9613-wasm` crate.
//!
//! See `docs/iso9613-solver-standalone-plan.md` for the architecture,
//! `docs/iso9613-2-1996-vs-2024-differences.md` for the edition model, and
//! `validation/` for the reference test cases.
//!
//! Phase 0 status: 2024 physics chain (Adiv, Aatm, Agr General, Abar over-top
//! + lateral, Annex D, Cmet) behind both the legacy flat evaluators and the
//! typed `scene` API. The path-engine / StandardModel split and the 1996
//! edition land in Phases 1–2.

// Doc comments use ISO-style indented continuation lists; the pedantic
// doc-indentation lints fight that formatting without value.
#![allow(clippy::doc_overindented_list_items, clippy::doc_lazy_continuation)]

pub mod iso9613;
pub mod scene;
pub mod spectrum;
pub mod standards;
pub mod units;

pub use spectrum::{BandSpectrum, BandSystem};
pub use units::{Decibels, Hz, Metres, Vec3};
