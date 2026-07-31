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

## Not currently modelled

**Reflections.** The engine implements first-order specular reflection, and the 2024 higher-order and cylindrical cases, all conformance-validated. The app supplies no reflecting surfaces, so walls screen without reflecting and no reflected paths contribute.
