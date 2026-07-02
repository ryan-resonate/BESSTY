# `iso9613-solver` — standalone solver: design & implementation plan

Status: **proposed** (awaiting sign‑off on the architecture in §3). Branch:
`feature/iso9613-solver-standalone`.

This plan turns the BESSTY‑embedded 2024‑only solver into a standalone, multi‑standard,
buildings‑capable outdoor sound‑propagation engine that any Resonate web app (and future internal
tooling) can consume. It is closed‑source and internal to Resonate.

Companion doc: [`iso9613-2-1996-vs-2024-differences.md`](./iso9613-2-1996-vs-2024-differences.md) —
the authoritative list of what the edition switch changes.

---

## 1. Goals & non‑negotiables (from the design conversation)

1. **Standalone, reusable artifact.** Consumed by multiple Resonate web apps via a **git‑dependency**
   package (not a submodule). Extractable to its own repo later with history.
2. **Multi‑standard by construction.** Ships ISO 9613‑2 **:1996** and **:2024**, selectable
   whole‑standard. Architecture must accommodate CONCAWE / CoRTN / others **without any of their code
   or references in the core** — traits/seams only.
3. **Strict conformance.** The 1996 mode is **implemented to ISO/TR 17534‑3:2015 §5** — its QA
   "additional recommendations" that pin down the ambiguous corners of the 1996 text — and
   **validated against its §6 test cases** (hard pre‑deploy gate). Own independent case suite first,
   TR §6 second (no overfitting). See
   [`iso9613-2-17534-3-implementation-notes.md`](./iso9613-2-17534-3-implementation-notes.md).
4. **General physics, exact to the standard.** Reflections, houses (`Ahous`), industrial (`Asite`),
   foliage (`Afol`), directivity — all present; **no transmission** (opaque screens only). Neutral
   defaults: directivity off, `Ahous/Asite/Afol = 0`.
5. **Point, line & area sources** via the standard's point‑source substitution (§4).
6. **Buildings in any form:** 2D area + height, 2D walls, and full 3D objects. 2.5D by default; true
   3D where an object is specified in 3D. Speed‑first: a fast 2.5D path‑finder and a separate 3D one.
7. **Speed is paramount; memory‑careful on large grids.** Multithreaded from day 0. Configurable
   concurrency budget (100 % CPU for batch, throttled for responsive apps).
8. **Near‑instant interactive feedback** (move a point → update) without autodiff — via a warm,
   stateful session with incremental recompute.
9. **Cartesian metres only** in the core; geodetic/parsing lives in adapter layers.
10. **Rust core → WASM/npm + native**, **Python bindings** later, **no C ABI**.
11. Autodiff **removed** for now (re‑introducible later behind a seam if a need returns).

---

## 2. Guiding principles

- **Separate geometry from physics.** A *path engine* turns a scene into propagation *paths*; a
  *standard evaluator* scores a path. This is what makes 1996/2024/CONCAWE interchangeable and what
  keeps buildings/reflections orthogonal to the standard.
- **Pure kernels.** Every physics function is a pure `f64` function of its inputs — no shared mutable
  state — so parallelism is a thin driver, not a rewrite. (Dropping AD makes this clean.)
- **Typed scene in, typed results out**, with a stateful fast path underneath for interactivity.
- **One behaviour, cheapest correct strategy.** 2.5D closed‑form where valid; 3D search only when an
  object demands it. Hidden behind the path abstraction.
- **Edition differences are data, not forks.** Terms are parameterised by an `EditionParams` where
  possible (see the differences doc), so 1996 and 2024 share the same kernels wherever the standard
  does.

---

## 3. Target architecture  ← **sign‑off requested**

### 3.1 Workspace layout (in place under `solver/`, extractable later)

