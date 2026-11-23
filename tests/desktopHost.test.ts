// The desktop_* tools in main: the helper client's desktop requests over a fake helper socket
// (computer.cjs), the approval kinds (approvals.cjs), the computer_* coordinator's lock claim and Esc
// handling (tools/computer.cjs), and setupComputerUse's wiring (computerUse.cjs) of the tools, the
// overlay and global Esc (mocked Electron), the turn-end release and computer:forget (mocked IPC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeHelper } from './e2e/fixtures/fake-helper.ts';
import { defined } from './support/defined.ts';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { ComputerHelper, BUILT_IN_DENY } = require('../electron/capabilities/computer.cjs');
const { ApprovalBroker, KINDS } = require('../electron/capabilities/contract/approvals.cjs');
const { ComputerUse } = require('../electron/capabilities/tools/computer.cjs');
const { GrantStore } = require('../electron/capabilities/grants.cjs');
const { setupComputerUse, PARITY_FLAG, FLAG, HIDE_FLAG, chatModel } = require('../electron/capabilities/computerUse.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const NOTES = { pid: 4242, bundleId: 'com.apple.Notes', name: 'Notes' };

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
async function until(fn: () => any, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/* -- the helper client ---------------------------------------------------- */
test('helper client: the desktop requests go over the socket with their parameters', async () => {
  const sock = path.join(tmp('dh-'), 'h.sock');
  const fake = await startFakeHelper(sock);
  const helper = new ComputerHelper({ connectTo: sock });
  try {
    await helper.start();
    const last = () => fake.log.at(-1);
    assert.deepEqual((await helper.listApps()).apps[0].bundleId, 'com.apple.Notes');
    assert.deepEqual(last(), { method: 'apps.list', params: {} });
    const resolved = await helper.resolveApps(['Notes', 'Nope']);
    assert.deepEqual(
      resolved.apps.map((a: any) => a.app?.bundleId ?? null),
      ['com.apple.Notes', null],
    );
    assert.deepEqual(last(), { method: 'apps.resolve', params: { queries: ['Notes', 'Nope'] } });
    assert.equal((await helper.openApp('com.apple.Notes', { bundleIds: ['com.apple.Notes'] })).frontmost, true);
    assert.deepEqual(last(), { method: 'apps.open', params: { bundleId: 'com.apple.Notes', bundleIds: ['com.apple.Notes'] } });
    await helper.openApp('com.apple.Notes');
    assert.deepEqual(defined(last()).params, { bundleId: 'com.apple.Notes' });
    assert.equal((await helper.listDisplays()).displays[0].name, 'Fake display');
    assert.deepEqual(last(), { method: 'displays.list', params: {} });
    assert.deepEqual(await helper.cursor(), { x: 0, y: 0 });
    assert.equal(defined(last()).method, 'input.cursor');
    await helper.move(3, 4, { bundleIds: ['b'] });
    assert.deepEqual(last(), { method: 'input.move', params: { x: 3, y: 4, bundleIds: ['b'] } });
    await helper.move(5, 6);
    assert.deepEqual(defined(last()).params, { x: 5, y: 6 });
    await helper.drag(1, 2, 3, 4, { bundleIds: ['b'] });
    assert.deepEqual(last(), { method: 'input.drag', params: { x1: 1, y1: 2, x2: 3, y2: 4, bundleIds: ['b'] } });
    await helper.drag(1, 2, 3, 4);
    assert.deepEqual(defined(last()).params, { x1: 1, y1: 2, x2: 3, y2: 4 });
    await helper.button('left', true, { x: 7, y: 8 }, { bundleIds: ['b'] });
    assert.deepEqual(last(), { method: 'input.button', params: { button: 'left', down: true, x: 7, y: 8, bundleIds: ['b'] } });
    await helper.button('right', false);
    assert.deepEqual(defined(last()).params, { button: 'right', down: false });
    await helper.releaseInput({ keys: ['shift'], buttons: ['left'] });
    assert.deepEqual(last(), { method: 'input.release', params: { keys: ['shift'], buttons: ['left'] } });
    await helper.releaseInput();
    assert.deepEqual(defined(last()).params, { keys: [], buttons: [] });
    await helper.releaseInput({});
    assert.deepEqual(defined(last()).params, { keys: [], buttons: [] });
    assert.deepEqual(await helper.axPress(4242, '0.1', { bundleIds: ['b'] }), { ok: true, route: 'ax', center: { x: 20, y: 20 } });
    assert.deepEqual(last(), { method: 'ax.press', params: { pid: 4242, id: '0.1', bundleIds: ['b'] } });
    await helper.axPress(4242, '0.2');
    assert.deepEqual(defined(last()).params, { pid: 4242, id: '0.2' });
    await helper.axFocus(4242, '0.3', { bundleIds: ['b'] });
    assert.deepEqual(last(), { method: 'ax.focus', params: { pid: 4242, id: '0.3', bundleIds: ['b'] } });
    await helper.axFocus(4242, '0.4');
    assert.deepEqual(defined(last()).params, { pid: 4242, id: '0.4' });
    // an input request while the user has taken over is refused by the helper
    fake.pause('takeover');
    await assert.rejects(helper.move(1, 1), (e: any) => e.reason === 'paused');
  } finally {
    helper.stop();
    await fake.close();
  }
});

/* -- approval kinds -------------------------------------------------------- */
test('approvals: the desktop cards are approval kinds of their own; others are refused', async () => {
  assert.ok(KINDS.has('computerAccessSet') && KINDS.has('computerTakeover'));
  const added: any[] = [];
  const broker = new ApprovalBroker({
    controller: { addApproval: (c: string, a: any) => added.push([c, a]), resolveApproval: () => true },
  });
  const set = broker.ask('c1', 'computerAccessSet', { apps: [] });
  const takeover = broker.ask('c1', 'computerTakeover', { apps: [] });
  assert.deepEqual(
    added.map(([, a]) => a.method),
    ['sage/computerAccessSet', 'sage/computerTakeover'],
  );
  assert.equal(added[0][1].params.kind, 'computerAccessSet');
  broker.answer(set.id, { decision: 'allow', apps: ['com.apple.Notes'] });
  broker.answer(takeover.id, { decision: 'deny' });
  assert.deepEqual(await set, { decision: 'allow', apps: ['com.apple.Notes'] });
  assert.deepEqual(await takeover, { decision: 'deny' });
  await assert.rejects(broker.ask('c1', 'computerEverything', {}), /unknown approval kind/);
});

/* -- the computer_* coordinator ---------------------------------------------- */
function scriptedCu(o: { acquire?: (holder: string) => Promise<any>; suspendEscape?: any } = {}) {
  const dir = tmp('dh-cu-');
  const meta = new Map<string, any>();
  const chats = {
    get: (id: string) => (meta.has(id) ? { meta: meta.get(id) } : null),
    patchMeta: (id: string, p: any) => (meta.set(id, { ...(meta.get(id) ?? {}), ...p }), true),
  };
  const grants = new GrantStore({ file: path.join(dir, 'computer.json'), chats });
  const calls: any[] = [];
  const rec =
    (m: string, out: any = { ok: true }) =>
    async (...a: any[]) => (calls.push([m, ...a]), out);
  const helper: any = {
    running: true,
    start: rec('start', {}),
    targetInfo: rec('targetInfo', NOTES),
    screenshot: rec('screenshot', { png: 'P', width: 10, height: 10, display: { x: 0, y: 0 }, pixelsPerPoint: 1 }),
    axSnapshot: rec('axSnapshot', { root: { id: '0', role: 'AXApplication' } }),
    glowStart: rec('glowStart'),
    glowStop: rec('glowStop'),
    acquireControl: o.acquire ?? rec('acquireControl', {}),
    releaseControl: rec('releaseControl', {}),
    key: rec('key'),
  };
  const activity: any[] = [];
  const cu = new ComputerUse({
    helper,
    grants,
    broker: new ApprovalBroker({ controller: { addApproval() {}, resolveApproval: () => true } }),
    session: () => ({ modality: 'image', permission: 'default' }),
    onActivity: (c: string, a: any) => activity.push([c, a]),
    suspendEscape: o.suspendEscape,
    settleMs: 0,
    waitMs: 30,
    pollMs: 5,
  });
  grants.grant('c1', NOTES, 'full', 'chat');
  return { cu, helper, calls, activity, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('computer_key: an Escape the agent sends lifts the Esc-to-stop shortcut; other keys do not', async () => {
  const lifted: string[] = [];
  const r = scriptedCu({
    suspendEscape: async (fn: () => Promise<any>) => {
      lifted.push('lift');
      const out = await fn();
      lifted.push('back');
      return out;
    },
  });
  try {
    for (const key of ['Escape', 'cmd+Esc', 'shift + escape', 'Return', 'escapeHatch'])
      await r.cu.run('computer_key', { key }, { chatId: 'c1' });
    assert.deepEqual(
      r.calls.filter((c) => c[0] === 'key').map((c) => c[1]),
      ['Escape', 'cmd+Esc', 'shift + escape', 'Return', 'escapeHatch'],
    );
    assert.deepEqual(lifted, ['lift', 'back', 'lift', 'back', 'lift', 'back'], 'three Escapes, each pressed inside a suspension');
  } finally {
    r.done();
  }
  // the default: pressed directly
  const bare = scriptedCu();
  try {
    await bare.cu.run('computer_key', { key: 'Escape' }, { chatId: 'c1' });
    assert.equal(bare.calls.filter((c) => c[0] === 'key').length, 1);
  } finally {
    bare.done();
  }
});

test('control: the lock is claimed before the helper answers, so a second chat cannot take it meanwhile', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const r = scriptedCu({
    acquire: async () => {
      await gate;
      return {};
    },
  });
  try {
    const first = r.cu.control('c1', NOTES);
    await tick();
    assert.equal(r.cu.controlling, 'c1');
    const second = r.cu.control('c2', NOTES);
    await assert.rejects(second, (e: any) => e.code === 'busy');
    release();
    await first;
    assert.equal(r.cu.controlling, 'c1');
  } finally {
    r.done();
  }
});

test('control: a failed claim gives the lock back, unless someone else holds it by then', async () => {
  const failing = scriptedCu({
    acquire: async () => {
      throw Object.assign(new Error('socket closed'), { reason: 'other' });
    },
  });
  try {
    await assert.rejects(failing.cu.control('c1', NOTES), /socket closed/);
    assert.equal(failing.cu.controlling, null);
  } finally {
    failing.done();
  }
  let cu: any;
  const stolen = scriptedCu({
    acquire: async () => {
      cu.controlling = 'c9';
      throw Object.assign(new Error('busy'), { reason: 'lock_busy' });
    },
  });
  cu = stolen.cu;
  try {
    await assert.rejects(stolen.cu.control('c1', NOTES), (e: any) => e.code === 'busy');
    assert.equal(stolen.cu.controlling, 'c9');
  } finally {
    stolen.done();
  }
});

/* -- setupComputerUse wiring ------------------------------------------------ */
function fakeElectron() {
  const events: any[] = [];
  const shortcuts = new Map<string, Function>();
  const windows: any[] = [];
  class BrowserWindow {
    static getAllWindows() {
      return windows;
    }
    visible = false;
    destroyed = false;
    onTop = false;
    bounds = { x: 0, y: 0, width: 800, height: 600 };
    constructor() {
      windows.push(this);
    }
    isVisible() {
      return this.visible;
    }
    show() {
      this.visible = true;
      events.push('window:show');
    }
    setIgnoreMouseEvents() {}
    isAlwaysOnTop = () => this.onTop;
    setAlwaysOnTop(on: boolean) {
      this.onTop = on;
    }
    getBounds = () => this.bounds;
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    loadURL() {
      return Promise.resolve();
    }
    webContents = { insertCSS: async () => 'key', removeInsertedCSS: async () => undefined, send: () => {} };
    setBounds(b: any) {
      this.bounds = b;
    }
    showInactive() {
      this.visible = true;
      events.push('overlay:show');
    }
    hide() {
      this.visible = false;
      events.push('overlay:hide');
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      events.push('overlay:destroy');
    }
  }
  let clip = '';
  return {
    events,
    shortcuts,
    windows,
    electron: {
      BrowserWindow,
      screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1, height: 1 } }] },
      globalShortcut: {
        register: (k: string, fn: Function) => (events.push(`register:${k}`), shortcuts.set(k, fn), true),
        unregister: (k: string) => (events.push(`unregister:${k}`), shortcuts.delete(k)),
      },
      clipboard: {
        readText: () => clip,
        writeText: (t: string) => {
          clip = t;
        },
      },
      app: { focus: (o: any) => events.push(`app:focus:${o.steal}`) },
    },
  };
}

