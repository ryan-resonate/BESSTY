# Solver Design

Maps ISO 9613-2:2024 formula by formula to Rust modules. Every formula reference below cites the standard's clause/equation number. All distances are metres, levels decibels, frequencies hertz unless noted.

## 0. Band-system support (octave AND third-octave, native)

The solver runs end-to-end in whichever band system the user selects per project. We do **not** down-fold third-octave to octave before solving — both are first-class.

- Default project band system: **octave** (8 bands, 63 Hz to 8 kHz).
- Optional: **one-third octave** (24 bands, 50 Hz to 10 kHz nominal centres per IEC 61260-1).

Implementation: a generic `BandSystem` carries a slice of band centre frequencies. Every attenuation kernel is computed per centre frequency:

- `Adiv` is frequency-independent — same value all bands.
- `Aatm` uses the per-band centre frequency through ISO 9613-1's exact formula (which is continuous in `f`).
- `Abar` uses `λ = 340 / f_centre` per band — Eq 18 is naturally per-frequency.
- `Agr` per Table 3 is *defined* on octave bands only. For third-octave we apply each octave's `a'/b'/c'/d'` shape function to all three third-octaves within that octave, per ISO 9613-2 software practice (and ISO/TR 17534-3). The three third-octaves within an octave receive the same `AS, AR, Am` contributions.
- `Reflection` validity check (Eq 26) uses per-band `λ`.

A `BandSystem` enum exposes the centre frequencies and the matching A-weighting table. Per-band code never branches on the band system.

```rust
pub enum BandSystem {
    Octave,
    OneThirdOctave,
}

impl BandSystem {
    pub fn centre_frequencies(&self) -> &'static [f64] { ... }
    pub fn a_weighting(&self) -> &'static [f64] { ... }
    pub fn n_bands(&self) -> usize { self.centre_frequencies().len() }
    /// For ground attenuation: maps each band index to its parent octave index (0..8).
    pub fn parent_octave(&self, band_idx: usize) -> usize { ... }
}
```

Spectra at ingestion: third-octave inputs flow through unchanged. Octave inputs sum upward only when an octave-mode project loads a third-octave catalog entry (rare; surface a notice that bands have been combined and accuracy may degrade).

## 1. Crate layout

```
solver/
  Cargo.toml
  src/
    lib.rs              wasm_bindgen exports + ticket dispatch
    dual.rs             Dual<N>: forward-mode AD scalar with N-input tape
    units.rs            UTM coords, Vec3, type aliases
    spectrum.rs         OctaveBand, BandSpectrum, A-weighting, Lp summation
    iso9613/
      mod.rs            top-level evaluate(source, receiver, env) → BandSpectrum + AD
      divergence.rs     Adiv (Eq 8)
      atmosphere.rs     Aatm (Eq 9), αatm from ISO 9613-1
      ground/
        mod.rs          orchestration of source/middle/receiver regions
        general.rs      AS/AR/Am per Table 3, Eqs 10-13
        functions.rs    a'(h), b'(h), c'(h), d'(h)
      barrier/
        mod.rs          Abar = Dz [- Agr] (Eqs 16, 17, 25)
        diffraction.rs  Dz (Eq 18), zmin (Eq 19), C3 (Eq 20), Kmet (Eq 21)
        path.rs         path-length Δz (Eqs 22, 23, 24), rubber-band ray over edges
        lateral.rs      lateral diffraction (7.4.3)
      reflection/
        mod.rs          image source enumeration, order N
        check.rs        Eqs 26, 27 — frequency/size validity
      annex_d/
        mod.rs          WT-specific dispatch (G≤0.5, 4 m receiver, etc.)
        barrier_cap.rs  Annex D.3 — elevated source + Abar cap
        concave.rs      Annex D.5 — −3 dB if hm ≥ 1.5·(hS+hR)/2
    geometry/
      dem.rs            DEM bilinear interpolation, ray march, ground-region split
      ray.rs            ray-segment vs polygon barrier intersections
    orchestrator/
      mod.rs            work queue, ticket dispatch, error-driven recompute
      tripwires.rs      discontinuity proximity detection
      taylor.rs         first-order extrapolation kernels
  tests/
    case_01_divergence.rs   .. mirrors validation/case-01-*.md
    case_02_ground.rs
    ...
```

