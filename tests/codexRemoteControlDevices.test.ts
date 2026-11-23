// Codex's Remote Control devices in the window (src/session/harness/codexRemoteControl.ts): the paired devices read while the link is up,
// revoking one, and a pairing code that counts down, is watched until a device uses it, and is asked for again when it ends.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h } from 'react';
import { mount } from './support/composer-kit.ts';
import { fakeStore } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({});
stubStore(store.exports);
const NOW = 1_700_000_000_000;
let listCalls: Array<() => Promise<any>>;
let revokes: Array<() => Promise<any>>;
let pairings: Array<() => Promise<any>>;
let claims: Array<(code: string) => Promise<any>>;
const claimedWith: string[] = [];
mock.module('../src/harness/adapters/codexApi.ts', {
  namedExports: {
    codexApi: {
      remoteControlRead: async () => ({ status: 'disabled', environmentId: null, error: null }),
      remoteControlClients: () => listCalls.shift()!(),
      remoteControlRevoke: (id: string) => revokes.shift()!(),
      remoteControlPairing: () => pairings.shift()!(),
      remoteControlClaimed: (code: string) => (claimedWith.push(code), claims.shift()!(code)),
    },
  },
});
// the poll the pairing hook counts down on: a test runs it by hand, one beat of `ms` at a time
const polls: Array<{ key: string; ms: number; run: () => void; stopped: boolean }> = [];
mock.module('../src/lib/visiblePoll.ts', {
  namedExports: {
    visiblePoll: (key: string, ms: number, run: () => void) => {
      const poll = { key, ms, run, stopped: false };
      polls.push(poll);
      return () => void (poll.stopped = true);
    },
  },
});
const { useRemoteControlClients, revokeRemoteControlClient, useRemoteControlPairing } = await import(
  '../src/session/harness/codexRemoteControl.ts'
);

const phone = { clientId: 'a', name: 'Phone', platform: 'iOS', lastSeenAt: 1 };
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
beforeEach(() => {
  listCalls = [];
  revokes = [];
  pairings = [];
  claims = [];
  claimedWith.length = 0;
  polls.length = 0;
  store.calls.length = 0;
});
afterEach(() => mock.timers.reset());

let clients: any;
const Clients = ({ connected }: { connected: boolean }) => ((clients = useRemoteControlClients(connected)), null);

test('the devices are read when the link comes up and on refresh, and dropped when it goes down', async () => {
  const m = await mount(h(Clients, { connected: false }));
  assert.equal(clients.clients, null);
  listCalls.push(async () => [phone]);
  await m.render(h(Clients, { connected: true }));
  await settle();
  assert.deepEqual(clients.clients, [phone]);
  listCalls.push(async () => []);
  await act(async () => clients.refresh());
  await settle();
  assert.deepEqual(clients.clients, []);
  await m.render(h(Clients, { connected: false }));
  assert.equal(clients.clients, null);
  assert.equal(clients.error, null);
  await m.unmount();
});

test('a read that fails says why and recovers on refresh; an answer that comes after the link went down is not shown', async () => {
  listCalls.push(async () => Promise.reject(new Error('Sign in to ChatGPT again')));
  const m = await mount(h(Clients, { connected: true }));
  await settle();
  assert.equal(clients.error, 'Sign in to ChatGPT again');
  assert.equal(clients.clients, null);
  listCalls.push(async () => [phone]);
  await act(async () => clients.refresh());
  await settle();
  assert.deepEqual([clients.clients, clients.error], [[phone], null]);
  // two reads in flight: the later one stands, and none shows after the link ends
  let first: (v: any) => void = () => undefined;
  let second: (e: Error) => void = () => undefined;
  listCalls.push(
    () => new Promise((r) => (first = r)),
    () => new Promise((_, r) => (second = r)),
  );
  await act(async () => clients.refresh());
  await act(async () => clients.refresh());
  first([]);
  await settle();
  assert.deepEqual(clients.clients, [phone]);
  second(new Error('late'));
  await settle();
  // the older read's answer was dropped; the latest one's failure stands, with the devices still shown
  assert.deepEqual([clients.clients, clients.error], [[phone], 'late']);
  let late: (v: any) => void = () => undefined;
  listCalls.push(() => new Promise((r) => (late = r)));
  await act(async () => clients.refresh());
  await m.render(h(Clients, { connected: false }));
  late([phone, phone]);
  await settle();
  assert.equal(clients.clients, null);
  await m.unmount();
});