async function hostRig(o: { electron?: boolean; flags?: Record<string, boolean>; prefs?: any; record?: any; notes?: boolean } = {}) {
  const dir = tmp('dh-host-');
  const sock = path.join(dir, 'h.sock');
  const fake = await startFakeHelper(sock);
  const e = fakeElectron();
  const flags: Record<string, boolean> = { [FLAG]: true, [PARITY_FLAG]: true, 'shared.computerUse.unattended': true, ...o.flags };
  const handlers = new Map<string, Function>();
  const approvals = new Map<string, any[]>();
  const controller = {
    chatOf: (id: string) => id,
    ref: () => ({ kind: 'claude' }),
    isSubagentCall: () => false,
    viewing: () => false,
    addApproval: (chatId: string, a: any) => approvals.set(chatId, [...(approvals.get(chatId) ?? []), a]),
    resolveApproval: (id: string) => {
      for (const [c, list] of approvals)
        approvals.set(
          c,
          list.filter((a) => a.id !== id),
        );
      return true;
    },
  };
  const patches: any[] = [];
  // each chat's control strip (appControl) is kept, as main's SessionStore keeps it
  const strips = new Map<string, any>();
  const sessions = {
    get: (chatId: string) => ({
      activeTurn: { human: true },
      permission: 'default',
      modality: 'image',
      appControl: strips.get(chatId) ?? null,
    }),
    patch: (chatId: string, p: any) => {
      patches.push([chatId, p]);
      if ('appControl' in p) strips.set(chatId, p.appControl);
    },
  };
  const meta = new Map<string, any>();
  const chats: any = {
    records: new Map(),
    get: (id: string) => (meta.has(id) ? { meta: meta.get(id) } : null),
    patchMeta: (id: string, p: any) => (meta.set(id, { ...(meta.get(id) ?? {}), ...p }), true),
  };
  if (o.record) chats.record = () => o.record;
  const stops: string[] = [];
  const controlling: any[] = [];
  const notified: any[] = [];
  const registry = new Registry();
  const prev = process.env.SAGE_CU_FAKE_HELPER;
  process.env.SAGE_CU_FAKE_HELPER = sock;
  let runtime: any;
  try {
    runtime = setupComputerUse({
      ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
      registry,
      flags: { isEnabled: (k: string) => !!flags[k] },
      chats,
      controller,
      sessions,
      userData: dir,
      packaged: false,
      broadcast: () => {},
      stop: async (chatId: string) => {
        stops.push(chatId);
      },
      onControlling: (c: any) => controlling.push(c),
      // the app's notifier and names (none: no notifications, "The agent")
      ...(o.notes === false
        ? {}
        : {
            notifyKind: (kind: string, chatId: string, opts: any) => (
              notified.push([kind, chatId, opts.title, opts.body]), chatId === 'c1' ? { shown: true } : undefined
            ),
            agentName: (chatId: string) => (chatId === 'c1' ? 'Claude' : ''),
            chatName: (id: string) => (id === 'c1' ? 'Notes chat' : null),
          }),
      ...(o.prefs ? { prefs: () => o.prefs } : {}),
      ...(o.electron === false ? {} : { electron: e.electron }),
    });
  } finally {
    if (prev === undefined) delete process.env.SAGE_CU_FAKE_HELPER;
    else process.env.SAGE_CU_FAKE_HELPER = prev;
  }
  runtime.cu.settleMs = 0;
  runtime.desktop.settleMs = 0;
  /** answers the next card of a kind in c1 through the computer:answer IPC */
  const answer = async (kind: string, result: any) => {
    const card = await until(() => approvals.get('c1')?.find((a) => a.method === `sage/${kind}`));
    await handlers.get('computer:answer')!({}, card.id, result);
    return card;
  };
  const invoke = (tool: string, args: any) => registry.invoke('c1', 's1', tool, args);
  return {
    runtime,
    fake,
    e,
    flags,
    handlers,
    registry,
    patches,
    stops,
    controlling,
    approvals,
    answer,
    invoke,
    notified,
    // fire-and-forget calls (the glow) settle first: stop() leaves a pending call to its timeout
    done: async () => {
      await until(() => runtime.helper.pending.size === 0);
      runtime.stop();
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("setup: the desktop tools register with the switch, through every harness's registry", async () => {
  const r = await hostRig();
  try {
    assert.ok(r.registry.has('desktop_request_access'));
    assert.ok(r.registry.has('desktop_batch'));
    assert.ok(r.registry.has('computer_screenshot'));
    // the parity switch off: the desktop tools go, computer_* stays
    r.flags[PARITY_FLAG] = false;
    r.runtime.sync();
    assert.equal(r.registry.has('desktop_request_access'), false);
    assert.ok(r.registry.has('computer_screenshot'));
    r.runtime.sync();
    // back on
    r.flags[PARITY_FLAG] = true;
    r.runtime.sync();
    assert.ok(r.registry.has('desktop_request_access'));
    r.runtime.sync();
    // the computer-use switch off takes both
    r.flags[FLAG] = false;
    r.runtime.sync();
    assert.equal(r.registry.has('desktop_request_access'), false);
    assert.equal(r.registry.has('computer_screenshot'), false);
  } finally {
    await r.done();
  }
});

test('setup: a deny-list change reaches a running helper now and a stopped (or relaunched) one at launch', async () => {
  const r = await hostRig();
  try {
    assert.equal(r.runtime.helper.running, false);
    await r.handlers.get('computer:setDeny')!({}, ['com.example.bank']);
    // nothing launched for it, but the next launch carries it
    assert.equal(r.runtime.helper.running, false);
    assert.deepEqual(r.runtime.helper.denyBundleIds, ['com.example.bank']);
    await r.runtime.helper.start();
    await r.handlers.get('computer:setDeny')!({}, ['com.example.other']);
    assert.deepEqual(r.fake.log.at(-1)!.params.bundleIds.slice(-2), [BUILT_IN_DENY.at(-1).pattern, 'com.example.other']);
  } finally {
    await r.done();
  }
});

test('setup: taking control shows the overlay and binds Esc; Esc stops the chat and its batch; the turn end lets go', async () => {
  const r = await hostRig();
  try {
    const access = r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'write a note' });
    const card = await r.answer('computerAccessSet', { decision: 'allow' });
    assert.equal(card.params.apps[0].name, 'Notes');
    const granted = JSON.parse((await access).content[0].text);
    assert.deepEqual(granted.granted, [{ app: 'Notes', bundleId: 'com.apple.Notes', tier: 'full' }]);
    const shot = await r.invoke('desktop_screenshot', {});
    assert.equal(shot.ok, true);
    assert.equal(r.e.events.length, 0, 'looking takes nothing over');
    const click = r.invoke('desktop_left_click', { coordinate: [0, 0] });
    await r.answer('computerTakeover', { decision: 'allow' });
    const clicked = await click;
    assert.equal(clicked.ok, true, JSON.stringify(clicked.error));
    assert.equal(r.runtime.cu.controlling, 'c1');
    assert.deepEqual(r.e.events, ['overlay:show', 'register:Escape']);
    assert.ok(r.fake.log.some((l: any) => l.method === 'control.acquire'));
    assert.ok(r.patches.some(([c, p]: any) => c === 'c1' && p.computer?.state === 'active' && p.computer.app === 'Notes'));
    assert.deepEqual(r.controlling.at(-1), 'c1');
    // the whole screen: no banner over what the agent clicks (the pill and glow say it), the done note after
    assert.deepEqual(r.notified, []);
    // Esc: the chat stops (as Stop does), a running batch stops before its next action, control is given back
    const epoch = r.runtime.desktop.session('c1').epoch;
    r.e.shortcuts.get('Escape')!();
    await until(() => r.stops.length);
    assert.deepEqual(r.stops, ['c1']);
    assert.equal(r.runtime.desktop.session('c1').epoch, epoch + 1);
    assert.equal(r.runtime.cu.controlling, null);
    // the overlay fades out (0.3s), then hides
    await until(() => r.e.events.includes('overlay:hide'));
    assert.deepEqual(r.e.events.slice(2), ['unregister:Escape', 'overlay:hide']);
    assert.deepEqual(r.notified.at(-1), ['computer', 'c1', 'Claude is done using your computer', 'Notes chat']);
    // control again, then the turn ends: the lock, the overlay and Esc go, once
    await r.invoke('desktop_left_click', { coordinate: [0, 0] });
    assert.equal(r.runtime.cu.controlling, 'c1');
    assert.deepEqual(r.e.events.slice(4), ['overlay:show', 'register:Escape']);
    // main's turn ledger (turnEnd.cjs) calls turnEnded when the turn ends; a session patch alone lets go of nothing
    r.runtime.onSessionPatch({ chatId: 'c1', patch: { turn: 'idle' } });
    await tick();
    assert.equal(r.runtime.cu.controlling, 'c1');
    void r.runtime.turnEnded('c1');
    await until(
      () =>
        r.runtime.cu.controlling === null &&
        !r.e.shortcuts.has('Escape') &&
        r.e.events.filter((x: string) => x === 'overlay:hide').length === 2,
    );
    assert.deepEqual(r.e.events.slice(6), ['unregister:Escape', 'overlay:hide']);
    await r.runtime.turnEnded('c1');
    r.runtime.onSessionPatch({ chatId: 'c1', patch: { turn: 'crashed' } });
    await tick();
    assert.equal(r.e.events.length, 8);
    assert.deepEqual(
      r.notified.map((x: any) => x[2]),
      ['Claude is done using your computer', 'Claude is done using your computer'],
    );
    assert.ok(r.fake.log.some((l: any) => l.method === 'control.release'));
  } finally {
    await r.done();
  }
});

test('setup: a computer_key Escape is pressed with the Esc shortcut lifted', async () => {
  const r = await hostRig();
  try {
    r.runtime.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'chat');
    const timeline: string[] = [];
    const gs = r.e.electron.globalShortcut;
    const reg = gs.register;
    const unreg = gs.unregister;
    gs.register = (k: string, fn: Function) => (
      timeline.push(`register@${r.fake.log.filter((l: any) => l.method === 'input.key').length}`), reg(k, fn)
    );
    gs.unregister = (k: string) => (
      timeline.push(`unregister@${r.fake.log.filter((l: any) => l.method === 'input.key').length}`), unreg(k)
    );
    const out = await r.invoke('computer_key', { key: 'Escape' });
    assert.equal(out.ok, true, JSON.stringify(out.error));
    // bound when control is taken, lifted around the key press (key count 0 -> 1), bound again once the key settled
    assert.deepEqual(timeline, ['register@0', 'unregister@0']);
    await until(() => timeline.length === 3);
    assert.deepEqual(timeline, ['register@0', 'unregister@0', 'register@1']);
    assert.equal(r.fake.log.filter((l: any) => l.method === 'input.key')[0].params.key, 'Escape');
  } finally {
    await r.done();
  }
});

