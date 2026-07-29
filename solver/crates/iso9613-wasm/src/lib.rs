//! WebAssembly bindings for `iso9613-core` — the **Scene JSON** surface.
//!
//! The whole engine is driven by one serialisable [`Scene`](iso9613_core::scene::Scene):
//! sources, receivers, ground, terrain, obstacles, atmosphere and settings go in
//! as JSON, per-receiver/per-source band levels come out as JSON. The caller
//! (BEESTY's `sceneBuilder.ts`) owns the mapping from its own project model, so
//! this layer never has to mirror the Rust types.
//!
//! Two entry points:
//! - [`solve_scene`] — one-shot. Build a scene, get results.
//! - [`WasmSession`] — stateful. Caches the obstacle/terrain decomposition across
//!   [`WasmSession::set_receivers`] calls, so a grid is solved tile by tile
//!   without re-decomposing the world each time.
//!
//! **No panics.** Every fallible path returns `Result<_, JsError>`, so a bad input
//! surfaces as a catchable JS exception instead of trapping (and poisoning) the
//! wasm instance. Validation failures carry the core's own message.
//!
//! ```js
//! import init, { solve_scene, WasmSession } from './iso9613_wasm.js';
//! await init();
//! const results = JSON.parse(solve_scene(JSON.stringify(scene)));
//!
//! const session = new WasmSession(JSON.stringify(scene));   // grid: build once
//! session.set_receivers(JSON.stringify(tileCells));         // per tile
//! const tile = JSON.parse(session.solve());
//! session.free();
//! ```

use iso9613_core::scene::{self, Receiver, Scene, Session};
use iso9613_core::{BandSpectrum, BandSystem};
use wasm_bindgen::prelude::*;

/// Route Rust panics to `console.error` with a readable stack. Debug builds only
/// — a release wasm should never panic (every fallible path returns `JsError`),
/// and the hook costs binary size.
/// (The dependency is wasm32-only, so the host build of this crate — which
/// `cargo test --workspace` does — must not see it.)
#[cfg(all(debug_assertions, target_arch = "wasm32"))]
#[wasm_bindgen(start)]
pub fn wasm_main() {
    console_error_panic_hook::set_once();
}

/// Solve a JSON-encoded [`Scene`], returning JSON-encoded results.
///
/// Errors (malformed JSON, failed scene validation) become JS exceptions carrying
/// the core's message — e.g. `"terrain: heights length must equal nx·ny"`.
#[wasm_bindgen]
pub fn solve_scene(scene_json: &str) -> Result<String, JsError> {
    scene::solve_json(scene_json).map_err(|e| JsError::new(&e))
}

/// Stateful, incremental solver — the grid path.
///
/// Construction validates the scene and decomposes its obstacles/terrain once;
/// [`set_receivers`](Self::set_receivers) then swaps in a new batch of receivers
/// (a grid tile) without redoing that work. A rejected `set_receivers` leaves the
/// session untouched and still solvable (the core's mutators are transactional).
#[wasm_bindgen]
pub struct WasmSession {
    inner: Session,
}

#[wasm_bindgen]
impl WasmSession {
    /// Build from a JSON-encoded scene. Fails on malformed JSON or validation.
    #[wasm_bindgen(constructor)]
    pub fn new(scene_json: &str) -> Result<WasmSession, JsError> {
        let scene: Scene = serde_json::from_str(scene_json)
            .map_err(|e| JsError::new(&format!("scene JSON: {e}")))?;
        let inner = Session::new(scene).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Self { inner })
    }

    /// Replace the receiver batch (JSON array of
    /// `{id, position: [e, n, z_abs], height_agl}`). Cheap — no obstacle or
    /// terrain re-decomposition.
    pub fn set_receivers(&mut self, receivers_json: &str) -> Result<(), JsError> {
        let receivers: Vec<Receiver> = serde_json::from_str(receivers_json)
            .map_err(|e| JsError::new(&format!("receivers JSON: {e}")))?;
        self.inner
            .set_receivers(receivers)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Solve the current receiver batch → JSON results.
    pub fn solve(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.solve())
            .map_err(|e| JsError::new(&format!("results JSON: {e}")))
    }

    /// How many receivers are currently loaded (diagnostics).
    pub fn n_receivers(&self) -> usize {
        self.inner.scene().receivers.len()
    }
}

/// Energy-sum a per-band Lp array into one A-weighted total dB(A).
/// 10 bands → octave; 31 → one-third octave. Used by the web after it adds its
/// own `DΩ` term (which the core has no concept of).
///
/// Returns an error rather than trapping for any other band count.
#[wasm_bindgen]
pub fn a_weighted_total(lp_summed: &[f64]) -> Result<f64, JsError> {
    let bs = match lp_summed.len() {
        10 => BandSystem::Octave,
        31 => BandSystem::OneThirdOctave,
        n => {
            return Err(JsError::new(&format!(
                "a_weighted_total: expected 10 (octave) or 31 (third-octave) bands, got {n}"
            )))
        }
    };
    Ok(BandSpectrum::from_iter(bs, lp_summed.iter().copied()).a_weighted_total())
}

/// Octave-band NOMINAL centre frequencies (Hz) — 10 values, for axis labels.
///
/// Nominal labels (…, 4000, 8000). The physics uses the exact ISO 266 base-10
/// centres internally; never feed these back in as physical frequencies.
#[wasm_bindgen]
pub fn octave_centres() -> Vec<f64> {
    iso9613_core::spectrum::OCTAVE_CENTRES_HZ.to_vec()
}

/// Octave-band A-weighting offsets (dB) — 10 values, for chart overlays.
#[wasm_bindgen]
pub fn octave_a_weighting() -> Vec<f64> {
    iso9613_core::spectrum::OCTAVE_A_WEIGHTING_DB.to_vec()
}
