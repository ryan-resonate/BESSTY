---
title: Settings
section: Reference
---

Settings open in a floating window from the **gear button in the top-right of the side panel**, grouped into five tabs. The window is non-modal, so the map stays live while you adjust things — drag it out of the way rather than closing it.

## Calculation

- **Band system** — octave (10 bands) is faster; one-third octave (31 bands) catches narrowband content. Source data held in the other band system is folded automatically: third-octave to octave by energy sum, octave to third-octave by distributing equally across the three children.
- **Standard** — ISO 9613-2:1996 or :2024. They differ in the ground-effect geometry factor, the barrier `Dz` bracket and `Kmet`, plus the 2024-only annexes.
- **Solid-angle correction** — 0 dB is the default (strict ISO 9613-2, matching SoundPLAN); +3 dB matches common practice that folds in the ground-reflection boost.
- **Cmet** — meteorological correction per section 8.
- **Barrier diffraction** — optional per-band cap on `Dz` for non-WTG sources. WTGs use the Annex D cap independently. If a barrier is attenuating less than its geometry suggests, check this setting first: a 2 dB cap clamps `Dz` far below what ISO section 7.4 would give.

## Compliance

- **Limit comparison** — by default the level rounds to the nearest integer before being compared, so 40.4 dB does not exceed a 40 dB limit. Switch to **Exact** for jurisdictions that compare unrounded. Only the level rounds; the limit is taken as entered. Landing exactly on the limit passes either way. Displayed numbers never change, so this affects the pass/fail colour only.

## Environment

- **Ground** — default G factor (0 hard, 1 porous). Annex D caps at 0.5 for WTGs regardless.
- **Atmosphere** — temperature and relative humidity drive ISO 9613-1 absorption.
- **Topography** — DEM despiking strength. Terrain screening is evaluated by the solver from a sampled height raster.

## Sources

- **Source containers** — model each BESS and auxiliary unit as its physical enclosure: a screening box using the product's footprint and container height, with the acoustic centre just above the roof. Units then shade each other within a row.

  Dimensions come from the catalog product, falling back to a kind default (BESS 2.6 m tall, auxiliary 2.2 m) when the product does not pin one. Set exact dimensions per product in the catalog, or per unit with the table button on a source.

  The point-receiver and grid toggles are independent because a contour grid pays for the extra obstacles at every cell — it is common to want the detail on reported receiver levels but not on a whole-site map.

  Expect the change at close receivers. Because each unit's source sits above its own roof, a unit only screens its neighbour once the ray descends below that neighbour's roofline. Across a flat, uniform row that is worth roughly 1 to 2 dB inside about 100 m, tending to zero by 200 m, where what remains is the acoustic centre being lifted to roof height.
- **Annex D** — wind-turbine specifics: barrier cap, elevated source for barriers, concave correction, receiver-height clamp.
- **General sources** — default receiver height.

## Performance

- **Contour grid spacing** — auto-picked from the calculation area when it is first created; choose a value to override and your choice sticks.
- **Max contribution distance** — sources further than this from a receiver are skipped entirely. Default 20 km; set 0 to disable.
- **Tree acceptance θ** — the Barnes-Hut clustering tolerance, default 0.25. Lower is more literal and slower. See Methodology for what it does, and why values at or above 1 carry no error guarantee at all.