test("setup: the helper exiting drops control and the overlay; computer:forget drops a chat's desktop grants", async () => {
  const r = await hostRig();
  try {
    const access = r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    await r.answer('computerAccessSet', { decision: 'allow' });
    await access;
    await r.invoke('desktop_screenshot', {});
    const click = r.invoke('desktop_left_click', { coordinate: [0, 0] });
    await r.answer('computerTakeover', { decision: 'allow' });
    await click;
    assert.ok(r.e.shortcuts.has('Escape'));
    r.runtime.helper.emit('exit');
    assert.equal(r.runtime.cu.controlling, null);
    assert.deepEqual(r.patches.at(-1), ['c1', { computer: null }]);
    assert.equal(r.controlling.at(-1), null);
    assert.deepEqual(r.notified.at(-1)?.[2], 'Claude is done using your computer');
    assert.equal(r.e.shortcuts.has('Escape'), false);
    // exiting with nobody in control
    const n = r.patches.length;
    r.runtime.helper.emit('exit');
    assert.equal(r.patches.length, n);
    // forget: bad ids are ignored; the chat's grants and consent go
    const forget = r.handlers.get('computer:forget')!;
    assert.equal(await forget({}, 42), false);
    assert.equal(await forget({}, ''), false);
    assert.equal(r.runtime.desktop.granted('c1').size, 1);
    assert.equal(r.runtime.grants.chat('c1').length + Number(await forget({}, 'c1')), 2, 'saved with the chat, then forgotten');
    assert.equal(r.runtime.desktop.granted('c1').size + r.runtime.grants.chat('c1').length, 0);
  } finally {
    await r.done();
  }
});

