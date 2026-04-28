# Case 04 — Two-edge barrier (multiple diffraction)

Tests the multi-edge `C3` (Eq 20), the 25 dB multi-edge cap, and the rubber-band path construction across more than one barrier.

## Geometry

| Object | Easting (m) | Northing (m) | Height above ground (m) |
|---|---|---|---|
| Source S | 0 | 0 | 5 |
| Receiver R | 100 | 0 | 1.5 |
| Barrier B1 | x = 30 (vertical, infinite extent) | top at z = 7 |
| Barrier B2 | x = 70 (vertical, infinite extent) | top at z = 7 |

Flat ground at z = 0. `G = 0.5`.

Both barriers above the LOS:
- LOS at x = 30: y = 5 + (1.5 − 5)·(30/100) = 3.95 m. Barrier 1 top at 7 m → blocks.
- LOS at x = 70: y = 2.55 m. Barrier 2 top at 7 m → blocks.

## Source

Same as previous cases: 100 dB flat, omnidirectional. Atmosphere as Case 01.

## Step-by-step

### `Adiv` and `Aatm`

Same as Case 03 (same `d` and `dp`): `Adiv = 51.005 dB`. Same `Aatm` table.

### Path-length difference (Eq 22)

Rubber-band path: `S(0,5) → E1(30,7) → E2(70,7) → R(100,1.5)`.

```
dSS = sqrt(30² + (7−5)²)   = sqrt(904)   = 30.067 m
e   = sqrt((70−30)² + 0²) = 40.000 m
dSR = sqrt((100−70)² + (7−1.5)²) = sqrt(930.25) = 30.500 m
Δz  = (dSS + dSR + e) − d = 30.067 + 30.500 + 40.000 − 100.061 = 0.506 m
```

### `C3` (Eq 20)

```
C3 = (1 + (5/e)²) / (1/3 + (5/e)²)
   = (1 + 0.0156) / (0.3333 + 0.0156)
   = 1.0156 / 0.3490 = 2.911
```

### `zmin`, `Δz − zmin`, `Kmet`

`zmin = −λ / (C2·C3) = −λ / 58.21`

| Band | λ (m) | zmin (m) | Δz − zmin |
|---|---|---|---|
| 63 | 5.397 | −0.0927 | 0.599 |
| 125 | 2.720 | −0.0467 | 0.553 |
| 250 | 1.360 | −0.0234 | 0.529 |
| 500 | 0.680 | −0.0117 | 0.518 |
| 1k | 0.340 | −0.00584 | 0.512 |
| 2k | 0.170 | −0.00292 | 0.509 |
| 4k | 0.085 | −0.00146 | 0.507 |
| 8k | 0.0425 | −0.00073 | 0.507 |

Kmet inner: `(max(dSS, dSR) + e)·min(dSS, dSR)·d / (2·(Δz − zmin))`
```
= (30.500 + 40.000) · 30.067 · 100.061 / (2·(Δz − zmin))
= 70.500 · 30.067 · 100.061 / (2·(Δz − zmin))
= 212108 / (2·(Δz − zmin))
= 106054 / (Δz − zmin)
```

| Band | inner | sqrt | Kmet |
|---|---|---|---|
| 63 | 177051 | 420.8 | 0.810 |
| 125 | 191798 | 437.9 | 0.803 |
| 250 | 200480 | 447.7 | 0.800 |
| 500 | 204738 | 452.5 | 0.798 |
| 1k | 207134 | 455.1 | 0.796 |
| 2k | 208358 | 456.5 | 0.796 |
| 4k | 209178 | 457.4 | 0.796 |
| 8k | 209178 | 457.4 | 0.796 |

### `Dz` (Eq 18)

`Dz = 10·log10[1 + (3 + C2·C3·Δz/λ)·Kmet] = 10·log10[1 + (3 + 29.46/λ)·Kmet]`

