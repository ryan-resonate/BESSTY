---
title: Settings
section: Reference
---

Settings open in a floating window from the gear button on the map, grouped into five tabs. The window is non-modal, so the map stays live while you adjust things.

## Calculation

- **Band system** — octave (10 bands) is faster; one-third octave (31 bands) catches narrowband content.
- **Standard** — ISO 9613-2:1996 or :2024. They differ in the ground-effect geometry factor, the barrier `Dz` bracket and `Kmet`, plus the 2024-only annexes.
- **Solid-angle correction** — 0 dB is the default (strict ISO 9613-2, matching SoundPLAN); +3 dB matches common practice that folds in the ground-reflection boost.
- **Cmet** — meteorological correction per section 8.
- **Barrier diffraction** — optional per-band cap on `Dz` for non-WTG sources. WTGs use the Annex D cap independently.

## Compliance

- **Limit comparison** — by default the level rounds to the nearest integer before being compared, so 40.4 dB does not exceed a 40 dB limit. Switch to **Exact** for jurisdictions that compare unrounded. Only the level rounds; the limit is taken as entered. Displayed numbers never change, so this affects the pass/fail colour only.

## Environment

- **Ground** — default G factor (0 hard, 1 porous). Annex D caps at 0.5 for WTGs regardless.
- **Atmosphere** — temperature and relative humidity drive ISO 9613-1 absorption.
- **Topography** — DEM despiking strength. Terrain screening is evaluated by the solver from a sampled height raster.

## Sources

- **Source containers** — model BESS and auxiliary units as screening boxes. Point-receiver and grid calculations toggle independently, because a grid pays for the extra obstacles at every cell.
- **Annex D** — wind-turbine specifics: barrier cap, elevated source for barriers, concave correction, receiver-height clamp.
- **General sources** — default receiver height.

## Performance

- **Contour grid spacing** — cell size for the raster.
- **Propagation cutoffs** — distance cutoff, and Barnes-Hut theta for source clustering. Lower theta is more accurate and slower.
- **Drag extrapolation caps** — when extrapolation during a drag exceeds these, the display clamps and a re-snapshot is queued.
