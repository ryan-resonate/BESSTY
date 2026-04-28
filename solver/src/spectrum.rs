//! Band-system support: octave (8 bands) and one-third octave (24 bands).
//!
//! All solver kernels iterate over the centre frequencies of the active
//! `BandSystem` — they don't branch on which system is in use. A
//! `BandSpectrum<T>` carries one value per band; `T` is `f64` for non-AD
//! evaluation or `Dual<N>` for AD evaluation.

use crate::dual::ADScalar;
use crate::units::{Decibels, Hz};
use smallvec::SmallVec;

/// Octave-band centre frequencies (Hz). Extended below 63 Hz to cover the
/// low-frequency content typically present in WTG datasheets (16 / 31.5 Hz).
pub const OCTAVE_CENTRES_HZ: [Hz; 10] =
    [16.0, 31.5, 63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0];

/// A-weighting at octave-band centres per IEC 61672-1.
pub const OCTAVE_A_WEIGHTING_DB: [Decibels; 10] =
    [-56.4, -39.4, -26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];

/// One-third octave centres, 10 Hz to 10 kHz (full audio range covering both
/// IEC 61400-11 WTG datasheets and standard industrial spectra).
pub const ONE_THIRD_OCTAVE_CENTRES_HZ: [Hz; 31] = [
    10.0, 12.5, 16.0, 20.0, 25.0, 31.5, 40.0,
    50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0, 400.0,
    500.0, 630.0, 800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0,
    4000.0, 5000.0, 6300.0, 8000.0, 10000.0,
];

/// A-weighting at one-third octave centres per IEC 61672-1.
pub const ONE_THIRD_OCTAVE_A_WEIGHTING_DB: [Decibels; 31] = [
    -70.4, -63.4, -56.7, -50.5, -44.7, -39.4, -34.6,
    -30.2, -26.2, -22.5, -19.1, -16.1, -13.4, -10.9, -8.6, -6.6, -4.8,
    -3.2,  -1.9,  -0.8,   0.0,   0.6,   1.0,   1.2,   1.3,   1.2,
     1.0,   0.5,  -0.1,  -1.1,  -2.5,
];

/// Maps each one-third octave to its parent octave index (0..10).
/// Octave grouping convention (centre frequencies):
///   16  Hz oct ← 10, 12.5, 16, 20         (4 entries — extra 10 Hz folds in)
///   31.5 oct  ← 25, 31.5, 40
///   63  Hz oct ← 50, 63, 80
///   125 oct   ← 100, 125, 160
///   250 oct   ← 200, 250, 315
///   500 oct   ← 400, 500, 630
///   1k oct    ← 800, 1k, 1250
///   2k oct    ← 1600, 2k, 2500
///   4k oct    ← 3150, 4k, 5000
///   8k oct    ← 6300, 8k, 10000
pub const ONE_THIRD_OCTAVE_PARENT_OCTAVE: [usize; 31] = [
    0, 0, 0, 0,   // 10, 12.5, 16, 20  → 16 Hz oct
    1, 1, 1,      // 25, 31.5, 40      → 31.5 Hz oct
    2, 2, 2,      // 50, 63, 80        → 63 Hz oct
    3, 3, 3,      // 100, 125, 160     → 125 Hz oct
    4, 4, 4,      // 200, 250, 315     → 250 Hz oct
    5, 5, 5,      // 400, 500, 630     → 500 Hz oct
    6, 6, 6,      // 800, 1k, 1250     → 1k Hz oct
    7, 7, 7,      // 1600, 2k, 2500    → 2k Hz oct
    8, 8, 8,      // 3150, 4k, 5000    → 4k Hz oct
    9, 9, 9,      // 6300, 8k, 10000   → 8k Hz oct
];

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BandSystem {
    Octave,
    OneThirdOctave,
}

impl BandSystem {
    pub fn centres(&self) -> &'static [Hz] {
        match self {
            BandSystem::Octave         => &OCTAVE_CENTRES_HZ,
            BandSystem::OneThirdOctave => &ONE_THIRD_OCTAVE_CENTRES_HZ,
        }
    }

    pub fn a_weighting(&self) -> &'static [Decibels] {
        match self {
            BandSystem::Octave         => &OCTAVE_A_WEIGHTING_DB,
            BandSystem::OneThirdOctave => &ONE_THIRD_OCTAVE_A_WEIGHTING_DB,
        }
    }

    pub fn n_bands(&self) -> usize {
        self.centres().len()
    }

    /// Octave index (0..8) for ground-attenuation Table 3 lookup.
    pub fn parent_octave(&self, band_idx: usize) -> usize {
        match self {
            BandSystem::Octave         => band_idx,
            BandSystem::OneThirdOctave => ONE_THIRD_OCTAVE_PARENT_OCTAVE[band_idx],
        }
    }
}

#[derive(Clone, Debug)]
pub struct BandSpectrum<T = f64> {
    pub system: BandSystem,
    pub bands: SmallVec<[T; 24]>,
}

impl<T: ADScalar> BandSpectrum<T> {
    pub fn zeros(system: BandSystem) -> Self {
        let n = system.n_bands();
        let mut bands = SmallVec::with_capacity(n);
        for _ in 0..n { bands.push(T::zero()); }
        Self { system, bands }
    }

    pub fn from_iter<I: IntoIterator<Item = T>>(system: BandSystem, iter: I) -> Self {
        let bands: SmallVec<[T; 24]> = iter.into_iter().collect();
        assert_eq!(
            bands.len(), system.n_bands(),
            "BandSpectrum length {} doesn't match BandSystem ({} bands)",
            bands.len(), system.n_bands(),
        );
        Self { system, bands }
    }

    pub fn n_bands(&self) -> usize { self.system.n_bands() }
}

impl BandSpectrum<f64> {
    /// Energy sum across bands with A-weighting applied — the overall LAT(DW)
    /// per Eq 6 of ISO 9613-2:2024.
    pub fn a_weighted_total(&self) -> Decibels {
        let aw = self.system.a_weighting();
        let s: f64 = self.bands.iter().zip(aw.iter())
            .map(|(l, a)| 10f64.powf(0.1 * (l + a)))
            .sum();
        10.0 * s.log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn parent_octave_mapping() {
        // Octave maps to itself.
        assert_eq!(BandSystem::Octave.parent_octave(3), 3);
        // 1000 Hz third-octave is at index 20 in the 31-band list
        // (10, 12.5, 16, 20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200,
        //  250, 315, 400, 500, 630, 800, 1000, ...) and parent octave 6
        // (since 1k is the 7th entry in the 10-band octave list:
        //  16, 31.5, 63, 125, 250, 500, 1k, ...).
        assert_eq!(BandSystem::OneThirdOctave.centres()[20], 1000.0);
        assert_eq!(BandSystem::OneThirdOctave.parent_octave(20), 6);
        // 8000 Hz third-octave at index 29 → parent octave 9 (8 kHz).
        assert_eq!(BandSystem::OneThirdOctave.centres()[29], 8000.0);
        assert_eq!(BandSystem::OneThirdOctave.parent_octave(29), 9);
    }

    #[test]
    fn a_weighted_flat_octave() {
        let s = BandSpectrum::from_iter(
            BandSystem::Octave,
            std::iter::repeat(100.0).take(10),
        );
        let expected: f64 = 10.0 * OCTAVE_A_WEIGHTING_DB.iter()
            .map(|a| 10f64.powf(0.1 * (100.0 + a))).sum::<f64>().log10();
        assert_relative_eq!(s.a_weighted_total(), expected, epsilon = 1e-9);
    }
}
