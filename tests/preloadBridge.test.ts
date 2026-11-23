// electron/preload.cjs: the window.native bridge over a fake ipcRenderer.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installNative } from '../src/lib/native.ts';
import '../src/lib/native/cloud.ts';
import '../src/lib/native/git.ts';
import '../src/lib/native/contracts/platform.ts';

const require = createRequire(import.meta.url);
const listeners = new Map<string, Set<Function>>();
const calls: { kind: string; channel: string; args: any[] }[] = [];
let invokeResult: any = undefined;
let syncImpl: () => any = () => null;
let bridge: any = null;
const ipcRenderer = {
  on: (channel: string, h: Function) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(h);
  },
  removeListener: (channel: string, h: Function) => listeners.get(channel)?.delete(h),
  invoke: (channel: string, ...args: any[]) => (calls.push({ kind: 'invoke', channel, args }), Promise.resolve(invokeResult)),
  send: (channel: string, ...args: any[]) => calls.push({ kind: 'send', channel, args }),
  sendSync: (channel: string) => (calls.push({ kind: 'sendSync', channel, args: [] }), syncImpl()),
};
const emit = (channel: string, ...args: any[]) => {
  for (const h of listeners.get(channel) ?? []) h({ sender: 'event' }, ...args);
};
mock.module('electron', {
  exports: {
    contextBridge: { exposeInMainWorld: (key: string, api: any) => (assert.equal(key, 'native'), (bridge = api)) },
    ipcRenderer,
    webUtils: { getPathForFile: (f: any) => `/picked/${f.name}` },
  },
});
require('../electron/preload.cjs');
const { loadBridge, channelsOf } = require('../electron/bridge/spec.cjs');
const { hasMoPilotService } = require('../electron/platform/mopilotPresence.cjs');

test('the bridge is exposed as window.native with the platform and whether the build has the MoPilot service', () => {
  assert.equal(bridge.platform, process.platform);
  assert.equal(bridge.mopilotService, hasMoPilotService());
  // the preload's own keys, then one namespace per electron/bridge declaration
  assert.deepEqual(Object.keys(bridge), ['platform', 'mopilotService', 'flags', ...Object.keys(loadBridge())]);
});

