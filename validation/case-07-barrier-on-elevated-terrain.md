# Case 07 — Single barrier on elevated terrain (z-datum regression)

**Purpose:** expose finding **A1** in `docs/solver-review-2026-06.md` — the
solver conflates "height above local ground" (needed by the ground-attenuation
Table-3 functions) with "absolute z" (needed by the divergence + barrier
diffraction geometry) into a single `z` per source/receiver. On flat ground at
elevation 0 the two are identical, so cases 01–06 never exercise the
difference. The moment a DEM puts the site on non-zero terrain, barrier and
topography-screening geometry is computed in a mixed datum and is wrong.

This case is **case 03 lifted onto a 100 m plateau**. Because adding a constant
to every z leaves the diffraction geometry unchanged, the physically correct
answer is *identical to case 03*. We show that the current web→WASM call path
instead produces a barrier pinned at its cap.

> Status: analysis/spec only — no Rust test is added here (the review was
> read-only). Once A1 is fixed, port this to `solver/tests/case_07_*.rs` and
> assert the "correct" column; it should reproduce case 03 to the dB.

## Geometry

Terrain: a flat plateau at **100 m AMSL**, except a ridge at easting 50 m whose
crest is at **108 m AMSL** (i.e. 8 m above the plateau).

| Object | Easting (m) | Ground elev (m AMSL) | Height above ground (m) | Absolute z (m) |
|---|---|---|---|---|
| Source S (BESS, general) | 0 | 100 | 5 | 105 |
| Receiver R | 100 | 100 | 1.5 | 101.5 |
| Ridge crest E | 50 | 108 | — | 108 |

`G = 0.5`, octave bands, ISO reference atmosphere. Source = 100 dB flat,
omnidirectional (as case 01/03). `dp = 100 m`.

Relative to the *local plateau*, this is exactly case 03 (source 5 m, receiver
1.5 m, barrier top 8 m, `dp = 100 m`). So the correct result **is** case 03.

## How the web layer calls the solver (the bug)

Per `web/src/lib/solver.ts:192-213` the source/receiver z passed to WASM are
**height-above-ground (HAG)**: `S.z = 5`, `R.z = 1.5`. Per
`web/src/lib/propagation.ts:179-196` the DEM ridge is detected in the
**absolute** frame (correct test) and emitted as a barrier with
`top_z = groundZ = 108` (absolute). The solver then builds the diffraction
plane from `S.z = 5` (HAG), `R.z = 1.5` (HAG) and edge `z = 108` (absolute) —
`solver/src/iso9613/barrier/mod.rs:67-71`.

### Correct frame (all z absolute, consistent)

```
S(0, 105) → E(50, 108) → R(100, 101.5)
dSS = sqrt(50² + (108−105)²)   = sqrt(2509)    = 50.090 m
dSR = sqrt(50² + (108−101.5)²) = sqrt(2542.25) = 50.420 m
d   = sqrt(100² + (101.5−105)²)= sqrt(10012.25)= 100.061 m
Δz  = 50.090 + 50.420 − 100.061 = 0.449 m      ← identical to case 03
```

### What the solver actually computes (HAG source/rx + absolute edge)

```
S(0, 5) → E(50, 108) → R(100, 1.5)
dSS = sqrt(50² + (108−5)²)   = sqrt(13109)   = 114.494 m
dSR = sqrt(50² + (108−1.5)²) = sqrt(13842.25)= 117.653 m
d   = sqrt(100² + (1.5−5)²)  = sqrt(10012.25)= 100.061 m
Δz  = 114.494 + 117.653 − 100.061 = 132.086 m   ← ~294× too large
```

The barrier looks ~100 m taller than it is (the plateau elevation leaks in
through the absolute edge while the source/receiver stay at HAG).

### Resulting Dz

With `Δz = 132.086`, every octave band's `Dz = 10·log10(1 + (3 + 20·Δz/λ)·Kmet)`
blows past the single-edge **20 dB cap**:

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Dz (uncapped, dB) | ~26.7 | ~29.7 | ~32.7 | ~35.7 | ~38.7 | ~41.7 | ~44.7 | ~47.7 |
| Dz (capped @ 20) | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 |

So the solver applies a flat ~20 dB screen on every band. Correct (case 03) is
a graded 6.8 → 20 dB. The low/mid bands are over-attenuated by **6–13 dB**, and
the spectrum *shape* is destroyed.

(For a WTG source the Annex D cap is 3 dB, so the same geometry saturates at a
flat 3 dB instead — still wrong, just bounded.)

## Expected output

| Quantity | Correct (= case 03) | Solver today | Note |
|---|---|---|---|
| Δz | 0.449 m | 132.09 m | A1: mixed z-datum |
| Dz @ 500 Hz | 10.67 dB area | 20 dB (capped) | over-screened |
| Barrier shape | graded 6.8→20 dB | flat 20 dB | spectrum destroyed |
| LAT(DW) insertion loss | ≈ 14 dB(A) | ≈ 20 dB(A) | ~6 dB(A) too much |

**Acceptance once A1 is fixed:** with the geometry above, the solver must
reproduce case 03's per-band `Abar` and `LAT(DW) = 41.17 dB(A) ± 0.5`,
independent of the plateau elevation (test at 0 m, 100 m and 500 m AMSL — all
three must agree).

## Companion check (A2 — divergence over differing ground elevation)

Add a variant where S sits at ground 250 m and R at ground 50 m (200 m of real
vertical separation), 500 m apart horizontally, no barrier:

```
Correct d = sqrt(500² + ((50+1.5) − (250+5))²) = sqrt(500² + 203.5²) = 539.8 m
Solver d  = sqrt(500² + (1.5 − 5)²)            = sqrt(500² + 3.5²)    = 500.0 m
ΔAdiv = 20·log10(539.8/500.0) = 0.67 dB
```

The HAG convention drops the ground-elevation difference from the slant
distance, so `Adiv` is ~0.67 dB low here (grows with relief / shorter range and
also perturbs `Kgeo` via `hS−hR`). The in-code estimate of "0.1 dB" assumes the
elevation *difference* is preserved; it is not.