| Band | (3 + 29.46/λ) | inner | Dz raw (dB) | Dz capped @ 25 (dB) |
|---|---|---|---|---|
| 63 | 8.46 | 7.855 | 8.95 | 8.95 |
| 125 | 13.83 | 12.110 | 10.83 | 10.83 |
| 250 | 24.66 | 20.715 | 13.16 | 13.16 |
| 500 | 46.32 | 37.945 | 15.79 | 15.79 |
| 1k | 89.65 | 72.404 | 18.60 | 18.60 |
| 2k | 176.29 | 141.327 | 21.50 | 21.50 |
| 4k | 349.59 | 279.13 | 24.46 | 24.46 |
| 8k | 696.18 | 554.88 | 27.44 | 25.00 |

(Multi-edge cap is 25 dB; only 8 kHz is capped.)

### `Agr` (no barrier) and `Abar` combination

`Agr` is identical to Case 03 (same `dp`, hS, hR, G):

| Band | Agr (dB) |
|---|---|
| 63 | −2.993 |
| 125 | 0.168 |
| 250 | 1.923 |
| 500 | 0.648 |
| 1k | −1.213 |
| 2k | −1.497 |
| 4k | −1.497 |
| 8k | −1.497 |

Lateral diffraction not applicable (barriers assumed infinite in y) — `Abar = Abar,top` per Eq 25.

| Band | Agr sign | Abar | Agr in total A? |
|---|---|---|---|
| 63 | < 0 | 8.95 | yes |
| 125 | > 0 | 10.83 − 0.168 = 10.66 | no |
| 250 | > 0 | 13.16 − 1.923 = 11.24 | no |
| 500 | > 0 | 15.79 − 0.648 = 15.14 | no |
| 1k | < 0 | 18.60 | yes |
| 2k | < 0 | 21.50 | yes |
| 4k | < 0 | 24.46 | yes |
| 8k | < 0 | 25.00 | yes |

### Total A and Lp

| Band | A (dB) | Lp = 100 − A |
|---|---|---|
| 63 | 51.005 + 0.010 − 2.993 + 8.95 = 56.97 | 43.03 |
| 125 | 51.005 + 0.040 + 10.66 = 61.71 | 38.29 |
| 250 | 51.005 + 0.100 + 11.24 = 62.35 | 37.65 |
| 500 | 51.005 + 0.190 + 15.14 = 66.34 | 33.66 |
| 1k | 51.005 + 0.370 − 1.213 + 18.60 = 68.76 | 31.24 |
| 2k | 51.005 + 0.970 − 1.497 + 21.50 = 71.98 | 28.02 |
| 4k | 51.005 + 3.280 − 1.497 + 24.46 = 77.25 | 22.75 |
| 8k | 51.005 + 11.700 − 1.497 + 25.00 = 86.21 | 13.79 |

### A-weighted overall

| Band | Lp,A | 10^(L/10) |
|---|---|---|
| 63 | 16.83 | 48.2 |
| 125 | 22.19 | 165.7 |
| 250 | 29.05 | 803.5 |
| 500 | 30.46 | 1112 |
| 1k | 31.24 | 1330 |
| 2k | 29.22 | 835.6 |
| 4k | 23.75 | 237.1 |
| 8k | 12.69 | 18.6 |
| Sum | | 4551 |

```
LAT(DW) = 10·log10(4551) = 36.58 dB(A)
```

Compared to Case 03 (single barrier, 41.17 dB(A)), the second edge gives an additional ≈ 4.6 dB(A) reduction. Compared to no-barrier (≈ 55.14 dB(A)) the total insertion loss is ≈ 18.6 dB(A).

## Expected output

| Quantity | Value | Tolerance |
|---|---|---|
| Δz | 0.506 m | ±0.001 |
| C3 | 2.911 | ±0.005 |
| Dz @ 1 kHz | 18.60 dB | ±0.15 |
| Dz @ 8 kHz (capped) | 25.00 dB | exact |
| LAT(DW) | 36.58 dB(A) | ±0.5 |

## Lateral diffraction sub-test

The case as written assumes infinite barriers (y → ±∞). To test lateral diffraction (Eq 25), add a sub-case where:

- B1 extends from y = −10 to y = +10 (length 20 m).
- B2 same extent.
- Compute lateral paths around both edges (4 paths total: each barrier × left/right).

Expected: lateral paths' Abar combine with `Abar,top = 18.60 dB @ 1 kHz` per Eq 25, *reducing* the effective screening. Hand calc deferred to a sub-case file.
