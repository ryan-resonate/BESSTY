# Case 03 — Single thin barrier, soft ground

Tests `Abar` for a single-edge barrier per 7.4.1: path-length difference (Eq 22), `Dz` (Eq 18), `Kmet` (Eq 21), and the combination with `Agr` per Eq 16/17.

## Geometry

| Object | Easting (m) | Northing (m) | Height above ground (m) |
|---|---|---|---|
| Source S | 0 | 0 | 5 |
| Receiver R | 100 | 0 | 1.5 |
| Barrier B (thin, vertical) | 50 | along entire y-extent (assumed infinite) | top at z = 8 |

Flat ground at z = 0. `G = 0.5` everywhere.

- `dp` = 100 m
- `d` (3D direct) = `sqrt(100² + (5−1.5)²) = sqrt(10012.25) = 100.061 m`
- Barrier blocks LOS: at x = 50, LOS height = 5 + (1.5−5)·(50/100) = 3.25 m, less than barrier top at 8 m.

## Source

Same as Case 01: 100 dB flat, omnidirectional. Atmosphere as Case 01.

## Step-by-step

### `Adiv` and `Aatm`

```
Adiv = 20·log10(100.061) + 11 = 40.005 + 11 = 51.005 dB
```

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Aatm (dB) | 0.010 | 0.040 | 0.100 | 0.190 | 0.370 | 0.970 | 3.280 | 11.700 |

### Path-length difference (Eq 22)

The diffracted ray over the barrier top:
```
S(0, 5) → E(50, 8) → R(100, 1.5)
```

```
dSS = sqrt(50² + (8−5)²)   = sqrt(2509)   = 50.090 m
dSR = sqrt(50² + (8−1.5)²) = sqrt(2542.25)= 50.420 m
e   = 0   (single edge)
Δz  = (dSS + dSR + e) − d = 50.090 + 50.420 + 0 − 100.061 = 0.449 m
```

### Dz (Eq 18) and Kmet (Eq 21)

`C2 = 20`, `C3 = 1` (single edge).

`zmin = −λ / (C2·C3) = −λ / 20` per band.

`λ = 340 / f` (using ISO reference c = 340 m/s).

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| λ (m) | 5.397 | 2.720 | 1.360 | 0.680 | 0.340 | 0.170 | 0.085 | 0.0425 |
| zmin (m) | −0.270 | −0.136 | −0.068 | −0.034 | −0.017 | −0.0085 | −0.00425 | −0.00213 |
| Δz − zmin | 0.719 | 0.585 | 0.517 | 0.483 | 0.466 | 0.4575 | 0.45325 | 0.45113 |

Kmet inner argument: `(max(dSS,dSR) + e)·min(dSS,dSR)·d / (2·(Δz − zmin))`
```
= 50.420 · 50.090 · 100.061 / (2·(Δz − zmin))
= 252672 / (2·(Δz − zmin))
= 126336 / (Δz − zmin)
```

Per band:

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| inner | 175710 | 215959 | 244364 | 261565 | 271108 | 276144 | 278734 | 280043 |
| sqrt | 419.2 | 464.7 | 494.3 | 511.4 | 520.7 | 525.5 | 528.0 | 529.2 |
| Kmet | 0.811 | 0.793 | 0.781 | 0.774 | 0.771 | 0.769 | 0.768 | 0.768 |

`Dz = 10·log10[1 + (3 + C2·C3·Δz/λ) · Kmet] = 10·log10[1 + (3 + 8.98/λ) · Kmet]`

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| (3 + 8.98/λ) | 4.664 | 6.301 | 9.603 | 16.21 | 29.41 | 55.82 | 108.65 | 214.29 |
| inner | 4.782 | 5.995 | 8.500 | 13.555 | 23.671 | 43.92 | 84.44 | 165.49 |
| Dz raw (dB) | 6.80 | 7.78 | 9.29 | 11.32 | 13.74 | 16.43 | 19.27 | 22.19 |
| Dz capped @ 20 (dB) | 6.80 | 7.78 | 9.29 | 11.32 | 13.74 | 16.43 | 19.27 | 20.00 |

(Single-edge cap = 20 dB; only 8 kHz hits it.)

### `Agr` without barrier (needed for Eq 16)

Same calculation method as Case 02, but with `dp = 100 m`:

- `30·hS + 30·hR = 195 > 100`, so no middle region. `q = 0`, `Am = 0`.

Source-region functions at `dp = 100`:
```
a'(5) = 1.5 + 3.0·(1−e⁻²) + 5.7·e⁻²·²⁵·(1−e⁻⁰·⁰²⁸)
      = 1.5 + 3.0·0.8647 + 0.6008·0.0276 = 4.111
b'(5) = 1.5 + 8.6·e⁻²·²⁵·0.8647 = 2.284
c'(5), d'(5) ≈ 1.500
```

