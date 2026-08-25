// Static wiring checks over the app's own source.
//
// Two defects shipped past a fully green suite (tsc, 221 unit tests, a clean
// production build) because nothing in the pipeline ever looks at how the
// components are CONNECTED:
//
//   1. The settings gear renders only when its parent passes `onOpenSettings`.
//      Moving it from the map controls into the side panel dropped the prop and
//      never re-added it. Both ends are optional, so nothing complained and
//      Settings became unreachable from the running app.
//   2. Every overlay attached its own `window` keydown listener for Escape.
//      Those are siblings on one EventTarget, so `stopPropagation` does nothing
//      between them: one keypress fired all of them, and dismissing a confirm
//      dialog also closed the wizard behind it, discarding the user's edits.
//
// Neither is a type error and neither is reachable from a unit test of any one
// module — they are properties of the whole tree. A DOM harness would catch
// them, but it needs dependencies that aren't approved here; these read the
// source instead, which costs nothing and targets the exact failure mode.
//
// The rules are deliberately narrow. A wiring test that guesses at intent
// becomes a nuisance that people silence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/// `web/src`, found by walking up from this file's location at build time.
/// The bundler inlines nothing here — the tests run from a temp dir, so the
/// path is resolved from the repo layout instead.
const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'wasm' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if ((name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

test('the source tree is visible to these checks', () => {
  // A silent zero-file scan would make every check below vacuously pass.
  assert.ok(FILES.length > 20, `expected the app's source, found ${FILES.length} files`);
  assert.ok(FILES.some((f) => f.path.endsWith('ProjectScreen.tsx')), 'ProjectScreen not found');
});

test('every optional prop that GATES a control is actually passed by a parent', () => {
  // The Settings-gear bug exactly: `{props.onOpenSettings && (<button .../>)}`
  // renders nothing at all when no parent passes the prop, and both ends being
  // optional means the compiler is satisfied.
  const gated = new Map<string, string>();   // prop name → file that gates on it
  for (const { path, text } of FILES) {
    for (const m of text.matchAll(/\{\s*props\.(on[A-Z]\w*)\s*&&/g)) {
      gated.set(m[1], path);
    }
  }
  assert.ok(gated.size > 0, 'no gated props found — the pattern check is broken');

  const missing: string[] = [];
  for (const [prop, where] of gated) {
    // Passed as a JSX attribute anywhere in the tree?
    const passed = FILES.some((f) => f.path !== where
      && new RegExp(`(^|\\s)${prop}=\\{`).test(f.text));
    if (!passed) missing.push(`${prop} (gates a control in ${where.replace(SRC, 'src')})`);
  }
  assert.deepEqual(
    missing, [],
    'these props gate a rendered control but no parent passes them, so the control '
    + 'never appears:\n  ' + missing.join('\n  '),
  );
});

test('a component that returns null without its callbacks still gets them', () => {
  // The same failure as the gear, one step further out: a card whose whole body
  // is behind `if (!onFoo) return null` disappears silently when a parent stops
  // passing the prop. `{props.onFoo && …}` above catches the inline form; this
  // catches the early return, which is what a card-sized control tends to use.
  const gated = new Map<string, string>();
  for (const { path, text } of FILES) {
    // The condition may contain nested calls — `if (!onFoo || !ready(x))` — so
    // it is matched by balancing parentheses rather than by `[^)]*`, which
    // stops at the first inner one and skips the whole guard.
    for (const m of text.matchAll(/if\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < text.length && i < open + 400; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
      }
      if (close < 0) continue;
      if (!/^\s*return null/.test(text.slice(close + 1))) continue;
      // EVERY negated callback in the condition, not just the first: a guard
      // reading `if (!onUpdate || !onRemove)` gates on both, and capturing one
      // would let the other be dropped silently.
      for (const n of text.slice(open, close).matchAll(/!\s*((?:on|set)[A-Z]\w*)/g)) {
        gated.set(n[1], path);
      }
    }
  }
  const missing: string[] = [];
  for (const [prop, where] of gated) {
    // Same file counts here, unlike the check above: a card like
    // CustomContourCard is rendered by a sibling component in its own module,
    // and that is a real parent. The gear bug is still caught, because nothing
    // anywhere passed the prop it gated on.
    const passed = FILES.some((f) => new RegExp(`(^|\\s)${prop}=\\{`).test(f.text));
    if (!passed) missing.push(`${prop} (gates a component in ${where.replace(SRC, 'src')})`);
  }
  assert.deepEqual(
    missing, [],
    'these props gate a whole component but no parent passes them, so it never '
    + 'renders:\n  ' + missing.join('\n  '),
  );
});

test('no result or limit label spells dB(A) into the source', () => {
  // The assessment weighting is selectable, so a hardcoded "dB(A)" on anything
  // that reports a LEVEL or a LIMIT is a label that contradicts its own number
  // the moment a project is set to dB(C). Source sound power in the catalog is
  // genuinely A-weighted whatever the project does, so that file is exempt.
  const exempt = ['CatalogScreen.tsx', 'weighting.ts', 'SettingsWindow.tsx'];
  const offenders: string[] = [];
  for (const { path, text } of FILES) {
    if (exempt.some((e) => path.endsWith(e))) continue;
    // Comments explain the convention; only rendered strings matter.
    const code = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of code.matchAll(/dB\(A\)/g)) {
      const around = code.slice(Math.max(0, m.index! - 90), m.index! + 10);
      // The Settings dropdown legitimately names all three weightings, and the
      // dBC-dBA screening column is defined as that pair whatever is selected.
      if (/value="A"|dbc_minus_dba|dB\(C\)\s*−\s*dB\(A\)|Lw /.test(around)) continue;
      offenders.push(`${path.replace(SRC, 'src')}: …${around.replace(/\s+/g, ' ').slice(-70)}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'these labels are pinned to dB(A) but the level they describe is not:\n  '
    + offenders.join('\n  '),
  );
});

test('every annotation kind has a way to be selected on the map', () => {
  // A dimension was drawn entirely from `interactive: false` layers, with its
  // one click handler sitting UNDER the invisible drag handle that swallowed
  // the click. It could be created but never selected, and therefore never
  // deleted. The rule: each annotation branch must attach a click handler.
  const map = FILES.find((f) => f.path.endsWith('MapView.tsx'));
  assert.ok(map, 'MapView not found');
  const body = map!.text;
  // Bounded by the two comments that bracket the effect, rather than by a
  // character count — the block is long, and a fixed window silently stopped
  // short of the dimension branch it is meant to check.
  const start = body.indexOf('// ---- Annotations (notes + dimensions) ----');
  const end = body.indexOf('// Barrier mode:', start);
  assert.ok(start > 0 && end > start, 'annotation render block not found');
  const block = body.slice(start, end);

  // The text branch selects via its marker…
  assert.ok(/marker\.on\('click', \(\) => callbacksRef\.current\.onSelectAnnotation/.test(block),
    'the note marker should select on click');
  // …and the dimension branch has a shared `select` wired to more than one
  // layer, so the line, the ends and the label all reach it.
  const selectUses = (block.match(/select/g) ?? []).length;
  assert.ok(selectUses >= 4, `dimension select is wired ${selectUses} times; expected the line, both ends and the label`);
  // The hit line must be interactive — a transparent stroke is the only part
  // wide enough to click reliably.
  assert.ok(/weight: 14, opacity: 0, interactive: true/.test(block),
    'the dimension needs a wide transparent hit line');
});

test('every spectrum lookup goes through the mode resolver, and checks for Off', () => {
  // `spectrumFor` falls back to the catalog's FIRST mode when it doesn't
  // recognise a name — it doesn't throw. So handing it a raw `modeOverride`
  // (which may be a per-period object) or the reserved Off id doesn't fail
  // loudly: the source runs, at a mode nobody chose, and the number looks fine.
  //
  // The rule: every call resolves through `sourceModeName` first and drops the
  // source when that returns null. `spectra.ts` is exempt — it DEFINES the
  // function and its own alias passes a name through. (It lives there rather
  // than in `catalog.ts` so the pure projection maths carries no Firebase edge;
  // `catalog.ts` only re-exports it.)
  const offenders: string[] = [];
  for (const { path, text } of FILES) {
    if (path.endsWith('spectra.ts') || path.endsWith('types.ts')) continue;
    for (const m of text.matchAll(/spectrumFor\(/g)) {
      // The resolve + guard sit immediately above the call; 6 lines is room for
      // a comment between them without letting an unrelated guard count.
      const before = text.slice(0, m.index).split('\n').slice(-6).join('\n');
      const line = text.slice(0, m.index).split('\n').length;
      const at = `${path.replace(SRC, 'src')}:${line}`;
      // The check binds ONE variable through all three steps — resolved from
      // sourceModeName, null-checked, and actually passed as the mode argument.
      // Requiring merely "some resolve" plus "some null check" in the window
      // let `spectrumFor(entry, m ?? entry.defaultMode, …)` through, which runs
      // an Off source at the default mode: the exact failure this test exists
      // to prevent.
      const decl = before.match(/(?:const|let)\s+(\w+)\s*=\s*sourceModeName\(/);
      if (!decl) {
        offenders.push(`${at} — no sourceModeName() resolve above it`);
        continue;
      }
      const name = decl[1];
      if (!new RegExp(`if\\s*\\(\\s*${name}\\s*===?\\s*null\\s*\\)`).test(before)) {
        offenders.push(`${at} — ${name} is resolved but never checked for Off`);
        continue;
      }
      // Second argument of the call must be exactly the guarded variable.
      const call = text.slice(m.index, m.index! + 200);
      const arg = call.match(/^spectrumFor\(\s*[^,]+,\s*([\w.!]+)\s*[,)]/);
      if (!arg || arg[1] !== name) {
        offenders.push(`${at} — resolves ${name} but passes ${arg?.[1] ?? 'something else'}`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'these spectrum lookups can be handed an unresolved override or the Off id, '
    + 'and would silently run the source at the catalog\'s first mode:\n  '
    + offenders.join('\n  '),
  );
});

test('no surface picks its own limit — every judgement goes through the resolver', () => {
  // A receiver's limit may be a scalar per period OR a wind-speed curve
  // (`limitTable`). `limitForPeriod` only ever returns the scalar, so a
  // surface still calling it judges against a different number than the
  // surface beside it — the map says pass, the export says fail, and both
  // look right on their own. `limitFor`/`resolveLimit` from lib/limits is the
  // one way in.
  //
  // types.ts DEFINES it and limitTable.ts is the resolver that legitimately
  // falls back to it.
  const owners = ['types.ts', 'limitTable.ts'];
  const offenders: string[] = [];
  for (const { path, text } of FILES) {
    if (owners.some((o) => path.endsWith(o))) continue;
    const code = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of code.matchAll(/\blimitForPeriod\s*\(/g)) {
      const line = code.slice(0, m.index).split('\n').length;
      offenders.push(`${path.replace(SRC, 'src')}:${line}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'these read the scalar limit directly and so ignore any wind-speed limit '
    + 'table; call limitFor(project, receiver, period?) from lib/limits '
    + 'instead:\n  ' + offenders.join('\n  '),
  );
});

test('the wind-direction correction stays inside the curtailment optimiser', () => {
  // It is a curtailment-planning approximation, not an ISO term and not a
  // property of the project. Everything BESSTY REPORTS — map badges, contours,
  // the receiver export, the PDF — must stay on the downwind-to-every-receiver
  // reading, so an import of `directivity` anywhere outside the curtailment
  // path is the correction leaking into an output that should not have it.
  //
  // `exporters` is on the list for one reason only: the curtailment XLSX labels
  // its swept directions. If that file ever used it for anything else this
  // check would not catch it — hence the second assertion below.
  const allowed = [
    'directivity.ts',
    'curtailment.ts',
    'CurtailmentStudy.tsx',
    'exporters.ts',
  ];
  const offenders = FILES
    .filter((f) => /from '\.{1,2}\/(lib\/)?directivity'/.test(f.text))
    .map((f) => f.path)
    .filter((p) => !allowed.some((a) => p.endsWith(a)))
    .map((p) => p.replace(SRC, 'src'));
  assert.deepEqual(
    offenders, [],
    'these import the wind-direction correction but are not part of the '
    + 'curtailment optimiser, so it would reach a reported level:\n  '
    + offenders.join('\n  '),
  );

  // The exporter may only NAME a direction, never apply a correction.
  const exporters = FILES.find((f) => f.path.endsWith('exporters.ts'));
  assert.ok(exporters, 'exporters.ts not found');
  const imported = exporters!.text.match(/import \{([^}]*)\} from '\.\/directivity'/);
  assert.ok(imported, 'expected exporters to import from directivity');
  assert.deepEqual(
    imported![1].split(',').map((s) => s.trim()).filter(Boolean),
    ['describeWindFrom'],
    'the exporter may only label a direction; applying a correction there would '
    + 'put it into a file BESSTY reports from',
  );
});

test('no source but a wind turbine is given a directivity correction', () => {
  // Ryan, explicitly: it applies to turbine curtailment and has no other
  // meaning — never to a BESS, in any way. The guard is a `kind === 'wtg'`
  // membership test in the cell model, with no option to widen it.
  const curtailment = FILES.find((f) => f.path.endsWith('curtailment.ts'));
  assert.ok(curtailment, 'curtailment.ts not found');
  const body = curtailment!.text;
  const start = body.indexOf('const adjust =');
  assert.ok(start > 0, 'the per-pair adjustment helper was not found');
  const guard = body.slice(start, start + 240);
  assert.match(
    guard, /if \(!wind \|\| !turbineIds\.has\(s\.id\)\) return undefined;/,
    'the adjustment must bail for anything that is not a turbine',
  );
  // And nothing may reintroduce a way to turn that off.
  assert.doesNotMatch(
    body, /onFixedSources|directivityOnFixedSources/,
    'there must be no switch that applies the correction to non-turbine sources',
  );
});

test('both contour EXPORTS trace through one function, so they cannot drift apart', () => {
  // There are two paths that write contour lines to a file: the side panel's
  // KML / shapefile buttons, and the wind sweep. They must produce identical
  // geometry for identical inputs — a sweep whose 8 m/s layer disagrees with an
  // on-screen export at 8 m/s is indefensible in a report — and the subtle half
  // of that is the overlap rule: a custom line sitting exactly on a display step
  // is ONE contour, and writing it both as a stepped set and as a named one
  // makes a GIS consumer count it twice.
  //
  // `traceForExport` owns that. The map and the PDF legitimately keep the
  // stepped and named sets APART (they style them differently), so this rule is
  // scoped to the two file exporters rather than banning the primitives outright.
  const exportPaths = ['SidePanel.tsx', 'windSweep.ts'];
  for (const name of exportPaths) {
    const file = FILES.find((f) => f.path.endsWith(name));
    assert.ok(file, `${name} not found`);
    const code = file!.text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(
      code, /\btraceForExport\s*\(/,
      `${name} writes contours to a file but does not go through traceForExport`,
    );
    for (const primitive of ['steppedTracesFrom', 'customTracesFrom', 'unionContourLevels']) {
      assert.ok(
        !new RegExp(`\\b${primitive}\\s*\\(`).test(code),
        `${name} assembles its own export line set (${primitive}); use traceForExport `
        + 'so both exports apply the same stepped/named overlap rule',
      );
    }
  }
});

test('the public share viewer cannot solve, cannot reach the catalog, and cannot write', () => {
  // `/share/:token` renders for anyone on the internet with no account. Its
  // safety rests on a claim in its own header — that it holds no project, runs
  // no solver, and has no mutation path — and a claim like that is worth
  // exactly as much as whatever enforces it.
  //
  // The specific ways this erodes: someone "reuses" MapView (which imports the
  // catalog and the solver) to avoid duplicate map code; someone adds a
  // "recalculate at this wind speed" convenience; someone lets a viewer leave
  // a comment. Each is reasonable-sounding and each turns a frozen public
  // snapshot into a live one.
  const viewer = FILES.find((f) => f.path.endsWith('ShareViewerScreen.tsx'));
  assert.ok(viewer, 'ShareViewerScreen not found');
  const code = viewer!.text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const banned = [
    ['solver', /from '\.\.\/lib\/solver'/],
    ['catalog', /from '\.\.\/lib\/catalog'/],
    ['spectra', /from '\.\.\/lib\/spectra'/],
    ['curtailment', /from '\.\.\/lib\/curtailment'/],
    ['windSweep', /from '\.\.\/lib\/windSweep'/],
    ['MapView', /from '\.\.\/components\/MapView'/],
    ['firestoreProjects', /from '\.\.\/lib\/firestoreProjects'/],
  ] as const;
  for (const [name, re] of banned) {
    assert.ok(
      !re.test(code),
      `the share viewer imports ${name}; it must render only what the share document `
      + 'carries, with no route to a solve, the catalog, or a project',
    );
  }

  // No Firestore WRITE may exist here. A viewer is unauthenticated, so any
  // write it attempted would fail — but the presence of one means someone
  // expected it to work, and the next step is relaxing a rule to make it.
  for (const write of ['setDoc', 'updateDoc', 'addDoc', 'deleteDoc', 'writeBatch']) {
    assert.ok(
      !new RegExp(`\\b${write}\\s*\\(`).test(code),
      `the share viewer calls ${write}(); the viewer is strictly read-only (Q30)`,
    );
  }
});

test('the grid cache key is stamped only where a grid is actually stored', () => {
  // `gridKeyRef` lets the automatic regrid skip re-solving a grid whose inputs
  // have not changed — which is what stops the end of a wind sweep triggering a
  // pointless full regrid. The failure direction is asymmetric and nasty: a key
  // stamped for a grid that never arrived makes the map SKIP a regrid it owed,
  // leaving contours that do not match the project, labelled ready, and
  // exportable.
  //
  // That is exactly what happened when it was stamped before the solve: a sweep
  // starting mid-regrid terminates the pool (newest wins), the regrid's catch
  // keeps the stale grid, and the catch-up afterwards saw a matching key.
  //
  // So: every write of the key must be immediately followed by storing a grid.
  // A reset to null is always safe (it can only cause an extra solve).
  const screen = FILES.find((f) => f.path.endsWith('ProjectScreen.tsx'));
  assert.ok(screen, 'ProjectScreen not found');
  const code = screen!.text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // `=(?!=)` so the guard's `gridKeyRef.current === key` is not read as a write.
  const writes = [...code.matchAll(/gridKeyRef\.current\s*=(?!=)\s*([^;]+);/g)];
  assert.ok(writes.length > 0, 'no gridKeyRef writes found — has it been renamed?');
  const offenders: string[] = [];
  for (const m of writes) {
    if (/^\s*null\s*$/.test(m[1])) continue;                 // clearing is safe
    const after = code.slice(m.index! + m[0].length, m.index! + m[0].length + 120);
    if (!/^\s*setGrid\s*\(/.test(after)) {
      offenders.push(`line ${code.slice(0, m.index).split('\n').length}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'these stamp the grid key somewhere other than immediately before setGrid(), so a '
    + 'grid that never arrives can mark its inputs as current and suppress the regrid '
    + 'that owes them:\n  ' + offenders.join('\n  '),
  );
});

test('a study never mutates the project it was handed', () => {
  // The studies (curtailment, wind sweep, factorial) re-solve the project under
  // conditions the user is NOT looking at — a different wind speed, a different
  // period, a pinned set of modes. The map, the badges and the autosave are all
  // reading the live object, so writing to it would silently redefine what is
  // on screen, and the autosave would then persist it.
  //
  // Assignment to a nested scenario field is the specific shape that does this
  // without tripping any type check.
  const offenders: string[] = [];
  for (const { path, text } of FILES) {
    const code = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of code.matchAll(/\.scenario\.\w+\s*=(?!=)/g)) {
      const line = code.slice(0, m.index).split('\n').length;
      offenders.push(`${path.replace(SRC, 'src')}:${line}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'these assign into a project\'s scenario in place; build a copy '
    + '({ ...project, scenario: { ...project.scenario, ... } }) instead:\n  '
    + offenders.join('\n  '),
  );
});

test('Escape is handled only through the shared stack', () => {
  // Multiple window-level Escape listeners are siblings: stopPropagation does
  // not separate them, so one keypress fires every overlay's handler at once.
  // `escStack` owns the single listener and dispatches to the top overlay.
  //
  // Element-level Escape (a React `onKeyDown` on an input, where Escape means
  // "revert this field") is legitimate and stays: the stack ignores keys
  // raised inside text fields precisely so those keep working.
  const offenders: string[] = [];
  for (const { path, text } of FILES) {
    if (path.endsWith('escStack.ts')) continue;
    for (const m of text.matchAll(/key\s*===\s*['"]Escape['"]/g)) {
      // Element-level handlers are fine; anything else is a global listener.
      const before = text.slice(Math.max(0, m.index - 300), m.index);
      if (/onKeyDown\s*=/.test(before)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(`${path.replace(SRC, 'src')}:${line}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'these files add their own window-level Escape listener; register with '
    + 'pushEscHandler() from lib/escStack instead so only the top overlay '
    + 'responds:\n  ' + offenders.join('\n  '),
  );
});

test('every side-panel tab renders a body', () => {
  // A tab listed in TABS with no `tab === '<id>'` branch shows a blank panel —
  // which is what the Settings tab would have become had it been left in the
  // list when its body was deleted.
  const panel = FILES.find((f) => f.path.endsWith('SidePanel.tsx'));
  assert.ok(panel, 'SidePanel.tsx not found');
  const ids = [...panel.text.matchAll(/\{\s*id:\s*'([a-z]+)'\s*,\s*label:/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, `expected the tab list, found ${ids.length} entries`);
  const orphans = ids.filter((id) => !panel.text.includes(`tab === '${id}'`));
  assert.deepEqual(orphans, [], `tabs with no body: ${orphans.join(', ')}`);
});

test('the app entry mounts the providers the imperative APIs need', () => {
  // `notify.confirm()` resolves NEGATIVELY when no <Notifications> provider is
  // mounted (it cannot hang the caller), so losing the provider would silently
  // turn every confirmation into a "no" — destructive actions would appear to
  // do nothing, with only a console error.
  const app = FILES.find((f) => f.path.endsWith('App.tsx'));
  assert.ok(app, 'App.tsx not found');
  assert.match(app.text, /<Notifications\s*\/>/, 'App must mount <Notifications />');
});

test('no worker is constructed outside the modules that own one', () => {
  // Workers are expensive and a solver worker loads its own copy of the wasm.
  // The ones that exist are pooled or laned deliberately (grid pool, scene
  // lanes, contour tracer); a stray `new Worker` elsewhere would quietly
  // multiply memory and CPU.
  //
  // dxfImport is the one exception, and a narrow one: it holds no wasm, spawns
  // at most one worker per user-initiated import, and terminates it in a
  // `finally`. Anything added here should be able to say the same.
  const owners = ['solver.ts', 'contourLines.ts', 'dxfImport.ts'];
  const offenders = FILES
    .filter((f) => /new Worker\s*\(/.test(f.text))
    .map((f) => f.path)
    .filter((p) => !owners.some((o) => p.endsWith(o)))
    .map((p) => p.replace(SRC, 'src'));
  assert.deepEqual(
    offenders, [],
    `unexpected Worker construction outside ${owners.join(' / ')}:\n  ` + offenders.join('\n  '),
  );
});
