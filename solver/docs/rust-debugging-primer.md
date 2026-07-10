# Debugging Rust — a primer for reviewing `iso9613-core`

You haven't debugged Rust before, so this is practical and specific to this
workspace (Windows 11, PowerShell, the `solver/` Cargo workspace). It goes from
"the fastest useful loop" to "a real step-debugger", and ends with recipes for
*this* engine.

Everything below is run from the workspace root:
`C:\Users\RyanMcKay\...\20260427 BEESTY WF attempt\solver`.

---

## 0. The mental model (30 seconds)

- **`cargo`** is the build tool + test runner + everything. You almost never call
  the compiler directly.
- Rust has **no runtime surprises**: if it compiles, most bugs are logic bugs you
  find with a test + a print, or a real debugger.
- The tests ARE the spec. Every physics term and the 19 ISO/TR conformance cases
  are `#[test]` functions. The fastest review loop is *run one test, change one
  input, re-run*.
- Two build profiles matter: **debug** (default, has overflow checks + debug
  symbols, slower) and **release** (`--release`, optimised, overflow checks OFF).
  Review/debug in the debug profile.

---

## 1. Toolchain sanity

```powershell
rustc --version        # compiler
cargo --version        # build/test tool
rustup component add rust-analyzer   # the IDE brain (if not present)
```

In **VS Code**, install the **`rust-analyzer`** extension (not the old "Rust"
one). It gives you inline types, go-to-definition (F12), find-all-references
(Shift+F12), hover docs, and "Run test | Debug" code-lenses above every `#[test]`.
That alone makes reviewing 10× easier — hover any variable to see its type, click
a function to jump to it.

---

## 2. The fastest loop: run one test

```powershell
# run everything (fast; ~1-2 s to build incrementally)
cargo test -p iso9613-core

# run ONE test by name (substring match)
cargo test -p iso9613-core t07_varying_heights_simplified

# run all tests in one file
cargo test -p iso9613-core --test conformance_tr17534

# a lib (unit) test inside a module
cargo test -p iso9613-core --lib terrain::tests::mean_height
```

**See `println!`/`dbg!` output** — cargo hides stdout for passing tests. Add
`-- --nocapture`:

```powershell
cargo test -p iso9613-core t15_polygonal_building --  --nocapture
```

`cargo check` (type-check only, no codegen) is the fastest "did I break the build"
signal:

```powershell
cargo check -p iso9613-core
```

---

## 3. Print debugging (you'll use this 80% of the time)

### `dbg!` — the workhorse
Wrap any expression; it prints `file:line`, the expression text, and the value,
then **returns the value** so you can drop it inline:

```rust
let delta_z = dbg!(d_ss + e_total + d_sr - l);   // prints and keeps going
```
Output: `[path.rs:362] d_ss + e_total + d_sr - l = 1.66`

### `eprintln!` — formatted, to stderr
```rust
eprintln!("over_top: dss={:.3} e={:.3} Δz={:.3}", g.over_top.d_ss, g.over_top.e_total, g.over_top.delta_z);
```
Format specifiers you'll want:
- `{:?}` — debug form of any `#[derive(Debug)]` type (all our structs have it).
- `{:#?}` — **pretty** (multi-line) debug — great for a whole `BandSpectrum` or `Scene`.
- `{:.3}` — 3 decimal places; `{:.17e}` — full-precision scientific (used by the golden test).

```rust
eprintln!("bands = {:#?}", result.per_receiver[0].per_source[0].bands);
```

Remember `-- --nocapture` to see it. Delete the prints before committing (or leave
a `// TODO` — clippy won't complain about `eprintln!`).

### Panic backtraces
If something panics (an `unwrap`, an index out of bounds), get the stack:

```powershell
$env:RUST_BACKTRACE = "1"      # or "full" for every frame
cargo test -p iso9613-core the_failing_test -- --nocapture
```

The backtrace lists the call chain to the panic — read bottom-up to your code.

---

## 4. Assertions in tests (how the suite checks physics)

You'll see these constantly; know how to read them:

```rust
assert!(cond, "message {}", value);                  // boolean
assert_eq!(a, b);                                    // exact equality
assert_relative_eq!(x, 41.30, epsilon = 0.05);       // from the `approx` crate:
                                                     //   |x−41.30| ≤ 0.05
```

`epsilon` is the tolerance. The conformance tests use `0.05` (the TR's ±0.05 dB
rule). If you tighten an input and want to check the output, temporarily add your
own `assert_relative_eq!(got, expected, epsilon = …)` or just `dbg!(got)`.

---

## 5. A real step-debugger (breakpoints, stepping, inspecting)

When a print isn't enough — you want to *stop* inside `build_geometry` and poke
around — use a step debugger. On Windows there are two options; **CodeLLDB** is
the easiest:

### Setup (VS Code)
1. Install the **CodeLLDB** extension (`vadimcn.vscode-lldb`).
2. Create `.vscode/launch.json` in the `solver/` folder:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "lldb",
      "request": "launch",
      "name": "Debug a specific test",
      "cargo": {
        "args": ["test", "--no-run", "-p", "iso9613-core",
                 "--test", "conformance_tr17534"],
        "filter": { "kind": "test" }
      },
      "args": ["t15_polygonal_building_receiver_high", "--nocapture", "--exact"],
      "cwd": "${workspaceFolder}"
    }
  ]
}
```

   `cargo.args` builds the test binary; `args` is what's passed to it (the test
   name filter). Change the `--test` file and the test name to target anything.

3. Even simpler: with rust-analyzer installed, a **`▶ Run | Debug`** code-lens
   appears above every `#[test]`. Click **Debug** — it wires up the above for you.

