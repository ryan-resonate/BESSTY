# Phase 0 / Phase 1 — execution addendum

Companion to [`iso9613-solver-standalone-plan.md`](./iso9613-solver-standalone-plan.md) (the *what
and why*). This document is the *how*: exact file map, signatures, commands, definitions of done,
and guardrails. It is written to be executable by any implementer without access to the design
conversation.

## 0. Global guardrails (apply to every phase)

1. **Never edit an expected value to make a test pass.** Expected values change only with a
   documented physics fix, recomputed **by hand from the standard text** (cite clause + formula in
   the commit message). If a test disagrees with the code and you cannot tell which is right, STOP
   and flag it.
2. **Never alter a frozen `EditionSpec`** (Phase 1+). A change to a validated edition's numbers is a
   new variant, not an edit.
3. **The TR conformance gate can never be weakened** — no tolerance widening, no case skipping.
4. **No future-standard names in code** (CONCAWE/CoRTN/CNOSSOS…) — not as enum variants, strings,
   comments, or stubs. Extension points stay anonymous (`#[non_exhaustive]`).
5. **Licensed PDFs (`Standards/`) must never be committed.** The ignore rule exists; don't bypass it.
   Canonical copies: `T:\Literature\Standards\ISO`.
6. Every commit compiles and passes `cargo test` (excluding `--ignored` benches). Commit messages:
   plain, no AI/Co-Authored-By trailers.
7. Keep `clippy` clean (`cargo clippy --all-targets -- -D warnings`) from Phase 0 onward.
8. All kernels stay **pure `f64` functions** — no globals, no interior mutability, no shared state
   (`Send + Sync` by construction). This is what makes Phase 6 parallelism a driver, not a rewrite.

## 1. Phase 0 — standalone foundation

### 1.1 Baseline capture (BEFORE any restructuring)

- Add `solver/tests/golden_phase0.rs`: evaluates a fixed set of scenarios through the public Rust
  API and compares against `solver/tests/golden_phase0.txt` (one `{:.17e}` float per line).
  Regenerate mode: `GOLDEN_WRITE=1 cargo test --test golden_phase0`. Scenarios must cover: free
  field; ground octave + third-octave; single + multi wall barriers on elevated terrain (split
  z-datum); lateral edges; WTG (concave on/off); both barrier conventions; `dz_cap` override.
- Fix `bench_grid.rs` stale signature (missing `lateral` arg) — mechanical, no behaviour change.
- Record perf baseline: `cargo test --release --test bench_grid -- --ignored --nocapture` output
  saved to `solver/benches/baseline-phase0.txt`.
- **The golden file is the byte-identical gate for the whole Phase 0 restructure.** It may not
  change again until the documented Phase 1 fixes (§2.3), which will regenerate it with a commit
  message citing the formulae.

### 1.2 Repo hygiene

- `git rm -r -q --cached solver/target` (ignore rule already present; files were committed before it).
- Stage the root-level deletions of `ISO_9613-2_2024(en).pdf` and `iso_9613-2.txt`.
- `.gitignore` gains `Standards/` (done) and `solver/crates/**/pkg/`.

### 1.3 Workspace split — file map

```
OLD                                NEW
solver/Cargo.toml                  solver/Cargo.toml                     [workspace] only
                                   solver/rust-toolchain.toml            channel = "stable"
                                   solver/LICENSE                        proprietary notice
solver/src/lib.rs                  solver/crates/iso9613-core/src/lib.rs   (wasm module REMOVED,
                                                                          dual re-exports removed)
solver/src/dual.rs                 DELETED (autodiff removal)
solver/src/units.rs                solver/crates/iso9613-core/src/units.rs
solver/src/spectrum.rs             solver/crates/iso9613-core/src/spectrum.rs
solver/src/iso9613/**              solver/crates/iso9613-core/src/iso9613/**
  (+ new)                          solver/crates/iso9613-core/src/iso9613/meteorology.rs  (cmet_db
                                     moved from the wasm layer + unit tests)
  (+ new)                          solver/crates/iso9613-core/src/scene/mod.rs  (typed Scene API)
solver/tests/*.rs                  solver/crates/iso9613-core/tests/*.rs  (imports → iso9613_core;
                                                                          Dual gradient tests deleted)
(wasm module from old lib.rs)      solver/crates/iso9613-wasm/src/lib.rs  (compat shim, same export
                                                                          names, calls core)
```

Manifests:
- Workspace: `members = ["crates/iso9613-core", "crates/iso9613-wasm"]`, `resolver = "2"`, release
  profile (opt-level 3, `lto = "fat"`, `codegen-units = 1`) at workspace level.
- `iso9613-core`: `license-file`, `publish = false`; deps `smallvec`, `serde` (derive); dev-dep
  `approx`.
- `iso9613-wasm`: `crate-type = ["cdylib"]`, `publish = false`; deps `iso9613-core` (path),
  `wasm-bindgen`; carries the `wasm-opt = false` metadata comment from the old manifest.

