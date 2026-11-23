// The app's wiring of the remote mirrors: the registry's running-tool surface, the Mac's per-device switch, and the seams the service reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { rig } from './support/remotePairingRig.ts';
import { makePhone, helloFor } from './support/remotePhone.ts';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { createMirrorWiring } = require('../electron/app/chromePanelMirror.cjs');
const { register } = require('../electron/app/ipc/remoteSettings.cjs');
const { createConsent } = require('../electron/remote/consent.cjs');
const { buildApi } = require('../electron/bridge/spec.cjs');
const spec = require('../electron/bridge/remoteSettings.cjs');

const gate = () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  return { held, release };
};

test('the registry tells which surface a running call shows, and when the running calls change', async () => {
  const reg = new Registry();
  const g = gate();
  for (const [name, needs] of [
    ['shot', 'iab'],
    ['look', 'cu'],
    ['plain', null],
  ] as const)
    reg.register({ name, policy: 'observe', needs, handler: () => g.held });
  const heard: string[] = [];
  const off = reg.onCallChange((id: string) => heard.push(`${id}:${reg.surfaceOf(id)}`));
  reg.onCallChange(() => {
    throw new Error('a bad listener');
  });
  assert.equal(reg.surfaceOf('c1'), null);
  const a = reg.invoke('c1', 's1', 'plain', {});
  assert.equal(reg.surfaceOf('c1'), null, 'a tool that shows neither surface');
  const b = reg.invoke('c1', 's2', 'shot', {});
  const c = reg.invoke('c2', 's3', 'look', {});
  await Promise.resolve();
  assert.equal(reg.surfaceOf('c1'), 'browser');
  assert.equal(reg.surfaceOf('c2'), 'screen');
  g.release();
  await Promise.all([a, b, c]);
  assert.equal(reg.surfaceOf('c1'), null);
  assert.ok(heard.includes('c1:browser') && heard.at(-1) === 'c2:null', heard.join());
  off();
  const n = heard.length;
  await reg.invoke('c1', 's4', 'plain', {});
  assert.equal(heard.length, n, 'a listener that left hears nothing');
});

test('the wiring reads the chat’s folder, asks the Mac’s terminal card, forwards the pty and the tool surface, and frames each surface', async () => {
  const asked: any[] = [];
  const calls: any[][] = [];
  const pty: any = {};
  for (const m of ['spawn', 'write', 'resize', 'kill', 'pause', 'resume']) pty[m] = (...a: any[]) => calls.push([m, ...a]);
  const live: any = {
    pty,
    controller: { ref: () => ({ kind: 'codex' }) },
    computerUse: { broker: { ask: async (...a: any[]) => (asked.push(a), { decision: asked.length === 1 ? 'allow' : 'deny' }) } },
    capabilities: { surfaceOf: () => 'browser', onCallChange: () => () => 'off' },
    browserTabs: {
      current: (id: string) => (id === 'c1' ? { agent: async () => ({ w: 10, h: 10 }) } : null),
      capture: async () => ({ data: 'AA', width: 4, height: 4 }),
    },
    remote: { devices: { byPair: (p: string) => (p === 'on' ? { mirrors: true } : p === 'off' ? { mirrors: false } : null) } },
  };
  const sig = new AbortController().signal;
  live.computerUse.desktop = { frame: async (id: string) => (id === 'c1' ? { data: 'SS', width: 1, height: 1 } : null) };
  const w = createMirrorWiring({ live, cwdOf: async () => '/work' });
  assert.equal(await w.mirror.folderOf('c1'), '/work');
  assert.equal(await w.mirror.approveTerminal('c1', { cwd: '/work', signal: sig }), true);
  assert.deepEqual(asked[0].slice(0, 2), ['c1', 'terminalTab']);
  assert.deepEqual(asked[0][2], { harness: 'codex', cwd: '/work', tool: 'open_terminal_tab' });
  assert.equal(asked[0][3].signal, sig, 'the card is tied to the open');
  assert.equal(await w.mirror.approveTerminal('c1', { cwd: '/work', signal: sig }), false, 'a denied card');
  const none = createMirrorWiring({
    live: { ...live, computerUse: null, browserTabs: null, capabilities: null, remote: null },
    cwdOf: async () => null,
  });
  assert.equal(await none.mirror.approveTerminal('c1', { cwd: '/x', signal: sig }), false, 'no broker, no card, no terminal');
  w.mirror.pty.spawn('k', { cwd: '/work' }, {});
  w.mirror.pty.write('k', 'x');
  w.mirror.pty.resize('k', 1, 2);
  w.mirror.pty.kill('k');
  w.mirror.pty.pause('k');
  w.mirror.pty.resume('k');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['spawn', 'write', 'resize', 'kill', 'pause', 'resume'],
  );
  assert.equal(w.mirror.tool.running('c1'), 'browser');
  assert.equal(w.mirror.tool.onChange(() => {})(), 'off');
  assert.deepEqual(await w.mirror.frame('c1', 'browser'), { data: 'AA', width: 4, height: 4 });
  assert.deepEqual(await w.mirror.frame('c1', 'browser'), { data: 'AA', width: 4, height: 4 }, 'the source is made once');
  assert.equal(await w.mirror.frame('zzz', 'browser'), null, 'no page, no frame');
  assert.equal((await w.mirror.frame('c1', 'screen'))?.data, 'SS');
  assert.equal(await w.mirror.frame('other', 'screen'), null, 'nothing on the screen to show');
  assert.equal(await none.mirror.frame('c1', 'screen'), null, 'no screen source yet');
  assert.equal(await none.mirror.frame('c1', 'browser'), null, 'no browser host');
  assert.equal(none.mirror.tool.running('c1'), null);
  assert.equal(typeof none.mirror.tool.onChange(() => {}), 'function');
  assert.deepEqual(
    [w.policy.mirrors('on'), w.policy.mirrors('off'), w.policy.mirrors('new'), none.policy.mirrors('on')],
    [true, false, false, false],
  );
});

