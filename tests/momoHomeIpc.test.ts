// MoMo's home over IPC in main (electron/app/ipc/momoHome.cjs, electron/momo/homeSlot.cjs, electron/bridge/momoHome.cjs): refused while MoMo is not allowed, "unavailable" while no home is composed, answers wrapped so the window can parse them, changes broadcast only while allowed, and in a dev run the scripted home is made on first use and its scenario switched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register, isDevRun, UNAVAILABLE } = require('../electron/app/ipc/momoHome.cjs');
const { setHomeApi, getHomeApi, onHomeChanged } = require('../electron/momo/homeSlot.cjs');
const { loadBridge } = require('../electron/bridge/spec.cjs');

function rig(o: { allowed?: () => boolean; dev?: boolean; loadFake?: () => Promise<any> } = {}) {
  const handlers = new Map<string, (e: unknown, ...a: any[]) => any>();
  const sent: [string, unknown][] = [];
  register(
    { handle: (c: string, f: any) => handlers.set(c, f) } as any,
    { broadcastAll: (c: string, p: unknown) => sent.push([c, p]) },
    { allowed: () => true, dev: false, ...o },
  );
  return { call: (c: string, ...a: any[]) => handlers.get(c)!(null, ...a), sent };
}

function fakeApi(view: () => Promise<unknown> = async () => ({ view: { home: {} } })) {
  const fns = new Set<(p: unknown) => void>();
  return {
    api: {
      view,
      intent: async (i: any) => ({ ok: true, echoed: i }),
      onChanged: (f: (p: unknown) => void) => (fns.add(f), () => void fns.delete(f)),
    },
    push: (p: unknown) => fns.forEach((f) => f(p)),
    listeners: () => fns.size,
  };
}

test('no home composed: the view and every intent are answered unavailable, and MoMo not allowed refuses first', async () => {
  setHomeApi(null);
  const r = rig();
  assert.deepEqual(await r.call('momoHome:view'), { ok: false, reason: 'unavailable', cause: UNAVAILABLE });
  assert.deepEqual(await r.call('momoHome:intent', { kind: 'wake' }), { ok: false, reason: 'unavailable', cause: UNAVAILABLE });
  assert.equal(await r.call('momoHome:dev'), false);
  assert.equal(await r.call('momoHome:devScenario', 'asleep'), false);
  const off = rig({ allowed: () => false });
  assert.deepEqual(await off.call('momoHome:view'), { ok: false, reason: 'not_allowed', cause: 'MoMo is not available.' });
});

test('a composed home answers the view and intents, a failure becomes an answer, and its changes reach the windows only while allowed', async () => {
  const f = fakeApi();
  setHomeApi(f.api);
  let allowed = true;
  const r = rig({ allowed: () => allowed });
  assert.deepEqual(await r.call('momoHome:view'), { ok: true, view: { home: {} } });
  assert.deepEqual(await r.call('momoHome:intent', { kind: 'wake' }), { ok: true, echoed: { kind: 'wake' } });
  f.push({ ev: 'momo.home.changed' });
  allowed = false;
  f.push({ ev: 'again' });
  assert.deepEqual(r.sent, [['momoHome:changed', { ev: 'momo.home.changed' }]]);
  const broken = fakeApi(() => Promise.reject(new Error('x')));
  setHomeApi(broken.api);
  allowed = true;
  assert.deepEqual(await r.call('momoHome:view'), { ok: false, reason: 'error', cause: 'MoMo’s home didn’t answer.' });
  assert.equal(f.listeners(), 0, 'the replaced home is let go of');
  setHomeApi(null);
  assert.equal(getHomeApi(), null);
});

test('a listener that throws does not stop the others, and a listener can leave', () => {
  const f = fakeApi();
  setHomeApi(f.api);
  const seen: unknown[] = [];
  const offThrow = onHomeChanged(() => {
    throw new Error('window gone');
  });
  const off = onHomeChanged((p) => seen.push(p));
  f.push(1);
  assert.deepEqual(seen, [1]);
  off();
  offThrow();
  f.push(2);
  assert.deepEqual(seen, [1]);
  setHomeApi(null);
});

test('a dev run serves the scripted home, made once, and switches its scenario; without the file the home stays unavailable', async () => {
  setHomeApi(null);
  const calls: string[] = [];
  const scripted = fakeApi();
  const r = rig({
    dev: true,
    loadFake: async () => ({
      createFakeHome: ({ scenario }: any) => (
        calls.push(`make:${scenario}`), { api: scripted.api, scenario: (n: string) => calls.push(`scenario:${n}`) }
      ),
    }),
  });
  assert.equal(await r.call('momoHome:dev'), true);
  assert.deepEqual(await r.call('momoHome:view'), { ok: true, view: { home: {} } });
  assert.equal(await r.call('momoHome:devScenario', 'asleep'), true);
  assert.equal(await r.call('momoHome:devScenario', 7), false);
  assert.deepEqual(calls, ['make:running', 'scenario:asleep']);
  setHomeApi(null);
  const missing = rig({ dev: true, loadFake: () => Promise.reject(new Error('Cannot find module')) });
  assert.deepEqual(await missing.call('momoHome:view'), { ok: false, reason: 'unavailable', cause: UNAVAILABLE });
  assert.equal(await missing.call('momoHome:devScenario', 'asleep'), false);
});