### 1.4 Autodiff removal recipe (mechanical)

For every kernel file: delete `use crate::dual::ADScalar`; change `fn f<T: ADScalar>(…: T)` to
`fn f(…: f64)`; replace `T::from_f64(x)`/`T::zero()`/`T::one()` with literals; `.to_f64()` deleted;
`Vec3<T>`→`Vec3` (fields `f64`), `BandSpectrum<T>`→`BandSpectrum`, `WallBarrier<T>`→`WallBarrier`,
`LateralEdge<T>`, `DiffractionEdge<T>`, `PathLengths<T>` likewise. `10^x = exp(x·ln10)` tricks may
revert to `10f64.powf(x)`. Delete: `dual.rs`; the two gradient tests (`case_01
case_01_gradient_w_r_t_source_position`, `case_02` dual test, `divergence.rs` gradient unit test);
the wasm gradient exports (`evaluate_*_with_grad_*`, `eval_cell_source_grad`, `unpack_walls_dual`,
`pack_dual_grad`). **Numerics of the primal path must not change** — same operations in the same
order; the golden file enforces this.

### 1.5 Scene API (Phase-0 scope: types + one-shot solve, 2024 only)

```rust
// crates/iso9613-core/src/scene/mod.rs  (serde Serialize/Deserialize on everything)
#[non_exhaustive] pub enum Standard { Iso9613_2_1996, Iso9613_2_2024 }
pub struct Scene { pub schema_version: u32 /* =1 */, pub standard: Standard,
    pub atmosphere: Atmosphere, pub ground: Ground, pub sources: Vec<Source>,
    pub receivers: Vec<Receiver>, pub obstacles: Vec<Obstacle>, pub settings: Settings }
pub struct Ground { pub default_g: f64 }               // regions arrive Phase 3
pub enum SourceKind { General, WindTurbine { rotor_diameter_m: f64, apply_concave: bool } }
pub struct Source { pub id: String, pub kind: SourceKind, pub position: [f64; 3] /* e,n,z_abs */,
    pub height_agl: f64, pub lw: Vec<f64> /* len 10|31 → band system */ }
pub struct Receiver { pub id: String, pub position: [f64; 3], pub height_agl: f64 }
pub enum Obstacle { Wall { polyline: Vec<[f64; 2]>, base_z: Vec<f64>, height_agl: f64 } }
pub struct Settings { pub dz_cap_db: Option<f64>, pub c0_db: f64,
    pub barrier_convention: BarrierConvention }        // convention removed in Phase 1
pub fn solve(scene: &Scene) -> Result<Results, SceneError>   // validates, then per-pair evaluate
pub struct Results { pub per_receiver: Vec<ReceiverResult> }
pub struct ReceiverResult { pub receiver_id: String, pub total_dba: f64,
    pub per_source: Vec<SourceContribution> }
pub struct SourceContribution { pub source_id: String, pub bands: Vec<f64> }
```
Validation errors (non-finite coords, empty/degenerate walls, bad `lw` length, `Iso9613_2_1996` →
`SceneError::StandardNotImplemented`) are typed; `solve` never panics on user input. Wall obstacles
decompose into per-segment `WallBarrier`s + end `LateralEdge`s inside the core (ends of the whole
polyline only).

### 1.6 wasm compat shim

`iso9613-wasm/src/lib.rs` re-exports the exact current flat API (same names, same argument lists):
`evaluate_general_octave`, `evaluate_wtg_octave`, `a_weighted_total`, `octave_centres`,
`octave_a_weighting`, `GridEvaluator` (constructor + `n_sources` + `eval_cell_dba`). Bodies call
core functions. Gradient exports are dropped (web no longer imports them).

### 1.7 Web update

- `web/package.json`: `build:wasm` → `cd ../solver/crates/iso9613-wasm && wasm-pack build --target
  web --out-dir ../../../web/src/wasm`.