test('Settings turns mirrors on per device, shows the switch, and refuses odd input or a stale pair', async () => {
  const r = rig();
  const phone = makePhone();
  const begun = await r.svc.begin();
  await r.svc.handleHello(helloFor(phone, begun.payload));
  const handles = new Map<string, Function>();
  const listeners = new Map<string, Function>();
  let flag = true;
  const live: any = { mopilot: { creds: { user: { id: 'u' }, deviceId: 'd' } }, remote: { devices: r.devices, pairing: r.svc } };
  live.remoteConsent = createConsent(
    live,
    () => ({ prefs: { mobileRemoteOwner: JSON.stringify(['u', 'd']) } }),
    () => ({}),
    () => 'unused',
  );
  register(
    { handle: (name: string, fn: Function) => handles.set(name, fn), on: (name: string, fn: Function) => listeners.set(name, fn) },
    {
      live,
      readState: () => ({ prefs: { mobileRemoteOwner: JSON.stringify(['u', 'd']) } }),
      patchPrefs: () => undefined,
      STATE_FILE: () => 'unused',
      allowed: () => flag,
    },
  );
  const sender: any = new EventEmitter();
  sender.mainFrame = {};
  sender.isDestroyed = () => false;
  const event: any = { sender, senderFrame: sender.mainFrame };
  const api = buildApi(
    { remoteSettings: spec },
    {
      ipcRenderer: {
        sendSync: (name: string) => {
          listeners.get(name)!(event);
          return event.returnValue;
        },
        invoke: (name: string, ...args: unknown[]) => Promise.resolve(handles.get(name)!(event, ...args)),
      },
      webUtils: {},
    },
  ).remoteSettings;
  let rechecks = 0;
  const shown = async () => (await api.state()).devices[0];
  const d = await shown();
  assert.equal(d.mirrors, false, 'off until the Mac turns it on');
  assert.equal(await api.rename(d.id, 'stale-pair', 'Work phone'), false, 'a stale pair keeps its name');
  assert.equal(await api.rename(d.id, d.pairId, '   '), false, 'an empty name is refused');
  assert.equal(await api.rename(d.id, d.pairId, 7 as any), false);
  assert.equal(await api.rename('', d.pairId, 'x'), false);
  assert.equal(await api.rename(d.id, '', 'x'), false);
  assert.equal(await api.rename('nobody', d.pairId, 'x'), false, 'a phone that is gone');
  assert.equal(await api.rename(d.id, d.pairId, 'Work phone'), true);
  assert.equal((await shown()).name, 'Work phone');
  assert.equal(await api.setMirrors(d.id, 'stale-pair', true), false, 'a stale pair changes nothing');
  assert.equal(rechecks, 0);
  live.chromePanel = { service: { mirror: { recheck: () => rechecks++ } } };
  assert.equal(await api.setMirrors(d.id, d.pairId, true), true);
  assert.equal(rechecks, 1, 'running mirrors are rechecked at once');
  assert.equal((await shown()).mirrors, true);
  assert.equal(r.devices.byPair(d.pairId).mirrors, true, 'kept on the device');
  assert.equal(await api.setMirrors(d.id, d.pairId, 'yes' as any), false);
  assert.equal(await api.setMirrors('', d.pairId, false), false);
  assert.equal(await api.setMirrors(d.id, '', false), false);
  assert.equal((await shown()).mirrors, true, 'odd input changed nothing');
  assert.equal(await api.setMirrors(d.id, d.pairId, false), true);
  assert.equal((await shown()).mirrors, false);
  live.remote.devices = null;
  assert.equal(await api.setMirrors(d.id, d.pairId, true), false, 'no device list, no switch');
  live.remote.devices = r.devices;
  flag = false;
  assert.equal(await api.setMirrors(d.id, d.pairId, true), false, 'hidden when Mobile Remote is not available');
});
