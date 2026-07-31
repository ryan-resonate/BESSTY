import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetNotifyForTests, dismissToast, getState, notify, resolveDialog, subscribe,
} from './notify';

/** Subscribe with a no-op so the store counts as "provider mounted".
 *  Note the `await` — `try { return fn() } finally { unsub() }` would
 *  unsubscribe the moment the promise is CREATED, dropping the provider
 *  part-way through the test. */
async function withProvider(fn: () => Promise<void>) {
  const unsub = subscribe(() => {});
  try {
    await fn();
  } finally {
    unsub();
  }
}

test('toasts stack and can be dismissed individually', () => {
  __resetNotifyForTests();
  const a = notify.info('first');
  const b = notify.success('second');
  assert.equal(getState().toasts.length, 2);
  assert.deepEqual(getState().toasts.map((t) => t.message), ['first', 'second']);

  dismissToast(a);
  assert.deepEqual(getState().toasts.map((t) => t.message), ['second']);
  dismissToast(b);
  assert.equal(getState().toasts.length, 0);
  // Dismissing an unknown id is a no-op, not a throw.
  dismissToast(9999);
});

test('errors are sticky by default, other kinds are not', () => {
  __resetNotifyForTests();
  notify.error('boom');
  notify.warning('careful');
  const [err, warn] = getState().toasts;
  assert.equal(err.sticky, true, 'an error that auto-vanishes is one nobody read');
  assert.equal(warn.sticky, false);
  // Explicit override still wins.
  __resetNotifyForTests();
  notify.error('transient', { sticky: false });
  assert.equal(getState().toasts[0].sticky, false);
});

test('subscribers are notified and get the current state immediately', () => {
  __resetNotifyForTests();
  const seen: number[] = [];
  const unsub = subscribe((s) => seen.push(s.toasts.length));
  assert.deepEqual(seen, [0], 'fires immediately on subscribe');
  notify.info('x');
  assert.deepEqual(seen, [0, 1]);
  unsub();
  notify.info('y');
  assert.deepEqual(seen, [0, 1], 'no calls after unsubscribe');
});

test('confirm resolves with the answer', async () => {
  __resetNotifyForTests();
  await withProvider(async () => {
    const p = notify.confirm({ title: 'Delete?' });
    const dlg = getState().dialogs[0];
    assert.equal(dlg.kind, 'confirm');
    resolveDialog(dlg.id, true);
    assert.equal(await p, true);
    assert.equal(getState().dialogs.length, 0, 'answered dialog leaves the queue');

    const p2 = notify.confirm({ title: 'Delete?' });
    resolveDialog(getState().dialogs[0].id, false);
    assert.equal(await p2, false);
  });
});

test('prompt resolves with the string, or null when cancelled', async () => {
  __resetNotifyForTests();
  await withProvider(async () => {
    const p = notify.prompt({ title: 'Name' });
    resolveDialog(getState().dialogs[0].id, 'Site A');
    assert.equal(await p, 'Site A');

    const p2 = notify.prompt({ title: 'Name' });
    resolveDialog(getState().dialogs[0].id, null);
    assert.equal(await p2, null);
  });
});

test('dialogs queue rather than overwrite', async () => {
  __resetNotifyForTests();
  await withProvider(async () => {
    const first = notify.confirm({ title: 'One' });
    const second = notify.confirm({ title: 'Two' });
    assert.equal(getState().dialogs.length, 2, 'both are pending');
    // Answering the head reveals the next; neither answer is lost.
    resolveDialog(getState().dialogs[0].id, true);
    assert.equal(await first, true);
    assert.equal(getState().dialogs.length, 1);
    assert.equal(getState().dialogs[0].opts.title, 'Two');
    resolveDialog(getState().dialogs[0].id, false);
    assert.equal(await second, false);
  });
});

test('with no provider mounted a dialog answers negatively instead of hanging', async () => {
  __resetNotifyForTests();
  // No subscriber: a caller awaiting a confirm would otherwise wait forever,
  // and "no" is the safe answer for a destructive action.
  assert.equal(await notify.confirm({ title: 'Delete everything?' }), false);
  assert.equal(await notify.prompt({ title: 'Name' }), null);
  assert.equal(getState().dialogs.length, 0, 'nothing left queued');
});
