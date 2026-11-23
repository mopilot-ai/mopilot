// The exit gate's dialog (src/components/dialogs/QuitDialog.tsx): confirm quit/restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
let confirm: (id: number, req: any) => void = () => {};
let installResult: () => Promise<boolean> = async () => true;
installNativeStub({
  exitGate: {
    onConfirm: (cb: any) => ((confirm = cb), () => calls.push(['offConfirm'])),
    answer: (id: number, ok: boolean) => calls.push(['answer', id, ok]),
  },
  updates: { install: (o: unknown) => (calls.push(['install', o]), installResult()) },
});
stubStore({ toastFailure: (what: string) => (e: Error) => calls.push(['toastFailure', what, e.message]) });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QuitDialog } = await import('../src/components/dialogs/QuitDialog.tsx');

const host = document.createElement('div');
const root = createRoot(host);
await act(() => root.render(createElement(QuitDialog)));
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLElement;

test('nothing shows until main asks', () => {
  assert.equal(host.innerHTML, '');
});

test('quitting lists what would stop; Quit answers yes', async () => {
  await act(() => confirm(1, { reason: 'quit', text: '2 turns are running' }));
  assert.equal(host.querySelector('#quit-title')!.textContent, 'Quit MoPilot?');
  assert.equal(host.querySelector('#quit-detail')!.textContent, '2 turns are running');
  await act(() => button('Quit').click());
  assert.deepEqual(calls.splice(0), [['answer', 1, true]]);
  assert.equal(host.innerHTML, '');
});

test('an update restart without detail; Cancel and Escape answer no', async () => {
  await act(() => confirm(2, { reason: 'update', text: '' }));
  assert.equal(host.querySelector('#quit-title')!.textContent, 'Restart to update?');
  assert.equal(host.querySelector('#quit-detail') === null, true);
  assert.ok(button('Restart now'));
  await act(() => button('Cancel').click());
  await act(() => confirm(3, { reason: 'update' }));
  const backdrop = host.querySelector('.sketch-backdrop')!;
  await act(() => backdrop.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as any));
  assert.ok(host.querySelector('.dialog'));
  await act(() => backdrop.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as any));
  assert.deepEqual(calls.splice(0), [
    ['answer', 2, false],
    ['answer', 3, false],
  ]);
});

test('a restart to update while work runs can wait for idle instead; quitting never offers it', async () => {
  await act(() => confirm(4, { reason: 'update', text: '1 turn is running' }));
  await act(() => button('Restart when idle').click());
  assert.equal(host.innerHTML, '');
  assert.deepEqual(calls.splice(0), [
    ['answer', 4, false],
    ['install', { when: 'idle' }],
  ]);
  // scheduling it can fail: the user hears why
  installResult = () => Promise.reject(new Error('gone'));
  await act(() => confirm(5, { reason: 'update', text: '1 turn is running' }));
  await act(async () => button('Restart when idle').click());
  assert.deepEqual(calls.splice(0), [
    ['answer', 5, false],
    ['install', { when: 'idle' }],
    ['toastFailure', "Couldn't schedule the restart to update", 'gone'],
  ]);
  installResult = async () => true;
  // nothing running: nothing to wait for
  await act(() => confirm(6, { reason: 'update', text: '' }));
  assert.equal(button('Restart when idle'), undefined);
  await act(() => button('Cancel').click());
  await act(() => confirm(7, { reason: 'quit', text: '1 turn is running' }));
  assert.equal(button('Restart when idle'), undefined);
  await act(() => button('Cancel').click());
  calls.splice(0);
});

test('with chats on this Mac\'s background Host the sheet offers Quit and stop them, which answers "stop"', async () => {
  await act(() => confirm(9, { reason: 'quit', text: '2 chats keep running on this Mac.', keeps: 2 }));
  await act(() => button('Quit and stop them').click());
  assert.deepEqual(calls.splice(0), [['answer', 9, 'stop']]);
  await act(() => confirm(10, { reason: 'quit', text: '1 turn will stop.' }));
  assert.equal(button('Quit and stop them'), undefined);
  await act(() => button('Cancel').click());
  calls.splice(0);
});

test('unmounting unsubscribes', async () => {
  await act(() => root.unmount());
  assert.deepEqual(calls.splice(0), [['offConfirm']]);
});
