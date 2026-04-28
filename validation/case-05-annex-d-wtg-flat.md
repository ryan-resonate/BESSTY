# Case 05 — Annex D: Wind turbine over flat ground

Tests Annex D specifics: omnidirectional WT source at hub height, `G ≤ 0.5` cap, 4 m receiver-height enforcement, no chimney/general directivity rules.

## Geometry

| Object | Easting (m) | Northing (m) | Height above local ground (m) |
|---|---|---|---|
| Source S (hub centre) | 0 | 0 | 100 |
| Receiver R (display) | 500 | 0 | 1.5 (user-set) |
| Receiver R (calc) | 500 | 0 | **4.0** (Annex D minimum) |

Flat ground at z = 0. Rotor diameter = 120 m (relevant only for Annex D.3 tip-height-for-barriers; no barriers in this case).

- `dp` = 500 m
- `hS` = 100 m, `hR_calc` = 4 m
- `d = sqrt(500² + (100 − 4)²) = sqrt(259216) = 509.13 m`

## Source

Wind turbine. Per Annex D.2: omnidirectional point source at hub. `Dc = 0`.

Reference test spectrum (representative WT at 8 m/s, octave-band LW):

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| LW (dB) | 95 | 100 | 103 | 105 | 103 | 100 | 95 | 89 |

Project-level wind speed: 8 m/s (drives the LW lookup). Mode: standard operation.

## Atmosphere

ISO reference, 10 °C, 70 % RH.

## Ground

Per Annex D.4: G capped at 0.5 for porous ground. Use `G = 0.5` everywhere. (User input might be 1.0 for grass; the WT-source rules force 0.5.)

## Step-by-step

### `Adiv` (Eq 8)

```
Adiv = 20·log10(509.13) + 11 = 54.136 + 11 = 65.136 dB
```

### `Aatm` (Eq 9), `d/1000 = 0.50913`

| Band (Hz) | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Aatm (dB) | 0.051 | 0.204 | 0.509 | 0.967 | 1.884 | 4.939 | 16.700 | 59.568 |

### Ground regions

- `30·hS = 3000 >> dp = 500` → source region covers entire path.
- `30·hR = 120 < dp` → receiver region is rear 120 m.
- `30·hS + 30·hR = 3120 > dp` → no middle region. `q = 0`, `Am = 0`.

### Per-band shape functions

Source region (`h = 100 m`):
For `h = 100`, all `exp(−0.09·h²) = exp(−900) ≈ 0` and `exp(−0.12·(h−5)²) = exp(−1083) ≈ 0`.
So `a'(100) ≈ b'(100) ≈ c'(100) ≈ d'(100) ≈ 1.500`.

Receiver region (`h = 4 m`):
```
a'(4) = 1.5 + 3.0·exp(−0.12·1)·(1 − e⁻¹⁰) + 5.7·exp(−0.09·16)·(1 − e⁻⁰·⁷)
      = 1.5 + 3.0·0.8869·1 + 5.7·0.2369·0.5034
      = 1.5 + 2.661 + 0.680 = 4.840

b'(4) = 1.5 + 8.6·exp(−1.44)·1 = 1.5 + 8.6·0.2369 = 3.537
c'(4) = 1.5 + 14.0·exp(−7.36)·1 = 1.5 + 14.0·6.36e−4 = 1.509
d'(4) = 1.5 + 5.0·exp(−14.4)·1 ≈ 1.500
```

### `AS`, `AR`, `Am`

`AS` (G = 0.5, h = 100 m):

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| AS (dB) | −1.500 | −0.750 | −0.750 | −0.750 | −0.750 | −0.750 | −0.750 | −0.750 |

`AR` (G = 0.5, h = 4 m):

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| AR (dB) | −1.500 | 0.920 | 0.269 | −0.746 | −0.750 | −0.750 | −0.750 | −0.750 |

`Am = 0` for all bands.

