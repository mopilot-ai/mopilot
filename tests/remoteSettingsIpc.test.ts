// Mobile Remote IPC binds pair actions to the local document and gates them by account consent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createConsent } = require('../electron/remote/consent.cjs');
const { register } = require('../electron/app/ipc/remoteSettings.cjs');

test('local opt-in, owner confirmation and revoke use the real settings handlers', async () => {
  const handles = new Map<string, Function>();
  const listeners = new Map<string, Function>();
  const ipc = { handle: (k: string, fn: Function) => handles.set(k, fn), on: (k: string, fn: Function) => listeners.set(k, fn) };
  const prefs: any = {};
  let flag = false;
  let revokes = 0;
  let retired = false;
  const pairing = {
    begin: async () => ({ qr: 'private', expiresAt: 42 }),
    cancel() {},
    unpair: async () => {
      revokes++;
      return true;
    },
  };
  const live: any = {
    mopilot: { creds: { user: { id: 'u' }, deviceId: 'd' } },
    remote: {
      pairing,
      devices: { list: () => [{ id: 'p', pairId: 'pair', name: 'Phone', pub: 'secret' }], isRetired: () => retired },
      running: true,
      sync: async () => {},
    },
  };
  live.remoteConsent = createConsent(
    live,
    () => ({ prefs }),
    (_: string, p: object) => Object.assign(prefs, p),
    () => 'x',
  );
  register(ipc, {
    live,
    readState: () => ({ prefs }),
    STATE_FILE: () => 'x',
    patchPrefs: (_: string, p: object) => Object.assign(prefs, p),
    allowed: () => flag,
  });
  function window() {
    const sender: any = new EventEmitter();
    sender.mainFrame = {};
    sender.isDestroyed = () => false;
    const event: any = { sender, senderFrame: sender.mainFrame };
    listeners.get('remoteSettings:document')!(event);
    return { event, token: event.returnValue };
  }
  const a = window();
  const b = window();
  const call = (k: string, w: any, ...args: unknown[]) => handles.get(`remoteSettings:${k}`)!(w.event, w.token, ...args);
  assert.deepEqual(call('state', a), { visible: false });
  flag = true;
  const savedRemote = live.remote;
  live.remote = undefined;
  assert.deepEqual(call('state', a).devices, []);
  live.remote = savedRemote;
  flag = false;
  await assert.rejects(call('setEnabled', a, true), /unavailable/);
  flag = true;
  live.mopilot.creds = null;
  await assert.rejects(call('setEnabled', a, true), /Sign in/);
  assert.throws(() => call('begin', a), /unavailable/);
  assert.equal(call('answer', a, true), false);
  live.mopilot.creds = { user: { id: 'u' }, deviceId: 'd' };
  await call('setEnabled', a, true);
  assert.deepEqual(call('state', a).devices, [
    {
      id: 'p',
      pairId: 'pair',
      name: 'Phone',
      lastSeenAt: undefined,
      pairedAt: undefined,
      online: false,
      connection: 'unknown',
      mirrors: false,
      retired: false,
      frames: null,
    },
  ]);
  // a phone connected to the relay now reads as online
  live.remote.presence = { isOnline: (pair: string) => pair === 'pair' };
  assert.equal(call('state', a).devices[0].online, true);
  live.remote.presence = null;
  // with the channel up, each phone shows what its frames did (a flood of bad ones is visible here)
  live.remote.channel = {
    statsOf: (pair: string) => (pair === 'pair' ? { dropped: 2, duplicates: 0, gaps: 1, held: 0, throttled: 7, paused: false } : null),
    closedReason: () => null,
  };
  assert.deepEqual(call('state', a).devices[0].frames, { dropped: 2, duplicates: 0, gaps: 1, held: 0, throttled: 7, paused: false });
  live.remote.channel = undefined;
  retired = true;
  assert.equal(call('state', a).devices[0].retired, true);
  live.remote.devices.locked = true;
  assert.equal(call('state', a).locked, true);
  assert.throws(() => call('begin', a), /unavailable/);
  assert.equal(call('answer', a, true), false);
  live.remote.devices.locked = false;
  live.remote.pairing = null;
  await assert.rejects(call('begin', a), /unavailable/);
  live.remote.pairing = pairing;
  assert.equal((await call('begin', a)).qr, 'private');
  assert.equal(call('state', b).pairing.state, 'elsewhere', 'another document learns it is busy, and no code');
  assert.equal(call('state', b).pairing.qr, null);
  const ac = new AbortController();
  const pending = live.remoteSettings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal: ac.signal });
  assert.equal(call('answer', b, true), false);
  assert.equal(call('answer', a, true), true);
  assert.equal(await pending, 'allow');
  assert.equal(await call('revoke', a, '', 'pair'), false);
  assert.equal(await call('revoke', a, 42, 'pair'), false);
  live.remote.pairing = null;
  assert.equal(await call('revoke', a, 'p', 'pair'), false);
  live.remote.pairing = pairing;
  assert.equal(await call('revoke', a, 'p', 'pair'), true);
  assert.equal(revokes, 1);
  a.event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.throws(() => call('state', a), /earlier page/);
  await call('setEnabled', b, false);
  assert.equal(await call('revoke', b, 'p', 'pair'), false);
});
