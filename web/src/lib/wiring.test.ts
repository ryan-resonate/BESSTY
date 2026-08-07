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
