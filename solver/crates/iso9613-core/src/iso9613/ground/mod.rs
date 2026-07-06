//! ISO 9613-2 — 7.3 Ground attenuation.
//!
//! Sub-modules:
//! - `functions` — per-octave shape functions a', b', c', d' (Table 3;
//!                 identical in the 1996 and 2024 editions).
//! - `general`   — General method computing AS, AR, Am. The final combination
//!                 is edition-dependent (1996: plain sum; 2024: Kgeo wrap) —
//!                 see `docs/iso9613-2-1996-vs-2024-differences.md` §6. The
//!                 current evaluator implements the 2024 combination; the
//!                 edition switch lands in Phase 1/2.
//!
//! The Simplified method (7.3.2) is IN SCOPE (needed for ISO/TR 17534-3
//! T05/T07) and arrives in Phase 2 as a `ground_method` setting.

pub mod functions;
pub mod general;

pub use general::agr_spectrum;

/// How the per-region attenuations `AS + AR + Am` combine into the final
/// `Agr` — the one place the ground term differs between editions
/// (differences doc §6). Defined here (not in `standards`) so the kernel can
/// name it without an import cycle.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum GroundCombination {
    /// ISO 9613-2:1996 Eq 9: `Agr = AS + AR + Am` (plain sum).
    Sum,
    /// ISO 9613-2:2024 Eqs 11–13: the sum wrapped in the `Kgeo` geometry factor.
    KgeoWrap,
}
