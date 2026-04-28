# Case 06 — Annex D: Wind turbine over concave terrain

Tests Annex D.5 concave-ground correction (`ΔAgr = −3 dB`) and DEM-driven `hm` computation.

## Geometry

Same WTG and receiver as Case 05, but the ground between source and receiver dips into a valley.

| Object | Position (UTM e, n) | Height above local ground (m) |
|---|---|---|
| Source S (hub) | (0, 0) | 100 (above ground at z = 0 at source base) |
| Receiver R (calc) | (500, 0) | 4.0 (above ground at z = 0 at receiver base) |

DEM ground profile along the source-receiver line, parameterised:
```
z_ground(x) = −45 · (1 − ((x − 250)/250)²)   for 0 ≤ x ≤ 500
```

Boundary checks:
- `z_ground(0) = −45·(1 − 1) = 0` ✓ (source base at zero)
- `z_ground(250) = −45·(1 − 0) = −45 m` (valley floor)
- `z_ground(500) = −45·(1 − 1) = 0` ✓ (receiver base at zero)

The DEM is supplied as a synthetic raster (or the test harness mocks the DEM lookup with the analytical formula above).

## Source

Same WT spectrum and wind speed as Case 05.

## Step-by-step

### `hm` computation (mean LOS height above ground)

LOS from `(0, 100)` to `(500, 4)` (heights in absolute z):
```
z_LOS(x) = 100 + (4 − 100)·(x/500) = 100 − 0.192·x
```

Height above ground:
```
h(x) = z_LOS(x) − z_ground(x) = (100 − 0.192·x) − (−45·(1 − ((x − 250)/250)²))
     = 100 − 0.192·x + 45·(1 − ((x − 250)/250)²)
```

Substitute `u = (x − 250)/250`, so `x = 250 + 250u` and `dx = 250 du`:
```
h(u) = 100 − 0.192·(250 + 250u) + 45·(1 − u²)
     = 100 − 48 − 48u + 45 − 45u²
     = 97 − 48u − 45u²
```

Mean over the path:
```
hm = (1 / 500) · ∫₀^500 h(x) dx
   = (1 / 2) · ∫_{−1}^{1} (97 − 48u − 45u²) du
   = (1 / 2) · [97·2 − 0 − 45·(2/3)]
   = (1 / 2) · [194 − 30]
   = 82 m
```

### Annex D.5 condition

```
threshold = 1.5 · (hS + hR) / 2 = 1.5 · (100 + 4) / 2 = 78 m
hm = 82 m ≥ 78 m  → CONDITION MET, apply ΔAgr = −3 dB
```

The orchestrator's tripwire flags this case as "near threshold within 5 %" (margin = 4 m, which is 5.1 % of 78). Trip wire bookkeeping: any input change that pushes `hm` below 78·1.05 = 81.9 OR above 78·1.05 (already there) needs an exact recompute. Since `hm` is already in the "apply correction" regime and 5 % above threshold, this is acceptable for the cached gradient.

### `Adiv` and `Aatm`

3D distance source-to-receiver: same as Case 05 (`d = 509.13 m`) — the LOS doesn't depend on the ground profile in between.

```
Adiv = 65.136 dB
```

Aatm same as Case 05.

### Ground regions and `Agr_inner`

Same as Case 05 (`hS = 100`, `hR = 4`, `dp = 500`, `G = 0.5`):

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Agr_inner (dB) | −3.000 | 0.170 | −0.481 | −1.496 | −1.500 | −1.500 | −1.500 | −1.500 |

`Kgeo = 0.99387` as Case 05.

`Agr` (Eq 11) before correction, identical to Case 05:

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Agr_pre (dB) | −2.987 | 0.169 | −0.478 | −1.489 | −1.492 | −1.492 | −1.492 | −1.492 |

### Apply Annex D.5 correction

