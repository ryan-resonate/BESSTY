// The optimisation problem behind curtailment, and the solver behind that.
//
// Deliberately knows nothing about acoustics. The shape is a MULTIPLE-CHOICE
// MULTI-DIMENSIONAL KNAPSACK: each group (a turbine) picks exactly one option
// (a mode), every option consumes some amount of each resource (sound energy at
// each receiver), no resource may exceed its capacity, and the total cost (lost
// kW) is minimised.
//
// Two solvers, and both matter:
//   - `solveByEnumeration` tries every combination. Exact by construction and
//     the reference the MILP is tested against, but |options|^|groups| means it
//     is only usable on tiny problems.
//   - `solveWithHighs` hands the same model to HiGHS, which returns a PROVEN
//     optimum. Lazy-loaded, because the wasm is ~1 MB and most sessions never
//     open the optimiser.
//
// Keeping the model a plain data structure is what lets the two be
// cross-checked on random problems — see milp.test.ts.

/// One option within a group: `cost` to choose it, `use[j]` of resource j.
export interface MilpOption {
  key: string;
  cost: number;
  use: number[];
}

export interface MilpGroup {
  key: string;
  options: MilpOption[];
}

export interface MilpModel {
  groups: MilpGroup[];
  /// One capacity per resource; `use` arrays are parallel to it.
  capacities: number[];
}

export type MilpStatus = 'optimal' | 'infeasible' | 'error';

export interface MilpSolution {
  status: MilpStatus;
  /// Index of the chosen option within each group, parallel to `groups`.
  /// Empty when not optimal.
  chosen: number[];
  cost: number;
  /// Set when `status` is 'error' — the solver said something we did not expect.
  detail?: string;
}

/// Resource totals for a given assignment. Used to report which receiver is
/// binding, and by the tests to confirm a returned assignment is really legal.
export function resourceUse(model: MilpModel, chosen: number[]): number[] {
  const out = new Array<number>(model.capacities.length).fill(0);
  model.groups.forEach((g, i) => {
    const opt = g.options[chosen[i]];
    if (!opt) return;
    for (let j = 0; j < out.length; j++) out[j] += opt.use[j];
  });
  return out;
}

export function totalCost(model: MilpModel, chosen: number[]): number {
  return model.groups.reduce((acc, g, i) => acc + (g.options[chosen[i]]?.cost ?? 0), 0);
}

/// Is this assignment within every capacity?
///
/// `tol` is a RELATIVE slack on each capacity. The capacities are sound
/// energies built from logarithms, so demanding exact arithmetic equality
/// against a solver's floating-point answer would reject assignments that are
/// compliant to any physical reading.
export function isFeasible(model: MilpModel, chosen: number[], tol = 1e-9): boolean {
  const use = resourceUse(model, chosen);
  return use.every((u, j) => u <= model.capacities[j] * (1 + tol) + Number.EPSILON);
}

/// The lowest possible use of each resource — every group at its quietest.
/// If this still exceeds a capacity, no assignment can satisfy it and the
/// problem is infeasible without any search.
export function minimumUse(model: MilpModel): number[] {
  const out = new Array<number>(model.capacities.length).fill(0);
  for (const g of model.groups) {
    for (let j = 0; j < out.length; j++) {
      let lo = Infinity;
      for (const o of g.options) lo = Math.min(lo, o.use[j]);
      out[j] += Number.isFinite(lo) ? lo : 0;
    }
  }
  return out;
}

/// Resources no assignment can satisfy. Reported rather than left for the
/// solver to call "infeasible", because naming the receiver that cannot be met
/// — and by how much — is the whole content of that answer.
export function unsatisfiableResources(model: MilpModel): number[] {
  const lo = minimumUse(model);
  const out: number[] = [];
  for (let j = 0; j < model.capacities.length; j++) {
    if (lo[j] > model.capacities[j] * (1 + 1e-9)) out.push(j);
  }
  return out;
}

// ------------------------------------------------------------- enumeration