```
solver/                          # workspace root == future standalone repo
  Cargo.toml                     # [workspace] members = ["crates/*"]
  rust-toolchain.toml
  .gitignore                     # /target, /pkg, node_modules …  (target/ no longer tracked)
  crates/
    iso9613-core/                # pure Rust physics — no wasm, no JS, f64 only
      src/
        scene/                   # Scene, Source, Receiver, Obstacle{Wall,Building,Solid3D},
                                 #   Ground(+regions), Atmosphere, Standard, Settings   (+ serde)
        geometry/                # Cartesian types, SR-plane projection, PathFinder strategies
        paths/                   # PropagationPath: ground segments, diffraction edges, reflections
        standards/               # StandardModel trait; iso1996/, iso2024/; shared term kernels
          terms/                 # divergence, atmosphere, ground, barrier, reflection, misc
        spectrum/                # band systems, IEC weighting, ISO 9613-1 absorption
        session/                 # warm state + incremental update
        solve/                   # orchestrator + ParallelBackend seam
      tests/
    iso9613-wasm/                # wasm-bindgen → private npm package (Scene JSON in, Results out)
    iso9613-py/                  # PyO3 bindings (Phase 7)
  validation/
    cases/                       # our own hand-calc cases (dev gate)
    tr17534-3/                   # conformance harness + expected values (private, closed-source)
  docs/                          # differences doc, methodology/conformance, dev guide
  benches/
```

BESSTY's `web/` consumes `iso9613-wasm` as a **git dependency** (path dependency during Phase 0–1,
switched to a pinned git ref once stable).

### 3.2 The five layers

1. **Scene model** — typed, `serde`‑serializable, Cartesian metres, edition‑tagged. The public "what
   to compute." Extensible by adding fields, never positional args.
2. **Geometry / path engine** — `Scene → Vec<PropagationPath>` per (source, receiver). A
   `PropagationPath` carries: ground segments (with per‑region `G`), the over‑top diffraction edge
   sequence, lateral edges, and reflection points. `PathFinder` is a strategy:
   - `Planar25D` — closed‑form vertical‑plane rubber‑band + lateral, for extruded footprints/walls
     (the common, fast case; what 17534‑3 needs).
   - `Search3D` — general 3D shortest‑diffracted‑path search, only for objects flagged 3D.
   Path‑finding is **edition‑independent**: per 17534‑3 §5.2 both editions use the same vertical‑plane
   rubber‑band + two‑lateral construction (the raw‑1996 `a`‑term formula survives only as 2024's
   optional §7.4.2 "alternative method", exposed as a setting if ever needed — see differences §8.3
   and implementation‑notes §5.2, incl. the best‑left/right selection and factor‑8 rules).
3. **Standard evaluators** — `trait StandardModel { fn attenuate(path, bands, atm, settings) -> BandSpectrum; }`
   with `Iso1996` and `Iso2024`. They call **shared term kernels** parameterised by edition (e.g.
   `ground::agr(sum, kgeo, edition)`), so the switch is localised exactly to the differences doc's
   deltas. CONCAWE/CoRTN would be new `StandardModel` impls over the same paths — **not built now**,
   but the trait reserves the seam.
4. **Session** — built once from a `Scene`; holds geometry/paths resident; exposes cheap edits
   (`move_source`, `move_receiver`, `set_level`, `set_standard`) that recompute only affected
   contributions; produces `receiver_levels()` and `grid(...)`. This is the interactivity engine.
5. **Parallel driver** — `trait ParallelBackend { fn map_reduce(...) }`: `rayon` natively, a
   **Web‑Worker pool** in wasm (grid partitioned across N workers, transferable buffers, no
   `SharedArrayBuffer` → no COOP/COEP tax). A **concurrency budget** (int or fraction of
   `hardwareConcurrency`) sets pool/threadpool size. `SharedArrayBuffer` threads remain a later opt‑in
   behind the same seam.

### 3.3 Public API (shape, not final)

**Setup (typed Scene):**
```rust
let scene = Scene {
    standard: Standard::Iso1996,
    atmosphere: Atmosphere { temp_c: 10.0, rh_pct: 70.0, pres_kpa: 101.325 },
    ground: Ground { default_g: 0.5, regions: vec![] },
    terrain: None,   // Option<Terrain>: contour polylines / TIN / raster heightfield
    sources:   vec![Source { id, kind, position, height, spectrum, directivity: None }, ..],
    receivers: vec![Receiver { id, position, height }, ..],
    obstacles: vec![Obstacle::Building(Building { footprint, base_z, height, reflective, .. }), ..],
    settings:  Settings { reflection_order: 1, band_system: Octave, concurrency: Budget::Fraction(0.5), .. },
};
let results = solve(&scene);            // one-shot
```