test('flags are read synchronously once, a failed read is retried, and changes replace the snapshot', () => {
  syncImpl = () => {
    throw new Error('no handler yet');
  };
  const warned: any[] = [];
  const warn = console.warn;
  console.warn = (...a: any[]) => void warned.push(a);
  try {
    assert.deepEqual(bridge.flags.all(), {});
    assert.equal(bridge.flags.isEnabled('x'), false); // retried, warned once
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.equal(warned[0][0], '[flags] could not read the remote switches:');
  assert.equal(warned[0][1].message, 'no handler yet');
  syncImpl = () => null;
  assert.equal(bridge.flags.isEnabled('x'), false);
  syncImpl = () => ({ x: true, y: false });
  assert.equal(bridge.flags.isEnabled('x'), true);
  assert.equal(bridge.flags.isEnabled('y'), false);
  const before = calls.filter((c) => c.kind === 'sendSync').length;
  const copy = bridge.flags.all();
  copy.x = false;
  assert.equal(bridge.flags.isEnabled('x'), true, 'all() is a copy');
  assert.equal(calls.filter((c) => c.kind === 'sendSync').length, before, 'a snapshot is not read again');
  emit('flags:changed', { z: true });
  assert.deepEqual(bridge.flags.all(), { z: true });
});

test('event subscriptions pass the arguments without the event and can be removed', () => {
  const got: any[] = [];
  const off = bridge.codex.onStatus((...a: any[]) => got.push(a));
  emit('codex:status', 1, 2);
  off();
  emit('codex:status', 3);
  assert.deepEqual(got, [[1, 2]]);
  assert.equal(listeners.get('codex:status')!.size, 0);
});

test('adapter calls resolve the value, throw the error with its code, and pass nothing through', async () => {
  invokeResult = { value: 42 };
  assert.equal(await bridge.codex.request('m', { a: 1 }), 42);
  assert.deepEqual(calls.at(-1), { kind: 'invoke', channel: 'codex:request', args: ['m', { a: 1 }] });
  invokeResult = { error: { message: 'locked out', code: 'locked' } };
  await assert.rejects(bridge.codex.resume('t'), (e: any) => e.message === 'locked out' && e.code === 'locked');
  invokeResult = null;
  assert.equal(await bridge.codex.connect(), undefined);
});

test('reset cards go to the selected account; a failure is rethrown with its message and code', async () => {
  invokeResult = { value: 'cards' };
  assert.equal(await bridge.accounts.resetCredits('b'), 'cards');
  assert.deepEqual(calls.at(-1), { kind: 'invoke', channel: 'accounts:resetCredits', args: ['b'] });
  invokeResult = { error: { message: 'card already used', code: 'conflict' } };
  await assert.rejects(
    bridge.accounts.consumeResetCredit('a', 'card'),
    (e: any) => e.message === 'card already used' && e.code === 'conflict',
  );
  assert.deepEqual(calls.at(-1), { kind: 'invoke', channel: 'accounts:consumeResetCredit', args: ['a', 'card'] });
});

test('plain wrappers forward their channel and arguments', async () => {
  invokeResult = 'ok';
  assert.equal(await bridge.accounts.addApiKey('k', 'u', 'r'), 'ok');
  assert.deepEqual(calls.at(-1), { kind: 'invoke', channel: 'accounts:addApiKey', args: ['k', 'u', 'r'] });
  bridge.pty.write('p1', 'ls\n');
  assert.deepEqual(calls.at(-1), { kind: 'send', channel: 'platform:pty:write', args: ['p1', 'ls\n'] });
  // an error a window ignored on purpose goes to main's ring, fire and forget
  bridge.app.ignored('close a tab', 'gone');
  assert.deepEqual(calls.at(-1), { kind: 'send', channel: 'app:ignored', args: ['close a tab', 'gone'] });
  bridge.exitGate.answer('g1', true);
  assert.deepEqual(calls.at(-1), { kind: 'send', channel: 'exitGate:confirm:reply', args: ['g1', true] });
  assert.equal(bridge.fs.pathForFile({ name: 'a.png' }), '/picked/a.png');
  await bridge.claude.discardFork('s1');
  assert.deepEqual(calls.at(-1), { kind: 'invoke', channel: 'claude:discardFork', args: ['s1'] });
  // Claude in Chrome's Reconnect: one chat, or with none every chat whose link is down
  await bridge.availability.chromeReconnect('c1');
  assert.deepEqual(calls.at(-1), { kind: 'invoke', channel: 'claude:chromeReconnect', args: ['c1'] });
  await bridge.availability.chromeReconnect();
  assert.deepEqual(calls.at(-1), { kind: 'invoke', channel: 'claude:chromeReconnect', args: [null] });
  await bridge.availability.chromeLinks(true);
  assert.deepEqual(calls.at(-1), { kind: 'invoke', channel: 'claude:chromeLinks', args: [true] });
  // Try again / Check again in the Computer use settings
  await bridge.availability.retry();
  assert.deepEqual(calls.at(-1), { kind: 'invoke', channel: 'availability:retry', args: [] });
});

test('every function on the bridge reaches ipcRenderer', async () => {
  invokeResult = undefined;
  const walk = async (obj: any, where: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'function') {
        const n = calls.length;
        const r = (v as Function)('a1', 'a2', 'a3', 'a4');
        if (r && typeof r.then === 'function') await r;
        const subscribed = k.startsWith('on') && typeof r === 'function';
        if (subscribed) r();
        else if (`${where}.${k}` !== 'fs.pathForFile' && !where.startsWith('flags'))
          assert.ok(calls.length > n, `${where}.${k} reaches ipcRenderer`);
      } else if (v && typeof v === 'object') await walk(v, where ? `${where}.${k}` : k);
    }
  };
  await walk(bridge, '');
  // every channel the declarations name (electron/bridge) was reached: invoked, sent or subscribed to
  const channels = new Set(calls.map((c) => c.channel));
  const declared = channelsOf(loadBridge());
  assert.ok(declared.length > 300);
  for (const c of declared)
    assert.ok(c.kind === 'on' ? listeners.has(c.channel) : channels.has(c.channel), `${c.path} reaches ${c.kind} ${c.channel}`);
});

test('Git status and diff forward the explicit freshness flag through typed native access', async (t) => {
  // the preload's bridge, installed in the port as src/lib/nativeInstall.ts installs window.native
  const previous = installNative(bridge as any);
  t.after(() => installNative(previous));
  const { native } = await import('../src/lib/native.ts');
  assert.equal(native.git, bridge.git);
  calls.length = 0;
  await native.git.status('/repo', true);
  await native.git.diff('/repo', 'file.txt', true);
  assert.deepEqual(
    calls.map(({ channel, args }) => [channel, args]),
    [
      ['git:status', ['/repo', true]],
      ['git:diff', ['/repo', 'file.txt', true]],
    ],
  );
});

test('Cloud launches carry the account and repository claim across the preload', async (t) => {
  const previous = installNative(bridge as any);
  t.after(() => installNative(previous));
  const { native } = await import('../src/lib/native.ts');
  calls.length = 0;
  const claim = { repository: 'github.com/org/app', account: 'account-a' };
  await native.cloud.exec('env', 'Finish the task', 1, claim);
  assert.deepEqual(
    calls.map(({ channel, args }) => [channel, args]),
    [['cloud:exec', ['env', 'Finish the task', 1, claim]]],
  );
});

test('queued-send receipts pass unchanged through typed native access', async (t) => {
  // the preload's bridge, installed in the port as src/lib/nativeInstall.ts installs window.native
  const previous = installNative(bridge as any);
  t.after(() => installNative(previous));
  const { native } = await import('../src/lib/native.ts');
  calls.length = 0;
  invokeResult = { status: 'queued', error: 'harness refused' };
  assert.equal(await native.session.sendNow('chat', 'q'), invokeResult);
  assert.deepEqual(
    calls.map(({ channel, args }) => [channel, args]),
    [['session:sendNow', ['chat', 'q']]],
  );
});

test('working thumbnail bridge retains its turn identity', async () => {
  await bridge.computer.workingThumb('chat', 'TextEdit', 'turn', 'large');
  assert.deepEqual(calls.at(-1), { kind: 'invoke', channel: 'computer:workingThumb', args: ['chat', 'TextEdit', 'turn', 'large'] });
});