/// Exhaustive search. Exact, and the reference the MILP is checked against.
///
/// Returns 'error' rather than running forever when the space is too large:
/// this is a test oracle and a fast path for trivial farms, not a fallback for
/// the real thing.
export function solveByEnumeration(model: MilpModel, maxCombos = 200_000): MilpSolution {
  const sizes = model.groups.map((g) => g.options.length);
  if (sizes.some((s) => s === 0)) {
    return { status: 'error', chosen: [], cost: 0, detail: 'a group has no options' };
  }
  const combos = sizes.reduce((a, b) => a * b, 1);
  if (combos > maxCombos) {
    return {
      status: 'error', chosen: [], cost: 0,
      detail: `${combos} combinations exceeds the enumeration cap of ${maxCombos}`,
    };
  }

  let best: number[] | null = null;
  let bestCost = Infinity;
  const cur = new Array<number>(model.groups.length).fill(0);

  const walk = (i: number, cost: number, use: number[]) => {
    // Cost can only grow, so a partial assignment already at or above the
    // incumbent cannot beat it.
    if (cost >= bestCost) return;
    if (i === model.groups.length) {
      if (use.every((u, j) => u <= model.capacities[j] * (1 + 1e-9))) {
        bestCost = cost;
        best = cur.slice();
      }
      return;
    }
    for (let k = 0; k < model.groups[i].options.length; k++) {
      const opt = model.groups[i].options[k];
      cur[i] = k;
      const next = use.map((u, j) => u + opt.use[j]);
      walk(i + 1, cost + opt.cost, next);
    }
  };
  walk(0, 0, new Array<number>(model.capacities.length).fill(0));

  if (!best) return { status: 'infeasible', chosen: [], cost: 0 };
  return { status: 'optimal', chosen: best, cost: bestCost };
}

// ----------------------------------------------------------------- LP format

/// A safe LP-format identifier. HiGHS reads CPLEX LP, where names may not
/// contain spaces or the operator characters, so variables are named
/// positionally and mapped back by index — a catalog mode called "NRO+2 (low)"
/// would otherwise produce a file that parses as arithmetic.
function varName(g: number, o: number): string {
  return `x${g}_${o}`;
}

/// Format a coefficient for LP text. Exponent notation is accepted by HiGHS and
/// keeps the very small scaled energies from rounding to zero in the file.
function coef(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return v.toExponential(12);
}

/// Render the model as CPLEX LP text.
///
/// Each resource row is DIVIDED BY ITS CAPACITY so every constraint reads
/// `… <= 1`. The raw numbers are sound energies spanning many orders of
/// magnitude — HiGHS treats matrix entries below 1e-9 as zero by default, which
/// on an unscaled row would silently drop a quiet turbine out of a constraint.
/// Scaling a row by a positive constant changes nothing mathematically.
///
/// Capacities that are not strictly positive cannot be scaled and are not
/// emitted here; `unsatisfiableResources` catches that case first.
export function toLpFormat(model: MilpModel): string {
  const lines: string[] = [];
  const objTerms: string[] = [];
  model.groups.forEach((g, i) => {
    g.options.forEach((o, k) => {
      objTerms.push(`${coef(o.cost)} ${varName(i, k)}`);
    });
  });
  lines.push('Minimize');
  lines.push(` obj: ${objTerms.join(' + ')}`);
  lines.push('Subject To');

  // Exactly one option per group.
  model.groups.forEach((g, i) => {
    const terms = g.options.map((_, k) => varName(i, k)).join(' + ');
    lines.push(` g${i}: ${terms} = 1`);
  });

  // One row per resource, scaled to a unit capacity.
  //
  // A capacity of exactly zero cannot be scaled, and must NOT be skipped: zero
  // means only a wholly silent assignment is admissible, and dropping the row
  // would hand back a cheaper schedule that breaches it. Such rows go out
  // unscaled against their true right-hand side.
  model.capacities.forEach((cap, j) => {
    const scale = cap > 0 ? cap : 1;
    const terms: string[] = [];
    model.groups.forEach((g, i) => {
      g.options.forEach((o, k) => {
        const v = o.use[j] / scale;
        if (v !== 0) terms.push(`${coef(v)} ${varName(i, k)}`);
      });
    });
    if (terms.length === 0) return;
    lines.push(` r${j}: ${terms.join(' + ')} <= ${cap > 0 ? '1' : coef(cap)}`);
  });

  lines.push('Binary');
  model.groups.forEach((g, i) => {
    g.options.forEach((_, k) => lines.push(` ${varName(i, k)}`));
  });
  lines.push('End');
  return lines.join('\n');
}