**Interactive (stateful Session):**
```rust
let mut session = Session::from_scene(scene);   // precompute geometry once
session.move_source("wtg_03", x, y);            // cheap: only that source's paths
let levels = session.receiver_levels();          // updated
let grid   = session.grid(spacing_m, rx_height); // parallel, tiled
```

**WASM (TS):** the same, `Scene` as a JSON‑ish object; `Session` is a wasm class. Grid returns a
transferable `Float32Array`.

### 3.4 Buildings & geometry model

- **Primitives** (scene `Obstacle`):
  - `Wall` — thin polyline screen (`base_z` per vertex + height); today's `WallBarrier` generalised.
  - `Building` — **closed footprint polygon + base elevation + height**; optional per‑vertex eave
    heights and a ridge for pitched roofs; `reflective` flag + optional per‑façade `α`.
  - `Solid3D` — arbitrary 3D object (facet set / extrudable prism) for genuinely 3D cases.
- **Decomposition** (path engine): a building yields (a) top/eave diffraction edges + vertical end
  edges for screening, and (b) reflecting façade facets for image sources. `Planar25D` handles
  `Wall` and extruded `Building`; `Search3D` handles `Solid3D` and pitched‑roof `Building` when 3D
  fidelity is requested.
- **Terrain is a first‑class scene input** (`Option<Terrain>`): accepted as contour polylines, a TIN,
  or a raster heightfield (17534‑3 cases T06/T10/T14/T19 define ground by **contour lines**, so the
  conformance harness needs at least contours). The core derives from it: ground profiles along each
  path, `hS`/`hR` above local ground, mean height `hm` (simplified method + Annex D.5), and
  terrain‑screening edges (a relevant contour/ridge is treated like a barrier top edge; per 17534‑3
  §5.8 terrain edges suppress lateral diffraction). Today BEESTY does this in JS (`gridCore.ts` ridge
  sampling) — it **moves into the core** so conformance and reuse are owned by the solver.
- **No transmission** — screens are opaque per the standard.
- **Format adapters are separate** (not in core): a `geo-import` layer parses GeoJSON/Shapefile/etc.
  into the typed primitives. Core consumes only clean Cartesian polygons.

---

### 3.5 Edition model — adding versions without forks

Editions are **data, not control flow**. There are two seams, at different scales:

- **`StandardModel` trait** — for *different model families* (a future CONCAWE/CoRTN‑class method):
  new impl over the same `PropagationPath`s.
- **`EditionSpec`** — for *variation within the 9613‑2 family* (1996, 2024, amendments, the next
  revision). Every place the editions diverge becomes a field (a small variant‑enum or constant) in
  one `EditionSpec` struct, defined in **one file per edition**. Shared kernels take the relevant
  field; the only "branch" is a `match` on a variant enum, resolved **once** at evaluator/Session
  build time — never `if edition == …` scattered through the physics.

```rust
pub struct EditionSpec {
    pub ground:  GroundCombination,   // Sum | KgeoWrap            (differences §6)
    pub barrier: BarrierParams,       // bracket V1996|V2024, kmet V1996|V2024   (§8.1–8.2)
    pub aatm:    AatmSource,          // Table2 | Iso9613_1        (§5)
    pub refl_loss: ReflLoss,          // ReflCoeff(ρ) | Absorption(α)  (§9.2)
    pub subdivision: SubdivisionRule, // TwoHmax | RasterK(0.5)+Projection  (§2)
    // …exactly one field per divergence in the differences doc §0 table
}
pub const ISO_1996: EditionSpec = EditionSpec { ground: GroundCombination::Sum, /* … */ };
pub const ISO_2024: EditionSpec = EditionSpec { ground: GroundCombination::KgeoWrap, /* … */ };
// A future amendment = struct‑update syntax, overriding only the delta:
// pub const ISO_2027: EditionSpec = EditionSpec { barrier: …, ..ISO_2024 };
```

