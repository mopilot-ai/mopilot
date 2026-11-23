// Codex's Remote Control in the window (src/session/harness/codexRemoteControl.ts): read while a Codex chat shows it and again on a timer,
// switched by a press whose answer is the state, a failure said in a toast, and an older read never overwriting a newer press.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h } from 'react';
import { mount } from './support/composer-kit.ts';
import { fakeStore } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({});
stubStore(store.exports);
const view = (status: string, error: string | null = null) => ({ status, environmentId: null, error });
let reads: Array<() => Promise<any>>;
let sets: Array<[boolean, () => Promise<any>]>;
let polls: Array<{ key: string; ms: number; run: () => void; stopped: boolean }>;
mock.module('../src/harness/adapters/codexApi.ts', {
  namedExports: {
    codexApi: {
      remoteControlRead: () => reads.shift()!(),
      remoteControlSet: (on: boolean) => sets.shift()![1](),
    },
  },
});
mock.module('../src/lib/visiblePoll.ts', {
  namedExports: {
    visiblePoll: (key: string, ms: number, run: () => void) => {
      const p = { key, ms, run, stopped: false };
      polls.push(p);
      return () => void (p.stopped = true);
    },
  },
});
const { useCodexRemoteControl, setCodexRemoteControl } = await import('../src/session/harness/codexRemoteControl.ts');

let seen: any;
const Probe = ({ active }: { active: boolean }) => ((seen = useCodexRemoteControl(active)), null);
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
beforeEach(() => {
  reads = [];
  sets = [];
  polls = [];
  store.calls.length = 0;
});

test('a read that fails before anything is known leaves an off switch that can be pressed, and one that fails later keeps what was known', async () => {
  reads.push(async () => {
    throw new Error("Codex isn't started");
  });
  const m = await mount(h(Probe, { active: true }));
  await settle();
  // nothing was known: the switch reads as off, ready to be pressed
  assert.equal(seen.status, 'disabled');
  reads.push(async () => view('connected'));
  polls.at(-1)!.run();
  await settle();
  assert.equal(seen.status, 'connected');
  reads.push(async () => {
    throw new Error('gone');
  });
  polls.at(-1)!.run();
  await settle();
  assert.equal(seen.status, 'connected');
  await m.unmount();
});

test('nothing is read or polled while no Codex chat shows it; one that does reads at once and again on the timer, and stops with it', async () => {
  const m = await mount(h(Probe, { active: false }));
  assert.equal(polls.length, 0);
  reads.push(
    async () => view('connected'),
    async () => view('disabled'),
  );
  await m.render(h(Probe, { active: true }));
  await settle();
  assert.equal(seen.status, 'connected');
  assert.equal(polls.length, 1);
  assert.equal(polls[0].key, 'codex-remote-control');
  polls[0].run();
  await settle();
  assert.equal(seen.status, 'disabled');
  await m.render(h(Probe, { active: false }));
  assert.equal(polls[0].stopped, true);
  await m.unmount();
});

test('a press shows the state main answers, and a refusal is a toast', async () => {
  reads.push(async () => view('disabled'));
  const m = await mount(h(Probe, { active: true }));
  await settle();
  sets.push([true, async () => view('connecting')]);
  await act(async () => setCodexRemoteControl(true));
  assert.equal(seen.status, 'connecting');
  sets.push([false, async () => Promise.reject(new Error('not reachable'))]);
  await act(async () => setCodexRemoteControl(false));
  assert.equal(seen.status, 'connecting');
  assert.deepEqual(store.calls.at(-1), ['toast', "Couldn't turn off Remote Control: not reachable", 'error']);
  sets.push([true, async () => Promise.reject(new Error('needs login'))]);
  await act(async () => setCodexRemoteControl(true));
  assert.match(String(store.calls.at(-1)![1]), /Couldn't turn on Remote Control/);
  await m.unmount();
});

test('a read that began before a press, or before a newer read, never overwrites it', async () => {
  reads.push(async () => view('disabled'));
  const m = await mount(h(Probe, { active: true }));
  let slow: (v: any) => void = () => undefined;
  reads.push(() => new Promise((r) => (slow = r)));
  polls.at(-1)!.run();
  sets.push([true, async () => view('connected')]);
  await act(async () => setCodexRemoteControl(true));
  slow(view('disabled'));
  await settle();
  assert.equal(seen.status, 'connected');
  // two reads in flight: the later one stands whichever answers last
  let first: (v: any) => void = () => undefined;
  let second: (v: any) => void = () => undefined;
  reads.push(
    () => new Promise((r) => (first = r)),
    () => new Promise((r) => (second = r)),
  );
  polls.at(-1)!.run();
  polls.at(-1)!.run();
  second(view('errored'));
  await settle();
  first(view('disabled'));
  await settle();
  assert.equal(seen.status, 'errored');
  // a failed read that began before a press leaves the press's state alone
  let failing: (e: Error) => void = () => undefined;
  reads.push(() => new Promise((_, r) => (failing = r)));
  polls.at(-1)!.run();
  sets.push([false, async () => view('disabled')]);
  await act(async () => setCodexRemoteControl(false));
  failing(new Error('late'));
  await settle();
  assert.equal(seen.status, 'disabled');
  await m.unmount();
});
