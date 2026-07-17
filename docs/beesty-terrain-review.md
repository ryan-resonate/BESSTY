# BEESTY — Terrain handling review (focus: terrain shielding)

Read-only review of how the BEESTY web app ingests, samples and applies terrain,
and whether it will **accurately handle terrain shielding**. Code as of the
current working tree (WASM `web/wasm/` built 2026‑07‑07; TS `web/src/lib/`).

**Bottom line:** the *approach* is the physically-correct one and terrain shielding
works to first order — a ridge between source and receiver is turned into a
diffracting edge exactly as ISO/TR 17534‑3 §5.8 prescribes, and the V2 validation
(real DEM) matched SoundPLAN to ~1.2 dB mean / ≤3.8 dB worst. But the fidelity is
**capped by DEM data quality and a handful of sampling/filter choices**, and there
are specific cases where it will silently under- or over-screen. Details and a
prioritised improvement list below.

---

## 1. How terrain shielding actually works in BEESTY

Terrain is **not** solved inside the acoustic engine. The WASM solver
(`web/wasm/iso9613_wasm.*`) is the *old flat-API shim*
(`evaluate_general_octave` / `GridEvaluator`) — it has **no heightfield input**.
Instead, terrain screening is computed in TypeScript and injected as **synthetic
"topography barriers"** (zero-height walls sitting at the ground silhouette),
which the engine then diffracts over together with any man-made barriers.

Pipeline, per source→receiver line:

```
DEM (Terrarium tiles or uploaded)                     web/src/lib/dem.ts
   │  dem.elevation(lat,lng)  — bilinear sample
   ▼
topographyBarriers(...)                               web/src/lib/gridCore.ts:145
   1. sample ground profile along the S→R plan line at DEM resolution
      (spacing = max(8 m, dem.resolutionM), capped at 256 samples)
   2. Hampel despike (remove DEM blunders; strength 'low' default)
   3. upper convex hull in (distance, height), with S and R pinned at their
      ABSOLUTE acoustic-centre heights as end anchors → the diffracting silhouette
   4. prominence-simplify: keep a hull edge only if it adds ≥ 2 m of extra path
      height (virtualBarrierMinHeightM); drop the rest
   5. emit each survivor as a thin virtual wall (±50 m perpendicular wings),
      top = ground elevation, height = 0
   ▼
concatBarriers(user walls, topo walls)                web/src/lib/solver.ts:285
   ▼
WASM evaluate_general_octave / GridEvaluator.eval_cell_dba
   → over-top diffraction (re-hulls terrain + man-made edges together)
```

Supporting facts:
- **Two z-datums are handled correctly.** Everything geometric uses absolute z
  (`z_abs`); the ground-attenuation shape functions use height-above-ground
  (`hagl`). The source/receiver `hagl` is derived from the DEM
  (`solver.ts:262-263`, `groundSrcRaw`/`groundRxRaw`), and the WASM `.d.ts`
  documents the split (lines 42-45). This is the classic terrain bug and BEESTY
  gets it right.
- **User barriers sit on the terrain.** `packBarriers` (`solver.ts:154`)
  subdivides each drawn wall into ≤10 m pieces and sets each piece's base to the
  DEM ground under its endpoints — so a fence/building follows the ground and its
  effective screen height is measured from the real surface.
- **Grid mode samples terrain per cell.** For a noise-map grid, the topography
  barriers are recomputed for every source→cell line in a Web Worker
  (`gridCore.ts` `buildTopoPack` / `runBatchedGrid`).
- **Concave-ground (WTG Annex D.5)** is evaluated web-side
  (`concaveCorrectionMet`, `gridCore.ts:231`) using the mean line-height over the
  terrain — the −3 dB reflection enhancement.

---

## 2. Strengths (what it gets right)

1. **Correct physical model.** A ground ridge as a diffracting silhouette edge is
   exactly ISO/TR 17534‑3 §5.8 (and matches the standalone solver's `terrain.rs`
   reference implementation). This is the right way to do it.
