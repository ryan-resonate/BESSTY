// The Escape-layering contract. Worth pinning because the failure it prevents
// is silent and destructive: before this stack existed, every overlay attached
// its own window listener, so one Esc fired all of them — dismissing a confirm
// dialog also closed the wizard behind it, discarding the user's edits.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pushEscHandler, __escStackDepthForTests } from './escStack';

/// Minimal DOM stand-in: node:test has no window, and the whole point of the
/// module is which listener runs, so a fake event target is enough.
interface FakeEvent { key: string; target: unknown; defaultPrevented: boolean; propagationStopped: boolean }
let listener: ((e: FakeEvent) => void) | null = null;

const g = globalThis as unknown as { window?: unknown };
g.window = {
  addEventListener(type: string, fn: (e: FakeEvent) => void) {
    if (type === 'keydown') listener = fn;
  },
  removeEventListener() { /* the module installs once and never removes */ },
};

function press(key = 'Escape', target: unknown = { tagName: 'DIV' }): FakeEvent {
  const ev: FakeEvent = { key, target, defaultPrevented: false, propagationStopped: false };
  const e = ev as unknown as { preventDefault(): void; stopPropagation(): void };
  e.preventDefault = () => { ev.defaultPrevented = true; };
  e.stopPropagation = () => { ev.propagationStopped = true; };
  listener?.(ev as unknown as FakeEvent);
  return ev;
}

test('only the top handler runs, and unwinding restores the one below', () => {
  const fired: string[] = [];
  const offA = pushEscHandler(() => fired.push('a'));
  const offB = pushEscHandler(() => fired.push('b'));

  press();
  assert.deepEqual(fired, ['b'], 'the most recently pushed handler wins');

  offB();
  press();
  assert.deepEqual(fired, ['b', 'a'], 'closing the top overlay re-exposes the one beneath');

  offA();
  press();
  assert.deepEqual(fired, ['b', 'a'], 'an empty stack ignores Escape');
  assert.equal(__escStackDepthForTests(), 0);
});

test('Escape inside a text field never reaches the stack', () => {
  const fired: string[] = [];
  const off = pushEscHandler(() => fired.push('x'));
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    press('Escape', { tagName });
  }
  press('Escape', { tagName: 'DIV', isContentEditable: true });
  assert.deepEqual(fired, [], 'fields own their own Escape (revert / close dropdown)');
  press();
  assert.deepEqual(fired, ['x']);
  off();
});

test('other keys pass through untouched', () => {
  const fired: string[] = [];
  const off = pushEscHandler(() => fired.push('x'));
  const ev = press('Enter');
  assert.deepEqual(fired, []);
  assert.equal(ev.defaultPrevented, false, 'a non-Escape key must not be swallowed');
  off();
});

test('a handled Escape is stopped so no stray listener also sees it', () => {
  const off = pushEscHandler(() => {});
  const ev = press();
  assert.ok(ev.defaultPrevented && ev.propagationStopped);
  off();
});

test('unregistering out of order removes the right handler', () => {
  const fired: string[] = [];
  const offA = pushEscHandler(() => fired.push('a'));
  const offB = pushEscHandler(() => fired.push('b'));
  offA();                       // remove the BOTTOM one while B is on top
  press();
  assert.deepEqual(fired, ['b']);
  offB();
  press();
  assert.deepEqual(fired, ['b'], 'stack is empty again');
  assert.equal(__escStackDepthForTests(), 0);
});
