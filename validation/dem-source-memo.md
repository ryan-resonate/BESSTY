# DEM source comparison and terrain QA — evidence memo (refreshed 2026-09-03)

Evidence for `docs/beesty-dem-source-plan.md`: the automatic DEM cascade is
**QLD LiDAR DTM → GA SRTM 1 Second DEM-S v1.0 → AWS Terrain Tiles**, with an
uploaded GeoTIFF overriding all three, and the Hampel despike replaced by a
visible, opt-in terrain QA pass.

Three questions had to be answered before that could be silent (decision 6):
does DEM-S agree with a commercial reference at least as well as the tiles it
replaces, how far does it move an existing project, and does the QA pass flag
anything on real data that is not a blunder?

Everything below was produced by the shipping pipeline —
`buildTerrainField` → `buildScene` → `solve_scene` — with only the `DemRaster`
swapped underneath.

**Refreshed after Phases 2 and 3.** Sections 1–3 were first written at Phase 1
(commit `bd6c250`); they are re-run here because two later fixes moved the
numbers: the despike removal (`73aed7b`) and, for the uploaded leg, the
`resolutionM` fix in the same commit plus the pixel-centre correction in
`a3fbd46`. Where a figure has changed, the Phase 1 value is given beside it.

## Reproducing

```
node tools/dem-probe.mjs                # live DEM-S + QLD reads, with timings
node validation/run_v2_dem.mjs          # V2 vs SoundPLAN, three DEMs (gate)
node validation/run_tarong_dem.mjs      # Tarong WF, Terrarium vs DEM-S
cd web && npm test                      # terrainQa.test.ts, the QA rule suite
```

The first three need network. None of them is part of `npm test`: a unit suite
that goes red when an S3 bucket hiccups is a suite people learn to ignore.

## 1. Live read (`tools/dem-probe.mjs`)

### DEM-S — Tarong (−26.78, 151.90), 5 km box + the 500 m terrain margin

| | |
|---|---|
| Window | 221 × 197 px (0.17 MB float32) |
| Elevations | 388.4 … 554.6 m, mean 451.3, 0 NaN of 43 537 samples |
| Pitch reported | 27.57 m (E-W, the finer axis at 26.8 °S) |
| COG header + first window | 1067 ms (Phase 1: 890 ms) |
| Window read, warm handle | **188 ms** (gate: < 2000 ms; Phase 1: 162 ms) |

The header is paid once per session; every project window after it is the
second number.

### QLD LiDAR — coverage and export

| | |
|---|---|
| Tarong, five `identify` probes | `covers = false` in 1979 ms — correctly refuses, cascade falls to DEM-S |
| Brisbane CBD 10 km box, five probes | `covers = true` in 3905 ms |
| Export, 2048 × 2048 at 5.37 m | 16.0 MB float32, **51 631 ms across three attempts** |
| Pitch | 1.00 m native, 5.37 m sampled |
| Elevations | −17.3 … 224.1 m, mean 23.6, 0 NaN of 65 536 samples |

The export figure is the honest one, not the good one: on this run the service
answered attempt 1 with HTTP 200, `content-type: image/tiff` and a JSON
`"General function failure"` body, attempt 2 with HTTP 500, and only attempt 3
with a raster. A single clean 2048² export took 8.3 s when the endpoint was
first characterised (plan, Phase 3) and ~8.7 s at the Phase 3 measurement
(`174f2c6`). The retry (two backoffs, then give up — `a3fbd46`) is what stops
the same project standing on 1 m LiDAR one session and 30 m DEM-S the next; it
buys that at the cost of a long worst case.

## 2. V2 vs SoundPLAN, three DEMs (`validation/run_v2_dem.mjs`) — the gate

V2 is three BESS units and 13 receivers in the Victorian Alps
(146.9 °E, −36.7 °S), 300–1000 m of relief. The existing `run_v2.mjs` and
`run_validation.mjs` cannot answer a DEM question: they replay terrain barriers
*recorded* from the old app, so the elevations are baked into the JSON. This
script rebuilds the case from its source data (`V2/Source.zip`,
`V2/Receivers.zip`, the recorded source spectrum) and solves it three times.