test('revoking a device says whether it is gone, and a failure is a toast', async () => {
  revokes.push(async () => undefined);
  assert.equal(await revokeRemoteControlClient('a'), true);
  revokes.push(async () => Promise.reject(new Error('not reachable')));
  assert.equal(await revokeRemoteControlClient('a'), false);
  assert.deepEqual(store.calls.at(-1), ['toast', "Couldn't revoke the device: not reachable", 'error']);
});

let pairing: any;
let claimedCount = 0;
const Pairing = () => ((pairing = useRemoteControlPairing(() => claimedCount++)), null);
const tick = (ms = 1000) =>
  act(async () => {
    for (let beat = 0; beat < ms / 1000; beat++) {
      mock.timers.tick(1000);
      for (const poll of polls.filter((p) => !p.stopped)) poll.run();
    }
    await Promise.resolve();
    await Promise.resolve();
  });
const code =
  (secondsLeft: number, value = 'ABCD-1234') =>
  async () => ({ code: value, expiresAt: NOW / 1000 + secondsLeft });

test('a pairing code counts down, is asked about every other second, and ends the watch when a device uses it', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  claimedCount = 0;
  pairings.push(code(10));
  const m = await mount(h(Pairing));
  await settle();
  assert.deepEqual(pairing.pairing, { phase: 'ready', code: 'ABCD-1234', secondsLeft: 10 });
  claims.push(
    async () => false,
    async () => true,
  );
  await tick();
  assert.equal(pairing.pairing.secondsLeft, 9);
  assert.deepEqual(claimedWith, []);
  await tick();
  assert.deepEqual(claimedWith, ['ABCD-1234']);
  assert.equal(claimedCount, 0);
  await tick();
  await tick();
  assert.equal(claimedWith.length, 2);
  assert.equal(claimedCount, 1);
  // used: nothing more is asked
  await tick(4000);
  assert.equal(claimedWith.length, 2);
  await m.unmount();
});

test('a check that fails is noted and tried again; one still waiting is not asked twice', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  claimedCount = 0;
  pairings.push(code(30));
  const m = await mount(h(Pairing));
  await settle();
  claims.push(async () => Promise.reject(new Error('offline')));
  await tick(2000);
  assert.equal(claimedWith.length, 1);
  let slow: (v: any) => void = () => undefined;
  claims.push(
    () => new Promise((r) => (slow = r)),
    async () => false,
  );
  await tick(2000);
  assert.equal(claimedWith.length, 2);
  // the answer for the second is still pending: the next even second does not ask again
  await tick(2000);
  assert.equal(claimedWith.length, 2);
  slow(false);
  await settle();
  await tick(2000);
  assert.equal(claimedWith.length, 3);
  assert.equal(claimedCount, 0);
  await m.unmount();
});

test('an ended code says so and a new one is asked for; an unmounted one asks nothing more', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  pairings.push(code(2), code(62, 'WXYZ-9876'));
  const m = await mount(h(Pairing));
  await settle();
  await tick();
  assert.equal(pairing.pairing.secondsLeft, 1);
  await tick();
  assert.deepEqual(pairing.pairing, { phase: 'expired' });
  await act(async () => pairing.restart());
  await settle();
  assert.deepEqual(pairing.pairing, { phase: 'ready', code: 'WXYZ-9876', secondsLeft: 60 });
  await m.unmount();
  claims.push(async () => true);
  await tick(4000);
  assert.deepEqual(claimedWith, []);
});

test('a code that cannot be had is an error that says why, and an answer after the page closed is dropped', async () => {
  pairings.push(async () => Promise.reject(new Error('Turn Remote Control on first.')));
  const m = await mount(h(Pairing));
  await settle();
  assert.deepEqual(pairing.pairing, { phase: 'error', message: 'Turn Remote Control on first.' });
  pairings.push(async () => ({ code: null, expiresAt: 1 }));
  await act(async () => pairing.restart());
  await settle();
  assert.deepEqual(pairing.pairing, { phase: 'error', message: "Couldn't get a pairing code" });
  let late: (v: any) => void = () => undefined;
  pairings.push(() => new Promise((r) => (late = r)));
  await act(async () => pairing.restart());
  await m.unmount();
  late({ code: 'AAAA-0000', expiresAt: 9e9 });
  await settle();
  let lateError: (e: Error) => void = () => undefined;
  pairings.push(() => new Promise((_, r) => (lateError = r)));
  const m2 = await mount(h(Pairing));
  await m2.unmount();
  lateError(new Error('too late'));
  await settle();
  assert.deepEqual(claimedWith, []);
});
