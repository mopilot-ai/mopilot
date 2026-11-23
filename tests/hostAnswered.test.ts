// Whether main has answered the Host gate (src/lib/host.ts useHostAnswered): a window with no Host bridge has nothing to wait for, one waiting on main is not answered yet, and a failed read counts as an answer of "no Host" so nothing waits for ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const { useHostAccess, useHostAnswered } = await import('../src/lib/host.ts');
const seen: [boolean, boolean][] = [];
function Probe() {
  seen.push([useHostAnswered(), useHostAccess()]);
  return null;
}
async function mount() {
  const el = document.createElement('div');
  document.body.append(el);
  await act(async () => createRoot(el).render(createElement(Probe)));
}

test('no bridge: nothing to wait for; with one, not answered until main answers, and a failed read answers "no"', async () => {
  seen.length = 0;
  await mount();
  assert.deepEqual(seen.at(-1), [true, false], 'no Host bridge in this window');
  let fail!: (e: Error) => void;
  const fake = fakeNative({ host: { access: () => new Promise<boolean>((_ok, no) => (fail = no)) } });
  installNative(fake);
  seen.length = 0;
  await mount();
  assert.deepEqual(seen.at(-1), [false, false], 'main has not answered');
  await act(async () => fail(new Error('ipc closed')));
  assert.deepEqual(seen.at(-1), [true, false], 'a failed read is an answer');
  await act(async () => fake.emit('host.onAccess', true));
  assert.deepEqual(seen.at(-1), [true, true]);
  await act(async () => fake.emit('host.onAccess', true));
  assert.deepEqual(seen.at(-1), [true, true], 'the same answer again changes nothing');
});