Deltas are BEESTY − SoundPLAN, dB(A):

| Rx | SoundPLAN | (a) Vicmap 10 m | Δ | (b) DEM-S | Δ | (c) Terrarium | Δ |
|---|---|---|---|---|---|---|---|
| R1 | 6.9 | 5.70 | −1.20 | 6.88 | −0.02 | 6.85 | −0.05 |
| R2 | −8.9 | −10.00 | −1.10 | −10.16 | −1.26 | −10.30 | −1.40 |
| R3 | −0.8 | −2.12 | −1.32 | −2.12 | −1.32 | −2.41 | −1.61 |
| R4 | 1.7 | 0.11 | −1.59 | 1.58 | −0.12 | −0.01 | −1.71 |
| R5 | 15.6 | 14.84 | −0.76 | 14.85 | −0.75 | 14.68 | −0.92 |
| R6 | −2.6 | −4.02 | −1.42 | −4.23 | −1.63 | −4.27 | −1.67 |
| R7 | 10.0 | 9.06 | −0.94 | 9.06 | −0.94 | 8.95 | −1.05 |
| R8 | 8.6 | 7.61 | −0.99 | 7.39 | −1.21 | 8.07 | −0.53 |
| R9 | 9.2 | 7.15 | −2.05 | 10.07 | +0.87 | 9.23 | +0.03 |
| R10 | 13.8 | 13.04 | −0.76 | 13.04 | −0.76 | 13.04 | −0.76 |
| R11 | 5.3 | 3.87 | −1.43 | 4.44 | −0.86 | 3.54 | −1.76 |
| R12 | 15.8 | 15.12 | −0.68 | 15.12 | −0.68 | 13.85 | −1.95 |
| R13 | −5.9 | −7.53 | −1.63 | −7.53 | −1.63 | −8.28 | −2.38 |

| Leg | mean \|Δ\| | worst \|Δ\| | raster | DEM load | solve |
|---|---|---|---|---|---|
| (a) uploaded Vicmap 10 m GeoTIFF | 1.22 | 2.05 | 10.0 m, 1304 × 979 | 86 ms | 5098 ms |
| **(b) GA SRTM 1s DEM-S** | **0.93** | **1.63** | 24.8 m, 528 × 396 | 1221 ms | 183 ms |
| (c) AWS Terrain Tiles | 1.22 | 2.38 | 15.3 m, 852 × 640 | 2443 ms | 429 ms |

Gates, all **PASS**: every receiver within ±3 dB (worst 1.63); mean ≤ 1.4 (0.93);
worst ≤ 3.8 (1.63); mean \|Δ\| no worse than Terrarium (0.93 vs 1.22).

DEM-S is the best of the three against SoundPLAN, on a third of the cells the
tiles need. Terrarium's two poorest receivers (R12 −1.95, R13 −2.38) are the
ones DEM-S recovers to −0.68 and −1.63: over-screening by canopy-height SRTM is
exactly what the vegetation-offset removal is for. Legs (b) and (c) are
unchanged from Phase 1 to the last printed digit — removing the despike moved
neither, because it had been altering 0.002 % of cells on clean data.

**Leg (a) has changed, and it got slightly worse.** At Phase 1 the uploaded
10 m GeoTIFF was screened at `terrainField`'s 20 m fallback, because
`parseDemGeoTiff` never set `resolutionM`; the raster was 20.0 m / 653 × 490 and
scored mean 1.16, worst 1.63. It is now sampled at its real 10 m pitch
(1304 × 979) with the pixel-centre fix on top, and scores mean 1.22, worst 2.05
— R9 alone moves from −1.62 to −2.05. That is the expected direction: a 10 m DEM
screens more ridges than a 20 m one, and the reference this is compared against
is SoundPLAN's model of the same site, not ground truth. It is still inside
every V2 limit, and it is now *what the file says* rather than a coarsened
version of it. It also costs: leg (a) carries 1.28 M heightfield nodes against
leg (b)'s 0.21 M — 6× the cells — and solves 28× slower, because profile
screening pays per ridge candidate along every path, not per cell.

