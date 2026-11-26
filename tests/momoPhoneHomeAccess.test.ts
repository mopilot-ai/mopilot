// Who may see MoMo's home screens is asked again for every computer and whenever the home changes; the store made for one account and computer is stopped and emptied when either goes, and asks nothing once it is not the current one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { fixtureView } from './support/phone/momo-screens';

const hookPath = '../mobile/src/screens/momoPhone/useMomoHome';
const { useMomoHome, useMomoHomeStore, forgetMomoHomeAnswers } = await import(hookPath);

type Any = any;
function makeRuntime(hello: (pair: string) => unknown) {
  forgetMomoHomeAnswers();
  const snap = { user: { id: 'u1' } as Any, selectedPair: 'p1' };
  const calls: string[] = [];
  const listeners: Any[] = [];
  const runtime: Any = {
    snapshot: () => snap,
    subscribe: () => () => undefined,
    onEvent: (l: Any) => (listeners.push(l), () => void listeners.splice(listeners.indexOf(l), 1)),
    request: async (method: string) => {
      calls.push(`${method}@${snap.selectedPair}`);
      if (method === 'machine.hello') return hello(snap.selectedPair);
      if (method === 'momo.home.view') return { view: fixtureView().view };
      throw new Error(`no ${method}`);
    },
  };
  return { runtime, snap, calls, listeners };
}
const allowed = { capabilities: { momo: true, momoHome: true } };

async function draw(runtime: Any, online = true) {
  const out: { last: Any } = { last: null };
  const Probe = ({ online }: { online: boolean }) => {
    out.last = useMomoHome(runtime, online);
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = async (on = online) => {
    await act(async () => root.render(createElement(Probe, { online: on })));
    await flush();
    await flush();
  };
  await show();
  return {
    out,
    show,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a computer that serves the home opens it; the store reads the home and is dropped with the screen', async () => {
  const { runtime, calls } = makeRuntime(() => allowed);
  const d = await draw(runtime);
  assert.equal(d.out.last.settled, true);
  const store = d.out.last.store;
  assert.ok(store);
  await store.load();
  assert.equal(store.get().view.view.home.machineName, 'Studio');
  assert.ok(calls.includes('momo.home.view@p1'));
  await d.close();
  assert.equal(store.get().view, null, 'nothing read from the home stays in memory');
});

test('switching computers asks again, drops the old store, and never calls a computer that is not the home', async () => {
  const { runtime, snap, calls } = makeRuntime((pair) => (pair === 'p1' ? allowed : { capabilities: { momo: true } }));
  const d = await draw(runtime);
  const first = d.out.last.store;
  await first.load();
  snap.selectedPair = 'p2';
  await d.show();
  assert.equal(d.out.last.store, null);
  assert.equal(d.out.last.settled, true);
  assert.equal(first.get().view, null, 'the old computer’s notes are gone from memory');
  assert.deepEqual(
    calls.filter((c) => c.startsWith('machine.hello')),
    ['machine.hello@p1', 'machine.hello@p2'],
  );
  // a store still held after the switch asks nothing of the new computer
  snap.selectedPair = 'p1';
  const held = await (async () => {
    const out: Any = {};
    const Probe = () => {
      out.store = useMomoHomeStore(runtime, JSON.stringify(['u1', 'p1']), true);
      return null;
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    return { out, root, host };
  })();
  snap.selectedPair = 'p3';
  const before = calls.length;
  await held.out.store.load();
  assert.equal(held.out.store.get().failure.cause, 'MoMo was opened on another computer.');
  assert.equal(calls.length, before, 'no request reached the computer');
  await act(async () => held.root.unmount());
  held.host.remove();
  await d.close();
});

test('a change of home asks the computer again whether it serves the home', async () => {
  let serves = true;
  const { runtime, calls, listeners } = makeRuntime(() => (serves ? allowed : { capabilities: { momo: true } }));
  const d = await draw(runtime);
  assert.ok(d.out.last.store);
  serves = false;
  await act(async () => listeners.forEach((l) => l({ ev: 'something.else' })));
  await flush();
  assert.equal(calls.filter((c) => c.startsWith('machine.hello')).length, 1);
  await act(async () => listeners.forEach((l) => l({ ev: 'momo.home.changed' })));
  await flush();
  await flush();
  assert.equal(calls.filter((c) => c.startsWith('machine.hello')).length, 2);
  assert.equal(d.out.last.store, null, 'a computer that stopped serving it is not asked for the view');
  await d.close();
});

test('a signed-out account, and a computer that is away, see nothing', async () => {
  const { runtime, snap, calls } = makeRuntime(() => allowed);
  snap.user = undefined;
  const d = await draw(runtime);
  assert.equal(d.out.last.store, null);
  assert.equal(calls.includes('momo.home.view@p1'), false);
  await d.close();
  const away = makeRuntime(() => allowed);
  const gone = await draw(away.runtime, false);
  assert.deepEqual([gone.out.last.store, gone.out.last.settled], [null, true], 'away is settled as no, and the classic screen shows');
  assert.equal(away.calls.length, 0, 'a computer that is away is not asked');
  await gone.close();
});

test('the first answer is awaited: nothing is settled before the computer has said', async () => {
  const { runtime } = makeRuntime(() => allowed);
  let release: (v: unknown) => void = () => undefined;
  runtime.request = (method: string) =>
    method === 'machine.hello' ? new Promise((resolve) => (release = resolve)) : Promise.reject(new Error('x'));
  const out: Any = {};
  const Probe = () => {
    out.last = useMomoHome(runtime, true);
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  assert.deepEqual([out.last.settled, out.last.store], [false, null]);
  release(allowed);
  await flush();
  await flush();
  assert.equal(out.last.settled, true);
  assert.ok(out.last.store);
  await act(async () => root.unmount());
  host.remove();
});
