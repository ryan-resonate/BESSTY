# BEESTY solver — fix plan (from 2026-06 review)

Companion to `docs/solver-review-2026-06.md`. Tracks the agreed fixes, their
phasing, and per-phase acceptance criteria.

## Decisions locked
- **A4 — never cluster WTGs.** The Barnes-Hut tree clusters **general
  (BESS/aux) sources only**. Every turbine is always evaluated exactly through
  the Annex D path (and keeps its drag gradients). This also removes the
  mixed-height cluster bug for free (clusters are now homogeneous general
  sources).
- **Phase 1 is one "Engine API v2" refactor** (A1 + A2 + S2 + S3 together) so
  the WASM signatures are redesigned once, not three times.
- **A6** (single project-wide G) is deliberate — no change.
- **S9** is contingent: only build it if the grid still feels slow after
  Phase 2.

---

## Phase 0 — quick wins (independent, low risk)
- **A7** — A-weighting at 16 Hz `-56.4` → `-56.7` in `solver/src/spectrum.rs:19`
  and `web/src/lib/solver.ts:98`.
- **S4** — `BandSpectrum.bands: SmallVec<[T; 24]>` → `[T; 32]`
  (`solver/src/spectrum.rs:100`) so 31-band third-octave stays inline.
- **S8** — re-enable `wasm-opt` with a modern binaryen (≥116); drop the
  override in `solver/Cargo.toml:46` once CI's toolchain is pinned.
- **A5** — diffraction guard hygiene in `solver/src/iso9613/barrier/diffraction.rs`:
  make `k_met` consistent with the `z > zmin` domain (compute Kmet whenever
  `delta_z > z_min` rather than short-circuiting at `delta_z <= 0`), so the
  value is continuous through `z = zmin`. No integrated-path behaviour change
  expected; locks out the latent discontinuity and the AD-gradient step.

**Acceptance:** all existing tests still pass; third-octave spectra no longer
heap-allocate (spot-check with an allocation counter or by inspection); a new
`case-08` zmin/cap continuity test (see Validation) passes.

---

## Phase 1 — Engine API v2 (A1 + A2 + S2 + S3)
The foundational refactor. Redesign the WASM boundary once.

### 1a. z-datum split (A1, A2)
- Source/receiver carry **both** absolute z (geometry) and HAG (ground):
  e.g. `src_z_abs, src_hagl, rx_z_abs, rx_hagl`.
- Kernels: `divergence`, `atmosphere`, `barrier` use the **absolute** Vec3;
  `ground::agr_spectrum` uses the **HAG** heights for `h_s`/`h_r` (dp unchanged).
- Barrier tops are **absolute**. Web `packBarriers` adds DEM ground elevation
  at the barrier location to the user's barrier height
  (`web/src/lib/solver.ts:131-142`); topography barriers already emit absolute
  `groundZ` and become correct once source/rx are absolute.
- AD: gradient tracks source horizontal position; HAG stays constant during a
  horizontal drag; the terrain-driven `z_abs` change is picked up by the
  background re-snapshot (DEM is sampled JS-side, non-differentiable).

### 1b. Batched entry point (S2)
- New WASM export that takes the source set + grid (or a row/tile) + per-pair
  barrier sets and loops cells×sources **inside Rust**, writing results into a
  single preallocated buffer in WASM linear memory (JS reads back via a view).
- Removes ~1.2M JS↔WASM crossings and ~1.2M return-`Vec` allocations per grid.

### 1c. Primal-only grid + lazy AD (S3)
- The displayed grid is computed **primal-only** (`T=f64`, no gradient pack):
  ~3–4× faster, 4× less memory.
- On drag-start, build a gradient grid for the **single dragged source** only;
  Taylor-extrapolate that source's contribution while the rest stay frozen at
  their primal values; re-snapshot primal-only on drag-end.

**Acceptance:**
- `case-07` (elevated-terrain barrier) now reproduces `case-03` to the dB at
  0 m, 100 m and 500 m AMSL plateau.
- New differing-ground-elevation case (A2) matches the absolute-frame slant
  distance.