test("setup: Always allow on one chat's card lets every chat use the app (through the shared registry) without a card until Settings removes it", async () => {
  const r = await hostRig();
  try {
    const access = r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    await r.answer('computerAccessSet', { decision: 'allow', apps: ['com.apple.notes'], remember: true });
    assert.deepEqual(
      JSON.parse((await access).content[0].text).granted.map((a: any) => a.app),
      ['Notes'],
    );
    assert.deepEqual(
      r.runtime.grants.global().map((g: any) => [g.bundleId, g.level]),
      [['com.apple.Notes', 'full']],
    );
    // Settings lists it under Always allowed
    assert.deepEqual(
      (await r.handlers.get('computer:status')!({})).grants.global.map((g: any) => g.name),
      ['Notes'],
    );
    // another chat: no card, and the result names it for the chat's line
    const c2 = JSON.parse(
      (await r.registry.invoke('c2', 's2', 'desktop_request_access', { apps: ['Notes'], reason: 'r' })).content[0].text,
    );
    assert.deepEqual(c2.alwaysAllowed, ['Notes']);
    assert.equal(r.approvals.get('c2'), undefined, 'no card in c2');
    // Remove all: the next new chat asks again; c2 keeps its grant
    assert.equal(await r.handlers.get('computer:revokeAll')!({}), true);
    assert.equal(await r.handlers.get('computer:revokeAll')!({}), false, 'already empty');
    assert.deepEqual(r.runtime.grants.global(), []);
    assert.equal(r.runtime.desktop.granted('c2').has('com.apple.notes'), true);
    const c3 = r.registry.invoke('c3', 's3', 'desktop_request_access', { apps: ['Notes'], reason: 'r' });
    const card = await until(() => r.approvals.get('c3')?.find((a: any) => a.method === 'sage/computerAccessSet'));
    await r.handlers.get('computer:answer')!({}, card.id, { decision: 'deny' });
    assert.deepEqual(JSON.parse((await c3).content[0].text).granted, []);
  } finally {
    await r.done();
  }
});