## 2. Core types

```rust
// units.rs
pub type Metres = f64;
pub type Decibels = f64;

#[derive(Copy, Clone, Debug)]
pub struct Utm {
    pub e: Metres,    // easting
    pub n: Metres,    // northing
    pub z: Metres,    // height above mean sea level
}

// spectrum.rs
pub const OCTAVE_BANDS_HZ: [f64; 8] =
    [63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0];
pub const OCTAVE_A_WEIGHTING_DB: [f64; 8] =
    [-26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];

pub const ONE_THIRD_OCTAVE_BANDS_HZ: [f64; 24] = [
    50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0, 400.0,
    500.0, 630.0, 800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0,
    4000.0, 5000.0, 6300.0, 8000.0, 10000.0,
];
pub const ONE_THIRD_OCTAVE_A_WEIGHTING_DB: [f64; 24] = [ /* per IEC 61672-1 */ ];

/// Spectrum with a runtime-chosen band count (8 or 24, but kernels treat
/// it as a generic length-N vector).
#[derive(Clone, Debug)]
pub struct BandSpectrum<T = f64> {
    pub system: BandSystem,
    pub bands: SmallVec<[T; 24]>,    // inline up to 24 → no heap alloc
}

impl BandSpectrum<f64> {
    pub fn a_weighted_total(&self) -> Decibels {
        let aw = self.system.a_weighting();
        10.0 * self.bands.iter().zip(aw.iter())
            .map(|(l, a)| 10f64.powf(0.1 * (l + a)))
            .sum::<f64>()
            .log10()
    }
}
```

`BandSpectrum<Dual<N>>` is the AD-instrumented version, used in the solver's hot path. The `SmallVec<[T; 24]>` keeps both 8- and 24-band spectra inline on the stack — no heap allocation in the hot loop.

## 3. Per-source-per-receiver evaluation

The single entry point in `iso9613::mod`:

```rust
pub fn evaluate<T: ADScalar>(
    source: &Source<T>,
    receiver: &Receiver<T>,
    barriers: &[Barrier<T>],
    reflectors: &[Reflector],
    env: &Environment,
    settings: &SolverSettings,
) -> BandSpectrum<T> {
    let lw = source.sound_power_spectrum(env.wind_speed);   // [LW per band]
    let dc = source.directivity(receiver.position());        // Dc per band

    let a_div = divergence::compute(source, receiver);              // Eq 8
    let a_atm = atmosphere::compute(source, receiver, env);         // Eq 9
    let a_gr  = ground::compute(source, receiver, env, settings);   // Eqs 10-13
    let (a_bar, ground_already_in_bar) = barrier::compute(
        source, receiver, barriers, env, settings, a_gr,
    );
    let a_misc = BandSpectrum::zero();  // v1: no Annex A

    // Eq 5, but Abar absorbs Agr per Eqs 16/17
    let a = a_div + a_atm + (if ground_already_in_bar { 0.0 } else { a_gr }) + a_bar + a_misc;

    lw + dc - a   // Eq 3
}
```

Reflections are handled by emitting one extra `evaluate(...)` call per image source (with adjusted source position and `LW` per Eq 28). The orchestrator manages enumeration and energy-summation via Eq 6.

## 4. Formula-by-formula

### 4.1 Geometric divergence — `divergence.rs`

Eq 8: `Adiv = 20·lg(d/d0) + 11`, `d0 = 1 m`. `d` is 3D slant distance source-to-receiver in metres.

```rust
pub fn compute<T: ADScalar>(source: &Source<T>, rx: &Receiver<T>) -> BandSpectrum<T> {
    let d = (rx.pos - source.pos).length();      // sqrt((Δe)² + (Δn)² + (Δz)²)
    let a = T::from_f64(20.0) * d.log10() + T::from_f64(11.0);
    BandSpectrum::splat(a)   // frequency-independent
}
```

AD: `d.log10()` propagates dual-number arithmetic naturally; the gradient w.r.t. source/receiver position is `∇d = (rx − src) / d`, scaled.

### 4.2 Atmospheric absorption — `atmosphere.rs`

Eq 9: `Aatm = αatm · d / 1000`, `αatm` per band from ISO 9613-1:1993 Eqs 2-6.

