// main's wiring of MoMo's gate (electron/app/identity.cjs, electron/app/flags.cjs): opened with the MoPilot account, fed its status, and asked again when a remote switch changes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';
import { mock } from 'node:test';

after(() => unloadMain());
// Mobile Remote's gate builds on MoMo's class too, which the stand-ins here lack
const phoneStub = {
  openPhoneAccess: () => ({}),
  updatePhoneAccess: () => undefined,
  recomputePhoneAccess: () => undefined,
  phoneAccess: () => false,
  phoneAccessAtStart: () => false,
  onPhoneAccess: () => () => undefined,
};
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);

test('MoMo’s gate opens with the MoPilot account, follows its status and the kill switch', async () => {
  const access = {
    openMomoAccess: mock.fn((o: any) => ({ momo: o })),
    updateMomoAccess: mock.fn(),
    recomputeMomoAccess: mock.fn(),
    momoAllowed: mock.fn(() => false),
    onMomoAccess: mock.fn(() => () => undefined),
  };
  const h = await loadMain({
    packaged: true,
    before: (x: any) => {
      x.mods['electron/momo/access.cjs'] = access;
      // Host's gate builds on MoMo's class, which this stand-in lacks
      x.mods['electron/host/access.cjs'] = {
        openHostAccess: () => ({}),
        updateHostAccess: () => undefined,
        recomputeHostAccess: () => undefined,
        hostAccess: () => false,
        // Host's IPC follows the gate for paired phones (electron/app/hostPhone.cjs)
        onHostAccess: () => () => undefined,
      };
      x.mods['electron/remote/phoneAccess.cjs'] = phoneStub;
    },
  });
  await h.ready();
  const mopilot = h.one('MoPilotAccount');
  const o = calls(access.openMomoAccess)[0][0];
  assert.match(o.file, /momo-access\.json$/);
  assert.equal(o.devInvite, false, 'a packaged build has no stand-in for the invite');
  assert.equal(o.waitForFlags, true, 'the cached kill switch loads after the account');
  assert.deepEqual(calls(access.updateMomoAccess)[0], [{ user: null }], 'the saved sign-in, before the server answers');
  const refreshes = mopilot.refreshStatus.mock.callCount();
  o.refresh();
  assert.equal(mopilot.refreshStatus.mock.callCount(), refreshes + 1);
  o.broadcast(true);
  assert.deepEqual(h.windows[0].webContents.on_('momo:access'), [[true]]);
  const st = { signedIn: true, user: { id: 'u1', features: ['momo'] }, checkedAt: 1 };
  mopilot.opts.broadcast(st);
  assert.deepEqual(calls(access.updateMomoAccess).at(-1), [st]);
  const recomputes = access.recomputeMomoAccess.mock.callCount();
  assert.ok(recomputes >= 1, 'once the cached switches are loaded');
  calls(h.mod('platform/flags.cjs').initFlags)[0][0].onChange({ 'momo.enabled': false });
  assert.equal(access.recomputeMomoAccess.mock.callCount(), recomputes + 1);
  // MoMo's services start with the app, refusing while the account isn't invited (electron/app/momo.cjs)
  for (const ch of ['momoChat:mainChat', 'momoMemory:list', 'momoSources:list', 'momoAsk:chat'])
    assert.ok(h.handlers.has(ch), `${ch} is registered at startup`);
  assert.equal(access.onMomoAccess.mock.callCount(), 2, 'MoMo’s services and its background work follow its access');
  assert.equal(h.claude.setIsolated.mock.callCount(), 1, 'MoMo’s chats run apart from the coding side');
  assert.deepEqual(await h.invoke('momoChat:mainChat'), {
    error: { message: 'MoMo is not available for this account.', code: 'not_allowed' },
  });
});

test('a MoMo service that can’t be made never fails startup: the steps after it run, and MoMo stays off', async () => {
  const momo = {
    openMomo: mock.fn(() => {
      throw new Error('broken store');
    }),
  };
  // main's live services, as the IPC modules are given them
  let live: any = null;
  const gateIpc = { register: (_ipc: any, deps: any) => void (live = deps.live) };
  const h = await loadMain({
    packaged: true,
    before: (x: any) => {
      x.mods['electron/app/momo.cjs'] = momo;
      x.mods['electron/app/ipc/momo.cjs'] = gateIpc;
    },
  });
  await h.ready();
  assert.equal(momo.openMomo.mock.callCount(), 1, 'MoMo was started');
  assert.ok(calls(h.mod('platform/flags.cjs').initFlags).length >= 1, 'the remote switches still load after MoMo');
  assert.ok(h.handlers.has('availability:status'), 'the tools were opened');
  assert.equal(h.handlers.has('momoChat:mainChat'), false, 'nothing of MoMo was registered');
  assert.ok(live, 'the IPC modules were given main’s services');
  assert.equal(live.momo, undefined, 'live.momo stays unset, so every live.momo?. path does nothing');
  // the app said it started: its renderer is admitted
  assert.deepEqual(await h.invoke('app:ready'), { value: null });
});