## 3. Tarong WF, Terrarium vs DEM-S (`validation/run_tarong_dem.mjs`)

The example project: 97 × V163 4.5 MW at 174 m hub, PO4500, 59 receivers at
4 m HAG, night, 10 m/s. No commercial reference exists for it, so this is not a
pass/fail — it answers "how much does an existing project move when the source
switches under it?"

| | |
|---|---|
| mean \|Δ\| | **0.06 dB** |
| mean Δ (bias) | +0.01 dB |
| largest Δ | +0.38 dB (Receiver 41) |
| receivers moving > 1 dB | **0 of 59** |

Next largest: +0.34 (R38), +0.33 (R24), +0.28 (R43), −0.24 (R12), +0.24 (R42).
Twenty-eight of the 59 move by less than 0.01 dB — at 174 m hub height over open
country most paths never touch a ridge, so the DEM only matters for the handful
of receivers that are actually screened.

Timings (headless, one thread, whole project in one scene):

| Leg | raster | DEM load | solve | QA flagged |
|---|---|---|---|---|
| AWS Terrain Tiles | 17.1 m, 1358 × 1543 | 2406 ms | 60 314 ms | 0 cells |
| GA SRTM 1s DEM-S | 27.6 m, 841 × 955 | 1509 ms | 21 067 ms | 0 cells |

The 2.9× solve speed-up is a side effect, not a goal: the terrarium raster is
z13 web-mercator at 17 m, so it carries 2.6× the cells to describe the same
ground at no better fidelity — SRTM resampled up. DEM-S is sampled at its own
1-arcsecond pitch.

Note: `run_tarong_dem.mjs` needed two mechanical repairs to run at all after
Phases 2–3 — `lastTerrainPitchM` became `lastTerrainBuild`, and
`evaluateProject` now returns `{ results, terrain }` rather than a bare array.
It reads the terrain record off the solve's own return value, which is what
`a3fbd46` made available precisely so a caller does not quote the contour grid's
raster by mistake.

## 4. Terrain QA on real DEMs (Phase 2)

### Nothing is flagged on clean data

| DEM | Raster QA ran over | Flagged |
|---|---|---|
| Vicmap 10 m (uploaded, `V2/DEM.tif`), V2 extent | 1304 × 979 at 10.00 m (1.28 M cells) | **0**, max deviation 0.00 m |
| AWS Terrain Tiles, Tarong extent | 1358 × 1543 at 17.1 m (2.10 M cells) | **0** |
| GA DEM-S, Tarong extent | 841 × 955 at 27.6 m (0.80 M cells) | **0** |

4.2 M cells of real Australian terrain across three datasets and three pitches,
and the pass flags nothing. That is the result the design wanted: the Hampel
despike it replaces altered 0.002 % of the same Vicmap raster, silently, and
what it altered was one-cell bunds and cuttings.

### Injected-artefact confidence check

Zero flags is only reassuring if the pass can still see a blunder. Over the
Vicmap 10 m raster above, 48 synthetic artefacts were injected at
well-separated interior sites — 4 shapes (1 cell, 2 cells, an L of 3, a 2×2
block) × 4 amplitudes (±2 and ±5 times the 45° rise limit, i.e. ±20 m and
±50 m on 10 m cells) × 3 sites each, 120 cells in all — and the pass re-run:

| | |
|---|---|
| Cells flagged | 112 of 120 injected |
| Artefacts flagged in full | **46 of 48** |
| Artefacts partly flagged | 0 |
| **Cells flagged that were not injected** | **0** (baseline was 0) |
| Correction | 112 cells moved, largest 55.2 m, 0 left flagged after one pass, 0 un-flagged cells touched |

