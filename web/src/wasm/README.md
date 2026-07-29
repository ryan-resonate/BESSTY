# `web/src/wasm/` — generated WebAssembly build

**Everything in this directory except this file is generated and gitignored.**
Do not edit; do not commit the artifacts.

Rebuild after any change to `solver/crates/iso9613-*`:

```bash
npm run build:wasm     # from web/ — wasm-pack build --target web
```

Source: `solver/crates/iso9613-wasm` (bindings) over `solver/crates/iso9613-core`
(the physics — ISO 9613-2:1996 + :2024, validated against all 19 ISO/TR 17534-3
conformance cases). Built with `wasm-opt -Oz`; current size ~436 KB.

## The surface — Scene JSON

The engine is driven by one serialisable `Scene` (sources, receivers, ground,
terrain, obstacles, atmosphere, settings) and returns per-receiver / per-source
band levels. BEESTY builds that object in `src/lib/sceneBuilder.ts`; nothing else
should hand-assemble scene JSON.

```ts
import init, { solve_scene, WasmSession, a_weighted_total } from '../wasm/iso9613_wasm.js';
await init();

// One-shot (point receivers)
const results = JSON.parse(solve_scene(JSON.stringify(scene)));

// Stateful (grid): decompose obstacles/terrain once, then solve tile by tile
const session = new WasmSession(JSON.stringify(scene));
session.set_receivers(JSON.stringify(tileCells));
const tile = JSON.parse(session.solve());
session.free();          // wasm memory is NOT garbage-collected — always free
```

| Export | Purpose |
|---|---|
| `solve_scene(sceneJson) -> string` | one-shot solve → `Results` JSON |
| `new WasmSession(sceneJson)` | stateful solver; caches the obstacle/terrain decomposition |
| `session.set_receivers(json)` | swap the receiver batch (cheap — no re-decomposition) |
| `session.solve() -> string` | solve the current batch → `Results` JSON |
| `session.n_receivers()` | diagnostics |
| `session.free()` | release wasm memory (required) |
| `a_weighted_total(bands) -> number` | A-weighted total of a band array (10 or 31), used after the web adds its own `DΩ` |
| `octave_centres()`, `octave_a_weighting()` | nominal labels / weights for charts |

### Error handling

**No export panics.** Malformed JSON, a scene that fails validation, or a bad
band count throw a normal JS `Error` carrying the core's message (e.g.
`"terrain: heights length must equal nx·ny"`). The wasm instance stays usable
afterwards, so callers can catch and continue. Wrap solves in `try/catch` and
surface `e.message`.

### Schema notes (JSON representation)

- `standard`: `"iso9613-2:1996"` | `"iso9613-2:2024"`
- Tagged enums use `type` + snake_case: source kinds
  (`{type:"general"}`, `{type:"wind_turbine", rotor_diameter_m, apply_concave}`),
  obstacles (`{type:"wall"|"building"|"solid", …}`), terrain
  (`{type:"heightfield", origin, spacing, nx, ny, heights}`)
- `settings.ground_method`: kebab-case (`"general"` | `"simplified"`)
- Positions are `[e, n, z_abs]` in **local metres** (project origin), `z_abs`
  absolute elevation; `height_agl` is height above local ground — two distinct
  datums, both required.

`validation/smoke_wasm.mjs` is the contract test for all of the above
(`node validation/smoke_wasm.mjs`).
