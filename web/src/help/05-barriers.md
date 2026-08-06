---
title: Barriers
section: Building a model
---

Click **+ Barrier**, then click to drop each wall vertex. **Right-click**, double-click or press **Enter** to finish; clicking the **first vertex** (it turns green as you hover it) closes the wall into a ring. A wall can be a single straight segment or a multi-vertex polyline that bends around a site. Each barrier carries a top height in metres above local ground, edited inline in the Barriers tab.

The solver applies `Abar` per ISO 9613-2 section 7.4 along every source to receiver path the wall intersects, combining the per-band `Dz` with `Agr`.

While drawing: **Backspace** removes the last vertex, **Esc** cancels. After placing a wall, select it to drag any vertex or the whole line.

## Closing a wall into a ring

Clicking the first vertex closes a wall into a loop, and that is the right way
to model a continuous enclosure. The solver then treats it as one unbroken
screen with no free ends, so there is no path around the ends — because there
are none. Every edge still screens, including the closing one.

Drawing the same enclosure as four separate walls is a different model: it
leaves eight free ends for sound to diffract around, and reads several decibels
louder at receivers off a corner (about 7 dB in a 30 m square test case). Use
separate walls only when the gaps are real.