Since `T = 10 °C` and `RH = 70 %` are fixed, `αatm` per band is a **constant lookup table** computed at startup. Per-band table (dB/km):

| Band | 63 | 125 | 250 | 500 | 1k | 2k | 4k | 8k |
|------|----|-----|-----|-----|----|----|----|----|
| αatm | 0.1 | 0.4 | 1.0 | 1.9 | 3.7 | 9.7 | 32.8 | 117.0 |

(Indicative; exact values computed from ISO 9613-1 at startup. Table re-computed if user later exposes T/RH overrides.)

### 4.3 Ground attenuation (General method) — `ground/`

7.3.1 with new 2024 form (Eq 11):

```
Agr = -10·lg[1 + (10^(-Agr_inner/10) - 1) · Kgeo]
where  Agr_inner = AS + AR + Am               (Eq 12)
       Kgeo = (dp² + (hS-hR)²) / (dp² + (hS+hR)²)   (Eq 13)
```

Component attenuations per band per Table 3:

```rust
fn a_side<T: ADScalar>(g: T, h: T, dp: T, band: usize) -> T {
    // -1.5 base, plus G·function(h) shape per band
    let base = T::from_f64(-1.5);
    match band {
        0 => base,                                                  // 63 Hz
        1 => base + g * func_a(h, dp),                              // 125
        2 => base + g * func_b(h, dp),                              // 250
        3 => base + g * func_c(h, dp),                              // 500
        4 => base + g * func_d(h, dp),                              // 1k
        5 | 6 | 7 => T::from_f64(-1.5) * (T::one() - g),            // 2k, 4k, 8k
        _ => unreachable!(),
    }
}
```

Where the per-band shape functions are (Table 3 footnote):

```
a(h) = 1.5 + 3.0·exp(-0.12·(h-5)²)·(1 - exp(-dp/50))
                    + 5.7·exp(-0.09·h²)·(1 - exp(-2.8e-6·dp²))
b(h) = 1.5 + 8.6·exp(-0.09·h²)·(1 - exp(-dp/50))
c(h) = 1.5 + 14.0·exp(-0.46·h²)·(1 - exp(-dp/50))
d(h) = 1.5 + 5.0·exp(-0.9·h²)·(1 - exp(-dp/50))
```

Middle region attenuation `Am`:

```rust
fn a_middle<T: ADScalar>(g_m: T, h_s: T, h_r: T, dp: T, band: usize) -> T {
    // q = 0 if dp ≤ 30(hS + hR), else 1 - 30(hS+hR)/dp
    let threshold = T::from_f64(30.0) * (h_s + h_r);
    let q = if dp.to_f64() <= threshold.to_f64() {
        T::zero()
    } else {
        T::one() - threshold / dp
    };
    match band {
        0 => T::from_f64(-3.0) * q,                                 // 63 Hz
        4..=7 => T::from_f64(-3.0) * q * (T::one() - g_m),          // 1k+
        _ => T::from_f64(-3.0) * q * (T::one() - g_m),              // 125-500
    }
}
```

The `dp ≤ threshold` switch is a **discontinuity tripwire** — the orchestrator marks any source-receiver pair within ±5 % of the threshold for immediate refresh on input change.

For DEM-equipped projects: `dp` is the projected horizontal distance; `hS`, `hR` are heights above local terrain (interpolated bilinear from DEM at `(es, ns)` and `(er, nr)`).

### 4.4 Barriers — `barrier/`

#### Path-length difference Δz

Eq 22: `Δz = (dSS + dSR + e) − d` for the rubber-band ray over barrier tops.

The ray is constructed in the vertical plane containing source and receiver (Fig 8). The standard's "rubber-band" algorithm:

1. Project all candidate barrier top edges into the vertical S-R plane.
2. Convex-hull the points (S, R, all edge tops) from above.
3. Hull edges between S and R (excluding S-R direct) form the diffracted ray. The kinks are the relevant edges E1...En.
4. `dSS = |S - E1|`, `dSR = |En - R|`, `e = sum of |Ei - E_{i+1}|`.
5. `d = |S - R|` (3D direct).

If the convex hull above contains only S-R (no edges above the LOS), `Δz` per Eq 23 picks the largest negative `Δz` from individual edges below the LOS — barrier "starts to work" only as edges approach LOS.