Receiver-region functions at `dp = 100`:
```
a'(1.5) = 1.5 + 3.0·e⁻¹·⁴⁷·0.8647 + 5.7·e⁻⁰·²⁰²⁵·0.0276 = 2.225
b'(1.5) = 1.5 + 8.6·e⁻⁰·²⁰²⁵·0.8647 = 7.573
c'(1.5) = 1.5 + 14.0·e⁻¹·⁰³⁵·0.8647 = 5.800
d'(1.5) = 1.5 + 5.0·e⁻²·⁰²⁵·0.8647 = 2.071
```

`Agr_inner = AS + AR + Am`:

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Agr_inner (dB) | −3.000 | 0.168 | 1.928 | 0.650 | −1.214 | −1.500 | −1.500 | −1.500 |

`Kgeo = 10012.25 / 10042.25 = 0.99701`

`Agr` (Eq 11):

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Agr (dB) | −2.993 | 0.168 | 1.923 | 0.648 | −1.213 | −1.497 | −1.497 | −1.497 |

### Combine barrier and ground (Eqs 16, 17)

Per 7.4.1: if `Agr > 0` use `Abar = Dz − Agr` (and *omit* `Agr` from Eq 5); if `Agr ≤ 0` use `Abar = Dz` (and *include* `Agr` in Eq 5).

| Band | Agr sign | Abar | Agr in total A? |
|---|---|---|---|
| 63 | < 0 | 6.80 (= Dz) | yes (−2.993) |
| 125 | > 0 | 7.78 − 0.168 = 7.61 | no |
| 250 | > 0 | 9.29 − 1.923 = 7.37 | no |
| 500 | > 0 | 11.32 − 0.648 = 10.67 | no |
| 1k | < 0 | 13.74 | yes (−1.213) |
| 2k | < 0 | 16.43 | yes (−1.497) |
| 4k | < 0 | 19.27 | yes (−1.497) |
| 8k | < 0 | 20.00 (capped) | yes (−1.497) |

### Total A and Lp

| Band | A (dB) | Lp = 100 − A |
|---|---|---|
| 63 | 51.005 + 0.010 + (−2.993) + 6.80 = 54.82 | 45.18 |
| 125 | 51.005 + 0.040 + 7.61 = 58.66 | 41.34 |
| 250 | 51.005 + 0.100 + 7.37 = 58.48 | 41.52 |
| 500 | 51.005 + 0.190 + 10.67 = 61.87 | 38.13 |
| 1k | 51.005 + 0.370 + (−1.213) + 13.74 = 63.90 | 36.10 |
| 2k | 51.005 + 0.970 + (−1.497) + 16.43 = 66.91 | 33.09 |
| 4k | 51.005 + 3.280 + (−1.497) + 19.27 = 72.06 | 27.94 |
| 8k | 51.005 + 11.700 + (−1.497) + 20.00 = 81.21 | 18.79 |

### A-weighted overall

| Band | Lp,A | 10^(L/10) |
|---|---|---|
| 63 | 18.98 | 79.1 |
| 125 | 25.24 | 334 |
| 250 | 32.92 | 1959 |
| 500 | 34.93 | 3112 |
| 1k | 36.10 | 4074 |
| 2k | 34.29 | 2685 |
| 4k | 28.94 | 783 |
| 8k | 17.69 | 59 |
| Sum | | 13085 |

```
LAT(DW) = 10·log10(13085) = 41.17 dB(A)
```

For comparison, the same source/receiver geometry with no barrier yields ≈ 55.14 dB(A) (case 02 calculation method, scaled to 100 m). Barrier insertion loss ≈ 14 dB(A).

## Expected output

| Quantity | Value | Tolerance |
|---|---|---|
| Δz | 0.449 m | ±0.001 |
| Dz @ 1 kHz | 13.74 dB | ±0.1 |
| Dz @ 8 kHz (capped) | 20.00 dB | exact (cap) |
| Abar @ 500 Hz (with Agr absorbed) | 10.67 dB | ±0.15 |
| LAT(DW) | 41.17 dB(A) | ±0.5 |

## Tripwire test

This case sits comfortably above all `zmin` thresholds and below the 20 dB cap (except 8 kHz which is at it). For tripwire verification:

- A second variant of this case with barrier height = 5.5 m gives `Δz` near `zmin` for high bands — verify the orchestrator triggers exact recompute.
- A third variant with barrier height = 12 m exceeds the 20 dB cap on most bands — verify gradient w.r.t. barrier height is zero on capped bands.