Rules that keep this maintainable:
- **Editions are frozen and additive.** Once validated, an edition's numbers never change (old
  projects must reproduce). A fix that would alter a frozen edition's output becomes a *new* variant,
  not an edit.
- **The differences doc is the spec**: its §0 table maps 1:1 onto `EditionSpec` fields. Adding an
  edition = a differences note + an `EditionSpec` + its validation cases.
- **User‑configurable settings are NOT edition fields.** E.g. reflection order lives in `Settings`
  (default 1) because both editions support nth order (1996 via 17534‑3 §5.9); the edition only fixes
  *semantics*, the user picks *usage*.
- Enums are `#[non_exhaustive]`; no future‑standard names appear anywhere in the core (see §6).

## 4. Parallelism, memory & performance

- **Kernels pure & `Send`/`Sync`** from Phase 0 so parallelism is drop‑in later.
- **Grid = embarrassingly parallel** → near‑linear scaling. Native `rayon`; web worker‑pool.
- **Concurrency budget** setting: `Max` (all cores), `Fraction(f)`, or `Fixed(n)`.
- **Memory discipline for large grids:** tile the grid; stream cell ranges to workers; emit `f32`
  rasters; bound per‑path caches; avoid materialising per‑(cell,source) intermediates. Watch
  per‑worker scene duplication (mitigate by cloning the immutable scene once per worker).
- **Interactivity:** Session caches per‑(source,receiver) energy; a source move updates only that
  source's contributions (subtract old / add new), grid recompute limited to the moved source and
  parallelised. Target: single‑point update < 1 ms; 200×200 grid single‑source update interactive.
- **Benches** (`benches/`) track point‑solve and grid throughput per phase; no silent perf regressions.

---

## 5. Validation & CI

**ISO/TR 17534‑3 is used two distinct ways — don't conflate them:**
- **§5 "Additional recommendations"** → *implementation requirements* for the 1996 mode (screening ray
  construction, cap over‑top only, the `zmin` two‑step, no `Abar<0` on reflecting ground, the lateral
  combination, higher‑order reflections, …). **Build to these from the start of Phase 2.** Most were
  later folded into 2024, so they become **shared** code — see
  [`iso9613-2-17534-3-implementation-notes.md`](./iso9613-2-17534-3-implementation-notes.md).
- **§6 test cases** → the *numeric oracle*: each ships step‑by‑step intermediate values + a final
  result *interval*. Assert the **intermediate terms** (`Adiv/Aatm/Agr/Dz/Abar` per band), not just
  totals, so a discrepancy localises to the offending term.
- **§7 Declaration of Conformity** → a Phase‑4 deliverable.

- **Two gates, in order** (agreed philosophy):
  1. **Own case suite** (`validation/cases/`) — hand‑calculated, edition‑specific, covers each term
     and each 1996↔2024 divergence, **plus everything the TR does not test**: extended line/area
     sources, cylindrical reflectors, `Amisc`, `Cmet`, all 2024‑specific behaviour. Expected values
     must be derived from the standard text independently of the code (the review found our existing
     barrier cases encoded a transcription error — see differences §8.1). The day‑to‑day dev gate.
  2. **ISO/TR 17534‑3:2015 §6** (`validation/tr17534-3/`) — the 1996‑mode conformance gate (T01–T19;
     T01–T07 plain 9613‑2, T08–T19 + §5 recommendations); **must pass in CI before any deploy.**
     Expected values kept private (closed‑source repo). **Pass criteria per ISO 17534‑1:2015, A.2**
     (now held): step‑by‑step values (incl. per‑band `α`, `a'…d'`, `Agr_s/m/r`, `Adiv`, `Aatm`, per‑band
     `L`, totals) are stated to **two decimal places** and are correct if the deviation
     **≤ ±0.05 dB**; final results must fall within the published lower/upper limits (one decimal
     place; where a 2‑dp result ends in x.x5, a 0.1 rounding interval applies; wider ±x dB intervals
     where the TR flags definitional freedom — explicitly incl. extended‑source partitioning).
- **2024 mode** (no official TR): validated via shared kernels + hand‑calc cases targeting the
  divergences (differences doc §13).
