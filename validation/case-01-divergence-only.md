# Case 01 — Geometric divergence + atmosphere only

Tests `Adiv` (Eq 8), `Aatm` (Eq 9), and the per-band → A-weighted summation (Eq 6).

No ground (free-field — set `G = 0` and place source and receiver at heights such that ground regions don't apply, or use `Agr = 0` test mode), no barriers, no reflections, no Annex D.

## Geometry

| Object | Easting (m) | Northing (m) | Height above ground (m) |
|---|---|---|---|
| Source S | 0 | 0 | 100 |
| Receiver R | 200 | 0 | 100 |

Both at the same height (100 m), so ground attenuation is forced to zero by setting `G = 0` and bypassing the ground module (test harness flag).

3D source-receiver distance: `d = sqrt(200² + 0² + 0²) = 200.000 m`

Project-local UTM, flat ground at z = 0.

## Source

Single point source, octave-band sound power level `LW = 100 dB` in every band (flat spectrum for arithmetic clarity).

No directivity (`Dc = 0`).

## Atmosphere

ISO reference: 10 °C, 70 % RH, 101.325 kPa.

Octave-band `αatm` (dB/km):

| Band (Hz) | 63 | 125 | 250 | 500 | 1000 | 2000 | 4000 | 8000 |
|---|---|---|---|---|---|---|---|---|
| αatm | 0.1 | 0.4 | 1.0 | 1.9 | 3.7 | 9.7 | 32.8 | 117.0 |

## Step-by-step

### `Adiv` (Eq 8)

```
Adiv = 20·log10(d/d₀) + 11
     = 20·log10(200/1) + 11
     = 20·2.30103 + 11
     = 46.0206 + 11
     = 57.0206 dB
```

Frequency-independent.

### `Aatm` (Eq 9)

`Aatm = αatm · d / 1000 = αatm · 0.200`

| Band (Hz) | 63 | 125 | 250 | 500 | 1000 | 2000 | 4000 | 8000 |
|---|---|---|---|---|---|---|---|---|
| Aatm (dB) | 0.020 | 0.080 | 0.200 | 0.380 | 0.740 | 1.940 | 6.560 | 23.400 |

### Total attenuation `A = Adiv + Aatm`

(All other terms zero by setup.)

| Band (Hz) | 63 | 125 | 250 | 500 | 1000 | 2000 | 4000 | 8000 |
|---|---|---|---|---|---|---|---|---|
| A (dB) | 57.041 | 57.101 | 57.221 | 57.401 | 57.761 | 58.961 | 63.581 | 80.421 |

### Per-band SPL at receiver (Eq 3)

`Lp = LW + Dc − A = 100 − A`

| Band (Hz) | 63 | 125 | 250 | 500 | 1000 | 2000 | 4000 | 8000 |
|---|---|---|---|---|---|---|---|---|
| Lp (dB) | 42.959 | 42.899 | 42.779 | 42.599 | 42.239 | 41.039 | 36.419 | 19.579 |

### A-weighting and overall

A-weighting per IEC 61672-1:

| Band (Hz) | 63 | 125 | 250 | 500 | 1000 | 2000 | 4000 | 8000 |
|---|---|---|---|---|---|---|---|---|
| Lp,A (dB) | 16.759 | 26.799 | 34.179 | 39.399 | 42.239 | 42.239 | 37.419 | 18.479 |

Energy sum (Eq 6):

```
LAT(DW) = 10·log10[ Σ 10^(0.1·Lp,A) ]
       = 10·log10[ 10^1.6759 + 10^2.6799 + 10^3.4179 + 10^3.9399
                 + 10^4.2239 + 10^4.2239 + 10^3.7419 + 10^1.8479 ]
       = 10·log10[ 47.4 + 478.6 + 2618 + 8710 + 16751 + 16751 + 5520.8 + 70.5 ]
       = 10·log10[ 50947 ]
       = 47.07 dB(A)
```

## Expected output

| Quantity | Value | Tolerance |
|---|---|---|
| Adiv | 57.02 dB | ±0.05 |
| Aatm @ 1 kHz | 0.74 dB | ±0.5 (allows ISO 9613-1 implementation drift) |
| Lp @ 1 kHz | 42.24 dB | ±0.55 |
| LAT(DW) overall | 47.07 dB(A) | ±0.5 |

## Gradient sanity check (AD)

For the source moved by `Δe = +1 m` (eastward, away from receiver — `d` increases by ≈ 1 m):

```
∂Adiv/∂d = 20 / (d · ln(10)) = 20 / (200 · 2.3026) = 0.0434 dB/m
∂Aatm/∂d = αatm / 1000   (e.g. 0.0037 dB/m at 1 kHz)
```

Forward-mode AD output for source `e` at 1 kHz must match `−0.0434 − 0.0037 = −0.0471 dB/m` (negative because Lp decreases as d increases) within 1e-6.
