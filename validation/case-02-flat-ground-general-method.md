# Case 02 — Single source, flat ground, General method

Tests `Agr` per the General method (7.3.1, Table 3, Eqs 10–13).

Single source, no barriers, no reflections, not Annex D (general point source).

## Geometry

| Object | Easting (m) | Northing (m) | Height above ground (m) |
|---|---|---|---|
| Source S | 0 | 0 | 5 |
| Receiver R | 200 | 0 | 1.5 |

Flat ground at z = 0 (no DEM).

- `dp` (projected horizontal source-receiver distance) = 200 m
- `hS` = 5 m, `hR` = 1.5 m
- 3D distance `d = sqrt(200² + (5 − 1.5)²) = sqrt(40012.25) = 200.031 m`

## Ground

Uniform porous (grass): `G = 0.5` everywhere along the path.

## Source

Same as Case 01: flat 100 dB per band, omnidirectional. Atmosphere as Case 01 (10 °C, 70 % RH).

## Step-by-step

### `Adiv` (Eq 8)

```
Adiv = 20·log10(200.031) + 11 = 46.022 + 11 = 57.022 dB
```

### `Aatm` (Eq 9)

`Aatm = αatm · 0.200031` (≈ 0.200 m → identical to Case 01 to 3 sf)

### Ground regions (7.3.1)

- `30·hS = 150`, `30·hR = 45`. `30·hS + 30·hR = 195`.
- `dp = 200 > 195`, so a middle region exists with width `200 − 195 = 5 m`.

`q` factor (Table 3 footnote b):
```
q = 1 − 30·(hS + hR)/dp = 1 − 195/200 = 0.025
```

### Per-band shape functions (Table 3)

For source region (h = `hS` = 5 m):

```
a'(5) = 1.5 + 3.0·exp(−0.12·(5−5)²)·(1 − exp(−200/50))
            + 5.7·exp(−0.09·25)·(1 − exp(−2.8e−6 · 200²))
      = 1.5 + 3.0·1·(1 − e⁻⁴) + 5.7·0.1054·(1 − e⁻⁰·¹¹²)
      = 1.5 + 3.0·0.9817 + 0.6008·0.1060
      = 1.5 + 2.9451 + 0.0637 = 4.509

b'(5) = 1.5 + 8.6·exp(−2.25)·(1 − e⁻⁴) = 1.5 + 8.6·0.1054·0.9817 = 2.390
c'(5) = 1.5 + 14.0·exp(−11.5)·(1 − e⁻⁴) ≈ 1.500   (exp(−11.5) ≈ 10⁻⁵)
d'(5) = 1.5 + 5.0·exp(−22.5)·(1 − e⁻⁴) ≈ 1.500
```

For receiver region (h = `hR` = 1.5 m):

```
a'(1.5) = 1.5 + 3.0·exp(−0.12·12.25)·0.9817 + 5.7·exp(−0.2025)·0.1060
        = 1.5 + 3.0·0.2299·0.9817 + 5.7·0.8167·0.1060
        = 1.5 + 0.677 + 0.493 = 2.671

b'(1.5) = 1.5 + 8.6·exp(−0.2025)·0.9817 = 1.5 + 8.6·0.8167·0.9817 = 8.395
c'(1.5) = 1.5 + 14.0·exp(−1.035)·0.9817 = 1.5 + 14.0·0.3552·0.9817 = 6.381
d'(1.5) = 1.5 + 5.0·exp(−2.025)·0.9817 = 1.5 + 5.0·0.1320·0.9817 = 2.148
```

### Component attenuations (Table 3)

`AS` (G = 0.5, h = 5 m):

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Formula | −1.5 | −1.5+0.5·a' | −1.5+0.5·b' | −1.5+0.5·c' | −1.5+0.5·d' | −1.5·(1−G) | −1.5·(1−G) | −1.5·(1−G) |
| AS (dB) | −1.500 | 0.754 | −0.305 | −0.750 | −0.750 | −0.750 | −0.750 | −0.750 |

`AR` (G = 0.5, h = 1.5 m):

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| AR (dB) | −1.500 | −0.165 | 2.697 | 1.691 | −0.426 | −0.750 | −0.750 | −0.750 |

`Am` (q = 0.025, Gm = 0.5):

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Formula | −3·q | −3·q·(1−Gm) | ditto | ditto | ditto | ditto | ditto | ditto |
| Am (dB) | −0.075 | −0.0375 | −0.0375 | −0.0375 | −0.0375 | −0.0375 | −0.0375 | −0.0375 |

### Inner Agr (Eq 12) and final Agr (Eq 11)

`Agr_inner = AS + AR + Am`:

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Agr_inner (dB) | −3.075 | 0.552 | 2.355 | 0.904 | −1.213 | −1.538 | −1.538 | −1.538 |

`Kgeo` (Eq 13):
```
Kgeo = (200² + (5−1.5)²) / (200² + (5+1.5)²)
     = 40012.25 / 40042.25 = 0.99925
```

`Agr` (Eq 11): `Agr = −10·log10(1 + (10^(−Agr_inner/10) − 1)·Kgeo)`

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Agr (dB) | −3.074 | 0.552 | 2.356 | 0.903 | −1.214 | −1.539 | −1.539 | −1.539 |

### Total attenuation and per-band SPL

`A = Adiv + Aatm + Agr`, `Lp = 100 − A`:

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Lp (dB) | 46.030 | 42.347 | 40.423 | 41.696 | 43.453 | 42.578 | 37.958 | 21.118 |

### A-weighted overall

A-weighted per band:

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Lp,A | 19.83 | 26.25 | 31.82 | 38.50 | 43.45 | 43.78 | 38.96 | 20.02 |

Energy sum:
```
LAT(DW) = 10·log10[ 96.2 + 421.7 + 1521 + 7079 + 22130 + 23878 + 7878 + 100.5 ]
       = 10·log10[ 63105 ] = 48.00 dB(A)
```

## Expected output

| Quantity | Value | Tolerance |
|---|---|---|
| Adiv | 57.02 dB | ±0.05 |
| Agr @ 250 Hz | +2.36 dB | ±0.1 |
| Agr @ 2 kHz | −1.54 dB | ±0.1 |
| Lp @ 1 kHz | 43.45 dB | ±0.55 |
| LAT(DW) overall | 48.00 dB(A) | ±0.5 |

## Notes

- Negative `Agr` values represent coherent ground reflection enhancing the level at the receiver (typical of low frequencies over reflective ground).
- The `Kgeo` correction (Eq 13) is small here (1 − Kgeo ≈ 7e−4) because `dp >> hS, hR`. For close-range cases it dominates.
- This case exercises the q-threshold barely (`dp` only 5 m above the threshold). Case 02b (TBD) should test `dp` exactly at threshold to verify the orchestrator's tripwire activates.

## Gradient sanity check

For source moved by `Δz_s = +1 m` (raising hub from 5 m → 6 m):

```
Numerical: rerun with hS = 6, compare Lp@1kHz delta.
AD: ∂Lp/∂z_s at 1 kHz must match numerical to 1e-3 relative.
```
