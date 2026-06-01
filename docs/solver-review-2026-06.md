# BEESTY solver review — accuracy & speed (2026-06-01)

Scope: the ISO 9613-2:2024 Rust/WASM solver (`solver/src/**`) and the web
glue that drives it (`web/src/lib/{solver,propagation,sourceTree}.ts`).
Focus per request: **accuracy bugs, validation gaps, areas for improvement,
and speed**. No code was changed. All 49 Rust tests currently pass
(`cargo test --release`).

The headline: the core ISO formulas are implemented **correctly and to the
2024 revision** (a genuine strength — see §1). The accuracy risk is almost
entirely at the **web→WASM boundary**, where the height/coordinate
convention and the terrain handling break the barrier geometry over real
terrain (§2, A1). The speed story is that the ambitious threaded/SIMD/batched
architecture described in the README and `docs/` is **largely not built** —
the grid runs single-threaded on the main thread with one WASM call per
cell·source (§4).

---

## 1. What is correct (verified against `iso_9613-2.txt`)

These were checked formula-by-formula against the licensed 2024 standard
text, not just against the hand-calc tests (tests only prove code = hand-calc,
not code = standard).

- **Adiv** (Eq 8): `20·log10(d)+11`. ✔ `divergence.rs:14`
- **Aatm** (Eq 9) + α(f,T,h,p) closed form from ISO 9613-1 §8: the classical,
  O₂ and N₂ relaxation terms and relaxation-frequency formulae all match. ✔
  `atmosphere.rs:57`. Good that it's a true closed form, not a 10 °C table.
- **Agr General method** with the **2024** Eqs 11–13 — including the new
  `Kgeo` geometry correction `Agr = −10·log10(1 + (10^(−Agr'/10) − 1)·Kgeo)`
  and `Kgeo = (dp²+(hS−hR)²)/(dp²+(hS+hR)²)`. ✔ `ground/general.rs:54-77`.
  Many tools still ship the 1996 form; implementing the 2024 form is correct
  and notable.
- **Table 3 shape functions** a′,b′,c′,d′ and the AS/AR/Am region split. ✔
  `ground/functions.rs`, `ground/general.rs:89-109`.
