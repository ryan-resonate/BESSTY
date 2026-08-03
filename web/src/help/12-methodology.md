---
title: Acoustic methodology
section: Reference
---

The solver implements ISO 9613-2, both the 1996 and 2024 editions, validated against all 19 ISO/TR 17534-3 conformance cases to within 0.05 dB on the total level.

- **Adiv** (section 7.1) — geometric divergence, `20*log10(d) + 11`.
- **Aatm** (section 7.2 and ISO 9613-1 section 8) — atmospheric absorption as a closed form per band, from the project temperature, humidity and pressure.
- **Agr** (section 7.3.1, General method) — three-region ground attenuation with the published shape functions.
- **Abar** (section 7.4) — diffraction over walls, buildings and 3-D solids, single and multi-edge. **Lateral diffraction (section 7.4.3) is implemented**, rebuilt in the tilted lateral plane so receivers above a roofline agree with reference tools.
- **Terrain** — a DEM-sampled height raster is handed to the solver, which treats any ridge breaking line of sight as a diffracting edge.
- **Annex D** — wind-turbine specifics: ground-factor cap of 0.5, receiver-height clamp of 4 m, elevated source for barriers (hub plus rotor radius), the barrier cap, and the concave-ground correction.

Cluster aggregation uses a Barnes-Hut treecode to fold distant source groups into a single virtual point for the contour grid. Named receivers always solve every source directly, with no clustering.

## Reflections

Specular reflection off barriers and source-container facades is available, and **off by default** — switch it on per project in Settings, Sources tab. Barriers carry their own absorption (see Barrier absorption); container facades are perfectly reflecting.

The engine implements first-order reflection plus the 2024 higher-order and cylindrical cases, all conformance-validated against ISO/TR 17534-3 case T19. BESSTY currently supplies flat facades only, so cylindrical reflectors are unused.

Higher orders are bounded: the engine refuses to enumerate more than 100 000 reflection paths, which caps a scene at 46 reflecting surfaces at order 3. BESSTY keeps the facades nearest the source-to-receiver corridor and lowers the order automatically rather than failing the solve, so a large site may silently run at a lower order than requested.

Not yet A/B tested against SoundPLAN through BESSTY — treat reflected results as provisional.