`ΔAgr = −3 dB` for all bands:

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|---|---|---|---|---|---|---|---|---|
| Agr (dB) | −5.987 | −2.831 | −3.478 | −4.489 | −4.492 | −4.492 | −4.492 | −4.492 |

(All `Agr` values are now negative, which means the ground enhancement at the receiver is larger — consistent with the standard's note that concave profiles give "lower levels of ground attenuation" → more negative `Agr` values.)

### Total A and Lp

| Band | A (dB) | Lp = LW − A |
|---|---|---|
| 63 | 65.136 + 0.051 − 5.987 = 59.20 | 95 − 59.20 = 35.80 |
| 125 | 65.136 + 0.204 − 2.831 = 62.51 | 100 − 62.51 = 37.49 |
| 250 | 65.136 + 0.509 − 3.478 = 62.17 | 103 − 62.17 = 40.83 |
| 500 | 65.136 + 0.967 − 4.489 = 61.61 | 105 − 61.61 = 43.39 |
| 1k | 65.136 + 1.884 − 4.492 = 62.53 | 103 − 62.53 = 40.47 |
| 2k | 65.136 + 4.939 − 4.492 = 65.58 | 100 − 65.58 = 34.42 |
| 4k | 65.136 + 16.700 − 4.492 = 77.34 | 95 − 77.34 = 17.66 |
| 8k | 65.136 + 59.568 − 4.492 = 120.21 | 89 − 120.21 = −31.21 |

### A-weighted overall

| Band | Lp,A | 10^(L/10) |
|---|---|---|
| 63 | 9.60 | 9.1 |
| 125 | 21.39 | 138 |
| 250 | 32.23 | 1671 |
| 500 | 40.19 | 10448 |
| 1k | 40.47 | 11144 |
| 2k | 35.62 | 3648 |
| 4k | 18.66 | 73.5 |
| 8k | −32.31 | ~0 |
| Sum | | 27131 |

```
LAT(DW) = 10·log10(27131) = 44.33 dB(A)
```

## Comparison to Case 05

| Case | LAT(DW) (dB(A)) | Note |
|---|---|---|
| 05 (flat) | 41.33 | Annex D + flat |
| 06 (concave, condition met) | 44.33 | +3.00 (D.5 correction) |
| Δ | +3.00 | exactly the −3 dB ΔAgr propagated through (Lp = LW − A; making Agr more negative reduces A by 3 dB, increasing Lp by 3 dB across all bands) |

This +3 dB offset is the entire effect; per-band details are otherwise identical to Case 05.

## Expected output

| Quantity | Value | Tolerance |
|---|---|---|
| hm | 82.0 m | ±0.5 (DEM bilinear interpolation acceptable drift) |
| Threshold (1.5·(hS+hR)/2) | 78.0 m | exact |
| D.5 condition | applied | boolean, exact |
| ΔAgr | −3.0 dB | exact |
| LAT(DW) | 44.33 dB(A) | ±0.5 |

## DEM-related sub-cases

- **Variant A** (just below threshold): valley floor at −40 m → `hm ≈ 78.7 m`, condition still met but margin tight. Tripwire should flag.
- **Variant B** (well below threshold): valley floor at −20 m → `hm ≈ 65 m < 78`, no correction applied.
- **Variant C** (DEM cell boundary crossing): receiver moves across a DEM cell boundary by 1 m. AD gradient should match finite difference to 1e-3 within a single cell, but discontinuity at the boundary should be caught by the sampled exact-vs-Taylor mechanism.

## Gradient w.r.t. concave correction

Because the −3 dB correction is a piecewise-applied constant, its gradient w.r.t. all inputs is zero **inside the application region** and undefined at the boundary. The orchestrator must trip a refresh whenever an input change pushes `hm` toward (or away from) the 78 m threshold.

The tripwire margin is set at ±5 % of threshold (so `hm ∈ [74.1, 81.9]` → flagged). Outside this range the binary state is stable and the cached gradient (with the constant correction applied or not) is valid.
