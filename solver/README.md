# `iso9613-solver`

A standalone, closed-source Rust engine implementing **ISO 9613-2** outdoor
sound propagation — both the **:1996** and **:2024** editions — validated against
**ISO/TR 17534-3:2015**. Built to be reused across Resonate's applications as a
git dependency (native Rust), a Python wheel, or a WebAssembly module.

> Proprietary — Resonate Consultants internal use only (see `LICENSE`).
> The ISO standards themselves are single-user licensed and are **never**
> committed; canonical copies live at `T:\Literature\Standards\ISO`.

## What it computes

`Lp = LW + Dc − Adiv − Aatm − Agr − Abar − Amisc`, per octave (16 Hz–8 kHz) or
one-third-octave band, energy-summed over sources and (in-band) reflections:

| Term | Clause | Status |
|---|---|---|
| `Adiv` geometric divergence | 7.1 | ✅ |
| `Aatm` atmospheric absorption | 7.2 | ✅ ISO 9613-1, evaluated at the **exact** ISO 266 centres |
| `Agr` ground — general (7.3.1) + simplified (7.3.2) | 7.3 | ✅ per-region G; terrain-aware mean height `hm = F/d` |
| `Abar` barriers — over-top (single/multi-edge) + around-the-side lateral | 7.4 | ✅ thin walls, terrain-following & sloped crests, terrain ridges |
| Buildings — footprints, clusters, concave courtyards (visibility-graph laterals) | 7.4 | ✅ |
| `Amisc` foliage / industrial / housing | Annex A | ✅ (off by default) |
| Reflections — first + **higher-order** image sources, per-band α | 7.5 | ✅ |
| Cylindrical reflections + `Acurv` | 7.5.4 | ✅ (2024) |
| Chimney-stack directivity `Dc` | Annex B | ✅ (2024) |
| Wind-turbine specifics | Annex D | ✅ |
| Long-term meteorological `Cmet` / `C0` | §8 / Annex C | ✅ |

Coordinates are Cartesian metres (`e, n, z`-absolute); heights are metres above
local ground (split z-datum). All geodetic/parsing work belongs in the caller.

## Conformance (the pre-deploy gate)

`cargo test -p iso9613-core --test conformance_tr17534` runs all 19 ISO/TR
17534-3 §6 cases at the TR's ±0.05 dB rule. **17 of 19 pass the ±0.05 gate on the
A-weighted total** — including the three-building cluster (T16/T17) and the
concave "backyard" building (T18), the multi-object cases the TR itself flags as
unsolved in general. The two receiver-above-roof cases (T12/T15) match within
ISO's ±3 dB method uncertainty. Per-test notes in that file document every
tolerance.

## Workspace layout

```
crates/
  iso9613-core/   pure-f64 physics + typed Scene/Session API   (the crate to depend on)
  iso9613-wasm/   thin WASM compat shim (existing consumers)
  iso9613-py/     PyO3 bindings — built on demand via maturin   (workspace-excluded)
```

## Consuming it

**Native Rust** — add the git dependency and use the typed API:

```toml
[dependencies]
iso9613-core = { git = "ssh://…/iso9613-solver", features = ["parallel"] }
```

```rust
use iso9613_core::scene::{Scene, solve, Session};

let results = solve(&scene)?;               // one-shot batch
let mut session = Session::new(scene)?;     // interactive: cache + re-solve
session.set_receivers(new_grid)?;
let live = session.solve();
```

**Any language / JSON seam** — `iso9613_core::scene::solve_json(scene_json) ->
Result<String, String>` is the stable string-in/string-out entry point every
binding wraps.

**Python** — `maturin build --release -m crates/iso9613-py/Cargo.toml` produces
an abi3 wheel (`import iso9613`; `solve`, `solve_parallel`, `Session`).

## Build & test

```bash
cd solver
cargo test --workspace                 # all native tests (both editions)
cargo test -p iso9613-core --features parallel   # + rayon determinism
cargo clippy --workspace --all-targets
```

The `parallel` feature adds rayon fan-out over receivers with an explicit thread
budget (`solve_par(scene, max_threads)`, `0` = all cores). It is **off by
default** so the WASM target stays single-threaded (the web app drives its own
Web-Worker pool). Every result is bit-for-bit identical across thread counts.

## Editions & extension

The edition is a data-only [`EditionSpec`] selected per `Scene.standard`; adding
a future standard is a new `StandardModel` over the same geometry engine — no
CONCAWE/CoRTN names appear in the core. The `Scene`/`Obstacle`/`SourceKind`
enums are `#[non_exhaustive]` / additively extended, never repurposed.

## Docs

- `docs/iso9613-2-1996-vs-2024-differences.md` — clause-by-clause edition diff
- `docs/iso9613-2-17534-3-implementation-notes.md` — the §5 QA recommendations
- `docs/iso9613-solver-standalone-plan.md` — the phased build plan
