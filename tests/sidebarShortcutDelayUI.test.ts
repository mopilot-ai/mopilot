// Modifier-only holds reveal sidebar hints after a delay and retire pending reveals with their input owner.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h, StrictMode } from 'react';
import { reset, thread, mountSidebar, key, fire, update, getState, render, Sidebar } from './support/shell-sidebar-kit.ts';

const hints = (view: Awaited<ReturnType<typeof mountSidebar>>) => view.$$('.chat-shortcut-hint').map((el) => el.textContent);
const advance = (t: TestContext, ms: number) => act(async () => t.mock.timers.tick(ms));
const press = () => key(document.body, 'Meta', { metaKey: true });
const release = () => fire(document.body, new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }));
const native = (combo: string, paneId = 'browser') =>
  act(async () => window.dispatchEvent(new CustomEvent('browser-shortcut-modifiers', { detail: { combo, paneId } })));

async function setup(t: TestContext, strict = false) {
  reset({
    threads: { a: thread('a'), b: thread('b', { updatedAt: 5 }) },
    threadOrder: ['a', 'b'],
    paneActive: 'browser',
    diffPanel: { open: true },
  });
  const view = strict ? await render(h(StrictMode, null, h(Sidebar.Sidebar, { width: 280 }))) : await mountSidebar();
  t.after(() => view.unmount());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return view;
}

test('Command hints wait 500 ms; short taps never reveal and a fresh hold still works', async (t) => {
  const view = await setup(t);
  await press();
  assert.deepEqual(hints(view), []);
  await advance(t, 499);
  assert.deepEqual(hints(view), []);
  await release();
  await advance(t, 1000);
  assert.deepEqual(hints(view), []);
  await press();
  await advance(t, 499);
  assert.deepEqual(hints(view), []);
  await advance(t, 1);
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  await release();
  assert.deepEqual(hints(view), []);
});

test('repeats, modifier changes and sidebar mutations preserve a continuous hold deadline and reveal current targets', async (t) => {
  const view = await setup(t);
  await press();
  await advance(t, 250);
  await key(document.body, 'Meta', { metaKey: true, repeat: true });
  await key(document.body, 'Alt', { metaKey: true, altKey: true });
  await update({ ...getState(), threadOrder: ['b'] });
  assert.deepEqual(hints(view), []);
  await advance(t, 249);
  assert.deepEqual(hints(view), []);
  await advance(t, 1);
  assert.deepEqual(hints(view), ['⌥⌘1']);
  await fire(document.body, new KeyboardEvent('keyup', { key: 'Alt', metaKey: true, bubbles: true }));
  assert.deepEqual(hints(view), ['⌘1']);
});

test('a normal Command shortcut cancels pending or visible hints without delaying the key event', async (t) => {
  const view = await setup(t);
  for (const elapsed of [200, 500]) {
    await press();
    await advance(t, elapsed);
    await key(document.body, 'c', { code: 'KeyC', metaKey: true });
    assert.deepEqual(hints(view), []);
    await fire(document.body, new KeyboardEvent('keyup', { key: 'c', code: 'KeyC', metaKey: true, bubbles: true }));
    await advance(t, 1000);
    assert.deepEqual(hints(view), []);
    await release();
  }
  await press();
  await advance(t, 500);
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
});

test('blur, visibility and IME retire a pending hold and let the next hold reveal', async (t) => {
  const view = await setup(t);
  for (const cancel of [
    () => act(async () => window.dispatchEvent(new Event('blur'))),
    () => act(async () => document.dispatchEvent(new Event('visibilitychange'))),
    () => key(document.body, 'Process', { metaKey: true, isComposing: true }),
    () => key(document.body, 'Process', { metaKey: true, keyCode: 229 }),
  ]) {
    await press();
    await advance(t, 200);
    await cancel();
    await advance(t, 1000);
    assert.deepEqual(hints(view), []);
    await press();
    await advance(t, 500);
    assert.deepEqual(hints(view), ['⌘1', '⌘2']);
    await release();
  }
});

test('a blocking dialog cancels the wait; removing it requires a fresh full delay', async (t) => {
  const view = await setup(t);
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  t.after(() => dialog.remove());
  await press();
  await advance(t, 250);
  await act(async () => document.body.append(dialog));
  await advance(t, 1000);
  assert.deepEqual(hints(view), []);
  await act(async () => dialog.remove());
  await advance(t, 499);
  assert.deepEqual(hints(view), []);
  await advance(t, 1);
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
});

test('native browser holds use the same delay and releases cannot clear a replacement renderer hold', async (t) => {
  const view = await setup(t);
  await native('⌘', 'other');
  await advance(t, 500);
  assert.deepEqual(hints(view), []);
  await native('⌘');
  await advance(t, 200);
  await native('');
  await advance(t, 500);
  assert.deepEqual(hints(view), []);
  await native('⌘');
  await advance(t, 200);
  await press();
  await native('');
  await advance(t, 499);
  assert.deepEqual(hints(view), []);
  await advance(t, 1);
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  await release();
  await native('⌘');
  await advance(t, 500);
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  await native('');
  assert.deepEqual(hints(view), []);
});

test('Strict Mode cleanup cancels a pending reveal and a replacement sidebar starts a new hold', async (t) => {
  const view = await setup(t, true);
  await press();
  await advance(t, 200);
  await view.unmount();
  const replacement = await mountSidebar();
  t.after(() => replacement.unmount());
  await advance(t, 500);
  assert.deepEqual(hints(replacement), []);
  await press();
  await advance(t, 499);
  assert.deepEqual(hints(replacement), []);
  await advance(t, 1);
  assert.deepEqual(hints(replacement), ['⌘1', '⌘2']);
});

test('already queued reveal callbacks cannot publish after cancellation or effect disposal', async (t) => {
  const view = await setup(t);
  const callbacks: (() => void)[] = [];
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 500) callbacks.push(args[0] as () => void);
    return schedule(...args);
  });
  await press();
  await advance(t, 200);
  await release();
  await press();
  await advance(t, 100);
  assert.equal(callbacks.length, 2);
  await act(async () => callbacks[0]());
  assert.deepEqual(hints(view), []);
  await advance(t, 399);
  assert.deepEqual(hints(view), []);
  await advance(t, 1);
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  await release();
  await press();
  const retired = callbacks.at(-1)!;
  await view.unmount();
  const replacement = await mountSidebar();
  t.after(() => replacement.unmount());
  await press();
  await act(async () => retired());
  assert.deepEqual(hints(replacement), []);
  await advance(t, 499);
  assert.deepEqual(hints(replacement), []);
  await advance(t, 1);
  assert.deepEqual(hints(replacement), ['⌘1', '⌘2']);
});

test('a native pane that closes or loses selection cannot finish its pending reveal', async (t) => {
  const view = await setup(t);
  for (const patch of [{ paneActive: 'other' }, { diffPanel: { open: false } }]) {
    await update({ ...getState(), paneActive: 'browser', diffPanel: { open: true } });
    await native('⌘');
    await advance(t, 200);
    await update({ ...getState(), ...patch });
    await advance(t, 1000);
    assert.deepEqual(hints(view), []);
    await native('');
  }
});