test('Host’s gate opens beside MoMo’s, follows the account and the kill switch, and a dev invite needs an unpackaged build and MOPILOT_HOST_DEV', async () => {
  const access = {
    openHostAccess: mock.fn((o: any) => ({ host: o })),
    updateHostAccess: mock.fn(),
    recomputeHostAccess: mock.fn(),
    hostAccess: mock.fn(() => false),
    onHostAccess: mock.fn(() => () => undefined),
  };
  const h = await loadMain({
    packaged: true,
    before: (x: any) => ((x.mods['electron/host/access.cjs'] = access), (x.mods['electron/remote/phoneAccess.cjs'] = phoneStub)),
  });
  await h.ready();
  const mopilot = h.one('MoPilotAccount');
  const o = calls(access.openHostAccess)[0][0];
  assert.match(o.dir, /./);
  assert.equal(o.devInvite, false, 'a packaged build has no stand-in for the invite');
  assert.equal(o.waitForFlags, true);
  const refreshes = mopilot.refreshStatus.mock.callCount();
  o.refresh();
  assert.equal(mopilot.refreshStatus.mock.callCount(), refreshes + 1);
  o.broadcast(true);
  assert.deepEqual(h.windows[0].webContents.on_('host:access'), [[true]]);
  const st = { signedIn: true, user: { id: 'u1', features: ['host'] }, checkedAt: 1 };
  mopilot.opts.broadcast(st);
  assert.deepEqual(calls(access.updateHostAccess).at(-1), [st]);
  const recomputes = access.recomputeHostAccess.mock.callCount();
  assert.ok(recomputes >= 1, 'once the cached switches are loaded');
  calls(h.mod('platform/flags.cjs').initFlags)[0][0].onChange({ 'host.enabled': false });
  assert.equal(access.recomputeHostAccess.mock.callCount(), recomputes + 1);
});

test('Mobile Remote’s gate opens beside Host’s, follows the account and the kill switch, and starts or stops the runtime and the menu-bar agent when it changes', async () => {
  let listener: (allowed: boolean) => void = () => undefined;
  const access = {
    openPhoneAccess: mock.fn((o: any) => ({ phone: o })),
    updatePhoneAccess: mock.fn(),
    recomputePhoneAccess: mock.fn(),
    phoneAccess: mock.fn(() => false),
    phoneAccessAtStart: () => false,
    onPhoneAccess: mock.fn((cb: (allowed: boolean) => void) => ((listener = cb), () => undefined)),
  };
  const h = await loadMain({ packaged: true, before: (x: any) => (x.mods['electron/remote/phoneAccess.cjs'] = access) });
  await h.ready();
  const mopilot = h.one('MoPilotAccount');
  const o = calls(access.openPhoneAccess)[0][0];
  assert.match(o.dir, /./);
  assert.equal(o.devInvite, false, 'a packaged build has no stand-in for the invite');
  assert.equal(o.waitForFlags, true);
  const refreshes = mopilot.refreshStatus.mock.callCount();
  o.refresh();
  assert.equal(mopilot.refreshStatus.mock.callCount(), refreshes + 1);
  const st = { signedIn: true, user: { id: 'u1', features: ['phone'] }, checkedAt: 1 };
  mopilot.opts.broadcast(st);
  assert.deepEqual(calls(access.updatePhoneAccess).at(-1), [st]);
  const recomputes = access.recomputePhoneAccess.mock.callCount();
  assert.ok(recomputes >= 1, 'once the cached switches are loaded');
  calls(h.mod('platform/flags.cjs').initFlags)[0][0].onChange({ 'remote.enabled': false });
  assert.equal(access.recomputePhoneAccess.mock.callCount(), recomputes + 1);
  // a change of the gate reaches the runtime and the always-on agent with no window open, and with neither up yet it is harmless
  listener(false);
  listener(true);
});