test('setup: switching the desktop tools off while a chat holds the desktop takes the overlay down', async () => {
  const r = await hostRig();
  try {
    const access = r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    await r.answer('computerAccessSet', { decision: 'allow' });
    await access;
    await r.invoke('desktop_screenshot', {});
    const click = r.invoke('desktop_left_click', { coordinate: [0, 0] });
    await r.answer('computerTakeover', { decision: 'allow' });
    await click;
    assert.ok(r.e.shortcuts.has('Escape'));
    r.flags[PARITY_FLAG] = false;
    r.runtime.sync();
    assert.equal(r.e.shortcuts.has('Escape'), false);
    await until(() => !r.e.windows[0].visible);
    // stop(): the overlay windows are destroyed and the helper stopped
    r.runtime.stop();
    assert.ok(r.e.windows[0].destroyed);
    assert.equal(r.runtime.helper.running, false);
  } finally {
    await r.done();
  }
});

test('setup: without Electron there is no overlay, Esc shortcut or clipboard, and the tools still work', async () => {
  const r = await hostRig({ electron: false });
  try {
    r.runtime.desktop.session('c1').clipboardRead = true;
    const out = await r.invoke('desktop_read_clipboard', {});
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'unavailable');
    const access = r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    await r.answer('computerAccessSet', { decision: 'allow' });
    await access;
    await r.invoke('desktop_screenshot', {});
    const click = r.invoke('desktop_left_click', { coordinate: [0, 0] });
    await r.answer('computerTakeover', { decision: 'allow' });
    assert.equal((await click).ok, true);
    assert.equal(r.runtime.cu.controlling, 'c1');
    assert.equal(r.runtime.indicator.windows.length, 0);
    await r.runtime.turnEnded('c1');
    assert.equal(r.runtime.cu.controlling, null);
  } finally {
    await r.done();
  }
});

