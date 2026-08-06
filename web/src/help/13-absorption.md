---
title: Barrier absorption (α)
section: Reference
---

Each barrier carries a **sound absorption coefficient α**, edited in the Barriers tab. It only does anything when **Reflections** is switched on: it sets how much energy the wall absorbs when sound bounces off it.

## What the number means

α is the fraction of incident sound **energy** not reflected back. ISO 9613-2 section 7.5 is written in terms of the *reflection* coefficient ρ (its Table 4) and applies `10 · lg ρ`; α is simply its complement, ρ = 1 − α, so a reflected ray loses

`10 · log10(1 − α)` decibels

Two things to know about how BESSTY differs from the letter of the standard:

- §7.5 states its reflection method applies to surfaces with **ρ > 0.2**, i.e. α below about 0.8. BESSTY does not enforce that cutoff, so the highly-absorptive end of the table below is an extrapolation — it keeps energy the standard would simply neglect, which is the conservative direction, but it is not §7.5 behaviour.
- α here is a single broadband number, whereas real absorption varies strongly with frequency.

The scale:

| α | Reflection loss | In practice |
| --- | --- | --- |
| 0 | 0 dB | Perfectly reflecting — dense concrete, steel, glass |
| 0.1 | −0.5 dB | **Default.** A normal hard acoustic barrier |
| 0.3 | −1.5 dB | Lightly absorptive facing |
| 0.5 | −3.0 dB | Genuinely absorptive treatment |
| 0.9 | −10 dB | Heavy absorptive lining |
| 1.0 | no reflection at all | The surface is removed from the reflection calculation |

Notice how forgiving the scale is: going from a hard wall to α = 0.3 removes only 1.5 dB from the **reflected** path. Absorptive treatment on a barrier usually buys much less than people expect, which is exactly why it is worth modelling rather than assuming.

How much that 1.5 dB matters at the receiver depends entirely on how the reflected path compares with the direct one. Where both are unobstructed the reflection is the weaker contributor and treating the wall changes little. **The case where it matters most is the one barriers are built for**: when the wall screens the direct path but a reflection reaches the receiver unscreened — off a facade, another barrier, or a container row — the reflected path can dominate the total, and absorption on the reflecting surface is then doing real work. Look at which paths are actually screened before deciding treatment is not worth it.

## This is not NRC

**Do not paste an NRC value in here.** NRC (Noise Reduction Coefficient) is the arithmetic mean of the absorption coefficients at 250, 500, 1000 and 2000 Hz, rounded to the nearest 0.05. It is a single-number product-marketing figure, and it is an average of the same underlying quantity — but averaged over only four bands, and rounded.

Two consequences:

- An NRC will usually be **higher** than the α that matters at the frequencies driving your result. BESS and turbine noise is weighted toward the lower bands, where absorptive products perform worst.
- α here is applied at **every** band. BESSTY does not currently vary α with frequency, so one number has to represent the whole spectrum. Choose it for the bands that matter to your assessment, not the flattering average.

If you have a datasheet with per-band α, use the value at the dominant band of your source rather than the NRC. If all you have is NRC, treat it as an optimistic bound and consider something lower.

## Two things that decide whether a wall reflects at all

**A surface has to be big enough.** ISO 9613-2 (Eq 26/27) only accepts a reflection where the facade is large enough to be specular at that wavelength — the test scales with the surface's effective size against the wavelength and the path lengths. A short wall therefore reflects the high bands and simply does not reflect the low ones, and the effect is strong: an 8 m tall wall beside a 200 m path reflects nothing below roughly 550 Hz, while a 20 m wall reflects from about 125 Hz up. This is physics, not a threshold anyone chose, but it does mean a modest acoustic barrier returns far less low-frequency energy than its length suggests.

The size that counts is the wall **as you drew it**. Each straight run between the vertices you clicked is one reflecting surface, so splitting a long wall into many short segments while drawing will reduce the reflection it produces.

**Reflected levels are currently under-estimated.** A known limitation: a reflected path is also being screened by the very wall it reflects off, which costs it up to 20 dB (the standard's single-edge diffraction cap) for a tall wall. Reflections are off by default and flagged provisional, so no default result is affected — but treat the *magnitude* of a reflection as a lower bound for now. The absorption behaviour described above is unaffected: it scales the reflected path correctly whatever that path's level.

## What is not modelled

- **Frequency-dependent α.** The engine supports per-band absorption; BESSTY sends a single broadband value. If per-band matters for your project, say so and it can be exposed.
- **Transmission through the barrier.** ISO 9613-2 has no transmission term, so barrier surface density is stored but unused. A barrier is assumed heavy enough that flanking, not transmission, governs.
- **Container facades.** Source containers reflect at α = 0, a perfectly reflecting box, and this is deliberately not adjustable yet. Fixing it means any reflection effect you see from a container row is the geometry rather than a tuned number.
