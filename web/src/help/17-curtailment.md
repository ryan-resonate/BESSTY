---
title: Curtailment optimiser
section: Studies
---

For each wind speed and period, works out which mode every turbine should run in so that **every receiver complies for the least generation given up**. Open it from **Results → Curtailment optimiser**.

Each answer is a *proven* optimum, not a good guess: the problem is handed to a mixed-integer solver (HiGHS) that returns the best schedule along with the proof there is no cheaper one. On small farms it has been checked against exhaustive enumeration of every combination.

## What it needs first

- **A power curve for every turbine mode** — the kW row under the spectrum grid in the catalog editor. This is what a quieter mode is priced against. A mode with no power curve makes that turbine unschedulable, and the optimiser will name it rather than guess.
- **Receiver limits.** Scalar per-period limits work. If your conditions vary the limit with wind speed, switch on **Wind-speed limits** in Settings and fill in each receiver's grid.

Wind speeds default to those every turbine's catalog covers — the intersection, because a speed one turbine has no spectrum for cannot be scheduled.

## Reading the table

Turbines down, wind speeds across, one tab per period. Under the modes:

- **Lost kW** — generation given up across the farm at that wind speed.
- **Binding** — the receiver with the least headroom under that schedule. This is the one deciding the answer; everything else has room to spare.
- **Headroom** — how far that receiver sits below its limit.

**Off** means the turbine is stopped for that period. It is always an available choice, which is why a schedule almost always exists.

**Apply** writes that cell's modes into the project as per-period mode overrides, so you can inspect or report the curtailed state. Only that cell's own period is touched, and it is an ordinary undoable edit.

## When a cell cannot be met

Because switching a turbine off is always available, the turbines alone can never make a cell impossible. An infeasible cell therefore means something the optimiser **cannot** switch — a BESS, a substation — is already over the limit at that receiver on its own. The table names the receiver and how far over it is.

## What the schedule assumes

The cap each receiver is held to is the limit, minus:

- any **margin** you set;
- **DΩ**, if the project applies one;
- a **tonality penalty**, if screening and the penalty are both on.

That last one is deliberately conservative. Whether a tone appears depends on the spectrum, which depends on the schedule, so it cannot be known before optimising. Assuming the penalty always applies may curtail slightly more than strictly necessary; assuming it never applies would hand back a schedule that fails its own assessed check.

If the project uses `integer` limit comparison, the half-decibel that rounding allows is included, exactly as it is for the pass/fail badges.

## Speed

The whole sweep runs off **one** acoustic solve. The transfer between a turbine and a receiver depends only on geometry, ground, atmosphere and barriers — never on how loud the turbine is — so every candidate schedule after that first solve is arithmetic. That assumption is checked against the engine in the test suite to within 0.01 dB.

## Export

**XLSX** gives one sheet per period — turbines by wind speed, with the lost-kW, binding-receiver and headroom rows beneath — plus a settings sheet recording the margin, weighting, limit comparison and everything else the run assumed.
