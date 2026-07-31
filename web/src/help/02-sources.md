---
title: Sources
section: Building a model
---

Three kinds: **WTG** (wind turbines), **BESS** (battery enclosures with fan noise) and **Auxiliary** (transformers, inverters, anything else).

Each source references a **catalog model** supplying the per-band sound power; a **mode** picks one of several emission conditions (e.g. NRO+0, full fan speed). BESS and auxiliary units default to a 1.5 m emission height; WTGs use their hub height.

Wind speed sets the operating-mode lookup for WTG catalog entries that report per-wind-speed spectra. Set it once at the project level — it is not a receiver-by-receiver knob.

## Source containers

BESS and auxiliary units can be modelled as their physical enclosure — a screening box with the acoustic centre just above the roof — rather than a bare point. Enable it in Settings, Sources tab.

Expect most of the change at close receivers. Because each unit's source sits above its own roof, a unit only screens a neighbour once the ray descends below that neighbour's roofline. Across a flat, uniform row that is worth roughly 1 to 2 dB inside about 100 m, and tends to zero by 200 m.
