# `beesty-solver`

Rust crate implementing ISO 9613-2:2024 outdoor noise propagation with forward-mode automatic differentiation, targeting WebAssembly.

## Status

**v0.4** — full ISO 9613-2:2024 chain except reflections and lateral diffraction:
- `Adiv` (7.1)
- `Aatm` (7.2)
- `Agr` General method (7.3.1)
- `Abar` over-top, single + multi edge (7.4.1)
- Annex D wind-turbine specifics (D.2 omnidirectional, D.3 elevated source + cap, D.4 G ≤ 0.5 + 4 m receiver, D.5 concave correction)

All 6 validation cases pass. **49 tests total** (22 unit + 27 case integration). WASM build via `wasm-pack` produces a 14 KB module the web app loads on the main thread.

Next:
- v0.5: Lateral diffraction (7.4.3) and Eq 25 combination
- v0.6: Reflections (image-source method, engine-only — no UI hook in v1)
- v0.7: Worker integration for adaptive contour grids

## Build

```bash
# Install Rust if needed
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Native build + tests
cd solver
cargo test

# WebAssembly build (requires wasm-pack)
cargo install wasm-pack
wasm-pack build --target web --release
```

The WASM build emits `pkg/` containing the `.wasm` module and TypeScript bindings, ready for the React app to import.

## Tests

```bash
cargo test                   # all tests
cargo test --test case_01_divergence   # validation case 01 only
```

Each validation case in `validation/*.md` has a corresponding `tests/case_*.rs` file. The tolerance policy is documented in `validation/README.md`.

## Crate layout

```
src/
  lib.rs           public API + WASM bindings (cfg-gated)
  units.rs         coordinate types (UTM Vec3)
  dual.rs          Dual<N> forward-mode AD scalar + ADScalar trait
  spectrum.rs      BandSystem (Octave / OneThirdOctave) + BandSpectrum
  iso9613/
    mod.rs         top-level evaluators
    divergence.rs  7.1 Eq 8
    atmosphere.rs  7.2 Eq 9 + αatm lookup
    ground/
      mod.rs       7.3 dispatcher
      functions.rs Table 3 shape functions a', b', c', d'
      general.rs   7.3.1 General method (AS, AR, Am, Eqs 10-13)
    barrier/
      mod.rs       7.4 dispatcher (over-top), Eqs 16/17
      diffraction.rs Dz Eq 18, zmin Eq 19, C3 Eq 20, Kmet Eq 21, caps
      path.rs      Wall projection, upper-hull selection, Δz Eq 22
    annex_d.rs     Annex D wind turbine rules
tests/
  case_01_divergence.rs
  case_02_ground.rs
  case_03_single_barrier.rs
  case_04_multi_edge_barrier.rs
  case_05_annex_d_wtg_flat.rs
  case_06_annex_d_wtg_concave.rs
```

## Key design choice: ADScalar trait

Every kernel is generic over `T: ADScalar`. `f64` and `Dual<N>` both implement
the trait. This means the same code runs:

- with `T = f64` for full-grid recompute (no AD overhead)
- with `T = Dual<3>` for source-position drag (3 inputs: e, n, z)
- with `T = Dual<n>` for any other interaction shape

No code duplication, no runtime branching on AD vs non-AD.

## Design references

- `docs/architecture.md` — overall system
- `docs/solver-design.md` — formula-by-formula mapping to modules
- `docs/auto-diff-strategy.md` — forward-mode rationale, drag lifecycle
- `validation/` — hand-calculated reference cases
