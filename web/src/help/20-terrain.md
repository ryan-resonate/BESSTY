---
title: Terrain data
section: Reference
---

Terrain loads by itself. There is no source to pick and nothing to download per project: BESSTY works out which elevation dataset covers the site, fetches the window it needs, and names what it used in the diagnostics, the status chip and the PDF.

## Which dataset, in what order

The first source that covers the site and loads, wins.

1. **QLD LiDAR DTM** — the Queensland Government `Elevation/QldDem` mosaic of the state's public 0.5–1 m LiDAR DTMs. The mosaic answers for the whole state, falling back to SRTM where the LiDAR does not reach, so coverage is not a bounding-box question: the site is probed at several points and the source is taken only when **every** probe reports LiDAR. A site half on a capture would otherwise be screened half at 1 m and half at 30 m, with an invented step between them.
2. **GA SRTM-derived 1 Second DEM-S v1.0** — Geoscience Australia's national ~30 m bare-earth DEM: vegetation offsets removed, voids filled. The default everywhere in Australia.
3. **AWS Terrain Tiles** — the Mapzen terrarium tiles, used outside DEM-S coverage or if the two above fail.

An **uploaded GeoTIFF always wins**, whatever the cascade would have chosen. Upload one on the DEM card when you have ELVIS or survey data for the site; it is sampled at its own pixel size, in the file's own coordinate reference system.

A source that reports no coverage, or fails, is skipped and the next one is tried. The Queensland service rejects a share of its exports under load, so an export is attempted up to three times before the cascade moves on — otherwise the same project would stand on 1 m LiDAR one session and 30 m DEM-S the next. A large Queensland export can take tens of seconds when that happens.

## How terrain is sampled

The DEM is sampled bilinearly onto a regular grid at the **DEM's own pitch**, never finer. Interpolating a 30 m dataset onto 5 m cells invents detail that is not in the data, so it is not done.

The only coarsening is the cell cap: a raster is capped at 2048 cells per axis, so a site larger than about 2048 pitches across is sampled coarser than its DEM. That is reported — the diagnostics say `Terrain resampled to X m (DEM provides Y m)`, and the PDF terrain line states both the native pitch and the pitch actually screened. When you see it, ridges narrower than a cell have stopped screening.

The raster covers every source, receiver, wall vertex and the calculation area, plus a 500 m margin, so nothing is founded at sea level just outside the box.

## Terrain QA

Free DEMs contain blunders — a single cell tens of metres above its neighbours, from a cloud, a bird or a mosaic seam. Left alone one becomes a phantom barrier and can take several decibels off a receiver.

Every solve **flags** them. A cell is suspect only when all three hold: a step to one of its four neighbours exceeds one cell width (45°); the cell, or the cluster of at most 2×2 cells it belongs to, stands strictly above or strictly below the ring of cells around it; and that cluster is not part of anything longer. So what gets flagged is an isolated one- to four-cell spike or pit — the shape a bad source cell has, either on its own or smeared over 2×2 by resampling.

Continuous ridges, bunds, cuttings and cliff lines are **not** what this looks for, however narrow: each of them forms a long cluster, or fails the extremum test, and is left alone. The one case to check before correcting is a crest whose own cells step by more than a cell width at a time — that can be flagged. Border cells are never flagged.

Flags appear in three places: the solve diagnostics (count and largest deviation from the ring median), a **Suspect terrain cells** overlay on the map under Layers → Terrain — click a marker for the cell's height and what correcting it would put there — and the terrain line of the PDF report.

**Correction is off by default.** Flagging reports; correcting is a modelling decision. Tick **Correct suspect terrain cells** in Settings → Environment and each flagged cell takes the median of its eight-neighbour ring — and nothing else is ever altered. Correcting can expose a residual (an uneven 2×2 smear flags only its worst cell first), so the pass repeats until nothing is left to flag, bounded at three passes in all, and reports how many cells moved and by how much. Sources, receivers, grid cells and wall feet stand on the corrected surface too, so a corrected cell is not left with a receiver floating over it.

## Attribution

The credit for whichever dataset was used travels with the results: it joins the base-map attribution on the map and is printed in the PDF title block. If you export a figure elsewhere, carry it with you.

| Source | Credit | Licence |
|---|---|---|
| GA DEM-S | Elevation: Geoscience Australia, SRTM-derived 1 Second DEM-S v1.0 (CC BY 4.0) | CC BY 4.0 |
| QLD LiDAR DTM | Elevation: © State of Queensland (Department of Natural Resources and Mines, Manufacturing, and Regional and Rural Development); © Commonwealth of Australia (Geoscience Australia) | See service metadata |
| AWS Terrain Tiles | Elevation: AWS Terrain Tiles (Mapzen terrarium) | Public-domain and openly licensed sources; see the AWS Terrain Tiles attribution |

The Queensland licence is **not confirmed**: no published record names this endpoint, and the two records for the sibling public elevation service disagree with each other. Both of them permit use with attribution, which is why the service's own copyright text is carried verbatim above, but the licence name is left unclaimed rather than guessed.