test('helper client: focused text, insert, paste, hiding apps and the saved clipboard go over the socket', async () => {
  const sock = path.join(tmp('dh-'), 'h.sock');
  const fake = await startFakeHelper(sock);
  const helper = new ComputerHelper({ connectTo: sock });
  try {
    await helper.start();
    const last = () => fake.log.at(-1);
    assert.equal((await helper.focusedText({ bundleIds: ['b'] })).role, 'AXTextArea');
    assert.deepEqual(last(), { method: 'text.focused', params: { bundleIds: ['b'] } });
    await helper.focusedText();
    assert.deepEqual(defined(last()).params, {});
    assert.deepEqual(await helper.insertText('hi', { bundleIds: ['b'] }), { ok: false, reason: 'not_settable' });
    assert.deepEqual(last(), { method: 'text.insert', params: { text: 'hi', bundleIds: ['b'] } });
    await helper.insertText('x');
    assert.deepEqual(defined(last()).params, { text: 'x' });
    await helper.paste({ bundleIds: ['b'] });
    assert.deepEqual(last(), { method: 'input.paste', params: { bundleIds: ['b'] } });
    await helper.paste();
    assert.deepEqual(defined(last()).params, {});
    assert.deepEqual(await helper.hideOthers(['com.apple.Notes']), { hidden: [] });
    assert.deepEqual(last(), { method: 'apps.hideOthers', params: { keepBundleIds: ['com.apple.Notes'] } });
    await helper.restoreApps([30, 31], 11);
    assert.deepEqual(last(), { method: 'apps.restore', params: { pids: [30, 31], activatePid: 11 } });
    await helper.restoreApps([30]);
    assert.deepEqual(defined(last()).params, { pids: [30] });
    assert.deepEqual(await helper.saveClipboard(), { saved: true, items: 1 });
    assert.deepEqual(last(), { method: 'pasteboard.save', params: {} });
    assert.deepEqual(await helper.restoreClipboard(), { restored: true });
    assert.deepEqual(last(), { method: 'pasteboard.restore', params: { apply: true } });
    assert.deepEqual(await helper.restoreClipboard(false), { restored: false });
  } finally {
    helper.stop();
    await fake.close();
  }
});

test("chat model: the chat's own pick, its segment's, then the harness default", () => {
  const rec = (model: any, config: any = null) => ({ segments: [{ model: 'old' }, { model }], meta: { config } });
  assert.equal(chatModel('claude', rec('claude-opus-4-7'), {}), 'claude-opus-4-7');
  assert.equal(chatModel('claude', rec(null), { claudeSelection: { model: 'sonnet' } }), 'sonnet');
  assert.equal(chatModel('claude', null, null), 'opus', "Claude Code's default is the current Opus");
  assert.equal(chatModel('codex', rec('gpt-a', { model: 'gpt-b' }), { model: 'gpt-c' }), 'gpt-b');
  assert.equal(chatModel('codex', rec('gpt-a'), { model: 'gpt-c' }), 'gpt-a');
  assert.equal(chatModel('codex', rec(undefined), { model: 'gpt-c' }), 'gpt-c');
  assert.equal(chatModel('codex', null, undefined), null);
  assert.equal(chatModel('acp:kimi', rec('k2')), 'k2');
  assert.equal(chatModel('acp:kimi', null), null);
});

test("setup: the chat's own model sizes its screenshots", async () => {
  const r = await hostRig({ record: { segments: [{ model: 'claude-sonnet-4-6' }] }, prefs: { claudeSelection: { model: 'opus' } } });
  try {
    r.runtime.grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'chat');
    await r.invoke('desktop_screenshot', {});
    assert.equal(defined(r.fake.log.find((l: any) => l.method === 'screenshot')).params.maxSide, 1568);
  } finally {
    await r.done();
  }
});

