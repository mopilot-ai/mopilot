// Auto-update in the renderer (src/session/updates.ts): the updater's state, and prefs pushed to main.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { controlledReads } from './support/async-scenarios.ts';
import type { UpdateState } from '../src/lib/native';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

let onState: (s: any) => void = () => {};
let unsubscribed = 0;
const listeners: ((s: UpdateState) => void)[] = [];
const failures: unknown[][] = [];
const checking: UpdateState = {
  status: 'checking',
  version: '1.0.0',
  available: null,
  error: null,
  checkedAt: null,
};
let readState: () => Promise<UpdateState> = async () => checking;
const configured: any[] = [];
let prefs: any = {};
installNativeStub({
  updates: {
    state: () => readState(),
    onState: (cb: (s: any) => void) => (
      (onState = cb),
      listeners.push(cb),
      () => {
        unsubscribed++;
      }
    ),
    configure: async (c: any) => void configured.push(c),
  },
});
mock.module('../src/lib/ignored.ts', {
  namedExports: {
    noteIgnored: (context: string, error: unknown) => failures.push([context, error]),
    ignoring: (context: string) => (error: unknown) => failures.push([context, error]),
  },
});
stubStore({ useStore: (f: any) => f({ prefs }) });
const { createElement, act, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useUpdatePrefsSync, useUpdateState } = await import('../src/session/updates.ts');

beforeEach(() => {
  readState = async () => checking;
  listeners.length = 0;
  failures.length = 0;
  unsubscribed = 0;
});

test('the update state starts idle, loads from main and follows its pushes', async () => {
  const seen: any[] = [];
  const Probe = () => (seen.push(useUpdateState().status), null);
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  assert.equal(seen[0], 'idle');
  assert.equal(seen.at(-1), 'checking');
  await act(async () => onState({ ...checking, status: 'downloading' }));
  assert.equal(seen.at(-1), 'downloading');
  await act(async () => root.unmount());
  assert.equal(unsubscribed, 1);
});

test('prefs sync: auto unless turned off, and only known channels', async () => {
  const Probe = () => (useUpdatePrefsSync(), null);
  const root = createRoot(document.createElement('div'));
  for (const p of [
    {},
    { autoUpdate: false, updateChannel: 'beta' },
    { autoUpdate: true, updateChannel: 'dogfood' },
    { updateChannel: 'nightly' },
  ]) {
    prefs = p;
    await act(async () => root.render(createElement(Probe)));
  }
  await act(async () => root.unmount());
  assert.deepEqual(configured, [
    { auto: true, channel: 'stable' },
    { auto: false, channel: 'beta' },
    { auto: true, channel: 'dogfood' },
    { auto: true, channel: 'stable' },
  ]);
});

const state = (status: UpdateState['status']): UpdateState => ({
  ...checking,
  status,
});
const renderState = async (strict = false) => {
  const seen: UpdateState[] = [];
  const Probe = () => (seen.push(useUpdateState()), null);
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe)));
  return { seen, unmount: () => act(async () => root.unmount()) };
};

test('a live update wins over an older initial snapshot, then later events stay in order', async () => {
  const reads = controlledReads<UpdateState>();
  readState = reads.read;
  const p = await renderState();
  const downloading = {
    ...state('downloading'),
    progress: { version: '2', received: 10, total: 20 },
  };
  await act(async () => onState(downloading));
  assert.equal(p.seen.at(-1), downloading);
  await act(async () => reads.requests[0].resolve(state('ready')));
  assert.equal(p.seen.at(-1), downloading, 'a late ready snapshot must not enable Restart while downloading');
  const installing = state('installing');
  await act(async () => onState(installing));
  assert.equal(p.seen.at(-1), installing);
  await p.unmount();
});

test('an obsolete initial-read rejection leaves the live state and diagnostics alone', async () => {
  const reads = controlledReads<UpdateState>();
  readState = reads.read;
  const p = await renderState();
  const ready = { ...state('ready'), available: { version: '2', notes: '' } };
  await act(async () => onState(ready));
  await act(async () => reads.requests[0].reject(new Error('obsolete read')));
  assert.equal(p.seen.at(-1), ready);
  assert.deepEqual(failures, []);
  await p.unmount();
});

test('a current initial read failure is recorded once and a later event recovers', async () => {
  const reads = controlledReads<UpdateState>();
  readState = reads.read;
  const p = await renderState();
  const error = new Error('state unavailable');
  await act(async () => reads.requests[0].reject(error));
  assert.equal(p.seen.at(-1)!.status, 'idle');
  assert.deepEqual(failures, [['read the update state', error]]);
  const ready = state('ready');
  await act(async () => onState(ready));
  assert.equal(p.seen.at(-1), ready);
  await p.unmount();
});

for (const result of ['success', 'failure'] as const) {
  test(`cleanup retires queued callbacks and a late snapshot ${result}, and a remount loads independently`, async () => {
    const reads = controlledReads<UpdateState>();
    readState = reads.read;
    const first = await renderState();
    const oldEvent = listeners[0];
    await first.unmount();
    assert.equal(unsubscribed, 1);
    const renders = first.seen.length;
    const second = await renderState();
    await act(async () => {
      oldEvent(state('error'));
      if (result === 'success') reads.requests[0].resolve(state('ready'));
      else reads.requests[0].reject(new Error('retired read'));
    });
    assert.equal(first.seen.length, renders);
    assert.equal(second.seen.at(-1)!.status, 'idle', 'replacement read remains pending');
    assert.deepEqual(failures, []);
    const fresh = state('checking');
    await act(async () => reads.requests[1].resolve(fresh));
    assert.equal(second.seen.at(-1), fresh);
    await second.unmount();
    assert.equal(unsubscribed, 2);
  });

  test(`Strict Mode retires the first setup's ${result} while its replacement is pending`, async () => {
    const reads = controlledReads<UpdateState>();
    readState = reads.read;
    const p = await renderState(true);
    assert.equal(reads.requests.length, 2);
    assert.equal(unsubscribed, 1);
    await act(async () => {
      listeners[0](state('error'));
      if (result === 'success') reads.requests[0].resolve(state('ready'));
      else reads.requests[0].reject(new Error('retired setup'));
    });
    assert.equal(p.seen.at(-1)!.status, 'idle');
    assert.deepEqual(failures, []);
    const fresh = state('downloading');
    await act(async () => reads.requests[1].resolve(fresh));
    assert.equal(p.seen.at(-1), fresh);
    const ready = state('ready');
    await act(async () => listeners[1](ready));
    assert.equal(p.seen.at(-1), ready);
    await p.unmount();
    assert.equal(unsubscribed, 2);
  });
}

test('simultaneous consumers keep independent snapshot ownership', async () => {
  const reads = controlledReads<UpdateState>();
  readState = reads.read;
  const sidebar = await renderState();
  const about = await renderState();
  const downloading = state('downloading');
  await act(async () => listeners[0](downloading));
  const snapshot = state('checking');
  await act(async () => reads.requests[1].resolve(snapshot));
  assert.equal(about.seen.at(-1), snapshot);
  await act(async () => reads.requests[0].resolve(state('ready')));
  assert.equal(sidebar.seen.at(-1), downloading);
  assert.equal(about.seen.at(-1), snapshot);
  await sidebar.unmount();
  const ready = state('ready');
  await act(async () => listeners[1](ready));
  assert.equal(about.seen.at(-1), ready);
  await about.unmount();
});