#### Dz per Eq 18

```
Dz = 10·lg(3 + (40·C3·Δz/λ) · Kmet)   if Δz > zmin
Dz = 0 dB                              if Δz ≤ zmin
```

Wait — re-reading the standard: Eq 18 is `Dz = 10·lg[1 + (3 + C2·C3·Δz/λ) · Kmet]` with `C2 = 20`. Implementing exactly:

```rust
fn dz<T: ADScalar>(delta_z: T, lambda: f64, c3: T, k_met: T) -> T {
    let c2 = T::from_f64(20.0);
    let z_min = -T::from_f64(lambda) / (c2 * c3);   // Eq 19
    if delta_z.to_f64() <= z_min.to_f64() {
        T::zero()
    } else {
        let inner = T::from_f64(3.0) + c2 * c3 * delta_z / T::from_f64(lambda);
        let raw = T::from_f64(10.0) * (T::one() + inner * k_met).log10();
        // Apply 20 dB single-edge / 25 dB multi-edge cap at the call site
        raw
    }
}
```

The `zmin` switch is a tripwire: smooth in the open region, exactly 0 below. The 20/25 dB cap is also a tripwire: gradient w.r.t. all inputs becomes zero once capped.

`C3` per Eq 20 is 1 for single edge (`e = 0`); for multi-edge:
```
C3 = (1 + (5/e)²) / (1/3 + (5/e)²)
```

`Kmet` per Eq 21:
```
Kmet = exp(-(1/2000) · sqrt(max(dSS,dSR) + e) · min(dSS,dSR) · d / (2·(Δz - zmin)))   if Δz > 0
     = 1                                                                                if Δz ≤ 0
```

Note Kmet = 1 is also assumed for all lateral diffraction paths.

#### Combining vertical + lateral — Eq 25

```
Abar = -10·lg(10^(-0.1·Abar_top) + 10^(-0.1·Abar_side1) + 10^(-0.1·Abar_side2))
```

If a path is irrelevant, its term is zero (in the inverse direction → contributes nothing). If the result is negative, clamp to 0 (standard requires this).

#### Caps

Per 7.4.4: `Dz ≤ 20 dB` single edge, `Dz ≤ 25 dB` multi-edge. These are project-configurable when in Annex D (WT) mode (default 3 dB per Annex D.3).

#### Combination with ground — Eqs 16, 17

```
Abar = Dz - Agr     if Dz > 0 AND Agr > 0   (vertical diffraction)
Abar = Dz           if Dz > 0 AND Agr ≤ 0   (or for lateral)
                    (and we then DON'T add Agr separately in Eq 5)
```

Returned as a tuple `(Abar, ground_already_in_bar: bool)` so the top-level evaluator knows whether to add `Agr` again.

### 4.5 Reflections — `reflection/`

Image-source enumeration up to order N (default 3, configurable):

1. For each reflector facing the source, construct image source position (mirror across reflector plane).
2. Validity check per Eqs 26, 27 — discard image if the reflector is too small for the wavelength.
3. Image source's `LW` per Eq 28: `LW_im = LW + 10·lg(1 - α) + DIr`. Default `α = 0.1` for unspecified surfaces.
4. Recursively for higher orders: image of image, applying Eq 29.
5. Each image source then routes through the standard `evaluate` pipeline (full ISO 9613-2 from image position to receiver).

Pruning per project settings:
- Max image-source search radius from receiver: 20 km (default).
- Max reflector-receiver distance: 200 m.
- Max source-reflector distance: 50 m.
- Tolerance: any image source whose contribution at receiver < 0.3 dB below the dominant contribution is pruned.

In v1 reflectors are derived from barrier vertical faces only (no buildings yet). The orchestrator pre-computes the reflector list when barriers change.

### 4.6 Annex D — `annex_d/`

Dispatch happens at the source level. A `Source` carries a `kind: SourceKind`:

```rust
pub enum SourceKind {
    WindTurbine { hub_height: Metres, rotor_diameter: Metres, mode: String },
    GeneralPoint { directivity: Option<DirectivityTable> },
}
```

When `kind == WindTurbine`:

- **Source position**: at `(easting, northing, ground + hub_height)`.
- **Source omnidirectional**: `Dc = 0` always (Annex D.2). Polar directivity disabled.
- **Receiver height clamp**: receiver effective height for Agr = `max(actual, 4.0)` (Annex D.4 + D.5 NOTE). Stored separately; the displayed receiver is at the user-set height but the calculation height is clamped.
- **Ground factor cap**: `G = min(G_user, 0.5)` per region (Annex D.4).
- **Barrier**:
  - Source position for barrier path-length: tip height = `hub + rotor_radius` (Annex D.3 elevated-source option).
  - `Dz` cap at `settings.annex_d_barrier_cap_db` (default 3 dB). Project-configurable.
- **Concave correction (D.5)**: if `hm ≥ 1.5·(hS+hR)/2` along the source-receiver path, add `−3 dB` to `Agr`. `hm` computed from DEM along the path.

When `kind == GeneralPoint`:

- Receiver effective height for Agr = max(actual, 1.5). (Project default; user-overridable.)
- No `G` cap — full 0.0–1.0 range.
- Standard barrier rules with 20/25 dB caps.
- No concave correction.
- Optional polar directivity table for Dc; AD includes yaw gradient.

### 4.7 Sound power spectra and wind speed

The project's wind speed (set at the project level, single value) drives `LW(v)` lookup for every WT source. Each WT source carries a reference to a catalog entry; the catalog provides:

```rust
pub struct WtgCatalogEntry {
    pub model_id: String,
    pub modes: Vec<String>,
    pub spectra: HashMap<(String /* mode */, OrderedFloat<f64> /* wind_speed */), [f64; 8]>,
    pub hub_heights: Vec<f64>,
    pub rotor_diameter: f64,
}
```

Wind-speed interpolation: linear in dB between the two nearest tabulated wind speeds. If the project wind speed is outside the catalog's tabulated range, clamp to nearest endpoint (and surface a warning in the UI).

For `GeneralPoint` sources (BESS, inverters, transformers), the spectrum is just `[f64; 8]` per mode — no wind-speed dependence.

## 5. Discontinuity tripwires summary

| Site | Mathematical form | Tripwire condition |
|---|---|---|
| `dp = 30(hS+hR)` (ground middle region) | `q` activates | within ±5 % |
| `Δz = zmin` (barrier) | `Dz` from 0 → log expr | within ±0.1 m |
| `Dz = 20` or `25` dB cap | gradient zeros | within ±0.5 dB |
| `max(Δzn)` over candidate edges (Eq 23) | active edge swap | top-2 edges within 0.1 m |
| Line of sight blocked / not | `Abar` activates | path within 0.5 m of barrier top |
| `hm = 1.5·(hS+hR)/2` (Annex D.5) | −3 dB jumps in/out | within ±5 % |
| DEM cell boundary | gradient discontinuous | every cell crossing |
| Reflector validity (Eqs 26, 27) | image source switches in/out | size near critical |

Each tripwire is checked by the orchestrator on input change. Any (s, r) pair near a tripwire is enqueued for immediate exact recompute, ahead of error-ranked tickets.

## 6. Performance notes

- Inner loop: 8 bands × forward-mode dual numbers with N inputs. Each band's full evaluation (divergence + atmosphere + ground + barrier) is ~50 ops on f64. With N=6 inputs (typical: src x,y,z + rx x,y,z), dual ops are ~7× scalar. So one (s, r, band) eval ≈ 350 ops ≈ 100 ns at modern f64 throughput. Eight bands = ~1 µs. Per-receiver-per-source ≈ 1 µs. 30 sources × 90 000 receivers = 2.7 M evals = 2.7 s single-threaded. Across 6 cores ≈ 450 ms full recompute. Drag updates use Taylor: a few µs total.

- WASM SIMD: each f64 lane is 2-wide on `wasm32-simd128`. Pack two bands into one 128-bit register where possible (low/mid bands, since they share shape functions). Expected 1.5× from SIMD.

- Memory bandwidth: per-source-contribution snapshot is 2.9 MB per dragged source. Streaming reads/writes during drag — keep cache hot.

- Cold start of WASM module: bundle as compressed `.wasm` (~80 kB minified expected), instantiate with `WebAssembly.instantiateStreaming` while React is rendering the project list. Should be ready before user clicks into a project.
