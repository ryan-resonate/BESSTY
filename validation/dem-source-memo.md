# DEM source comparison — GA DEM-S vs AWS Terrain Tiles (2026-09-03)

Phase 1 gate evidence for `docs/beesty-dem-source-plan.md`: the automatic DEM
cascade now resolves to **GA SRTM 1 Second DEM-S v1.0** for Australian projects,
with the AWS Terrain Tiles kept only as the fallback outside its coverage.

Two questions had to be answered before that switch could be silent
(decision 6): does DEM-S agree with a commercial reference at least as well as
the tiles it replaces, and how far does it move an existing project?

Everything below was produced by the shipping pipeline —
`buildTerrainField` → `buildScene` → `solve_scene` — with only the `DemRaster`
swapped underneath.

## Reproducing

```
node tools/dem-probe.mjs                # live DEM-S read + timings
node validation/run_v2_dem.mjs          # V2 vs SoundPLAN, three DEMs (gate)
node validation/run_tarong_dem.mjs      # Tarong WF, Terrarium vs DEM-S
```

All three need network. None of them is part of `npm test`: a unit suite that
goes red when an S3 bucket hiccups is a suite people learn to ignore.

## 1. Live read (`tools/dem-probe.mjs`)

Tarong (−26.78, 151.90), 5 km box + the 500 m terrain margin:

| | |
|---|---|
| Window | 221 × 197 px (0.17 MB float32) |
| Elevations | 388.4 … 554.6 m, mean 451.3, 0 NaN of 43 537 samples |
| Pitch reported | 27.57 m (E-W, the finer axis at 26.8 °S) |
| COG header + first window | 890 ms |
| Window read, warm handle | **162 ms** (gate: < 2000 ms) |

The header is paid once per session; every project window after it is the
second number.

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
| R1 | 6.9 | 5.62 | −1.28 | 6.88 | −0.02 | 6.85 | −0.05 |
| R2 | −8.9 | −10.02 | −1.12 | −10.16 | −1.26 | −10.30 | −1.40 |
| R3 | −0.8 | −2.12 | −1.32 | −2.12 | −1.32 | −2.41 | −1.61 |
| R4 | 1.7 | 0.22 | −1.48 | 1.58 | −0.12 | −0.01 | −1.71 |
| R5 | 15.6 | 14.84 | −0.76 | 14.85 | −0.75 | 14.68 | −0.92 |
| R6 | −2.6 | −4.02 | −1.42 | −4.23 | −1.63 | −4.27 | −1.67 |
| R7 | 10.0 | 9.06 | −0.94 | 9.06 | −0.94 | 8.95 | −1.05 |
| R8 | 8.6 | 7.84 | −0.76 | 7.39 | −1.21 | 8.07 | −0.53 |
| R9 | 9.2 | 7.58 | −1.62 | 10.07 | +0.87 | 9.23 | +0.03 |
| R10 | 13.8 | 13.04 | −0.76 | 13.04 | −0.76 | 13.04 | −0.76 |
| R11 | 5.3 | 3.94 | −1.36 | 4.44 | −0.86 | 3.54 | −1.76 |
| R12 | 15.8 | 15.12 | −0.68 | 15.12 | −0.68 | 13.85 | −1.95 |
| R13 | −5.9 | −7.53 | −1.63 | −7.53 | −1.63 | −8.28 | −2.38 |

| Leg | mean \|Δ\| | worst \|Δ\| | raster | DEM load | solve |
|---|---|---|---|---|---|
| (a) uploaded Vicmap 10 m GeoTIFF | 1.16 | 1.63 | 20.0 m, 653 × 490 | 91 ms | 1024 ms |
| **(b) GA SRTM 1s DEM-S** | **0.93** | **1.63** | 24.8 m, 528 × 396 | 1069 ms | 92 ms |
| (c) AWS Terrain Tiles | 1.22 | 2.38 | 15.3 m, 852 × 640 | 1217 ms | 387 ms |

Gates, all **PASS**: every receiver within ±3 dB (worst 1.63); mean ≤ 1.4 (0.93);
worst ≤ 3.8 (1.63); mean \|Δ\| no worse than Terrarium (0.93 vs 1.22).

DEM-S is the best of the three against SoundPLAN, on a third of the cells the
tiles need. Terrarium's two poorest receivers (R12 −1.95, R13 −2.38) are the
ones DEM-S recovers to −0.68 and −1.63: over-screening by canopy-height SRTM is
exactly what the vegetation-offset removal is for.

Note on leg (a): the uploaded 10 m GeoTIFF is *sampled at 20 m*, because
`parseDemGeoTiff` has never set `resolutionM` and `buildTerrainField` therefore
falls back to its 20 m default. Phase 0 now reports the native pitch, so the
gap is visible in the diagnostics and the PDF ("10.0 m native, 20.0 m sampled"),
but the behaviour is deliberately unchanged — fixing it would silently move
every existing upload project, which is not a Phase 0/1 decision to take.

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
Thirty-one of the 59 move by less than 0.01 dB — at 174 m hub height over open
country most paths never touch a ridge, so the DEM only matters for the handful
of receivers that are actually screened.

Timings (headless, one thread, whole project in one scene):

| Leg | raster | DEM load | solve |
|---|---|---|---|
| AWS Terrain Tiles | 17.1 m, 1358 × 1543 | 2100 ms | 58 312 ms |
| GA SRTM 1s DEM-S | 27.6 m, 841 × 955 | 1415 ms | 19 901 ms |

The 2.9× solve speed-up is a side effect, not a goal: the terrarium raster is
z13 web-mercator at 17 m, so it carries 2.6× the cells to describe the same
ground at no better fidelity — SRTM resampled up. DEM-S is sampled at its own
1-arcsecond pitch.

## Conclusion

DEM-S is better against the one commercial reference available, cheaper to
solve, and moves the existing example project by less than 0.4 dB anywhere.
The silent switch in decision 6 is supported by the numbers.

Terrain QA flag counts on real DEMs are Phase 2 and are not in this memo yet.