**The two misses are both 2×2 pits at the shallow −20 m amplitude, and both
landed on hillsides with 26–28 m of relief across the ring around them** — at
(184, 760) the ring spans 428.9–455.1 m, at (840, 760) 513.7–541.7 m. On ground
that steep the artefact's own cells link into the hillside's steep cluster, and
the ≤ 2×2 cluster rule then declines to call it a blunder. That is the rule
protecting a cliff line working as specified, not a bug: the same rule is why
0 of 4.2 M real cells were flagged. The consequence to state plainly is that a
shallow multi-cell pit on steep terrain can be missed. A deeper one (−50 m) at
the same sites is caught.

The shape rules themselves are pinned by `web/src/lib/terrainQa.test.ts`, which
runs every case at 30, 17 and 5 m pitch: an isolated spike and pit are flagged;
a 2×2 block is flagged whole; one-, two- and three-cell-wide ridges, diagonal
ridges, a 1×3 bund, cuttings, conical peaks, planar slopes, paraboloid summits,
a 3×3 block and a cliff with an undulating crest are all **not** flagged; border
cells are never flagged; and correction changes exactly the flagged cells and
nothing else. A 2048² grid flags in 121 ms.

## 5. Phase 3 performance (QLD LiDAR path)

The expensive case is a fine DEM over a large site. Measured over a 10 km
Brisbane box, 1 m native → 5.37 m sampled, 2048 × 2048 = 4.2 M cells:

| | Phase 3 (`174f2c6`) | Re-run today |
|---|---|---|
| `buildTerrainField` | 393 ms | 476 ms |
| `captureDemRegion` 2048², fast path | 54 ms | 73 ms |
| `captureDemRegion` 2048², via `elevation()` | 64 ms | 65 ms |
| Main-thread total | 447 ms | 549 ms |

Both are inside the 1 s main-thread budget the plan set, so the raster sampling
was left on the main thread and no worker scaffolding was built (plan, Phase 3).
The fast path exists because `DemRaster` now offers `grid()` for the lat/lng
gridded sources, so the snapshot copies typed array to typed array instead of
calling a closure 4.2 M times; on this run the two are within noise of each
other at 2048², and the gap widens with raster size.

Cell cap: 2048 per axis. A 10 km box at 1 m native is capped to 5.37 m and the
`terrain.resampled` diagnostic says so — that is the only coarsening BESSTY
does, and it is always reported.

## 6. Queensland licence — unconfirmed

**No QSpatial or data.qld.gov.au record names the `Elevation/QldDem` endpoint.**
The two records found for the sibling public elevation service
(`DEM_TimeSeries_AllUsers`) disagree with each other:

| Record | Licence stated |
|---|---|
| QSpatial / data.qld.gov.au portal listing | CC BY 3.0 (Australia) |
| The ISO 19115 metadata attached to the same dataset | CC BY-SA |

Both permit use in commercial consulting work provided the source is
attributed, so the source ships enabled; the difference between them is the
share-alike obligation, which does not bite on a noise report. The adapter
therefore carries the service's own `copyrightText` verbatim as the raster's
attribution — which is what the service's terms require in either reading — and
leaves `licence` as `see service metadata` rather than claiming one of two
contradictory records as fact. **Confirm with the department before this is
relied on in an issued report.**

## Conclusion

DEM-S is better against the one commercial reference available, cheaper to
solve, and moves the existing example project by less than 0.4 dB anywhere; the
silent switch in decision 6 is supported by the numbers. QLD LiDAR is a real
upgrade where it exists, bought at a slow and intermittently failing export and
an unconfirmed licence. The terrain QA pass flags nothing across 4.2 M cells of
real terrain from three datasets, and finds 46 of 48 injected blunders with no
false positives — the two it misses are shallow multi-cell pits on steep ground,
which is the price of never touching a cliff line.
