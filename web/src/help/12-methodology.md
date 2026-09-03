---
title: Acoustic methodology
section: Reference
---

The solver implements ISO 9613-2, both the 1996 and 2024 editions, validated against all 19 ISO/TR 17534-3 conformance cases to within 0.05 dB on the total level.

- **Adiv** (section 7.1) — geometric divergence, `20*log10(d) + 11`.
- **Aatm** (section 7.2 and ISO 9613-1 section 8) — atmospheric absorption as a closed form per band, from the project temperature, humidity and pressure.
- **Agr** (section 7.3.1, General method) — three-region ground attenuation with the published shape functions.
- **Abar** (section 7.4) — diffraction over walls, buildings and 3-D solids, single and multi-edge. **Lateral diffraction (section 7.4.3) is implemented**, rebuilt in the tilted lateral plane so receivers above a roofline agree with reference tools.
- **Terrain** — a DEM-sampled height raster is handed to the solver, which treats any ridge breaking line of sight as a diffracting edge. Which DEM, at what pitch, and what the QA pass flags in it: see Terrain data.
- **Annex D** — wind-turbine specifics: ground-factor cap of 0.5, receiver-height clamp of 4 m, elevated source for barriers (hub plus rotor radius), the barrier cap, and the concave-ground correction.

## Source clustering (Barnes-Hut)

Sites with hundreds of units would otherwise evaluate every source against every receiver. BESSTY builds an adaptive quadtree over the sources; each node stores the energy sum of its members' sound-power spectra, their energy-weighted centroid and mean height, and its bounding-box diagonal `s`.

Walking the tree for a receiver at distance `d` from a node, the acceptance test `s / d < θ` decides between collapsing that whole branch to one virtual source at the centroid, or recursing into it. Contour grids walk the tree once per 16 by 16 cell tile, measuring `d` from the nearest point of the tile, so a cluster is only collapsed when it is far from the entire tile. Cells sitting among the sources keep every source individually, which is why a grid drawn over the site itself is barely affected by θ — the speed of that case comes from the solver, not the tree.

Wind turbines are never folded into a cluster: the walk recurses until each turbine is an individual source, so its Annex D treatment survives.

Because the centroid is energy-weighted, first-order position errors cancel and the aggregate error is second order in `s/d` — well under a decibel at the default θ of 0.25. Two caveats: screening is evaluated along the centroid ray only, so a cluster straddling a barrier edge or a ridge line smears members that are actually screened differently; and **θ at or above 1 carries no error guarantee at all**, since a member can then sit arbitrarily close to the receiver. Treat high θ as a stress test, not a setting for reportable results. Set θ to 0 to disable clustering entirely. The setting accepts up to 3 so the behaviour can be explored, but nothing above about 0.5 belongs in a reported result.

### Seeing it

Layers → Debug → **Barnes-Hut clustering** draws the grouping the solver actually used. One box per grid tile, labelled with the number of sources that tile solved and how many of those were cluster stand-ins, coloured by how much merging happened. Clicking a tile outlines each stand-in over the region it replaced, with its member count and combined sound power. It runs the same tree and the same per-tile walk the solver does, so what it draws is what was computed — not a reconstruction that could drift.

## Reflections

Specular reflection off barriers and source-container facades is available, and **off by default** — switch it on per project in Settings, Sources tab. Barriers carry their own absorption (see Barrier absorption); container facades are perfectly reflecting.

The engine implements first-order reflection plus the 2024 higher-order and cylindrical cases, all conformance-validated against ISO/TR 17534-3 case T19. BESSTY currently supplies flat facades only, so cylindrical reflectors are unused.

Higher orders are bounded: the engine refuses to enumerate more than 100 000 reflection paths, which caps a scene at 46 reflecting surfaces at order 3. BESSTY keeps the facades nearest the source-to-receiver corridor and lowers the order automatically rather than failing the solve, so a large site may silently run at a lower order than requested.

Not yet A/B tested against SoundPLAN through BESSTY — treat reflected results as provisional.