### Using it
- Click in the gutter left of a line number to set a **breakpoint** (red dot) —
  e.g. inside `lateral_plane_hull` where the supports are collected.
- Start debugging (F5). Execution stops at the breakpoint.
- **Step**: F10 = step over, F11 = step into, Shift+F11 = step out, F5 = continue.
- **Inspect**: hover a variable, or read the **Variables** pane (left). Expand
  structs/vecs. The **Watch** pane lets you type an expression like
  `sup.len()` or `delta_z`.
- The **Call Stack** pane shows how you got here (click a frame to see its locals).
- The **Debug Console** (bottom) accepts expressions: type `p delta_z` or just
  the variable name.

### Windows note (MSVC vs LLDB)
The default Rust on Windows uses the **MSVC** toolchain. CodeLLDB works with it,
but pretty-printing of some std types can be limited. If values show as raw
pointers, either (a) install the **C/C++** extension and use the `cppvsdbg`
debugger type instead, or (b) `rustup toolchain install stable-x86_64-pc-windows-gnu`
and build with the GNU toolchain for nicer LLDB output. For reviewing pure-`f64`
code like this engine, CodeLLDB + MSVC is fine — the numbers show correctly.

---

## 6. Recipes for *this* engine

### A. "What geometry does case T15 actually produce?"
Instead of a debugger, drop a print in `build_geometry` (barrier/path.rs) right
before it returns:
```rust
eprintln!("over_top Δz={:.3}; laterals={:?}",
    over_top.delta_z, lateral.iter().map(|p| p.delta_z).collect::<Vec<_>>());
```
then `cargo test -p iso9613-core t15 -- --nocapture`. (This is exactly how the
receiver-above-roof bug was found.) Remove it after.

### B. "Compare a band spectrum to the expected"
In a test, print both and eyeball:
```rust
let got = solve(&scene).unwrap().per_receiver[0].per_source[0].bands.clone();
eprintln!("got = {:.2?}", got);           // {:.2?} = debug + 2 dp
```

### C. "Bisect a conformance failure to a single term"
The conformance helper `assert_tr` checks per-band **and** total. If a case fails,
you don't yet know if it's `Aatm`, `Agr`, or `Abar`. Temporarily compute the
terms in isolation via the low-level entry points (`iso9613::evaluate_free_field`
= LW − Adiv − Aatm only; `evaluate_with_ground` adds Agr; `evaluate_with_barriers`
adds Abar). Diff each stage against the TR's step-by-step table
(`scratchpad/tr17534.txt` if present, or the standard PDF). The term that first
diverges is your culprit.

### D. "Is this an input-validation reject or a physics result?"
`solve()` returns `Result<Results, SceneError>`. If you get an `Err`, print it:
```rust
match solve(&scene) { Ok(r) => …, Err(e) => eprintln!("rejected: {e}") };
```
`SceneError`'s `Display` tells you exactly which check failed (see `validate()`).

### E. "Re-derive a number independently"
The trusted pattern in this repo is a throwaway **Python oracle** (see
`scratchpad/*.py` from the build): re-implement the one formula in Python, feed
the same inputs, compare. Never regenerate a Rust expected-value *from* Rust
output — that just enshrines a bug. If you change physics and a golden/case value
moves, recompute it from an independent source and note why in the commit.

---

## 7. Fast feedback while reading

```powershell
cargo clippy -p iso9613-core --all-targets     # lints: catches many real bugs
cargo doc -p iso9613-core --no-deps --open     # renders the doc-comments as HTML
```

`cargo doc --open` is underrated for review: it turns every `///` comment into a
browsable API site with cross-links — a clean way to read the public surface
top-down. The doc-comments in this crate carry the ISO clause references and the
"why", so the rendered docs read like a spec.

---

## 8. Cheat sheet

| Goal | Command |
|---|---|
| Type-check only | `cargo check -p iso9613-core` |
| Run all tests | `cargo test -p iso9613-core` |
| Run one test + see prints | `cargo test -p iso9613-core NAME -- --nocapture` |
| Run conformance only | `cargo test -p iso9613-core --test conformance_tr17534` |
| Lints | `cargo clippy -p iso9613-core --all-targets` |
| Panic backtrace | `$env:RUST_BACKTRACE="1"` then run |
| Render docs | `cargo doc -p iso9613-core --no-deps --open` |
| Step-debug a test | rust-analyzer "Debug" code-lens, or `launch.json` (§5) |

| In code | Effect |
|---|---|
| `dbg!(expr)` | print `file:line = value`, return value |
| `eprintln!("{:#?}", x)` | pretty-print any `Debug` type to stderr |
| `{:.3}` / `{:.2?}` | 3 dp / debug-with-2-dp |
| `assert_relative_eq!(a,b,epsilon=0.05)` | tolerance check (approx crate) |
