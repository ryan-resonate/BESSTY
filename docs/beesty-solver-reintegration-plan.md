# BEESTY ⇄ standalone solver reintegration plan (2026-07-18)

Implementation plan for migrating the BEESTY web app off the old flat WASM shim
onto the reviewed standalone `iso9613-core` engine (Scene/Session API). Written
for an implementing Opus session; all product decisions below are **locked with
Ryan** — do not re-litigate them, ask only if something is genuinely
contradictory or unimplementable as specified.

## Locked decisions (from Ryan, 2026-07-18)

1. **Terrain goes native.** The web app resamples its DEM snapshot into a
   `Heightfield` and passes it in the `Scene`. The web-side synthetic
   terrain-barrier pipeline (`topographyBarriers`, prominence/spacing knobs) is
   **deleted**. One terrain path, core-quality sampling, clusters no longer skip
   terrain.
2. **Hard swap.** The flat wasm exports (`evaluate_general_octave`,
   `evaluate_wtg_octave`, `GridEvaluator`, …) are deleted, not kept behind a
   flag. Rollback = git revert.
3. **Scope of new physics exposed now:**
   - **Wall laterals ON** — the engine's around-the-end diffraction for drawn
     walls is accepted (closes BEESTY backlog #17). No suppression.
   - **1996/2024 selector** — new project setting; default `2024` (today's
     behaviour).
   - **Source containers** — a BESS/aux source can be modelled as a rectangular
     container (L×W×H box) with the point source above it. Details in Phase 5;
     the toggles are **separate for point-receiver calcs and grid/contour maps**.
   - NOT in scope: reflectors, drawable general buildings, ground regions,
     extended sources, chimney sources, Web-Worker *pool* (only if the perf gate
     fails), repo extraction.
4. **Container details:** dimensions come from **catalog products with
   per-source override**; orientation from the **BESS row heading where the
   source is in a row, else a per-source bearing** (default 0°); the acoustic
   centre is **clamped to ≥ container height + `roofOffsetM`**, where
   `roofOffsetM` is an **editable project setting, default 0.3 m**.
5. **Acceptance gate:** re-run V1+V2 validation vs SoundPLAN on the new path
   (limits in Phase 7) **plus** an automated old-vs-new per-receiver diff memo
   with every shift attributed to a named physics change. Ryan signs off on the
   memo before the swap is merged.

## Ground rules

- The solver core is DONE and reviewed — **do not change `iso9613-core` physics**.
  Core edits are allowed only if the wasm layer genuinely needs a new accessor,
  and never touching numerics. `cargo test --workspace` (156 tests) and the 19/19
  conformance gate must stay green after any solver-crate edit.
- Per-phase web gate: `npm run lint` (tsc) + `npm run build` green.
- Commit per phase, message style `web(reintegrate N): …` / `solver(wasm-v2): …`.
  No AI trailers. Never commit `web/src/wasm/*` build artifacts (gitignored) or
  anything under `Standards/`.
- Firestore schema changes are **additive with parse-tolerant defaults** — an
  old project must load unchanged (standard `2024`, containers off, old topo
  fields ignored).
- Results WILL shift (that's the point). Never "fix" a shift by fudging the web
  layer; shifts are explained in the A/B memo (Phase 7) instead.

## Current state (verified 2026-07-18)

- WASM surface consumed by the web: `evaluate_general_octave`,
  `evaluate_wtg_octave`, `GridEvaluator` (per-cell eval + per-source
  `topo_offsets`/`topo_barriers` packs + `concave_flags`), `a_weighted_total`,
  `octave_centres`, `octave_a_weighting`. Built by
  `npm run build:wasm` → wasm-pack → `web/src/wasm/` (gitignored).
- Only three files import the wasm: `web/src/lib/solver.ts`,
  `web/src/lib/gridCore.ts`, `web/src/lib/grid.worker.ts`. All UI goes through
  `solver.ts` (`evaluateProject`, `evaluateGrid`, `evaluateGridViaWorker`,
  `ensureSolverReady`, `bandCount`, `projectDOmegaDb`).
- Terrain today: `gridCore.ts::topographyBarriers` (DEM profile → hull →
  prominence filter → zero-height virtual walls, 8 m floor / 256-sample cap);
  clusters skip it. User walls: `solver.ts::packBarriers` subdivides to ≤10 m
  pieces with DEM ground bases. WTG Annex D.5: `gridCore.ts::concaveCorrectionMet`.
- Model: Sources (BESS/aux/WTG + clusters), Barriers (polyline walls with
  per-vertex `topHeightsM`), Receivers. No computed results are persisted.
- `DΩ` (reflecting-plane solid-angle term) is added **web-side** as a uniform dB
  (`projectDOmegaDb`) — the core has no DΩ concept. **Keep this as-is.**
- Old-shim quirks that die with the swap: `barrierConvention` setting (already
  ignored), `NO_LATERAL`, per-source topo packs.

---

## Phase 0 — New wasm surface (`solver/crates/iso9613-wasm`)

Rewrite the crate around the Scene API. Delete every flat export and its
supporting Rust. New surface (wasm-bindgen, `--target web`):

```text
init (default)                                  — unchanged wasm-pack loader
solve_scene(scene_json: string) -> string       — wraps iso9613_core::scene::solve_json;
                                                  Err(String) -> JsError (NO panics)
class WasmSession                               — wraps scene::Session
    new(scene_json) -> WasmSession | JsError
    set_receivers(receivers_json) -> void | JsError
    solve() -> string (Results JSON)
    free()
octave_centres(), octave_a_weighting()          — keep (tiny, used by charts)
```

Requirements:
- **No `panic!` anywhere** (this folds in deferred finding D2): every fallible
  path returns `Result<_, JsError>`; add `console_error_panic_hook` in debug
  builds only.
- Keep the crate `parallel`-feature-free (single-threaded wasm; workers provide
  parallelism).
- Gate: `npm run build:wasm` succeeds; `wasm_bg.wasm` raw size **< 500 KB**
  (serde_json comes in; current shim is 62 KB — if it balloons past 500 KB,
  investigate `wee_alloc`/opt-level=z before proceeding).
- Update `web/src/wasm/README.md` for the new surface.

## Phase 1 — Scene builder (`web/src/lib/sceneBuilder.ts`, new)

One pure module that maps a BEESTY `Project` (+ options) to a `Scene` JSON
object. No wasm calls, fully unit-testable in vitest/node. Mapping table:

| BEESTY | Scene |
|---|---|
| project origin | all positions in local metres via existing `latLngToLocalMetres` |
| band system (`octave`/`oneThirdOctave`) | LW array length 10 / 31 (unchanged catalog data) |
| BESS/aux source | `Source{kind: General, position:[e,n,z_abs], height_agl, lw}` — `z_abs = DEM ground + hagl` exactly as today (`solver.ts:262` logic), then container clamp (Phase 5) |
| WTG source | `kind: WindTurbine{rotor_diameter_m, apply_concave}`; `apply_concave` from the existing `concaveCorrectionMet` (KEEP that function web-side) |
| cluster pseudo-source | plain `General` source with the cluster's summed LW (reuse existing packing math). Clusters get **no container**; they DO now get terrain (improvement — note in memo) |
| Barrier | ONE `Obstacle::Wall{polyline, base_z[], height_agl: 0, top_z[]}`. **Densify** each polyline to ≤10 m vertex spacing first (preserves today's terrain-following fidelity), then `base_z[i] = DEM ground`, `top_z[i] = base_z[i] + topHeightsM(interp)`. The wall's two real ENDS give the lateral edges — laterals are now live |
| container (Phase 5) | `Obstacle::Building{footprint: rotated rect, base_z: DEM ground at source, height_agl: H}` |
| ground | `Ground{default_g: project g, regions: []}` |
| terrain | `Terrain::Heightfield` (Phase 2) or absent when no DEM |
| atmosphere | `{temperature_c, relative_humidity_pct, pressure_kpa}` from project |
| settings | `standard: project.settings.standard ?? '2024'` (new field, maps to `Iso9613_2_1996`/`Iso9613_2_2024`), `c0_db`, `dz_cap_db`, `ground_method: General`, `max_reflection_order: 1` |
| receivers | `[{id, position:[e,n,z_abs], height_agl}]` — point receivers or grid cells |
| DΩ | NOT in Scene — web adds `projectDOmegaDb` to results afterwards, unchanged |

Also delete-list bookkeeping: `packBarriers` (replaced by the Wall mapping),
`concatBarriers`, the flat source packing, `NO_LATERAL`.

Gate: unit tests for the builder (wall densification + top_z, WTG mapping,
cluster mapping, settings defaults for an OLD stored project).

## Phase 2 — Native terrain (`web/src/lib/terrainField.ts`, new)

Build `Terrain::Heightfield` from the existing DEM snapshot machinery:

- Bounds: union of (all sources, all receivers or grid bounds) + **500 m margin**
  (screening features just outside the hull matter).
- Spacing: `max(dem.resolutionM ?? 20, extentMax / 2048)` — native DEM
  resolution, capped at ~2048×2048 cells (worst case ~32 MB f64; typical
  projects ≪ that). No 8 m floor — the core samples the profile at raster
  resolution.
- Resample `dem.elevation(lat,lng)` over the grid (row-major, `heights[iy*nx+ix]`,
  origin/spacing in the same local-metres frame as everything else).
  Non-finite cells: fill from nearest finite neighbour (the core rejects NaN).
- **Keep the Hampel despike**, applied to the resampled grid (the
  `despikeStrength` setting survives; Terrarium blunders are real). DELETE the
  prominence + path-sample knobs (`virtualBarrierMinHeightM`, `pathSamples`)
  from `TopoSettings`, tolerating them in old stored projects.
- Runs in the worker for grids (same place the DEM snapshot already lives).

Then delete: `topographyBarriers`, `upperHull`, `simplifyByProminence`,
`despikeProfile`'s per-path use (it moves to the resample), `buildTopoPack`,
`TOPO_*` constants, and the `topo_offsets`/`topo_barriers` plumbing.

Gate: unit test — a synthetic ridge DEM produces a Heightfield whose
`profile_edges` (via a solve) screens a test path; flat DEM produces no
screening; NaN cells filled.

## Phase 3 — Receiver path (`solver.ts::evaluateProject`)

- Build ONE `Scene` with every point receiver; call `solve_scene`.
- Map `Results.per_receiver[i].per_source[j].bands` + `total_dba` back into the
  existing `ReceiverResult` shape (per-source contributions must keep working in
  the side panel), then add `projectDOmegaDb` per band/total exactly as today.
- Containers included iff `settings.containers.receiverCalc` (Phase 5).
- `ensureSolverReady` now loads the new module; `bandCount` unchanged.
- Keep the public signatures of `evaluateProject` / `ReceiverResult` STABLE so
  `SidePanel.tsx`, `exporters.ts`, `ProjectScreen.tsx` don't churn.

Gate: demo project receiver levels finite and plausible; per-source breakdown
still renders; A-weighted total = energy sum of per-source (existing invariant).

## Phase 4 — Grid path (`gridCore.ts` + `grid.worker.ts`)

- Replace `GridEvaluator` with **one `WasmSession` per grid job**: build the
  Scene once (sources, obstacles, terrain, settings — containers iff
  `settings.containers.grid`), then per tile call
  `set_receivers(tile cells)` + `solve()`. The obstacle/terrain decomposition is
  cached across tiles by the Session — this replaces the per-cell JS↔wasm calls
  with one call per tile.
- Per-cell receiver: `z_abs = DEM ground(cell) + rxHeightAboveGround`,
  `height_agl = rxHeightAboveGround` (same as today's per-cell sampling).
- Source cutoff (`cutoff_m`): the core has no cutoff — keep it web-side by
  building the per-tile Scene's source list filtered by horizontal distance to
  the tile (same behaviour, coarser granularity: per-tile not per-cell; note in
  memo if it shifts anything at map edges — it shouldn't at 60+ dB dynamic).
- Keep the worker message protocol (`GridJob`/`GridResult`) as stable as
  practical; `main-thread evaluateGrid` and `evaluateGridViaWorker` share the
  new core exactly as they share `runBatchedGrid` today.
- DΩ added per cell as today.

Gate + **perf gate**: demo project grid (pick the largest standard preview,
e.g. 128×128) wall-clock ≤ **1.5×** the old engine on the same machine. If it
fails: profile (likely per-tile Scene rebuild), reuse one Session with
`set_receivers` across ALL tiles, only then consider a worker pool (out of scope
otherwise).

## Phase 5 — Source containers (new feature)

Model (additive, parse-tolerant):
- Catalog product: optional `container?: { lengthM, widthM, heightM }` on BESS
  and aux entries (seed sensible values where known; absent = no container
  available).
- Source: optional `container?: { enabled?: boolean; lengthM?, widthM?,
  heightM?; bearingDeg? }` — overrides catalog dims; `bearingDeg` used only when
  the source is NOT in a row.
- Project settings: `containers?: { receiverCalc: boolean; grid: boolean;
  roofOffsetM: number }` — defaults `{ false, false, 0.3 }`.

Geometry (in `sceneBuilder.ts`):
- Footprint: rectangle L×W centred on the source plan position, rotated by the
  **row heading** when the source belongs to a BESS row/group (derive from the
  row axis in `bessGroups.ts`), else `bearingDeg` (default 0° = long axis
  north). Emit as `Obstacle::Building` (a box Building equals a box Solid
  bit-for-bit in the engine; Building is simpler).
- `base_z` = DEM ground at the source; `height_agl` = H.
- **Acoustic-centre clamp**: when that source's container is included,
  `z_abs = max(ground + hagl, ground + H + roofOffsetM)` (and `height_agl`
  raised to match) — the source must sit at/above the roof or the engine would
  screen its own emission. Clamp is per-source, applied at build time.
- Self- and mutual screening both come free from the engine (a row of
  containers pools into the lateral cluster).
- Clusters: never carry containers.

UI (keep minimal):
- Settings menu: the two toggles + `roofOffsetM` number field.
- Source side panel (BESS/aux): container enable + dims override + bearing
  (bearing hidden when in a row).
- Map: render container footprints as simple rectangles when enabled (reuse the
  barrier rendering style) — enough to sanity-check orientation.

Gate: unit tests — rotated footprint corners for a 30° row; clamp applied
exactly at `H + roofOffsetM`; toggles produce different scenes for receiver vs
grid; container behind→in-front-of a receiver changes the level in the right
direction. Manual: a two-row demo layout looks right on the map.

## Phase 6 — Settings & persistence

- `ProjectSettings.standard?: '1996' | '2024'` (default `'2024'`), exposed as a
  dropdown; wire into `sceneBuilder`.
- Add the container settings; delete the dead topo knobs from the UI (keep
  `despikeStrength`), hide the `barrierConvention` setting entirely.
- Firestore: no migration script needed (all additive); confirm an old project
  document loads and solves identically-shaped output.

## Phase 7 — Validation & the A/B memo (the acceptance gate)

1. **Core regression** (must stay green, untouched): `cargo test --workspace`,
   19/19 conformance.
2. **V1/V2 re-validation** — rewrite `validation/run_v1.mjs` / `run_v2.mjs` to
   the new surface:
   - V1 (flat, no barriers): build Scene JSON from the recorded inputs.
   - V2 two ways: (a) *parity variant* — recorded virtual topo walls passed as
     `Wall` obstacles (isolates engine change from terrain change); (b) *native
     variant* — build a `Heightfield` from `validation/V2/DEM.tif` (geotiff is
     already a web dep; scripts run under node) and let the core screen.
   - **Gates:** every receiver within **±3 dB** of the SoundPLAN reference;
     mean |diff| ≤ **1.4 dB** (current 1.23); worst receiver ≤ **3.8 dB**
     (current worst). Both V2 variants must pass; (b) is the shipping config.
3. **A/B memo** — a script (`validation/ab_memo.mjs`) that runs old-tag wasm and
   new wasm over V1+V2+two synthetic cases (short wall → laterals; ridge DEM →
   native terrain) and emits `docs/beesty-migration-ab-memo.md`: per-receiver
   old/new/Δ table plus an attribution section mapping each systematic shift to
   its cause (exact ISO-266 centres; barrier Dz/C3 corrections; Agr ordering;
   laterals ON; native terrain sampling; cluster terrain now applied). Build the
   old side by checking out the pre-migration wasm artifacts from the last
   pre-swap commit (or stash a copy of `web/src/wasm/` before Phase 0).
4. **Ryan reviews the memo and signs off.** The swap does not merge before that.

## Phase 8 — Cleanup & docs

- Confirm the delete-list is fully gone (grep: `GridEvaluator`,
  `topographyBarriers`, `evaluate_general_octave`, `barrier_convention`,
  `NO_LATERAL`, `topo_offsets`).
- Update `web/README`-level docs + `solver/README.md` consumption section
  (wasm now = Scene JSON surface).
- Update `docs/beesty-terrain-review.md` with a short "superseded by native
  terrain (R1 data-resolution caveat still applies; R2/R3 fixed)" note.
- Final full gate: core tests + conformance, `npm run lint`, `npm run build`,
  `npm run build:wasm`, validation scripts, perf gate numbers recorded in the
  memo.

## Risks & watch-items

- **wasm size**: serde_json pulls weight; gate at 500 KB raw (see Phase 0).
- **Grid perf**: per-tile Session solve replaces per-cell calls — expected
  faster, but terrain profiling per source×cell is new cost; the 1.5× gate and
  the fallbacks in Phase 4 bound it.
- **Result shifts**: expected and documented; the memo is the control. The known
  directions: 4–8 kHz Aatm (exact centres), barrier cases (Dz fixes), short
  walls (laterals reduce screening), terrain cases (finer sampling both ways),
  clusters behind hills (now screened → quieter).
- **Heightfield memory** in the worker (≤ ~32 MB worst case) — acceptable; cap
  enforced by the 2048 clamp.
- **DEM is still a ~30 m DSM** (Terrarium) — native terrain does NOT fix data
  resolution (see `docs/beesty-terrain-review.md` R1); containers now cover the
  engineered-unit screening explicitly, which removes the worst practical gap.
- **Old projects**: parse-tolerant defaults everywhere; one manual open-and-solve
  of a pre-migration project is part of Phase 6's gate.

## Suggested commit sequence

0. `solver(wasm-v2): Scene-JSON wasm surface, no-panic errors` (Phase 0)
1. `web(reintegrate 1): sceneBuilder + unit tests` (Phase 1)
2. `web(reintegrate 2): native Heightfield terrain + delete topo barriers` (Phase 2)
3. `web(reintegrate 3): receiver path on Scene engine` (Phase 3)
4. `web(reintegrate 4): grid/worker on WasmSession` (Phase 4)
5. `web(reintegrate 5): source containers (model+UI+geometry)` (Phase 5)
6. `web(reintegrate 6): settings, standard selector, persistence defaults` (Phase 6)
7. `validation: rewrite V1/V2 + A/B memo` (Phase 7 — memo to Ryan)
8. `web(reintegrate 8): cleanup + docs` (Phase 8, post sign-off)
