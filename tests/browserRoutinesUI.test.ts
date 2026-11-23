// Settings › Browser › Routines (#3571, G4; src/components/pages/settings/BrowserRoutines.tsx, src/lib/routines.ts):
// what a routine is and the empty state, each routine with its steps and runs, Rename (revision passed, kept open when
// main refuses), Delete after a confirm, a failed read with Try again, a read again when main says it changed, an older
// read losing to a newer one, and the listener removed with the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render, click, type, flush } from './support/shell-chrome-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';

const R = {
  id: 'r1',
  rev: 2,
  kind: 'browser',
  name: 'Buy a mug',
  description: 'Adds a mug.',
  steps: ['navigate x', 'left_click "Go"'],
  params: ['search'],
  runs: 1,
  updatedAt: 1,
};
const calls: any[] = [];
let list: () => Promise<any> = async () => ({ ok: true, routines: [] });
let edit: (...a: any[]) => Promise<any> = async () => ({ ok: true, routine: R });
let remove: (id: string) => Promise<any> = async () => ({ ok: true, removed: true });
const listeners = new Set<() => void>();
installNativeStub({
  routines: {
    list: () => (calls.push(['list']), list()),
    edit: (...a: any[]) => (calls.push(['edit', ...a]), edit(...a)),
    remove: (id: string) => (calls.push(['remove', id]), remove(id)),
    onChanged: (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb)),
  },
});
const { BrowserRoutines, ROUTINES_INTRO, ROUTINES_EMPTY, routineMeta } = await import(
  '../src/components/pages/settings/BrowserRoutines.tsx'
);

const button = (root: Element, label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLElement;
const reset = () => {
  calls.length = 0;
  listeners.clear();
  list = async () => ({ ok: true, routines: [] });
  edit = async () => ({ ok: true, routine: R });
  remove = async () => ({ ok: true, removed: true });
};
const mount = async () => {
  const r = await render(h(BrowserRoutines));
  await flush();
  return r;
};

test('empty: what a routine is and how to make one', async () => {
  reset();
  const { host, unmount } = await mount();
  assert.match(host.textContent!, new RegExp(ROUTINES_INTRO.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(host.textContent!, new RegExp(ROUTINES_EMPTY.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  await unmount();
  assert.equal(listeners.size, 0, 'the listener goes with the page');
});

test('a problem listing the routines as skills is one line, shown only with routines to list', async () => {
  reset();
  list = async () => ({ ok: true, routines: [R], skillsProblem: 'The Routines plugin was removed.' });
  const { host, unmount } = await mount();
  assert.match(host.textContent!, /New chats won't list these\. The Routines plugin was removed\./);
  await unmount();
  reset();
  list = async () => ({ ok: true, routines: [], skillsProblem: 'The Routines plugin was removed.' });
  const empty = await mount();
  assert.doesNotMatch(empty.host.textContent!, /New chats/);
  await empty.unmount();
});

test('routineMeta: steps and runs, singular and plural', () => {
  assert.equal(routineMeta({ ...R, steps: ['a'], runs: 0 } as any), '1 step · not run yet');
  assert.equal(routineMeta({ ...R, runs: 1 } as any), '2 steps · ran 1 time');
  assert.equal(routineMeta({ ...R, runs: 3 } as any), '2 steps · ran 3 times');
});

test('a routine: its name, what it does and its meta; Rename passes the revision; a refused rename stays open and says why', async () => {
  reset();
  list = async () => ({ ok: true, routines: [R, { ...R, id: 'r2', description: '', name: 'Bare' }] });
  const { host, unmount } = await mount();
  assert.match(host.textContent!, /Buy a mugAdds a mug\.2 steps · ran 1 time/);
  await click(button(host, 'Rename'));
  const [nameInput, descInput] = [...host.querySelectorAll('input')];
  await type(nameInput, '');
  assert.equal(button(host, 'Save').hasAttribute('disabled'), true);
  edit = async () => ({ ok: false, error: 'This routine changed meanwhile. Open it again.' });
  await type(nameInput, ' Mug run ');
  await type(descInput, ' Buys one. ');
  await click(button(host, 'Save'));
  assert.deepEqual(
    calls.find((c) => c[0] === 'edit'),
    ['edit', 'r1', 2, { name: 'Mug run', description: 'Buys one.' }],
  );
  assert.match(host.querySelector('[role=alert]')!.textContent!, /changed meanwhile/);
  assert.ok(button(host, 'Save'), 'still editing');
  edit = async () => ({ ok: true, routine: R });
  await click(button(host, 'Save'));
  assert.equal(host.querySelector('[role=alert]'), null);
  assert.equal(button(host, 'Save'), undefined, 'closed once saved');
  // Cancel closes without saving
  await click(button(host, 'Rename'));
  await click(button(host, 'Cancel'));
  assert.equal(button(host, 'Cancel'), undefined);
  await unmount();
});

test('Delete asks first; Keep takes it back; a delete that can’t reach main says so', async () => {
  reset();
  list = async () => ({ ok: true, routines: [R] });
  const { host, unmount } = await mount();
  await click(button(host, 'Delete…'));
  await click(button(host, 'Keep'));
  assert.equal(calls.filter((c) => c[0] === 'remove').length, 0);
  await click(button(host, 'Delete…'));
  await click(button(host, 'Delete'));
  assert.deepEqual(calls.at(-1), ['remove', 'r1']);
  remove = () => Promise.reject(new Error('gone'));
  await click(button(host, 'Delete'));
  assert.equal(host.querySelector('[role=alert]')!.textContent, 'Couldn’t save that. Try again');
  await unmount();
});

test('a failed read says so with Try again; main saying it changed reads again; an older read loses to a newer one', async () => {
  reset();
  list = async () => ({ ok: false, error: "Routines aren't ready yet" });
  const { host, unmount } = await mount();
  assert.match(host.querySelector('[role=alert]')!.textContent!, /Routines aren't ready yet/);
  list = () => Promise.reject(new Error('ipc'));
  await click(button(host, 'Try again'));
  assert.match(host.querySelector('[role=alert]')!.textContent!, /Couldn’t load the routines\./);
  const older = deferred<any>();
  const newer = deferred<any>();
  let n = 0;
  list = () => (++n === 1 ? older.promise : newer.promise);
  for (const fn of listeners) fn();
  for (const fn of listeners) fn();
  newer.resolve({ ok: true, routines: [R] });
  await flush();
  older.resolve({ ok: true, routines: [] });
  await flush();
  assert.match(host.textContent!, /Buy a mug/, 'the newer read stands');
  assert.equal(host.querySelector('[role=alert]'), null);
  await unmount();
});

test('a bridge that answers nothing (an older preload): the list says it could not reach the routines', async () => {
  reset();
  list = async () => undefined;
  const { host, unmount } = await mount();
  assert.match(host.querySelector('[role=alert]')!.textContent!, /Couldn’t reach the routines\./);
  await unmount();
});
