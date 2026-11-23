// MoMo's settings in the renderer (src/session/momoPrefs.ts): read from the store's prefs.momo with their defaults, and saved one key at a time through main; a refused save is told and resolves false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { fakeStore, render } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const store = fakeStore<any>({ prefs: { theme: 'dark' } });
const toasts: string[] = [];
stubStore({
  useStore: store.useStore,
  toast: (text: string, tone: string) => toasts.push(`${tone}: ${text}`),
});
const sets: any[] = [];
let refuse = false;
installNativeStub({
  momoPrefs: {
    set: async (key: string, value: unknown) => {
      sets.push([key, value]);
      if (refuse) throw Object.assign(new Error('MoMo is not available.'), { code: 'not_allowed' });
      return true;
    },
  },
});
mockSource('src/lib/ignored.ts', { errorText: (e: any) => e.message });
const { useMomoPrefs, saveMomoPref } = await import('../src/session/momoPrefs.ts');

test('the settings follow the store’s prefs.momo, with defaults for what is missing', async () => {
  const seen: any[] = [];
  const Probe = () => {
    seen.push(useMomoPrefs());
    return null;
  };
  const { unmount } = await render(createElement(Probe));
  assert.equal(seen.at(-1).routines.proactivity, 'default');
  await act(async () => store.setState({ prefs: { theme: 'dark', momo: { routines: { proactivity: 'off' } } } }));
  assert.equal(seen.at(-1).routines.proactivity, 'off');
  const n = seen.length;
  await act(async () => store.setState({ prefs: { ...store.getState().prefs, theme: 'light' } }));
  assert.equal(seen.at(-1), seen[n - 1], 'another pref changing reads nothing again');
  await unmount();
});

test('a save resolves true; a refused one is told and resolves false', async () => {
  assert.equal(await saveMomoPref('paused', true), true);
  refuse = true;
  assert.equal(await saveMomoPref('routines.proactivity', 'low'), false);
  assert.deepEqual(sets, [
    ['paused', true],
    ['routines.proactivity', 'low'],
  ]);
  assert.deepEqual(toasts, ['error: MoMo is not available.']);
});