- **Regression:** Phase 0/1 assert BESSTY's current numbers are unchanged through the refactor.
- **CI:** build `core` + `wasm`; run unit + case tests; run 17534‑3 gate; `cargo clippy`/`fmt`; wasm
  size check; (later) bench thresholds.

---

## 6. Multi‑standard future‑proofing (design‑only now)

- `StandardModel` trait + a `#[non_exhaustive]` `Standard` enum are the seam. **No future‑standard
  names (CONCAWE, CoRTN, CNOSSOS, …) appear anywhere in the core** — not even as reserved enum
  variants or stubs (per instruction). Extensibility is structural: the non‑exhaustive enum, the
  trait, and a documented *extension recipe* in the developer docs (how to add a model: new
  `StandardModel` impl + `EditionSpec`‑style params + validation suite). This planning doc is the
  only place the future names are written down. (Design note kept here: an empirical dB(A) road
  model would reuse geometry but little of the octave‑band term math — so `PropagationPath`/`Scene`
  must not over‑fit to 9613‑2.)
- Whole‑standard selection only for now; the config is shaped to allow per‑term overrides later
  without breaking the API.

---

## 7. Phased roadmap (with gates)

Each phase ends on a green gate before the next starts. Buildings + reflections are pulled **into**
the conformance track because 17534‑3 needs them.

**Phase 0 — Standalone foundation.**
Branch; Cargo workspace under `solver/`; split `iso9613-core` + `iso9613-wasm`; **remove autodiff**
(pure `f64`); **`git rm -r --cached solver/target`** (the ignore rule already exists — the files were
committed before it); set `license` to a proprietary identifier + `publish = false` in every crate;
rename (`iso9613-solver` workspace, `iso9613-core`); introduce the typed `Scene`/`Results` model +
`serde` (+ `schema_version` field, input validation: reject NaN coords, degenerate/self‑intersecting
polygons); capture a **performance baseline** (bench point‑solve + grid) before restructuring.
**BEESTY keeps calling the existing flat WASM exports via a compat shim** re‑implemented on top of
the core — its full migration to `Scene`/`Session` happens once `Session` exists (Phase 6), so we
migrate once, not twice.
*Gate:* all existing tests green; BEESTY output byte‑identical through the shim.

**Phase 1 — Path engine + evaluator split + known‑bug fixes.**
Introduce `PropagationPath`, `PathFinder::Planar25D`, `StandardModel` trait + `EditionSpec`; refactor
existing 2024 terms into `Iso2024` over paths; add `Standard` to `Scene` (2024 wired). **Fix the
known deviations found in review** (they are behaviour changes, made deliberately here, with
recomputed expected values): (a) `Dz` bracket `3+…` → `2+…` and `zmin = −λ/(C2C3)` → `−2λ/(C2C3)`
(differences §8.1 warning box); (b) cap over‑top only, never lateral (impl‑notes §5.3); (c) lateral
paths = best‑left + best‑right only, with the factor‑8 rule (impl‑notes §5.2); (d) collapse the two
barrier/ground conventions to the single literal‑ISO combination (Eq 5 keeps `Agr`; `Abar = Dz − Agr
≥ 0` when `Agr > 0` ⇒ net `= max(Dz, Agr)`) — the current `IsoEq16` variant drops `Agr` from the
total (net `Dz − Agr`), which matches neither the standard's algebra nor the reference tools; the
current default `DzMinusMaxAgr0` is the correct behaviour and becomes the only one.
*Gate:* regression identical **except** the four documented fixes, each covered by a recomputed
hand‑calc case; BEESTY re‑validated against Tarong/SoundPLAN data after the fix.

