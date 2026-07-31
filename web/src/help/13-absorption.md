---
title: Barrier absorption (α)
section: Reference
---

Each barrier carries a **sound absorption coefficient α**, edited in the Barriers tab. It only does anything when **Reflections** is switched on: it sets how much energy the wall absorbs when sound bounces off it.

## What the number means

ISO 9613-2 section 7.5 uses α exactly as the standard defines it: the fraction of incident sound **energy** not reflected back. A reflected ray loses

`10 · log10(1 − α)` decibels

so the scale is:

| α | Reflection loss | In practice |
| --- | --- | --- |
| 0 | 0 dB | Perfectly reflecting — dense concrete, steel, glass |
| 0.1 | −0.5 dB | **Default.** A normal hard acoustic barrier |
| 0.3 | −1.5 dB | Lightly absorptive facing |
| 0.5 | −3.0 dB | Genuinely absorptive treatment |
| 0.9 | −10 dB | Heavy absorptive lining |
| 1.0 | no reflection at all | The surface is removed from the reflection calculation |

Notice how forgiving the top of the scale is: going from a hard wall to α = 0.3 only removes 1.5 dB from the **reflected** path, and the reflected path is already weaker than the direct one. Absorptive treatment on a barrier buys much less than people expect, which is exactly why it is worth modelling rather than assuming.

## This is not NRC

**Do not paste an NRC value in here.** NRC (Noise Reduction Coefficient) is the arithmetic mean of the absorption coefficients at 250, 500, 1000 and 2000 Hz, rounded to the nearest 0.05. It is a single-number product-marketing figure, and it is an average of the same underlying quantity — but averaged over only four bands, and rounded.

Two consequences:

- An NRC will usually be **higher** than the α that matters at the frequencies driving your result. BESS and turbine noise is weighted toward the lower bands, where absorptive products perform worst.
- α here is applied at **every** band. BESSTY does not currently vary α with frequency, so one number has to represent the whole spectrum. Choose it for the bands that matter to your assessment, not the flattering average.

If you have a datasheet with per-band α, use the value at the dominant band of your source rather than the NRC. If all you have is NRC, treat it as an optimistic bound and consider something lower.

## What is not modelled

- **Frequency-dependent α.** The engine supports per-band absorption; BESSTY sends a single broadband value. If per-band matters for your project, say so and it can be exposed.
- **Transmission through the barrier.** ISO 9613-2 has no transmission term, so barrier surface density is stored but unused. A barrier is assumed heavy enough that flanking, not transmission, governs.
- **Container facades.** Source containers reflect at α = 0, a perfectly reflecting box, and this is deliberately not adjustable yet. Fixing it means any reflection effect you see from a container row is the geometry rather than a tuned number.