test('setup: hide-before-action: screen control asked just in time, MoPilot hides while in control, all back at the turn end', async () => {
  const r = await hostRig({ flags: { [HIDE_FLAG]: true } });
  try {
    const main = new r.e.electron.BrowserWindow();
    main.visible = true;
    const access = r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'write a note' });
    const card = await r.answer('computerAccessSet', { decision: 'allow' });
    assert.equal('takeover' in card.params, false);
    assert.equal(JSON.parse((await access).content[0].text).screenControl, false);
    await r.invoke('desktop_screenshot', {});
    // the chat's model (Claude Code's default, the current Opus) takes high-resolution screenshots
    assert.equal(defined(r.fake.log.find((l: any) => l.method === 'screenshot')).params.maxSide, 2000);
    const click = r.invoke('desktop_left_click', { coordinate: [0, 0] });
    const takeover = await r.answer('computerTakeover', { decision: 'allow' });
    assert.match(takeover.params.reason, /real pointer and keyboard/);
    const clicked = await click;
    assert.equal(clicked.ok, true, JSON.stringify(clicked.error));
    assert.equal([...r.approvals.values()].flat().length, 0, 'no card left');
    assert.deepEqual([main.visible, main.onTop], [true, true], "MoPilot's window docks as an on-top panel");
    assert.equal(r.runtime.indicator.windows[0].visible, true, 'the overlay stays');
    assert.ok(r.fake.log.some((l: any) => l.method === 'apps.hideOthers'));
    await r.runtime.turnEnded('c1');
    assert.deepEqual(defined(r.fake.log.filter((l: any) => l.method === 'apps.restore').at(-1)).params, { pids: [], activatePid: 4242 });
    assert.equal(main.onTop, false, 'and goes back');
    // the helper going away while the chat holds the desktop: MoPilot's windows come back
    await r.invoke('desktop_left_click', { coordinate: [0, 0] });
    assert.equal(main.onTop, true);
    r.runtime.helper.emit('exit');
    await until(() => !main.onTop);
    assert.equal(r.runtime.desktop.screen, null);
    r.runtime.helper.emit('exit');
  } finally {
    await r.done();
  }
});

test('setup: the background desktop_app_* tools register with the desktop tools and run over the helper socket without a takeover', async () => {
  const r = await hostRig();
  try {
    assert.ok(r.registry.has('desktop_app_screenshot'));
    assert.ok(r.registry.has('desktop_app_batch'));
    const access = r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    await r.answer('computerAccessSet', { decision: 'allow' });
    assert.match(JSON.parse((await access).content[0].text).next, /desktop_app_screenshot/);
    const shot = await r.invoke('desktop_app_screenshot', { app: 'Notes' });
    assert.equal(shot.ok, true, JSON.stringify(shot.error));
    assert.equal(shot.content[0].type, 'image');
    assert.match(shot.content[1].text, /Window 77 "Notes" of Notes: coordinate frame 800x600 pixels/);
    assert.match(shot.content[1].text, /\[1\] Button "New Note" at \(40, 40\)/);
    const click = await r.invoke('desktop_app_click', { app: 'Notes', element_index: 1 });
    assert.equal(click.ok, true, JSON.stringify(click.error));
    assert.equal(JSON.parse(click.content[0].text).route, 'ax');
    const typed = await r.invoke('desktop_app_type', { app: 'Notes', element_index: 2, text: 'hello' });
    assert.equal(JSON.parse(typed.content[0].text).effect, 'confirmed');
    // no takeover: no card, no lock on the screen, no overlay or Esc; the app is locked to this chat
    assert.equal(r.runtime.cu.controlling, null);
    assert.equal(r.runtime.indicator.windows.length, 0);
    assert.ok(!r.e.events.some((ev: string) => ev.startsWith('register:')));
    // the phantom cursor shows where the click landed, without the user's pointer
    assert.ok(r.runtime.cursor.window, 'the phantom cursor is up');
    // the chat's strip lists the app; the start is noted once, in the background wording
    const strip = r.patches.filter(([, p]: any) => 'appControl' in p).at(-1)[1].appControl;
    assert.deepEqual(
      [strip.apps.length, strip.apps[0].app, strip.apps[0].bundleId, strip.apps[0].takenOver],
      [1, 'Notes', 'com.apple.Notes', false],
    );
    assert.deepEqual(r.notified, [['computer', 'c1', 'Claude is using your computer', 'Notes chat']]);
    assert.ok(!r.fake.log.some((l: any) => l.method === 'control.acquire'));
    assert.deepEqual(
      r.fake.log.filter((l: any) => l.method.startsWith('app.')).map((l: any) => l.method),
      ['app.screenshot', 'app.marks', 'app.press', 'app.setText'], // a sparse window also asks for marks
    );
    assert.equal(r.runtime.apps.locks.get('com.apple.notes').chatId, 'c1');
    // Stop interrupts a background batch; the turn end lets go of the app locks
    const epoch = r.runtime.apps.session('c1').epoch;
    await r.runtime.cu.stop('c1');
    assert.equal(r.runtime.apps.session('c1').epoch, epoch + 1);
    await r.runtime.turnEnded('c1');
    assert.equal(r.runtime.apps.locks.size, 0);
    // done: noted, and the strip goes
    assert.deepEqual(r.notified.at(-1), ['computer', 'c1', 'Claude is done using your computer', 'Notes chat']);
    assert.equal(r.patches.filter(([, p]: any) => 'appControl' in p).at(-1)[1].appControl, null);
    // the strip's Take over and Hand back: only for an app the chat holds, and only strings
    assert.equal(await r.handlers.get('computer:takeOver')!({}, 'c1', 'com.apple.Notes'), false);
    assert.equal(await r.handlers.get('computer:takeOver')!({}, 'c1', 7), false);
    await r.invoke('desktop_app_click', { app: 'Notes', element_index: 1 });
    assert.equal(await r.handlers.get('computer:takeOver')!({}, 'c1', 'com.apple.Notes'), true);
    assert.equal(r.patches.filter(([, p]: any) => 'appControl' in p).at(-1)[1].appControl.apps[0].takenOver, true);
    await until(() => r.fake.log.some((l: any) => l.method === 'apps.open'));
    assert.equal(await r.handlers.get('computer:handBack')!({}, 'c1', 'com.apple.Notes'), true);
    assert.equal(r.patches.filter(([, p]: any) => 'appControl' in p).at(-1)[1].appControl.apps[0].takenOver, false);
    assert.equal(await r.handlers.get('computer:handBack')!({}, 'c1', 'com.apple.Notes'), false);
    assert.equal(await r.handlers.get('computer:handBack')!({}, null, 'com.apple.Notes'), false);
    r.runtime.onSessionPatch({ chatId: 'c1', patch: { turn: 'idle' } });
    // forget drops the chat's background session and locks
    await r.invoke('desktop_app_click', { app: 'Notes', element_index: 1 });
    assert.equal(r.runtime.apps.locks.size, 1);
    assert.equal(await r.handlers.get('computer:forget')!({}, 'c1'), true);
    assert.equal(r.runtime.apps.sessions.has('c1'), false);
    assert.equal(r.runtime.apps.locks.size, 0);
    // the other direction: full-screen input refuses an app another chat works in in the background
    for (const c of ['c1', 'c2']) r.runtime.grants.grant(c, { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'chat');
    await r.registry.invoke('c2', 's2', 'desktop_app_screenshot', { app: 'Notes' });
    assert.equal((await r.registry.invoke('c2', 's2', 'desktop_app_click', { app: 'Notes', element_index: 1 })).ok, true);
    await r.invoke('desktop_screenshot', {});
    const blocked = r.invoke('desktop_left_click', { coordinate: [0, 0] });
    await r.answer('computerTakeover', { decision: 'allow' });
    const refused = await blocked;
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'busy');
    assert.match(refused.error.message, /Another chat is working in Notes in the background/);
    assert.equal(r.runtime.cu.controlling, null);
    // once c2 lets go, c1 takes the screen
    r.runtime.turnEnded('c2');
    assert.equal((await r.invoke('desktop_left_click', { coordinate: [0, 0] })).ok, true);
    assert.equal(r.runtime.cu.controlling, 'c1');
    // the parity switch takes them off with the desktop tools
    r.flags[PARITY_FLAG] = false;
    r.runtime.sync();
    assert.equal(r.registry.has('desktop_app_screenshot'), false);
  } finally {
    await r.done();
  }
});