**Phase 2 — ISO 9613‑2:1996 mode (per 17534‑3 §5) + own validation suite.**
Implement `Iso1996`, incorporating the **17534‑3 §5 recommendations** (implementation‑notes doc) —
which align 1996 with 2024 on ray construction, lateral rules, caps, the barrier‑vs‑ground convention
and higher‑order reflections (→ these become **shared** code, not an edition fork). The genuinely
edition‑switched terms then reduce to a short list: `Agr` sum vs `Kgeo`; `Dz` bracket `3+…·Kmet` vs
`1+(2+…)·Kmet`; `Kmet` `2z` vs `2(z−zmin)` (+ multi‑edge numerator); `Aatm` coefficient source. Implement the
**§7.3.2 simplified ground method** (shared across editions; `ground_method` setting, default
General; Eq 15 `D` source term; `Agr ≥ 0` clamp; flat‑ground `hm` now, terrain‑profile `hm` in
Phase 3). Build `validation/cases/` (divergence, ground both editions + simplified, barrier
single/multi, `Cmet`), asserting intermediate terms.
*Gate:* our 1996 cases pass; 1996↔2024 deltas match hand calcs.

**Phase 3 — Terrain, buildings, reflections, per‑region ground, line/area sources.**
`Terrain` model in core (contours + TIN/raster; ground profiles, `hm`, terrain screening edges, §5.8
lateral suppression); building primitives (`Wall`/`Building`/`Solid3D`); silhouette diffraction
over‑top + two‑lateral (Eq 25 + factor‑8); image‑source reflections (`α`, default 0.1; order cap in
`Settings`, default 1, nth‑order machinery per TR §5.9); `Search3D` for flagged‑3D objects;
per‑region `G` (Eq 10 averaging over polygon regions, with a spatial index); extended‑source
substitution (line/area — edition‑switched rule, `EditionSpec.subdivision`; ⚠ open design item for
grids, §8); `Amisc` (`Afol/Asite/Ahous`) machinery (default 0). Cylindrical `Acurv` is NOT needed
here (no TR case) — it lands in Phase 5 as a 2024 feature.
*Gate:* our building/reflection/terrain/extended‑source cases pass.

**Phase 4 — ISO/TR 17534‑3 §6 conformance (acceptance gate).**
Encode the §6 test cases with their **step‑by‑step intermediate values and final result intervals**
(private); assert intermediates to localise discrepancies; resolve; wire the TR gate into CI as the
pre‑deploy requirement; produce the §7 **Declaration of Conformity**.
*Gate:* all §6 cases within their published intervals.

**Phase 5 — 2024 parity + cross‑checks.**
2024‑only features (cylindrical `Acurv` Eq 30; detailed forestal `Afol`; Annex B chimney directivity;
Annex C `C0`; Annex D wind‑turbines — D already largely built; higher‑order reflection *machinery*
already exists from Phase 3, 2024 just documents it normatively); hand‑calc 2024‑divergence cases
(`Kgeo`, `Dz` bracket, `Kmet`, subdivision rule).
*Gate:* 2024 cases pass; BESSTY (2024) unchanged or intentionally improved with sign‑off.

**Phase 6 — Parallelism, Session & performance.**
`ParallelBackend` seam; `rayon` native; wasm worker‑pool with concurrency budget; **worker snapshot
protocol** (Session lives on the main thread for instant point feedback; grid runs ship workers a
compact immutable flat‑buffer scene snapshot — scene types must stay snapshot‑friendly from Phase 0);
**deterministic reduction order** (parallel over cells; in‑cell source sum sequential → bitwise
reproducible); tiled/streamed large grids (`f32` rasters, bounded caches); Session incremental drag
path; **BEESTY migrates from the compat shim to `Scene`/`Session` here**; benches + thresholds.
*Gate:* perf targets met; parallel output identical to serial.