test('a dev run can show a whole view the journey sets, and clear it; outside a dev run nothing can', async () => {
  setHomeApi(fakeApi().api);
  const r = rig({ dev: true });
  assert.equal(await r.call('momoHome:devSetView', { home: { state: 'asleep' } }), true);
  assert.deepEqual(await r.call('momoHome:view'), { ok: true, view: { home: { state: 'asleep' } } });
  assert.deepEqual(r.sent.at(-1), ['momoHome:changed', { ev: 'momo.home.changed', view: { home: { state: 'asleep' } } }]);
  assert.equal(await r.call('momoHome:devSetView', null), true);
  assert.deepEqual(await r.call('momoHome:view'), { ok: true, view: { home: {} } });
  const prod = rig();
  assert.equal(await prod.call('momoHome:devSetView', { home: {} }), false);
  assert.equal(prod.sent.length, 0);
  setHomeApi(null);
});

test('a dev run forwards a refusal and a release to the scripted home; outside a dev run, or to a home without them, they do nothing', async () => {
  setHomeApi(null);
  const calls: unknown[][] = [];
  const home = {
    api: fakeApi().api,
    scenario: () => undefined,
    refuse: (...a: unknown[]) => calls.push(['refuse', ...a]),
    release: () => calls.push(['release']),
    turnAnswer: (...a: unknown[]) => calls.push(['turnAnswer', ...a]),
  };
  const r = rig({ dev: true, loadFake: async () => ({ createFakeHome: () => home }) });
  assert.equal(await r.call('momoHome:devRefuse', 'wake', 'Studio is offline.', { kind: 'wake' }, 'Wake Studio'), true);
  assert.equal(await r.call('momoHome:devRelease'), true);
  assert.equal(await r.call('momoHome:devRefuse', 7, 'x'), false);
  assert.equal(await r.call('momoHome:devTurnAnswer', 'turn-1', 'has'), true);
  assert.equal(await r.call('momoHome:devTurnAnswer', 1, 'has'), false);
  assert.deepEqual(calls, [
    ['refuse', 'wake', 'Studio is offline.', { kind: 'wake' }, 'Wake Studio'],
    ['release'],
    ['turnAnswer', 'turn-1', 'has'],
  ]);
  setHomeApi(null);
  const bare = rig({ dev: true, loadFake: async () => ({ createFakeHome: () => ({ api: fakeApi().api, scenario: () => undefined }) }) });
  assert.equal(await bare.call('momoHome:devRefuse', 'wake', 'x'), false);
  assert.equal(await bare.call('momoHome:devRelease'), false);
  assert.equal(await bare.call('momoHome:devTurnAnswer', 't', 'has'), false);
  setHomeApi(null);
  const prod = rig();
  assert.equal(await prod.call('momoHome:devRefuse', 'wake', 'x'), false);
  assert.equal(await prod.call('momoHome:devRelease'), false);
  assert.equal(await prod.call('momoHome:devTurnAnswer', 't', 'has'), false);
});

test('a dev run is the unpackaged app with the dev switch', () => {
  assert.equal(isDevRun({ isPackaged: false }, { MOPILOT_MOMO_DEV: '1' } as any), true);
  assert.equal(isDevRun({ isPackaged: true }, { MOPILOT_MOMO_DEV: '1' } as any), false);
  assert.equal(isDevRun({ isPackaged: false }, {} as any), false);
});

test('the bridge declares the calls the IPC serves', () => {
  const b: any = loadBridge().momoHome;
  assert.deepEqual(Object.fromEntries(Object.entries(b).map(([k, v]: any) => [k, v.channel])), {
    view: 'momoHome:view',
    intent: 'momoHome:intent',
    onChanged: 'momoHome:changed',
    dev: 'momoHome:dev',
    devScenario: 'momoHome:devScenario',
    devSetView: 'momoHome:devSetView',
    devRefuse: 'momoHome:devRefuse',
    devRelease: 'momoHome:devRelease',
    devTurnAnswer: 'momoHome:devTurnAnswer',
  });
});

test('a dev run without a given loader tries the scripted home’s own file and answers either way', async () => {
  setHomeApi(null);
  const r = rig({ dev: true });
  const answer = await r.call('momoHome:view');
  assert.equal(typeof answer.ok, 'boolean');
  setHomeApi(null);
});
