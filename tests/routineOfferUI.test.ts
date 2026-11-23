// "Save as routine" under a chat's last turn (#3571, G4; src/components/thread/RoutineOffer.tsx): nothing unless main
// offers it, one line with how many browser steps, a name to save it under, what main refused said, Cancel back, and
// the saved line naming where it runs.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render, click, type, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';

let offer: any = null;
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => ({ routineOffer: offer }),
    useSessionField: (_id: any, pick: any) => pick({ routineOffer: offer }),
  },
});
const calls: any[] = [];
let saveLast: (chatId: string, name: string) => Promise<any> = async (_c, name) => ({ ok: true, routine: { name } });
installNativeStub({ routines: { saveLast: (c: string, n: string) => (calls.push([c, n]), saveLast(c, n)) } });
const { RoutineOffer } = await import('../src/components/thread/RoutineOffer.tsx');

const button = (root: Element, label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLElement;
const submit = async (root: Element) => {
  await click(button(root, 'Save'));
  await flush();
};

test('nothing when main offers nothing', async () => {
  offer = null;
  const { host, unmount } = await render(h(RoutineOffer, { chatId: 'c1' }));
  assert.equal(host.innerHTML, '');
  await unmount();
});

test('the offer: one line, a name, Save; the saved line says where it runs', async () => {
  offer = { turnId: 't', steps: 5 };
  calls.length = 0;
  const { host, unmount } = await render(h(RoutineOffer, { chatId: 'c1' }));
  assert.equal(host.textContent, 'Save as routine5 steps');
  await click(button(host, 'Save as routine'));
  const save = button(host, 'Save');
  assert.equal(save.hasAttribute('disabled'), true, 'no name yet');
  await type(host.querySelector('input[aria-label="Routine name"]'), '  Buy a mug ');
  await submit(host);
  assert.deepEqual(calls, [['c1', 'Buy a mug']]);
  assert.equal(host.textContent, 'Saved “Buy a mug”. Run it from the / menu.');
  await unmount();
});

test('one step reads singular; what main refused shows, and Cancel goes back to the line', async () => {
  offer = { turnId: null, steps: 1 };
  saveLast = async () => ({ ok: false, error: 'A routine named "Buy" already exists' });
  const { host, unmount } = await render(h(RoutineOffer, { chatId: 'c1' }));
  assert.match(host.textContent!, /1 step$/);
  await click(button(host, 'Save as routine'));
  await type(host.querySelector('input'), 'Buy');
  // Enter submits the form
  const form = host.querySelector('form')!;
  form.dispatchEvent(new (globalThis as any).window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(host.querySelector('[role=alert]')!.textContent, 'A routine named "Buy" already exists');
  // a save that can't reach main says so
  saveLast = () => Promise.reject(new Error('ipc gone'));
  await submit(host);
  assert.equal(host.querySelector('[role=alert]')!.textContent, 'Couldn’t save the routine.');
  await click(button(host, 'Cancel'));
  assert.equal(host.querySelector('[role=alert]'), null);
  assert.ok(button(host, 'Save as routine'));
  // an empty name never submits
  await click(button(host, 'Save as routine'));
  await type(host.querySelector('input'), '   ');
  calls.length = 0;
  host.querySelector('form')!.dispatchEvent(new (globalThis as any).window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(calls, []);
  await unmount();
});