- Imports in `web/src/lib/{solver,gridCore,grid.worker}.ts`: `../wasm/beesty_solver.js` →
  `../wasm/iso9613_wasm.js` (plus the stale grad mention in solver.ts's header comment).
- `git rm` the old `web/src/wasm/beesty_solver*` artifacts; run `npm run build:wasm`; commit the
  regenerated `iso9613_wasm*` artifacts (BEESTY consumes committed artifacts until Phase 7 tags).

### 1.8 Phase 0 definition of done

- [ ] `cargo test` green in the workspace (all case tests unchanged, golden test passes in compare mode).
- [ ] `cargo clippy --all-targets -- -D warnings` clean.
- [ ] Golden file identical to the pre-restructure capture (byte-identical physics).
- [ ] `solver/target` untracked; licensed PDFs ignored; proprietary license + `publish = false`.
- [ ] wasm builds; `npm run lint` and `vite build` pass in `web/`; app imports the new module.
- [ ] Perf baseline recorded pre- and post-restructure (no regression beyond noise).
- [ ] No `Dual`/`ADScalar` anywhere; no gradient exports in the `.d.ts`.

## 2. Phase 1 — path engine, evaluator split, known-bug fixes

### 2.1 New abstractions (no behaviour change yet)

- `PropagationPath` (geometry output): `dp`, `d_direct`, per-path over-top edge sequence
  (`DiffractionEdge`s in the SR plane), lateral edge candidates (per side), ground descriptors
  (`h_s`, `h_r`, region Gs — single G until Phase 3).
- `trait StandardModel { fn attenuate(&self, path: &PropagationPath, lw: &BandSpectrum, atm:
  Atmosphere, settings: &Settings) -> BandSpectrum; }` with `Iso2024` as the only impl; selection
  via `Standard` → `&'static EditionSpec` + evaluator.
- `EditionSpec` per plan §3.5 — fields for: `GroundCombination` (Sum | KgeoWrap), `BarrierBracket`
  (V1996 | V2024), `KmetForm` (V1996 | V2024), `AatmSource` (Table2 | Iso9613_1),
  `SubdivisionRule` (TwoHmax | RasterK — used from Phase 3). Constants `ISO_2024` now, `ISO_1996`
  in Phase 2.

### 2.2 Refactor order

1. Extract path construction from `barrier::abar_spectrum` into the path engine (pure move).
2. Route `evaluate_with_barriers` / `evaluate_wtg` through `Iso2024::attenuate`.
3. Golden file must still match — refactor is inert.

### 2.3 The documented physics fixes (behaviour changes; golden + cases regenerated)

**Done in commit "barrier physics fixes":**

| # | Fix | Wrong (was) | Correct (2024 PDF p.16 / TR §5) |
|---|---|---|---|
| 1 | `Dz` bracket | `10·lg[1+(3+(C2/λ)C3·z)·Kmet]` | `10·lg[1+(2+(C2/λ)C3·z)·Kmet]` (Eq 18) |
| 2 | `zmin` | `−λ/(C2·C3)` | `−2λ/(C2·C3)` (Eq 19) |
| 3 | Caps | applied to every path | over-top only (TR §5.3); lateral uncapped |
| **5** | **`C3`** (found during recompute) | **`(1+(5/e)²)/(1/3+(5/e)²)`** — no `λ`, freq-independent | **`(1+(5λ/e)²)/(1/3+(5λ/e)²)`** (Eq 20) |

Plus: **deleted `BarrierConvention`** — single behaviour per the standard's algebra (Eq 5 keeps
`Agr`; `Abar = Dz − Agr ≥ 0` when `Agr > 0` and `Dz > 0`, else `Abar = Dz`; never applied with
`Agr < 0` per TR §5.5 — the old `DzMinusMaxAgr0` = the correct one). The wasm shim keeps accepting
the `barrier_convention` int and ignores it.

**Deferred to Phase 3** (needs geometry it doesn't yet carry):

| # | Item | Why deferred |
|---|---|---|
| 4 | Lateral selection: best-per-side (≤2) + factor-8 neglect (TR §5.2) | Only bites with **multiple** obstacles (buildings), which arrive in Phase 3 and bring the per-edge side/offset geometry the rule needs. For a single finite wall the two supplied end edges already ARE the best left/right paths, so the current sum is correct; and the web supplies no lateral edges yet (empty `NO_LATERAL`). The Eq-25 combination + the `≥ 0` floor (TR §5.6) and lateral-uncapping (Fix 3) are already in. |

Expected values for cases 03/04/07 were **recomputed independently** with a fresh Python
implementation of the standard (`scratchpad/oracle.py`, not ported from the Rust); the Rust then
matched that oracle to < 0.1 dB/band (case 03: 40.93 dB(A), case 04: 36.18 dB(A)). BEESTY
re-validation against Tarong `validation/V1`/`V2` follows the wasm rebuild.

### 2.4 Phase 1 definition of done

- [ ] All terms flow through `StandardModel`/`EditionSpec`; no direct term calls from `lib.rs`.
- [ ] The four fixes in, each with a hand-calculated test citing clause + formula.
- [ ] `BarrierConvention` gone from core; shim arg ignored.
- [ ] Golden file regenerated once, in the fixes commit, values hand-justified.
- [ ] Tarong V1/V2 cross-check rerun; deltas reported and signed off.
- [ ] Perf within baseline noise.

## 3. Command reference

```bash
cd solver
cargo test                                             # all native tests
GOLDEN_WRITE=1 cargo test --test golden_phase0         # regenerate goldens (documented commits only)
cargo test --release --test bench_grid -- --ignored --nocapture   # perf baseline
cargo clippy --all-targets -- -D warnings
cd ../web && npm run build:wasm && npm run lint && npm run build  # wasm + typecheck + bundle
```