- **Abar / Dz** with the **2024** Eq 18 `Dz = 10·log10(1 + (3 + (C2/λ)·C3·z)·Kmet)`
  — note this is the *revised* form (the `1 +` wrapper and `Kmet` multiplying
  the whole bracket are new in 2024 to fix the low-barrier / large-distance
  shortcomings called out in the standard's foreword). ✔ `diffraction.rs:56-65`.
- **zmin** (Eq 19) `−λ/(C2·C3)`, **C3** (Eq 20), **Kmet** (Eq 21) with the
  `2(z − zmin)` denominator (also a 2024 change). ✔ `diffraction.rs:15-53`.
- **Multi-edge rubber-band path** via an upper-convex-hull selection in the
  S–R vertical plane, with Δz = (dSS+dSR+e) − d. ✔ `barrier/path.rs`. Clean.
- **Annex D** dispatch: G≤0.5 cap, 4 m receiver clamp, elevated (tip-height)
  source for the barrier path, 3 dB Dz cap, −3 dB concave term. ✔
  `annex_d.rs` (but see A3 — the concave criterion is never actually fed in).
- **Forward-mode dual numbers**: arithmetic + sqrt/exp/ln/log10/powi chain
  rules are correct (`dual.rs`), and `f64: ADScalar` lets the same kernels run
  AD-free. Good design.

So the physics core is sound. The problems are integration-level.

---

## 2. Accuracy bugs & concerns

### A1 — **(HIGH) Barrier/terrain geometry uses an inconsistent z-datum**

This is the most important finding. The solver takes a single `z` per
source/receiver and uses it for **both**:
- ground attenuation (needs `z` = **height above local ground**, HAG), and
- divergence + barrier diffraction geometry (needs `z` in a **common
  absolute datum** shared with the barrier tops).

The web side resolved an earlier ground-attenuation bug by passing **HAG**
for source and receiver z (`solver.ts:192-213`, well-documented there). But
the barrier tops are passed in a **different** frame:

- User barriers: `top_z = b.topHeightsM[0]` verbatim (`solver.ts:138`).
- Topography (DEM) barriers: `top_z = groundZ` = **absolute elevation**
  (`propagation.ts:194`).

Inside the solver the diffraction plane is built from
`s.z = source_pos.z` (HAG), `r.z = receiver_pos.z` (HAG), and edge
`z = wall.top_z` (absolute) — `barrier/mod.rs:67-71`. Mixing HAG (single
digits…hub height) with absolute elevation (hundreds of m) makes the barrier
look ~`ground_elevation` metres taller than it is.

Concrete: source ground 100 m / 1.5 m HAG, receiver ground 100 m / 1.5 m HAG,
a ridge whose top is 130 m absolute (≈28.5 m above the real sightline). The
DEM path-sampler correctly detects the 28.5 m protrusion
(`propagation.ts:185-187`, absolute frame) but then emits the barrier at
`top_z = 130`. The solver sees source/receiver at z≈1.5 and a barrier top at
130 → a ~128 m barrier instead of ~28 m → Δz is hugely overestimated → Dz
pins at the cap (25 dB for general sources; 3 dB for WTG). **Result: whenever
a DEM is loaded and any terrain rises into the path, screening is wrong and
typically saturated at the cap.** Flat terrain at non-zero elevation is fine
(the protrusion test filters it), so this only bites on real relief — i.e.
exactly the cases the DEM was loaded for.

Root cause: one `z` field cannot be both HAG and absolute once ground
elevation ≠ 0. The General method implicitly assumes source-ground,
receiver-ground and barrier-base are all the same elevation.

**Fix direction (engine API change):** carry both quantities to the solver —
absolute z (or local-ground elevation) for source, receiver and each barrier
base for the divergence/diffraction geometry, *plus* hS/hR (HAG) for the
Table-3 ground functions. i.e. split the conflated `z` into `(z_abs, h_agl)`.
Barriers then carry `base_elev + height`. This is the single change that most
improves real-terrain accuracy.

**Why no test caught it:** every validation case (01–06) sits on flat ground
at z=0, so HAG ≡ absolute and the mismatch vanishes. See V1/V2 and the new
`validation/case-07-barrier-on-elevated-terrain.md`.

### A2 — (MEDIUM) HAG convention drops the source↔receiver ground-elevation difference

Because both z's are HAG, `Adiv`'s slant distance loses the **difference in
ground elevation** between source and receiver, not just a small 3-D
correction. The in-code note (`solver.ts:205-210`) estimates "0.1 dB at
1000 m / 100 m" — but that's the wrong error model: it assumes the elevation
*difference* is preserved. It isn't. For a turbine on a 250 m ridge over a
receiver in a 50 m valley (200 m true vertical separation) at 500 m
horizontal, true slant ≈ 538 m but the HAG geometry uses ≈ (hub_HAG − rx_HAG)
≈ 96 m vertical → ≈ 509 m → ~0.5 dB on Adiv, growing with relief and at
shorter range. It also feeds the same error into the diffraction `d`/`d_direct`
and into `Kgeo` (via hS−hR). Couples with A1.

### A3 — (MEDIUM) Annex D.5 concave correction is never triggered; D.3 terrain screening rides on the broken path

`apply_concave` is hard-coded `false` at every call site
(`solver.ts:242,770,979`). The DEM criterion `hm ≥ 1.5·(hS+hR)/2` is never
computed, so the −3 dB concave term (`annex_d.rs:120-124`) is dead in
production despite passing its unit test (the test sets the flag directly).
Separately, Annex D's terrain-screening (the 3 dB-capped Abar) depends on the
topography-barrier mechanism, which is subject to A1. Net: Annex D's two
terrain features are effectively non-functional over real terrain.

### A4 — (MEDIUM) Clustered sources lose Annex D physics (grid mode)

Barnes-Hut clusters are always evaluated as **general point sources**
(`evaluate_general_octave`, `solver.ts:982`) with `lwOverride` = energy-summed
LW. So once distant turbines are folded into a cluster they lose: the G≤0.5
cap, the 4 m receiver clamp, the 3 dB barrier cap (they get the 20/25 dB
caps instead), and concave handling. Combined with A1, a cluster behind any
ridge can shed ~25 dB instead of the WTG-correct ≤3 dB. Bounded to the far
field (clusters only form far away, θ=0.25 default), but it's a real
near/far physics seam. Also a cluster's `zAboveGround` is an energy-weighted
mean (`sourceTree.ts:130,139`) — meaningless if a cluster ever mixes WTG hub
heights with BESS 1.5 m heights (rare in practice, but unguarded).

### A5 — (LOW / robustness) Dead-but-fragile diffraction guards & AD discontinuities

`k_met` returns 1 for `delta_z ≤ 0` and `dz_uncapped` returns 0 for
`delta_z ≤ zmin` (`diffraction.rs:35,59`). With upper-hull selection Δz ≥ 0
whenever an edge is active, so these branches are essentially unreachable in
the integrated path — but if Δz ever lands at/just below 0 (grazing) there's
a step from 0 → ~4.8 dB at z=zmin, which is also a **gradient discontinuity**
the Taylor cache can't see. The architecture leans hard on smooth gradients,
yet the hard switches here, in the `q` factor (`ground/general.rs:48`), in the
Dz cap (`diffraction.rs:80`), and in the hull/active-edge selection are all
non-differentiable. The "tripwire" system that was supposed to catch these
(`docs/solver-design.md §5`) is **not implemented**. Low impact today, but
it's the mechanism that's supposed to keep drag-time extrapolation honest.

### A6 — (LOW) Single project-wide G; speed of sound fixed at 340 m/s

- `g` is one value applied to all three regions (`solver.ts:191`,
  `ground::agr_spectrum(.., g, g, g, ..)`). ISO allows GS/Gm/GR to differ; no
  terrain-derived per-region G. Acknowledged scope limit; flag for accuracy on
  mixed ground.
- `λ = 340/f` (`barrier/mod.rs:82`) while α uses the real temperature. 340 is
  the ISO nominal, so this is *defensible*, but it's a small internal
  inconsistency (at 0 °C c≈331, at 30 °C c≈349 → ~±1.3% on λ, hence on Dz).

### A7 — (LOW) Minor table drift

Octave A-weighting at 16 Hz is `−56.4` (`spectrum.rs:19`) vs `−56.7` in the
third-octave table (`spectrum.rs:33`) and IEC 61672. Immaterial to dB(A)
(16 Hz contributes nothing) but inconsistent.

---

## 3. Validation gaps

The suite is clean and the hand-calcs are good, but coverage has blind spots
that hide A1–A4:

- **V1 — no non-zero-terrain case.** Every case is flat at z=0, so the A1
  z-datum mismatch and A2 elevation-difference loss are structurally
  invisible. *New:* `validation/case-07-barrier-on-elevated-terrain.md` (added
  with this review) works the geometry by hand and shows the discrepancy.
- **V2 — the topography-virtual-barrier path is never exercised** by any test,
  in Rust or JS. It's the de-facto terrain-screening model and is untested.
- **V3 — no third-octave numeric references** (`validation/third-octave/` is
  still "TBD" in the README). And third-octave has its own perf bug (S4).
- **V4 — no case with source and receiver at different ground elevations**
  (isolates A2 and the `Kgeo`/`hS−hR` behaviour).
- **V5 — case 06 ("concave") feeds the −3 dB via a flag, not DEM geometry**,
  so it doesn't test the criterion that's actually never computed (A3).
- **V6 — no integration/property tests**: the README promises "sum of
  singletons = total" and grid-vs-points consistency, and a Barnes-Hut
  cluster-vs-exact error bound — none exist. A4 would surface immediately in
  a cluster-error test.
- **V7 — docs are stale**: README/`solver-design.md` still describe 8 octave
  bands (63 Hz–8 kHz) and 24 third-octave bands, but the code uses 10
  (16 Hz–8 kHz) and 31 (10 Hz–10 kHz). The validation README's αatm and
  A-weighting tables are 8-band. Fix the docs so reviewers aren't checking
  against the wrong band set.

Suggested additions (markdown + Rust test once code is touched): elevated
barrier (V1), differing-ground-elevation divergence (V4), a real-DEM concave
case (V5), and a `grid == Σ points` property test plus a `cluster vs exact ≤
ε(θ)` test (V6).

---

## 4. Speed — the big opportunities

Current grid path: `snapshotGrid`/`evaluateGrid` (`solver.ts:606,880`) loop
rows × cols × effectiveSources and make **one JS→WASM call per cell·source**,
**single-threaded on the main thread**. For a 200×200 grid × 30 sources that's
1.2 M WASM calls on the UI thread.

### S1 — (BIG) No threading. Move the grid off the main thread / onto workers
The README's "Main + Orchestrator + N Compute Workers + SharedArrayBuffer" is
**not built** — there are no worker files; `wasm-pack` builds `--target web`
(main-thread). Today a grid run **freezes the UI** and uses **one core**.
Biggest single win: run the grid in Web Worker(s). Even one worker restores
responsiveness; N workers over a tiled grid give near-linear scaling. (Needs
COOP/COEP headers for SharedArrayBuffer — already noted as a hosting
requirement.)

### S2 — (BIG) Batch the WASM boundary
Each call marshals the LW array in and allocates a fresh `Vec<f64>` out
(`lib.rs:92` etc.) — ~1.2 M allocations + boundary crossings per grid. Add a
**batched Rust entry point** that takes the whole source set + the grid (or a
row/tile) and loops internally, writing results into one pre-allocated buffer
in WASM linear memory that JS reads back via a view. This removes the
per-cell crossing and per-call allocation — likely the largest constant-factor
win, and it composes with S1 (one transfer per tile per worker).

### S3 — (BIG, for static maps) Don't compute gradients for the whole grid
`snapshotGrid` stores a full `Dual<3>` pack (n primal + 3n grad) for **every
cell·source** — `cellCount × sources × 4n × 4 B` (e.g. 200²×30×40×4 ≈ 768 MB,
and the dual arithmetic is ~3–4× the primal cost). Gradients are only useful
for sources the user might *drag*. Compute the grid **primal-only**
(`evaluateGrid`, `T=f64`, no AD) and cache gradients lazily, or only for the
selected/near source(s). ~4× less compute and a big memory drop on the common
"just show me the contours" path.

### S4 — (EASY) third-octave `SmallVec` spills to the heap
`BandSpectrum.bands: SmallVec<[T; 24]>` (`spectrum.rs:100`) but third-octave
has **31** bands → every third-octave spectrum (lw, aatm, agr, abar, out, …)
heap-allocates. Bump the inline size to `[T; 32]`. One-line fix; removes
allocation churn from the entire 31-band hot path.

### S5 — (MEDIUM) Topography sampling + allocation churn in the cell loop
For each **real** source·cell, `topographyBarriers` does 12 DEM bilinear
lookups, allocates a `Float64Array`, and `concatBarriers` allocates again
(`solver.ts:756-765`, `propagation.ts:179-196`). ~14 M DEM lookups + ~2.4 M
allocations per grid pass. Precompute per-source terrain/ridge profiles (the
DEM doesn't change during a grid run), reuse scratch buffers, and skip the
realloc when there are no protrusions.

### S6 — (MEDIUM) Rust per-call scratch allocations
`project_walls`, `upper_hull_select`, `path_lengths` each allocate `Vec`s per
evaluation (`barrier/path.rs`). Under a batched entry point (S2) these become
reusable thread-local scratch buffers. Also hoist `c3` out of the per-band
loop in `abar_spectrum` (it's band-independent — `diffraction.rs:56` recomputes
it per band).

### S7 — (MEDIUM) SIMD is claimed but not enabled
No `target-feature=+simd128` anywhere (`Cargo.toml` has no `.cargo/config`,
build is plain `wasm-pack build`). The `docs` "2-wide f64 lanes / 1.5× from
SIMD" is unrealised. Either enable `+simd128` and shape the band loop / pack
two `Dual` lanes for autovectorisation, or drop the claim. Modest
(~1.3–1.5×) and below S1–S3 in priority.

### S8 — (SMALL) Re-enable `wasm-opt`
Disabled for an old CI binaryen (`Cargo.toml:46`). A modern binaryen (116+)
gives a few % size/speed. Low priority.

### S9 — (PERCEPTUAL) Coarse-then-refine grid
Compute a coarse grid first, bilinear-upsample for immediate display, refine
on idle. Cheap responsiveness win independent of S1–S3.

Rough priority: **S1 + S2 + S3** (architecture: threads, batching, primal-only
grid) dominate; **S4** is a free quick win; **S5–S6** remove allocation churn;
**S7–S9** are polish.

---

## 5. Other notes

- **Taylor extrapolation is source-position-only.** Moving a source updates Lp
  via cached ∂Lp/∂src (`solver.ts:277`), but barriers/topography were baked at
  the *snapshot* position, so dragging a source across a ridge won't change
  screening until the debounced re-snapshot. Wind speed and G changes need a
  full recompute. All reasonable, but worth stating as known limits.
- **"Exact recompute streaming behind it"** (README) is really a debounced
  one-shot re-snapshot, not streaming. Fine — just align the docs.
- **NaN/Inf hygiene** on the JS side is good (`solver.ts:379,402`). The Rust
  side can still produce `-inf`/`NaN` gradients for a cell exactly on a source
  (d=0 → `log10(0)`, `0.5/sqrt(0)`); rare, and filtered downstream, but a
  guard at d→0 would be tidy.
- **`band_system_for` panics** on any band count ≠ 10/31 (`lib.rs:42`). A
  malformed import reaching WASM aborts the module rather than erroring
  gracefully.

---

## 6. Top 5, in order

1. **A1** — fix the z-datum: pass absolute z (geometry) *and* HAG (ground)
   separately; express barrier tops as base-elevation + height. Without this,
   terrain screening is wrong wherever the DEM matters.
2. **S1 + S2** — workers + a batched WASM entry point. Stops the main-thread
   freeze and removes ~1 M boundary crossings/allocs per grid.
3. **A3/A4** — wire the Annex D concave criterion and give clustered turbines
   WTG physics (or don't cluster WTGs), so grid maps match point results.
4. **S3 + S4** — primal-only grid by default + `SmallVec<[T;32]>`: large
   compute/memory drop and a free third-octave fix.
5. **V1–V2 / docs** — add elevated-terrain and topography-barrier validation
   cases (start: `case-07`), and reconcile the 8/24 vs 10/31 band docs.