**Phase 7 — Packaging, Python, docs, extraction.**
Git‑dependency distribution: CI builds the wasm `pkg/` and commits it to **release tags** so apps can
`npm install git+<url>#<tag>` without a Rust toolchain (npm git‑deps can't build wasm themselves);
PyO3 `iso9613-py`; methodology/conformance + developer docs incl. the **extension recipe** for future
standards (no named stubs in code, per §6); optional `git subtree split` to its own repo —
**excluding `Standards/`** (single‑user‑licensed PDFs; see §8).
*Gate:* a second app can consume it; docs sufficient for another internal dev.

---

## 8. Risks, watch‑items & open decisions

**Resolved decisions (2026‑07‑02):**
- **Simplified ground method §7.3.2 is IN SCOPE** — required for T05/T07 → unqualified DOC. It is
  identical in both editions (no `EditionSpec` field): a `ground_method` setting (default `General`).
  When active, `Dc` gains the Eq 15 `D = 10·lg(1 + Kgeo)` source term and `Agr` clamps at ≥ 0. The
  formula lands in Phase 2 (flat‑ground `hm`); `hm` from terrain profiles (Figure 5 area method)
  arrives with the Phase‑3 terrain module (T07 needs it; the `hm` machinery is shared with Annex D.5).
- **Licensed PDFs stay out of git.** `Standards/` was never tracked (verified) and is now
  `.gitignore`d so it can't be committed accidentally. Canonical copies for all Resonate staff:
  **`T:\Literature\Standards\ISO`**. Never carry PDFs into the extracted solver repo. (The old
  root‑level 2024 PDF exists in git history; acceptable for an internal repo — exclude via the
  Phase‑7 extraction filter.)
- **ISO 17534‑1:2015 obtained** — pass criteria extracted into §5 (±0.05 dB on 2‑dp step values;
  1‑dp final intervals).
- **Extended‑source subdivision: adaptive, criterion‑guaranteed.** The *criterion* IS normative and
  receiver‑dependent (2024 §4: sections "shall" be representative, operationalised as extent ≤
  k × distance with k = 0.5 "well proven", plus fully‑screened‑or‑unscreened uniformity via the
  projection method; 1996 §4: "shall be divided" unless `d ≥ 2·Hmax` with equal strength/height and
  same propagation conditions). The *algorithm* is not prescribed — and ISO 17534‑1 A.2 explicitly
  anticipates implementation‑dependent partitioning by widening acceptance intervals. Design: per
  extended source, precompute a subdivision hierarchy (segment tree for lines / quadtree for areas);
  per receiver or grid cell, descend until the edition's distance criterion AND screening uniformity
  hold; cache cut selections per grid tile (neighbouring cells reuse them). This guarantees the
  normative criterion everywhere while refining only where needed (near sources, near shadow
  boundaries) — "sufficient refinement but not too much".

**Watch‑items:**
- **3D path‑finder cost** — `Search3D` must stay off the hot path for ordinary scenes; keep it behind
  the object‑3D flag and benchmark early.
- **Worker‑pool memory** at extreme urban scale — monitor per‑worker scene duplication;
  `SharedArrayBuffer` is the escape hatch if needed.
- **Reflection cost on grids** — image‑source search per (cell × façade × source) explodes in urban
  scenes; needs reflector culling (BVH / max‑reflection‑distance in `Settings`) from the start of
  Phase 3.
- **Absorption model parity** — `Aatm` source (Table 2 vs ISO 9613‑1) is adjudicated by the TR
  step‑by‑step values (T01 gives T = 20 °C, RH = 70 % — a Table‑2 column); keep both options possible.
- **Out‑of‑standard bands** — BEESTY runs 16 Hz–8 kHz octave (10 bands) and 31‑band third‑octave;
  the standard defines 63 Hz–8 kHz. Document the extension policy for sub‑63 Hz/third‑octave
  coefficients (Table 3 mapping, A‑weighting, α) — implementation extension, clearly marked
  non‑normative.
- **API churn during Phase 0–2** — BEESTY stays on the compat shim until `Session` lands (Phase 6),
  then migrates once and pins a tag.

---

## 9. Immediate next actions (Phase 0, on the branch)

1. Untrack `solver/target` (`git rm -r --cached`; the ignore rule already exists).
2. Stand up the Cargo workspace and move current sources into `iso9613-core`; carve wasm bindings into
   `iso9613-wasm`; set proprietary `license` + `publish = false`; capture the perf baseline.
3. Strip the `ADScalar`/`Dual` genericity → `f64`.
4. Define the `Scene`/`Results` types + `serde` (+ `schema_version`, input validation); wrap the
   current 2024 evaluators behind them.
5. Keep BESSTY on the flat‑export **compat shim** (now backed by the core); assert byte‑identical
   output. (Full BESSTY migration to `Scene`/`Session` happens in Phase 6.)

Awaiting your sign‑off on §3 (architecture) before starting Phase 0.
