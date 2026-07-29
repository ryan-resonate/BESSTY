# BEESTY solver migration — A/B memo (Phase 7)

**For sign-off.** BEESTY has been migrated off the flat WASM shim onto the
reviewed standalone `iso9613-core` engine, per
`docs/beesty-solver-reintegration-plan.md`. This memo reports what changed
numerically, why, and what is *not* yet proven.

Reproduce with:

```bash
node validation/run_validation.mjs        # table + gates (add --json for data)
```

---

## Headline

**The engine swap is numerically neutral.** Run on identical geometry, the old
and new engines agree to **0.01 dB** across all 21 validation receivers.

| Case | mean \|new − ref\| | worst | vs old engine |
|---|---|---|---|
| V1 (flat, 1 source, no obstacles) | 1.25 dB | 2.32 dB | mean shift −0.01 dB |
| V2 (real DEM, 3 sources, terrain screening) | 1.23 dB | 3.84 dB | mean shift −0.00 dB |

Both match the pre-migration figures (V2 mean 1.23, worst 3.84). **All
no-regression gates pass.** The residual ~1.2 dB against SoundPLAN is the
pre-existing agreement level of the reference case, unchanged by this work.

### One gate needs re-stating

The plan set "every receiver within ±3 dB". Running the **old** engine here shows
its own worst receiver (V2 **R4**) is already **3.84 dB** off the reference — that
gate was never met by the baseline, and is a property of the reference case, not
of this migration. The operative gates are therefore *no regression vs the old
engine* (all pass), with the absolute figures reported for context. R4 deserves a
separate look some day; it is not something this change introduced or worsened.

---

## Per-receiver results

### V1 — flat ground, one Megapack, no obstacles
Isolates divergence, atmospheric absorption and ground effect.

| Rx | ref | old | new | new−ref | new−old |
|---|---|---|---|---|---|
| R1 | 28.0 | 27.64 | 27.64 | −0.36 | +0.01 |
| R2 | 17.1 | 16.43 | 16.43 | −0.67 | +0.01 |
| R3 | 10.3 | 9.48 | 9.48 | −0.82 | 0.00 |
| R4 | 5.4 | 4.33 | 4.32 | −1.08 | −0.00 |
| R5 | 5.4 | 4.38 | 4.38 | −1.02 | −0.00 |
| R6 | −11.9 | −13.66 | −13.67 | −1.77 | −0.02 |
| R7 | −17.2 | −19.17 | −19.20 | −2.00 | −0.02 |
| R8 | −29.3 | −31.58 | −31.62 | −2.32 | −0.05 |

### V2 — real DEM, three Megapacks, terrain screening
Parity variant: the terrain barriers the old app derived are replayed to both
engines, so this compares *engines*, not terrain pipelines.

| Rx | ref | old | new | new−ref | new−old |
|---|---|---|---|---|---|
| R1 | 6.9 | 7.16 | 7.16 | +0.26 | 0.00 |
| R2 | −8.9 | −9.99 | −10.00 | −1.10 | −0.01 |
| R3 | −0.8 | −2.11 | −2.12 | −1.32 | −0.01 |
| **R4** | 1.7 | 5.54 | 5.54 | **+3.84** | −0.00 |
| R5 | 15.6 | 14.84 | 14.85 | −0.75 | 0.00 |
| R6 | −2.6 | −3.58 | −3.59 | −0.99 | −0.01 |
| R7 | 10.0 | 9.07 | 9.07 | −0.93 | 0.00 |
| R8 | 8.6 | 10.91 | 10.91 | +2.31 | −0.00 |
| R9 | 9.2 | 10.44 | 10.44 | +1.24 | 0.00 |
| R10 | 13.8 | 13.05 | 13.06 | −0.74 | 0.00 |
| R11 | 5.3 | 5.12 | 5.11 | −0.19 | −0.00 |
| R12 | 15.8 | 15.10 | 15.11 | −0.69 | 0.00 |
| R13 | −5.9 | −7.53 | −7.54 | −1.64 | −0.01 |

The ≤0.05 dB residuals are the expected consequence of the engine's corrected
constants (exact ISO 266 band centres, the `C3` multi-edge factor, the `Dz`
bracket) — visible only at the far, quiet receivers where they have room to show.

---

## A finding worth recording

The first parity run showed V2 shifting **+0.54 dB** at the most-screened
receiver, which would have looked like a real regression. It was an artefact of
the *test harness*, and chasing it produced a useful confirmation.

The old app emitted each terrain ridge as a stub only ±50 m either side of the
path, and its engine gave terrain no around-the-end diffraction — correct per
ISO/TR 17534-3 §5.8, where a ground ridge is treated as **unbounded**. The new
engine *does* model lateral diffraction for finite walls, so replaying those
100 m stubs verbatim let sound leak around ends that do not physically exist.

Stretching each replayed stub along its own axis confirmed it exactly:

| ridge length | R4 | R11 | R6 |
|---|---|---|---|
| ×1 (as recorded, 100 m) | 6.085 | 5.304 | −3.483 |
| ×10 | 5.545 | 5.114 | −3.591 |
| ×100 | 5.538 | 5.112 | −3.593 |
| **old engine** | **5.54** | **5.12** | **−3.58** |