2. **Over-top only, no lateral terrain — correct.** No lateral edges are emitted
   for terrain (indeed `solver.ts:118` notes lateral edges aren't packed at all).
   Per §5.8 an (unbounded) ground ridge contributes no around-the-side path, so
   this is right — sound is not allowed to "leak around the end" of a hill.
3. **Native-resolution profile sampling** (not a fixed low count), so real crests
   on the path are seen rather than aliased.
4. **Despike** guards against Terrarium DEM blunders (single-pixel spikes are
   common in global tiles) without flattening genuine crests (Hampel is
   peak-preserving).
5. **Prominence filter is conservative in the safe direction** — dropping a
   marginal edge *reduces* screening, i.e. *over*-predicts noise. Erring loud is
   the defensible default for a compliance tool.
6. **Terrain-following man-made barriers** (≤10 m subdivision with per-piece
   ground base) — a wall over undulating ground screens correctly.
7. **Validated.** The V2 case (real DEM + terrain screening) sat within ~1.2 dB
   mean and ≤3.8 dB of SoundPLAN — inside ISO's ±3 dB method band.

---

## 3. Limitations & risks (ranked by impact on terrain-shielding accuracy)

### R1 — DEM resolution / data quality is the dominant limiter  ★ highest
Default terrain is the global **Terrarium** tileset
(`elevation-tiles-prod`, `dem.ts:12`), which is SRTM-derived — **effective ground
resolution ~30 m**, regardless of the map zoom (the tiles can be sampled finely
but the underlying data isn't). A **small screening feature — an acoustic bund,
embankment, levee, or berm a few metres high and 10–30 m wide — is at or below one
DEM cell and will be smoothed away or missed entirely.** For BESS sites where the
mitigating feature is exactly such an engineered bund, BEESTY on the default DEM
will **not** see the screen and will over-predict.
- *Impact:* can be many dB where a small bund is the controlling mitigation.
- *Direction:* non-conservative *only* if the real screen exists but the DEM omits
  it (predicts louder than reality — safe); but it also can't credit a designed
  bund, which matters commercially.
- Uploaded DEMs (`demUpload.ts`) can be finer, which helps — but see R2.

### R2 — 8 m minimum profile spacing caps sharp features even with a fine DEM
`spacing = max(TOPO_MIN_SPACING_M(=8 m), dem.resolutionM)` (`gridCore.ts:52,164`).
Even if a 1 m DEM is uploaded, the profile is walked at **8 m** steps, so a sharp
crest narrower than ~8 m (a steep bund top, a retaining wall captured in the DEM)
can fall between samples → its peak height is under-read → under-screening.
- *Fix:* sample at the finer of a smaller floor (e.g. 2 m) and the DEM cell when a
  high-res DEM is present; keep the 256-sample cap for cost.

### R3 — Terrain is skipped for CLUSTERED sources
`buildTopoPack` only runs ridge analysis for "real" sources within the cutoff;
clusters are skipped (`gridCore.ts:302`, `solver.ts:580` "clusters skip topo").
When many BESS units are merged into a cluster point for speed, that cluster gets
**no terrain screening** → over-prediction behind a hill for the clustered
contribution.
- *Impact:* depends on how aggressively the UI clusters; potentially significant
  on large arrays behind terrain.
- *Fix:* run topo for the cluster's representative point, or disable clustering
  when a DEM is loaded and terrain is material.

### R4 — Ground effect (Agr) does not use the terrain profile
The engine's `Agr` is the ISO 9613‑2 **general method** with a **single uniform
`g`** and only the source/receiver `hagl` — it does *not* use a terrain-derived
mean propagation height between them. Over strongly undulating ground the mean
ray-height (and thus the ground dip/enhancement) is only crudely represented by
the two endpoint heights. This is partly inherent to the general method, but note:
- the newer standalone engine computes a terrain mean height `hm = F/dp` for the
  *simplified* method; BEESTY (general method) doesn't use it;
- BEESTY passes one `g` for the whole path — **no per-region ground** (hard pad
  near the BESS vs soft farmland beyond). That's a ground-effect fidelity gap
  independent of shielding, worth flagging alongside terrain.

### R5 — Despike vs real sharp screens (tuning risk)
A Hampel despike can misread a genuinely sharp, narrow real crest (a thin
embankment) as an outlier and remove it → under-screening. Default is 'low' which
is cautious, but the knob exists and a user pushing 'medium' to clean a noisy DEM
could erase a real screen. Document the trade-off in the UI.

### R6 — Prominence threshold discards marginal-but-real screens
The 2 m default (`virtualBarrierMinHeightM`) drops any silhouette edge adding
< 2 m of path height. A ridge that just breaks the line of sight (1–2 m of
diffraction) is ignored. Safe direction (over-predicts), but it means BEESTY
won't credit shallow grazing screening that a full-resolution tool would.

### R7 — Reflected-ray paths are (almost certainly) not terrain-screened
Terrain barriers are built for the direct source→receiver line. Specular
reflections off façades are a separate path; there's no evidence terrain edges are
applied to the reflected leg — so a reflected ray that should be blocked by a hill
isn't. Same class of gap as the standalone engine's documented reflected-path
limitation. Low practical impact unless reflectors + terrain co-occur.

### R8 — Old WASM engine (misc, not terrain-specific)
BEESTY runs the **old flat-API shim**, not the reviewed standalone `Scene` engine,
so it does **not** carry the 2026‑07 review-fixes. For *terrain shielding
specifically* this matters little (terrain is web-side; the barrier over-top
diffraction the shim uses was already conformance-validated). But the shim lacks:
per-region ground, the receiver-above-roof lateral fix, building lateral wraps,
3‑D/pitched solids, and the input-validation hardening. A future migration to the
standalone engine (which *does* accept a heightfield directly) would let terrain be
solved natively and remove the web-side barrier approximation.

### R9 — Long-path effective resolution degrades
`TOPO_MAX_SAMPLES = 256`: a path > ~2 km is sampled at > 8 m effective spacing
(a 5 km path → ~20 m), coarsening the silhouette on long-range assessments.
Usually fine (long range is dominated by other terms) but note it.

---

## 4. Things I did NOT verify (scope honesty)
- Did not run the app or reproduce a terrain case numerically.
- Did not confirm the exact `dem.resolutionM` reported for Terrarium tiles vs the
  true data resolution, nor the uploaded-DEM resolution path in `demUpload.ts`.
- Did not trace whether reflected-path barriers include terrain (R7 inferred from
  the direct-line-only construction).
- Did not check the 3‑D map view's terrain vs the acoustic terrain (they may use
  different sampling).

---

## 5. Recommended improvements (prioritised)

| # | Change | Why | Effort |
|---|---|---|---|
| 1 | **Support / encourage high-res uploaded DEMs** and surface the active DEM resolution in the UI | R1 is the biggest real-world error source; a designed bund needs a bund-resolution DEM | low (UI) + demUpload wiring |
| 2 | **Lower the profile-spacing floor** (8 m → ~2 m) when a fine DEM is present | R2 — lets an uploaded DEM actually capture sharp bunds | low |
| 3 | **Run terrain for cluster representative points** (or auto-disable clustering when terrain is material) | R3 — clusters silently lose screening | medium |
| 4 | **Explicit "engineered bund" primitive** drawn as a barrier rather than relying on the DEM | side-steps R1/R2 entirely for the controlling feature; barriers already terrain-follow | medium |
| 5 | Add **per-region ground** support | R4 — hard pad vs farmland is a real ground-effect error | medium (needs the standalone engine or shim extension) |
| 6 | UI copy/tooltips on **despike + prominence** trade-offs, and a "show virtual terrain barriers" debug overlay | R5/R6 — let the user see what terrain the engine actually used | low |
| 7 | **Migrate to the standalone `iso9613-core`** (heightfield-native terrain, validated fixes, input validation) | R8 — removes the web-side barrier approximation and unifies with the reviewed engine | large |

---

## 6. Verdict on "will it accurately handle terrain shielding?"

**Yes, to first order — with important caveats.** The method is correct and
validated within ISO's ±3 dB against SoundPLAN on a real DEM. It will reliably
capture **large landform screening** (hills, ridges, valleys) present in the DEM.

It will **not** reliably capture **small engineered screens** (bunds/embankments
below ~1 DEM cell, ~30 m on the default global DEM), and it under-samples sharp
features even on a fine DEM (the 8 m floor). Clustered sources lose terrain
entirely. For a defensible BESS assessment where a bund is the controlling
mitigation, either upload a bund-resolution DEM **and** lower the sampling floor,
or model the bund as an explicit drawn barrier — don't rely on the global DEM to
find it.

The failure directions are mostly **safe (over-predicting)** — missing a screen
predicts louder than reality — except that it can't *credit* a real designed bund
the DEM doesn't resolve, which is the commercially important case to fix (items
1, 2, 4 above).
