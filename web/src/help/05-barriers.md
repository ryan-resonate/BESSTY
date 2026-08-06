---
title: Barriers
section: Building a model
---

Click **+ Barrier**, then click to drop each wall vertex. **Right-click**, double-click or press **Enter** to finish; clicking the **first vertex** (it turns green as you hover it) closes the wall into a ring. A wall can be a single straight segment or a multi-vertex polyline that bends around a site. Each barrier carries a top height in metres above local ground, edited inline in the Barriers tab.

The solver applies `Abar` per ISO 9613-2 section 7.4 along every source to receiver path the wall intersects, combining the per-band `Dz` with `Agr`.

While drawing: **Backspace** removes the last vertex, **Esc** cancels. After placing a wall, select it to drag any vertex or the whole line.

## Closing a wall into a ring

Clicking the first vertex closes a wall into a loop. Be aware of one modelling
consequence: the solver treats a closed ring as a single continuous screen with
no free ends, so it models no path around the ends — because there aren't any.
Drawing the same enclosure as four separate walls instead leaves eight free ends
that sound can diffract around, and can read several decibels louder at
receivers off a corner.

Neither is wrong; they describe different things. A genuinely continuous
enclosure is the ring. Four walls with gaps at the corners are four walls.
Choose the one that matches the site, and don't mix the two conventions within a
project you intend to compare against itself.
