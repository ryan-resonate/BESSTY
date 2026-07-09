// The pyo3 `#[pyfunction]`/`#[pymethods]` macros expand to code clippy flags as
// `useless_conversion` on the return types; it's macro noise, not our code.
#![allow(clippy::useless_conversion)]

//! Python bindings for the ISO 9613-2 engine (PyO3, abi3).
//!
//! Thin wrappers over the core crate's JSON seam ([`iso9613_core::scene::
//! solve_json`]) and the stateful `Session`. Scenes and results cross the
//! boundary as JSON strings — the Python side owns any typed model, so this
//! surface never has to mirror the Rust types.
//!
//! ```python
//! import iso9613, json
//! results = json.loads(iso9613.solve(json.dumps(scene)))
//! # or interactive:
//! s = iso9613.Session(json.dumps(scene))
//! s.set_source_lw("stack", [95.0]*10)
//! results = json.loads(s.solve())
//! ```

use iso9613_core::scene::{self, Receiver, Scene, Session as CoreSession};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

/// Solve a JSON-encoded scene, returning JSON-encoded results.
///
/// The GIL is released around the (potentially long, multi-threaded) solve so
/// other Python threads keep running: the borrowed `scene_json` is copied to an
/// owned `String` first, then `allow_threads` runs the pure-Rust compute.
#[pyfunction]
fn solve(py: Python<'_>, scene_json: &str) -> PyResult<String> {
    let owned = scene_json.to_owned();
    py.allow_threads(move || scene::solve_json(&owned)).map_err(PyValueError::new_err)
}

/// Solve using a private rayon pool with `max_threads` workers (0 = all cores).
#[pyfunction]
#[pyo3(signature = (scene_json, max_threads = 0))]
fn solve_parallel(py: Python<'_>, scene_json: &str, max_threads: usize) -> PyResult<String> {
    let scene: Scene =
        serde_json::from_str(scene_json).map_err(|e| PyValueError::new_err(format!("scene JSON: {e}")))?;
    // Release the GIL for the rayon fan-out — otherwise the whole interpreter is
    // frozen for the duration of the parallel solve.
    let results = py
        .allow_threads(|| scene::solve_par(&scene, max_threads))
        .map_err(|e| PyValueError::new_err(e.to_string()))?;
    serde_json::to_string(&results).map_err(|e| PyValueError::new_err(e.to_string()))
}

/// Stateful, incremental solver — caches the obstacle decomposition across edits.
#[pyclass]
struct Session {
    inner: CoreSession,
}

#[pymethods]
impl Session {
    /// Build from a JSON-encoded scene.
    #[new]
    fn new(scene_json: &str) -> PyResult<Self> {
        let scene: Scene = serde_json::from_str(scene_json)
            .map_err(|e| PyValueError::new_err(format!("scene JSON: {e}")))?;
        let inner = CoreSession::new(scene).map_err(|e| PyValueError::new_err(e.to_string()))?;
        Ok(Self { inner })
    }

    /// Full solve → JSON results. Releases the GIL for the compute.
    fn solve(&self, py: Python<'_>) -> PyResult<String> {
        let res = py.allow_threads(|| self.inner.solve());
        serde_json::to_string(&res).map_err(|e| PyValueError::new_err(e.to_string()))
    }

    /// Replace the receivers (JSON array). Cheap — no obstacle re-decomposition.
    fn set_receivers(&mut self, receivers_json: &str) -> PyResult<()> {
        let receivers: Vec<Receiver> = serde_json::from_str(receivers_json)
            .map_err(|e| PyValueError::new_err(format!("receivers JSON: {e}")))?;
        self.inner.set_receivers(receivers).map_err(|e| PyValueError::new_err(e.to_string()))
    }

    /// Retune one source's per-band sound power. Returns whether the id existed.
    fn set_source_lw(&mut self, id: &str, lw: Vec<f64>) -> PyResult<bool> {
        self.inner.set_source_lw(id, lw).map_err(|e| PyValueError::new_err(e.to_string()))
    }
}

#[pymodule]
fn iso9613(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(solve, m)?)?;
    m.add_function(wrap_pyfunction!(solve_parallel, m)?)?;
    m.add_class::<Session>()?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
