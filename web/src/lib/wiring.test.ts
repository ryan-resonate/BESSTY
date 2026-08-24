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