test("setup: without the app's notifier, background control still shows its strip and notes nothing; another chat is named by its agent", async () => {
  const r = await hostRig({ notes: false });
  try {
    const access = r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    await r.answer('computerAccessSet', { decision: 'allow' });
    await access;
    await r.invoke('desktop_app_screenshot', { app: 'Notes' });
    assert.equal((await r.invoke('desktop_app_click', { app: 'Notes', element_index: 1 })).ok, true);
    assert.equal(r.notified.length, 0);
    assert.equal(r.runtime.notes.started('c9', 'Notes'), null);
    assert.equal(r.patches.filter(([, p]: any) => 'appControl' in p).at(-1)[1].appControl.apps[0].app, 'Notes');
  } finally {
    await r.done();
  }
  const named = await hostRig();
  try {
    assert.equal(named.runtime.notes.started('c2', 'Mail', { background: true }), null);
    assert.deepEqual(named.notified, [['computer', 'c2', 'The agent is using your computer', '']]);
  } finally {
    await named.done();
  }
});

test('setup: a take-over whose app cannot come forward still applies, and a failed turn-end cleanup is contained', async () => {
  const r = await hostRig();
  try {
    const access = r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    await r.answer('computerAccessSet', { decision: 'allow' });
    await access;
    await r.invoke('desktop_app_screenshot', { app: 'Notes' });
    await r.invoke('desktop_app_click', { app: 'Notes', element_index: 1 });
    const opened: string[] = [];
    r.runtime.helper.openApp = async (bundleId: string) => {
      opened.push(bundleId);
      throw new Error('helper gone');
    };
    assert.equal(await r.handlers.get('computer:takeOver')!({}, 'c1', 'com.apple.Notes'), true);
    await tick();
    assert.deepEqual(opened, ['com.apple.Notes']);
    assert.equal(r.patches.filter(([, p]: any) => 'appControl' in p).at(-1)[1].appControl.apps[0].takenOver, true);
    const ended: string[] = [];
    r.runtime.desktop.turnEnded = async (chatId: string) => {
      ended.push(chatId);
      throw new Error('overlay gone');
    };
    await r.runtime.turnEnded('c1');
    assert.deepEqual(ended, ['c1']);
    assert.equal(r.runtime.apps.locks.size, 0, 'the app locks are let go regardless');
  } finally {
    await r.done();
  }
});