### `Agr_inner` and `Agr`

`Agr_inner = AS + AR + Am`:

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Agr_inner (dB) | −3.000 | 0.170 | −0.481 | −1.496 | −1.500 | −1.500 | −1.500 | −1.500 |

`Kgeo = (500² + 96²) / (500² + 104²) = 259216 / 260816 = 0.99387`

`Agr` (Eq 11):

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Agr (dB) | −2.987 | 0.169 | −0.478 | −1.489 | −1.492 | −1.492 | −1.492 | −1.492 |

### Total A and Lp

No barriers, no Annex D.5 correction (flat ground), no reflections. `A = Adiv + Aatm + Agr`.
`Lp = LW + Dc − A = LW − A`.

| Band | A (dB) | Lp = LW − A |
|---|---|---|
| 63 | 65.136 + 0.051 − 2.987 = 62.20 | 95 − 62.20 = 32.80 |
| 125 | 65.136 + 0.204 + 0.169 = 65.51 | 100 − 65.51 = 34.49 |
| 250 | 65.136 + 0.509 − 0.478 = 65.17 | 103 − 65.17 = 37.83 |
| 500 | 65.136 + 0.967 − 1.489 = 64.61 | 105 − 64.61 = 40.39 |
| 1k | 65.136 + 1.884 − 1.492 = 65.53 | 103 − 65.53 = 37.47 |
| 2k | 65.136 + 4.939 − 1.492 = 68.58 | 100 − 68.58 = 31.42 |
| 4k | 65.136 + 16.700 − 1.492 = 80.34 | 95 − 80.34 = 14.66 |
| 8k | 65.136 + 59.568 − 1.492 = 123.21 | 89 − 123.21 = −34.21 |

(8 kHz is below the threshold of audibility — contribution to A-weighted sum is negligible.)

### A-weighted overall

| Band | Lp,A | 10^(L/10) |
|---|---|---|
| 63 | 6.60 | 4.6 |
| 125 | 18.39 | 69.0 |
| 250 | 29.23 | 836.0 |
| 500 | 37.19 | 5234 |
| 1k | 37.47 | 5582 |
| 2k | 32.62 | 1828 |
| 4k | 15.66 | 36.8 |
| 8k | −35.31 | ~0 |
| Sum | | 13591 |

```
LAT(DW) = 10·log10(13591) = 41.33 dB(A)
```

## Expected output

| Quantity | Value | Tolerance |
|---|---|---|
| Effective receiver height (calc) | 4.0 m | exact (per Annex D) |
| Effective G (cap) | 0.5 | exact |
| Adiv | 65.14 dB | ±0.05 |
| Agr @ 500 Hz | −1.49 dB | ±0.1 |
| Lp,A @ 1 kHz | 37.47 dB | ±0.55 |
| LAT(DW) | 41.33 dB(A) | ±0.5 |

## Annex D rules exercised

- D.2: omnidirectional source at hub height. `Dc = 0` is asserted (test should fail if any directivity computation is invoked).
- D.4: receiver height clamped to 4 m for ground calculation. Test should also assert that the displayed receiver height (1.5 m) is preserved in the project document but never used for `Agr`.
- D.4: G ≤ 0.5. If the user sets G = 1.0 in the project and the source is WT, the solver clamps to 0.5 silently and surfaces a notice in the log. Test should include this scenario as a sub-case.

## Gradient sanity check

Move source by `Δz_s = +1 m` (hub from 100 → 101 m):
- `d` changes by `(100 − 4) / 509.13 = 0.1885` m → ΔAdiv ≈ 20·0.1885/(509.13·ln10) ≈ 0.0032 dB
- `Agr` changes due to `Kgeo` and `AS`/`AR` shape (very small at h = 100 m where exponentials are flat)

AD output for `∂Lp,A_total/∂z_s` should match numerical finite difference to 1e-3 relative.