// --------------------------------------------------------------- HiGHS

type HighsSolveResult = {
  Status: string;
  ObjectiveValue: number;
  Columns: Record<string, { Primal?: number }>;
};
type HighsInstance = { solve(lp: string, opts?: Record<string, unknown>): HighsSolveResult };

let highsPromise: Promise<HighsInstance> | null = null;

/// How to obtain a HiGHS instance. Injected by the node test suite, which has
/// no bundler to resolve the package or rewrite the wasm asset URL — and
/// running the REAL solver in tests is the point: the whole reason for taking
/// an external solver is that it is trusted to be correct, which is only worth
/// anything if the LP text we hand it is verified to mean what we intend.
let loaderOverride: (() => Promise<HighsInstance>) | null = null;

export function setHighsLoader(fn: (() => Promise<HighsInstance>) | null): void {
  loaderOverride = fn;
  highsPromise = null;    // a later solve must pick the new loader up
}

/// Load HiGHS once, on first use.
///
/// The import is dynamic so the ~1 MB wasm stays out of the main bundle: most
/// sessions never open the optimiser, and this is the only thing in the app
/// that needs a MILP solver.
async function loadHighs(): Promise<HighsInstance> {
  if (!highsPromise) {
    highsPromise = (async () => {
      if (loaderOverride) return loaderOverride();
      const mod = await import('highs');
      const loader = (mod as unknown as { default: (o?: unknown) => Promise<HighsInstance> }).default;
      // Emscripten resolves its .wasm relative to its own script URL, which is
      // wrong once the JS has been bundled into a hashed chunk. `?url` makes
      // Vite emit the binary as an asset and hand back where it landed.
      const wasmUrl = (await import('highs/runtime?url')).default;
      return loader({ locateFile: () => wasmUrl });
    })().catch((e) => {
      highsPromise = null;         // let a later attempt retry rather than wedge
      throw e;
    });
  }
  return highsPromise;
}

/// Solve to a proven global optimum.
///
/// Infeasibility is a real answer here, not a failure: it means even the
/// quietest available assignment exceeds a limit, and the caller reports which
/// receiver and by how much.
export async function solveWithHighs(model: MilpModel): Promise<MilpSolution> {
  if (model.groups.length === 0) return { status: 'optimal', chosen: [], cost: 0 };
  if (unsatisfiableResources(model).length > 0) {
    return { status: 'infeasible', chosen: [], cost: 0 };
  }
  let res: HighsSolveResult;
  try {
    const highs = await loadHighs();
    res = highs.solve(toLpFormat(model), {
      output_flag: false,
      log_to_console: false,
      // Ties between equal-cost schedules are broken by the solver; a fixed
      // seed at least makes the same project produce the same schedule twice.
      random_seed: 0,
      // Default is a 1e-4 RELATIVE gap, which on a five-figure kW objective
      // stops up to ~1 kW short of the optimum and would make the answer
      // disagree with the enumeration reference.
      mip_rel_gap: 0,
      mip_abs_gap: 1e-9,
    });
  } catch (e) {
    return {
      status: 'error', chosen: [], cost: 0,
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  if (res.Status === 'Infeasible') return { status: 'infeasible', chosen: [], cost: 0 };
  if (res.Status !== 'Optimal') {
    return { status: 'error', chosen: [], cost: 0, detail: `solver returned "${res.Status}"` };
  }

  const chosen: number[] = [];
  for (let i = 0; i < model.groups.length; i++) {
    let pick = -1;
    for (let k = 0; k < model.groups[i].options.length; k++) {
      // Binaries come back as floats; anything above a half is the chosen one.
      if ((res.Columns[varName(i, k)]?.Primal ?? 0) > 0.5) { pick = k; break; }
    }
    if (pick < 0) {
      return {
        status: 'error', chosen: [], cost: 0,
        detail: `no mode selected for group ${model.groups[i].key}`,
      };
    }
    chosen.push(pick);
  }
  // Trust the assignment, not the reported objective: recomputing from the
  // chosen options is what the caller will display, and any disagreement means
  // the model and the answer have drifted apart.
  return { status: 'optimal', chosen, cost: totalCost(model, chosen) };
}