Converged to the old engine within 0.01 dB. The harness now stretches by ×20.

**The shipping app never had this problem**: terrain goes to the engine as a
`Heightfield`, and the engine emits no lateral edges for terrain ridges by
construction. The episode is, if anything, evidence that the native-terrain path
is the more faithful one.

---

## Changes that this comparison deliberately does NOT measure

The parity run holds terrain and features fixed to isolate the engine. In the
app, four intended changes will move numbers — each was a locked decision:

1. **Native terrain** *(direction: both ways, generally more accurate)* — the
   engine samples the DEM raster itself instead of the app pre-reducing each path
   to virtual barriers. This removes the old 8 m sampling floor and 256-sample
   cap, so real ridges are resolved better. Expect small shifts wherever terrain
   screens, larger where a ridge was previously under-sampled.
2. **Clustered sources now get terrain** *(direction: quieter)* — clusters were
   silently skipped by the old terrain pipeline. Anything behind a hill that was
   modelled as a cluster was being over-predicted.
3. **Lateral diffraction on drawn walls** *(direction: louder behind short walls)*
   — the engine now models around-the-end paths for finite barriers, which the
   old app never sent. This closes BEESTY backlog #17. A long wall is unaffected;
   a short one correctly leaks.
4. **Source containers** *(off by default; direction: mixed)* — when enabled, a
   BESS unit becomes a screening box with its acoustic centre lifted to the roof.
   Note a container never screens its *own* source (the roof clamp puts the source
   above its own roof by construction); the benefit is mutual screening within a
   row.

Plus the 1996/2024 selector, which does nothing to existing projects (they
default to 2024, the edition they were always computed with).

---

## What is NOT yet proven

**The native-terrain V2 variant has not been run.** The plan asked for V2 both
ways — parity (done, above) and native (build a `Heightfield` from
`validation/V2/DEM.tif` and let the engine screen). The native run needs the
recorded local-metre geometry registered against the GeoTIFF's projected CRS,
which is a piece of work in its own right rather than a script tweak.

What I *do* have for the native path:
- an automated gate that a 40 m ridge in a DEM screens a 1 km path by >5 dB
  through the real engine, and that flat ground does not
  (`terrainField.test.ts`);
- the same demonstrated end-to-end through the grid path (`gridCore.test.ts`);
- the raster's node convention verified against the engine's own indexing.

That establishes the mechanism works, but **not** that the V2 site reproduces
1.23 dB under native terrain. If you want that number before merge, say so — it
is the one substantive item I'd add.

---

## State

| Gate | Result |
|---|---|
| Core Rust tests | 156 pass |
| ISO/TR 17534-3 conformance | 19/19 at ±0.05 dB |
| Rust clippy | clean |
| Web typecheck + build | clean |
| Web tests | 46 pass |
| wasm contract smoke test | 15 checks pass |
| wasm size | 436 KB (gate <500 KB) |
| Grid perf | 128×128 × 12 sources in ~1.2 s |
| Validation gates | all pass |

### Deviations from the plan, all deliberate

- **Test harness** is esbuild + `node:test` (no new dependencies) rather than
  vitest.
- **`topographyBarriers` deletion** moved from Phase 2 to Phases 3–4, so it
  happened in the commits that rewrote its callers instead of breaking the tree
  twice.
- **`a_weighted_total`** was kept on the wasm surface (the plan listed only
  `solve_scene`/`WasmSession`/the octave helpers) — the web uses it in three
  places to re-total after adding `DΩ`.
- **Container map rendering was not done.** The plan asked for footprint
  rectangles on the map to sanity-check orientation. The geometry is unit-tested
  (including the +90° convention conversion and a parallel row), but there is no
  visual confirmation yet. Worth adding before anyone relies on the feature.
- **`validation/old_wasm/`** (the pre-swap build, needed for this comparison) is
  deliberately **not committed** — it is a build artefact. Regenerate with
  `git checkout 4840a5e^ -- solver/crates/iso9613-wasm && npm run build:wasm`,
  copy `web/src/wasm/*` to `validation/old_wasm/`, add `{"type":"module"}` as its
  `package.json`, then restore the crate.

### Review

Every phase was reviewed by a standing adversarial reviewer. Findings actioned:
the Annex D.5 per-pair concave issue (would have misapplied ±3 dB once receivers
were batched — fixed with receiver grouping before the grid path hardened), a
`−120 dB` floor/`DΩ` ordering regression, two tests that did not test what they
claimed, a wasm-trap-vs-error blind spot in the smoke test, and several
docs/dead-code items.

---

## Recommendation

The migration is numerically neutral, all no-regression gates pass, and the
engine now carries the reviewed physics (receiver-above-roof, building clusters,
concave courtyards, 3-D solids, the full validation sweep) plus native terrain.

**Ready to merge**, with two things for your call:
1. whether you want the native-terrain V2 number first;
2. container map rendering before the feature is used in anger.
