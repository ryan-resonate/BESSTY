# Auto-differentiation strategy

The core trick: cache `SPL` *and* `∇SPL` for every source-receiver-band combination on full recompute. On the next drag, predict the new `SPL` via first-order Taylor:

```
SPL_new ≈ SPL_old + Σᵢ ∂SPL/∂xᵢ · Δxᵢ
```

This lets the renderer paint a plausibly correct contour every frame without waiting for an exact recompute. The exact recompute streams in behind, ordered by per-receiver predicted error.

## 1. Mode of differentiation: forward-mode

**Forward-mode** (dual numbers) propagates derivatives alongside primal values through the computation. Cost is `O(n_inputs × eval_cost)`.

**Reverse-mode** (backprop) propagates adjoints from output back to inputs. Cost is `O(n_outputs × eval_cost)`.

Our use pattern:
- Few inputs change at a time — typically 3 (one source's xyz) up to ~12 (a small group of sources/barriers being dragged together).
- Many outputs — every receiver in the grid (90 000+) and every band (8).

Forward-mode wins decisively. We pay 3–12× per evaluation; reverse-mode would pay 720 000× (8 bands × 90 000 receivers).

## 2. Dual numbers — `dual.rs`

A `Dual<N>` carries one primal scalar plus N partial derivatives:

```rust
#[derive(Copy, Clone)]
pub struct Dual<const N: usize> {
    pub v: f64,           // primal value
    pub d: [f64; N],      // ∂v/∂xᵢ for i = 0..N
}

impl<const N: usize> Add for Dual<N> {
    fn add(self, rhs: Self) -> Self {
        let mut d = [0.0; N];
        for i in 0..N { d[i] = self.d[i] + rhs.d[i]; }
        Dual { v: self.v + rhs.v, d }
    }
}

impl<const N: usize> Mul for Dual<N> {
    fn mul(self, rhs: Self) -> Self {
        let mut d = [0.0; N];
        for i in 0..N { d[i] = self.v * rhs.d[i] + rhs.v * self.d[i]; }
        Dual { v: self.v * rhs.v, d }
    }
}
```

And so on for sub, div, sqrt, ln, exp, sin, cos, atan2.

Inputs we differentiate (per source-receiver pair, when relevant):
- Source position: `e_s`, `n_s`, `z_s` (3)
- Receiver position: `e_r`, `n_r`, `z_r` (3)
- Source yaw: `θ_s` (only if directivity present, 1)
- Each barrier-edge top elevation along the diffracted path: `z_bar_i` (only if barriers in path, variable)

`N` is set per evaluation context — small (≤ 12) in practice. We use `const N` generics so the dual array is stack-allocated; no heap.

For full-grid recompute when nothing is being dragged, we compute with `N = 0` (just the primal, fastest) and don't cache gradients — only fill them in when an interaction begins.

## 3. The interaction lifecycle

### 3.1 Idle state

Cached: per-receiver-per-band `SPL_total` (sum over all sources). 90 000 × 8 × 4 B = 2.9 MB.

No gradients cached. CPU idle.

### 3.2 Drag begins

User mousedowns on source `s_k`. Orchestrator:

1. Issues a **snapshot ticket** for `s_k`: compute `s_k`'s contribution to every receiver, store at `per_source_grid[s_k]`. Cost: ~1 worker-second for one source × 90 000 receivers.
2. Issues a **gradient ticket** for `s_k`: same pairs, but with `Dual<3>` tracking `(e_s, n_s, z_s)`. Stores `∂SPL/∂{e,n,z}` per receiver per band into `gradient_grid[s_k]`.
3. Compute `SPL_other = SPL_total − contribution(s_k)` once. Cache.

Until both tickets complete, the UI shows the existing `SPL_total` (no extrapolation possible). Should take <1 second.

### 3.3 Drag in progress

User moves mouse. Orchestrator computes `Δ = (e_new, n_new, z_new) − (e_old, n_old, z_old)`. For every receiver:

```
contribution_new = contribution_old + (∂SPL/∂e · Δe + ∂SPL/∂n · Δn + ∂SPL/∂z · Δz)   per band
SPL_total_new   = SPL_other ⊕ contribution_new                                         per band
```

Where `⊕` is the dB-energy-sum (Eq 6).

This is pure SIMD-friendly arithmetic on the orchestrator: 90 000 × 8 multiplies + adds per drag frame. Trivially under a millisecond.

The new grid is written into the SAB. Renderer paints it next frame.

### 3.4 Behind the scenes during drag

- Orchestrator monitors per-receiver Taylor-vs-cumulative-Δ magnitude.
- Receivers with `|gradient · Δ| > tolerance` (e.g. 1 dB) are enqueued for exact recompute. Workers process the queue; results overwrite the SAB cells in place.
- Tripwire-flagged pairs jump the queue.
- Periodically (every ~200 ms) the orchestrator picks 5 % of receivers at random for exact recompute even if their predicted error is small. The discrepancy between Taylor-predicted and exact gives a calibration of the local error model.

### 3.5 Drag ends

User releases mouse. Orchestrator:

1. Issues a final full-grid exact recompute for `s_k` (ground truth).
2. Discards gradient grid for `s_k` once recompute completes (frees memory).
3. `per_source_grid[s_k]` may be retained briefly in case the user re-grabs.

## 4. Error estimation

Two complementary mechanisms:

### 4.1 Predicted error (cheap, per-receiver)

For first-order Taylor, the residual after step Δ is `½ Δᵀ H Δ + O(|Δ|³)`, where `H` is the Hessian of `SPL` w.r.t. inputs.

Computing the full Hessian is expensive. We use the **diagonal-Hessian** approximation:

```
err_predicted ≈ ½ Σᵢ |∂²SPL/∂xᵢ²| · Δxᵢ²
```

The diagonal-only Hessian costs roughly 2× the gradient (compute `Dual<2N>` with second-order tape, or finite-difference the gradient). We only compute it on the snapshot tick (drag begin), not on every frame. The diagonal Hessian is stored alongside the gradient, and the orchestrator scales it by `Δᵢ²` each frame to estimate per-receiver error.

This catches **smooth** error (curvature) but misses **discontinuity-crossing** error.

### 4.2 Sampled exact-vs-Taylor (catches discontinuity error)

5 % of receivers per ~200 ms are recomputed exactly while the drag continues. The orchestrator compares the Taylor prediction to the exact value. If the discrepancy exceeds the diagonal-Hessian estimate by a factor of >2 across multiple sample points, the orchestrator triggers an immediate full-grid refresh (not just queue).

This is a heuristic tripwire on top of the explicit-discontinuity tripwires in §5 of `solver-design.md`. It catches errors we missed (e.g. DEM-cell crossings the orchestrator isn't tracking precisely).

## 5. Discontinuity handling

ISO 9613-2 has several piecewise-defined places where the gradient is non-smooth. From `solver-design.md` §5:

| Site | Strategy |
|---|---|
| Ground middle-region threshold (`dp = 30(hS+hR)`) | Hard switch + tripwire (refresh if within ±5 %) |
| Barrier `zmin` | Hard switch + tripwire (within ±0.1 m) |
| Dz cap (20 / 25 dB or Annex D 3 dB) | Hard switch + tripwire (within ±0.5 dB), zero gradient above |
| `max(Δzn)` over edges | Tripwire when top-2 edges within 0.1 m, refresh on swap |
| LOS blocked / not | Tripwire when path within 0.5 m of edge |
| Annex D.5 concave (`hm = 1.5·(hS+hR)/2`) | Tripwire (within ±5 %) |
| DEM cell boundary | Sampled exact-vs-Taylor catches it |
| Reflector validity (Eq 26) | Tripwire when `λ` near critical for any reflector |

**Why not smooth approximations?** I considered using softmax / softplus to make the discontinuities differentiable everywhere. Rejected for v1 because:

- They introduce systematic bias (the smoothed value is wrong by some amount everywhere, not just near the threshold).
- The acoustic standard is what it is — smoothing changes the result. Practitioners reading our output need to be able to reproduce it from the standard with a calculator.
- The tripwire approach gives us *exact ISO results* with *fast updates everywhere except near discontinuities*, where we revert to fresh recomputes (still fast — single-receiver evals are cheap).

## 6. Multi-source AD

When the user drags multiple sources at once (a group), each source contributes its own gradient w.r.t. its own xyz. The orchestrator allocates `Dual<3·M>` per pair where `M` is the number of dragged sources, but only for pairs that touch one of the dragged sources (i.e., we don't differentiate other sources' contributions w.r.t. the dragged sources — those are zero).

For `M` up to ~5, the cost stays manageable. For larger groups, the orchestrator falls back to "freeze the visual, recompute exactly, repaint when done" — accepting a brief unresponsive moment per the user's accepted trade-off.

## 7. Barrier-height gradient (priority interaction)

**Barrier height is the most common interactive parameter** — practitioners adjust barrier height far more often than barrier position to test compliance. Height gradients must therefore be **first-class and pre-warmed**: the moment a user *selects* a barrier (mousedown on its handle, click on its row in the side panel, or any focus event), the orchestrator immediately:

1. Issues a snapshot ticket for every source-receiver pair whose diffracted ray passes over any of that barrier's top edges.
2. Issues gradient tickets with `Dual<n_edges>` tracking the elevation of each top-edge node on the barrier.
3. Caches the result so that any subsequent height drag is purely Taylor extrapolation — first frame is sub-millisecond.

This is in contrast to source-position gradients which are computed lazily on drag-start. Barrier-height interactions are common enough that the latency of the snapshot is unacceptable on first drag.

### Which pairs include which edges

The orchestrator maintains a "barrier-pair touch index": for each (source, receiver) pair, the list of barrier-top-edge node IDs that participate in the rubber-band diffraction path. Updated when:

- A barrier is added or moved (re-runs the rubber-band path-finding for affected pairs).
- A source or receiver moves significantly (> a few metres).
- A barrier height changes enough to re-rank candidate edges (a tripwire on `max(Δzn)` from Eq 23).

Pairs whose ray goes around the barrier laterally (Eq 25) without including its top edges as nodes contribute zero gradient w.r.t. those edges — they're omitted from the gradient tape entirely.

### Smooth height drag

For a smooth interaction:

- Pre-warming completes within ~100 ms of selection (sub-second worst case for 30 sources × 90 000 receivers if every pair touches the barrier; usually only ~1 % of pairs are touched, taking ~10 ms).
- Each frame during drag: per-receiver `Δh` × cached `∂Lp/∂h` per band → O(n_pairs_touched × n_bands) flops, well under 1 ms.
- 20/25 dB cap (or 3 dB Annex D cap): once a pair's `Dz` reaches the cap, its gradient w.r.t. height is zero — but the *cap level* is still affected by Δz, which is a function of barrier height. The tripwire fires when Δz approaches the cap from either side, triggering exact recompute for that pair.

### Why height matters more than position

Practitioners build barriers around fixed obstacles (buildings, plant boundaries) — the position is a constraint, not a knob. Height is the design variable optimised to meet a noise limit. The UI should make height-drag feel as fluid as moving a slider; we engineer the gradient pipeline to ensure that.

### Multi-barrier interactions

When two barriers contribute to the same diffracted path (rubber-band over both), the gradient tape includes both barriers' edge heights. AD propagates correctly through the geometry. Practical limit: a path with > 5 active barrier edges is rare — `Dual<5>` is well within memory and arithmetic budget.

## 8. Yaw gradient (directivity)

For `GeneralPoint` sources with a directivity table:

```
Dc(θ) = interpolate(table, θ - θ_yaw)
```

Where `θ` is the angle source-to-receiver in plan view, `θ_yaw` is the source's yaw. Differentiable w.r.t. `θ_yaw` via chain rule through the interpolation (linear-in-degrees by default; cubic optional).

Gradient w.r.t. yaw is added to the dual tape only when:
- The source has a directivity table.
- The source is currently being dragged for rotation.

WT sources (`Source::WindTurbine`) have no directivity per Annex D.2 — yaw is not a degree of freedom for them.

## 9. Gradient memory budget

For a worst-case interactive moment — dragging 5 sources simultaneously, each with 3-DOF position + 1 yaw, plus 2 barriers with 2 edge heights each:

```
DOF = 5·4 + 2·2 = 24
gradient_grid: 90 000 receivers × 8 bands × 24 DOFs × 4 B = 69 MB
```

Plus 5 × 2.9 MB per-source contribution = 14.5 MB.

Total ~85 MB during a heavy drag. Acceptable for desktop browsers (typical memory budget per tab is 4 GB on Chrome).

For lighter interactions (single source drag), it's ~10 MB.

## 10. Validation hook

Every validation case in `validation/` provides a hand-calculated SPL. The Rust test mirrors of these cases assert primal correctness within tolerance. They also assert gradient correctness via finite-difference: perturb the input by 1 m (or 0.1 m for sensitive cases), recompute, compare slope to AD output. Tolerance: 1e-3 of the predicted gradient magnitude (AD should be exact to floating-point).
