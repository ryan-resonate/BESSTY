# Validation cases

Hand-calculated reference cases for the BEESTY ISO 9613-2:2024 implementation. Each case file contains:

- **Geometry** — exact coordinates, heights, ground type.
- **Inputs** — source spectrum (octave bands), atmosphere, settings.
- **Step-by-step calculation** — every term shown with its equation reference and intermediate values.
- **Expected output** — per-band attenuation contributions, per-band SPL at receiver, A-weighted total.
- **Tolerance** — acceptable solver deviation per band and overall.

These exist for two purposes:

1. **Verification before deployment.** Each Rust solver test (`solver/tests/case_*.rs`) re-runs the case and asserts the result matches within tolerance. Acceptance criterion for each release: all cases pass.
2. **Documentation for users.** A practitioner sceptical of the solver should be able to pick any case, work through it on a calculator, and reproduce the expected number. The cases double as worked examples of ISO 9613-2:2024.

## Tolerance policy

- **Per-octave-band attenuation contribution (Adiv, Aatm, Agr, Abar)**: ±0.05 dB.
- **Per-octave-band total SPL at receiver**: ±0.1 dB.
- **A-weighted overall LAT(DW)**: ±0.05 dB.

Tolerances are chosen tighter than ISO 9613-2 Clause 9 (which states ±3 dB observational accuracy at distances < 1 km) because we are testing implementation correctness, not physical accuracy.

Where the standard's text contains a piecewise function or a clamping rule, the hand calculation explicitly states which branch is taken and shows the unclamped value as well, for traceability.

## Atmosphere reference

All cases use ISO reference conditions:

- Temperature: 10 °C
- Relative humidity: 70 %
- Atmospheric pressure: 101.325 kPa
- Octave-band atmospheric absorption coefficients (computed from ISO 9613-1:1993, dB/km):

| Band (Hz) | 63 | 125 | 250 | 500 | 1000 | 2000 | 4000 | 8000 |
|---|---|---|---|---|---|---|---|---|
| αatm (dB/km) | 0.1 | 0.4 | 1.0 | 1.9 | 3.7 | 9.7 | 32.8 | 117.0 |

These will be re-derived precisely from ISO 9613-1 once the solver is built; the table above uses commonly-cited approximate values for hand calculations. Tolerances allow ~0.5 dB drift in `αatm` per band.

## A-weighting reference

Standard A-weighting per IEC 61672-1, octave-band centre frequencies:

| Band (Hz) | 63 | 125 | 250 | 500 | 1000 | 2000 | 4000 | 8000 |
|---|---|---|---|---|---|---|---|---|
| A (dB) | −26.2 | −16.1 | −8.6 | −3.2 | 0.0 | +1.2 | +1.0 | −1.1 |

## Case index

| ID | Name | Tests |
|---|---|---|
| 01 | [Geometric divergence + atmosphere only](case-01-divergence-only.md) | Adiv (Eq 8), Aatm (Eq 9), summation Eq 6 |
| 02 | [Single source, flat ground, General method](case-02-flat-ground-general-method.md) | Agr per Table 3, Eqs 10–13 |
| 03 | [Single thin barrier, soft ground](case-03-single-barrier.md) | Abar with single-edge cap, Dz Eq 18, Kmet Eq 21 |
| 04 | [Two-edge barrier, multi-diffraction](case-04-multi-edge-barrier.md) | C3 (Eq 20), 25 dB cap, lateral diffraction (Eq 25) |
| 05 | [Annex D: WTG over flat ground](case-05-annex-d-wtg-flat.md) | G ≤ 0.5, 4 m receiver, omnidirectional source |
| 06 | [Annex D: WTG over concave terrain](case-06-annex-d-wtg-concave.md) | DEM ground regions, D.5 −3 dB correction |

All cases use a single source and a single point receiver. Multi-source / grid testing happens via property-based tests (sum of singletons = total) layered on top of these primary cases.

## Band system

Cases 01–06 are stated in **octave bands** (8 bands, 63 Hz to 8 kHz). The solver runs natively in either octave or one-third octave (24 bands, 50 Hz to 10 kHz). Third-octave reference cases live in `validation/third-octave/` (TBD) and assert that:

- For a given source spectrum supplied in third-octaves, the per-band Adiv, Aatm, Abar match the third-octave centre frequencies.
- Agr per third-octave matches its parent octave's `AS, AR, Am` (since Table 3 is octave-defined per ISO 9613-2 software practice).
- The A-weighted total computed in third-octave matches the octave-equivalent total within ±0.2 dB(A) when the same broadband emission is supplied in both representations.