- Grid result is bit-for-bit (within f32) identical between the old per-call
  path and the new batched path on a fixed scenario (regression guard).
- Drag still updates within one frame; drift caps still trigger re-snapshot.

---

## Phase 2 — Threading + terrain precompute (S1 + S5)
- **S1** — move the grid pass into Web Worker(s) driving the batched entry
  point; tile the grid across workers. Requires COOP/COEP headers (already a
  noted hosting requirement) if using SharedArrayBuffer; otherwise transfer
  buffers. Restores UI responsiveness + core scaling.
- **S5** — once calc area + grid resolution + DEM + source positions are known,
  a worker **precomputes and caches** the per-(source, cell) DEM ridge sets
  (and optionally the primal grid). Cache survives wind-speed/G/atmosphere
  changes (geometry unchanged); a source move invalidates only that source's
  entries and recomputes in the background.

**Acceptance:** main thread stays responsive during a full grid compute;
"Run grid" after a precompute returns near-instantly; ridge cache hit on a
wind-speed change (no DEM re-sampling).

---

## Phase 3 — Annex D correctness (A3 + A4)
- **A3** — compute mean propagation-path height `hm` from the DEM along each
  source→receiver path; evaluate the D.5 criterion `hm ≥ 1.5·(hS+hR)/2` and
  pass the real `apply_concave` flag (currently hard-coded `false` at
  `web/src/lib/solver.ts:242,770,979`).
- **A4** — build the Barnes-Hut tree from **general sources only**
  (`web/src/lib/sourceTree.ts`); WTGs always pass through as real
  `EffectiveSource`s (full Annex D, gradients). General clusters keep using
  `evaluate_general_*`, which is correct for them.

**Acceptance:** a real-DEM concave case (V5) triggers the −3 dB term; a
WTG-behind-a-ridge grid cell shows the 3 dB Annex D cap, not 20/25 dB; a
cluster-vs-exact property test bounds general-source clustering error vs θ.

---

## Phase 4 — micro-perf (S6 + S7)
- **S6** — reusable scratch buffers inside the batched loop (the per-call
  `Vec`s in `barrier/path.rs`); hoist band-independent `c3` out of the
  per-band loop in `abar_spectrum`.
- **S7** — enable `target-feature=+simd128` (via `.cargo/config.toml` or
  `RUSTFLAGS`); shape the band loop for autovectorisation. Verify a real
  speedup before keeping it.

**Acceptance:** measurable grid throughput gain; no result change.

---

## Phase 5 — validation expansion (+ optional S9)
Add cases for every known gap and sweep for more. Each gets a markdown spec
(`validation/case-NN-*.md`) and a Rust test (`solver/tests/case_NN_*.rs`).

Planned cases:
- **case-07** — barrier on elevated terrain (already drafted; becomes a test in
  Phase 1).
- Differing source/receiver **ground elevation** — divergence + Kgeo (A2).
- **Topography virtual-barrier** path end-to-end (V2).
- **Third-octave** numeric references (V3) + the octave-equivalence check.
- Real-DEM **concave** geometry (V5, A3).
- **grid == Σ points** property test (V6).
- **cluster vs exact ≤ ε(θ)** for general sources (V6, A4).
- **zmin / cap continuity** discontinuity case (A5) — *case-08*, lands in
  Phase 0.
- **Wind-speed interpolation** between tabulated LW points.
- **Atmosphere override** (non-reference T/RH/p) pinning the closed-form α.
- **Lateral diffraction / LOS-not-broken** behaviour.

Do a fresh gap sweep here rather than treat the list as closed.

**S9 (optional)** — coarse grid + bilinear upsample + refine-on-idle. Only if a
full grid still isn't fast enough after Phase 2.

---

## Sequencing notes
- Phase 0 can land immediately and in parallel with Phase 1 design.
- Phase 1 is the critical path; Phases 2–4 build on its API.
- Validation cases are written alongside the phase that makes them pass (so the
  suite always reflects shipped behaviour), with the full sweep in Phase 5.
