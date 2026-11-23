// The macOS Quick Actions (electron/platform/quickActions.cjs): the workflows written to ~/Library/Services, their install,
// status and removal, and the IPC that the Settings switch calls (electron/platform/quickActionsWiring.cjs).
import edition from '../shared/edition.json' with { type: 'json' };
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const qa = require('../electron/platform/quickActions.cjs');
const ipc = require('../electron/platform/quickActionsWiring.cjs');
const { inbox } = require('../electron/platform/openLinks.cjs');

const APP = "/Applications/MoPilot's Code.app";
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
const services = (h: string) => path.join(h, 'Library', 'Services');

test('three actions, each a Services workflow that opens a mopilot:// new-chat link in this app', () => {
  assert.deepEqual(
    qa.ACTIONS.map((a: { id: string }) => a.id),
    ['ask', 'chat-here', 'send'],
  );
  for (const a of qa.ACTIONS) {
    const s = qa.scriptFor(a, APP);
    assert.match(s, /\/usr\/bin\/open -a '\/Applications\/MoPilot'\\''s Code\.app'/);
    assert.ok(s.includes(`"${edition.desktop.scheme}://chat/new?source=services`));
    assert.match(s, /encodeURIComponent/);
  }
  assert.match(qa.scriptFor(qa.ACTIONS[0], APP), /head -c 16384/);
  assert.match(qa.scriptFor(qa.ACTIONS[1], APP), /&folder=\$\(enc "\$1"\)/);
  assert.match(qa.scriptFor(qa.ACTIONS[2], APP), /encAll "\$\{@:1:32\}"/);
});

test('a property list is escaped and typed', () => {
  const text = qa.plist({ a: 'x<&>', b: true, c: 3, d: [], e: {}, f: ['y'], g: { h: false } });
  assert.match(text, /<string>x&lt;&amp;&gt;<\/string>/);
  assert.match(text, /<key>b<\/key>\n\t<true\/>/);
  assert.match(text, /<integer>3<\/integer>/);
  assert.match(text, /<array\/>/);
  assert.match(text, /<dict\/>/);
  assert.match(text, /<false\/>/);
});

test('each workflow carries its menu title, input type, marker and, for the Finder one, the Finder scope', () => {
  const [ask, here, send] = qa.ACTIONS.map((a: unknown) => qa.workflowFiles(a, APP));
  assert.ok(ask.info.includes(`<string>Ask ${edition.desktop.name}</string>`));
  assert.match(ask.info, /public\.utf8-plain-text/);
  assert.match(ask.wflow, /com\.apple\.Automator\.text/);
  assert.match(here.info, /NSRequiredContext/);
  assert.match(here.info, /public\.folder/);
  assert.match(here.wflow, /com\.apple\.finder/);
  assert.match(send.info, /public\.item/);
  assert.doesNotMatch(send.info, /NSRequiredContext/);
  assert.doesNotMatch(send.wflow, /com\.apple\.finder/);
  for (const f of [ask, here, send]) {
    assert.match(f.info, new RegExp(`<key>${qa.MARKER}</key>`));
    assert.match(f.wflow, /<key>Class Name<\/key>/);
    assert.match(f.wflow, /com\.apple\.Automator\.servicesMenu/);
  }
  // the same action writes the same bytes
  assert.equal(qa.workflowFiles(qa.ACTIONS[0], APP).wflow, ask.wflow);
});

test('the app bundle is the .app that holds the running executable', () => {
  assert.equal(qa.bundleOf('/Applications/MoPilot.app/Contents/MacOS/MoPilot'), '/Applications/MoPilot.app');
  assert.equal(qa.bundleOf('/Applications/X.app'), '/Applications/X.app');
  assert.equal(qa.bundleOf('/usr/bin/node'), null);
  assert.equal(qa.bundleOf(undefined), null);
});

test('install writes all three, status says on, uninstall removes only ours', async () => {
  const h = home();
  const ran: string[][] = [];
  const mk = (appPath: string | null = APP) =>
    qa.createQuickActions({
      home: h,
      appPath,
      platform: 'darwin',
      execFile: (f: string, a: string[], _o: object, cb: () => void) => (ran.push([f, ...a]), cb()),
    });
  const q = mk();
  assert.deepEqual(q.status(), { state: 'off', installed: 0, total: 3 });
  assert.deepEqual(await q.install(), { state: 'on', installed: 3, total: 3 });
  assert.deepEqual(ran.at(-1), ['/System/Library/CoreServices/pbs', '-update']);
  assert.equal(fs.existsSync(path.join(services(h), `${edition.desktop.name} - ask.workflow`, 'Contents', 'document.wflow')), true);
  // a workflow of the user's own stays through uninstall
  const mine = path.join(services(h), 'My Action.workflow');
  fs.mkdirSync(mine, { recursive: true });
  assert.deepEqual(await q.uninstall(), { state: 'off', installed: 0, total: 3 });
  assert.equal(fs.existsSync(path.join(services(h), `${edition.desktop.name} - send.workflow`)), false);
  assert.equal(fs.existsSync(mine), true);
});

test('another copy of the app or a missing workflow reads as stale, and installing again repairs it', async () => {
  const h = home();
  const make = (appPath: string) =>
    qa.createQuickActions({
      home: h,
      appPath,
      platform: 'darwin',
      execFile: (_f: string, _a: string[], _o: object, cb: () => void) => cb(),
    });
  await make(APP).install();
  assert.equal(make('/Applications/Other.app').status().state, 'stale');
  assert.equal((await make('/Applications/Other.app').install()).state, 'on');
  fs.rmSync(path.join(services(h), `${edition.desktop.name} - send.workflow`), { recursive: true });
  assert.deepEqual(make('/Applications/Other.app').status(), { state: 'stale', installed: 2, total: 3 });
});

test('a write that fails halfway leaves none of the workflows, so the switch never reads as on', async () => {
  const h = home();
  const q = qa.createQuickActions({
    home: h,
    appPath: APP,
    platform: 'darwin',
    execFile: (_f: string, _a: string[], _o: object, cb: () => void) => cb(),
  });
  const real = fs.writeFileSync;
  let writes = 0;
  const m = mock.method(fs, 'writeFileSync', (...a: Parameters<typeof fs.writeFileSync>) => {
    if (++writes === 3) throw new Error('disk full');
    return real(...a);
  });
  try {
    await assert.rejects(q.install(), /disk full/);
  } finally {
    m.mock.restore();
  }
  assert.deepEqual(q.status(), { state: 'off', installed: 0, total: 3 });
  assert.deepEqual(fs.readdirSync(services(h)), []);
});

test('a workflow of the user with the same name is never replaced or deleted', async () => {
  const h = home();
  const theirs = path.join(services(h), `${edition.desktop.name} - ask.workflow`, 'Contents');
  fs.mkdirSync(theirs, { recursive: true });
  fs.writeFileSync(path.join(theirs, 'Info.plist'), '<plist>theirs</plist>');
  const q = qa.createQuickActions({
    home: h,
    appPath: APP,
    platform: 'darwin',
    execFile: (_f: string, _a: string[], _o: object, cb: () => void) => cb(),
  });
  await assert.rejects(q.install(), /already in Services/);
  assert.equal(fs.existsSync(path.join(services(h), `${edition.desktop.name} - send.workflow`)), false);
  await q.uninstall();
  assert.equal(fs.readFileSync(path.join(theirs, 'Info.plist'), 'utf8'), '<plist>theirs</plist>');
});

test('without a packaged Mac app they are unavailable and refuse to install', async () => {
  const noApp = qa.createQuickActions({ home: home(), appPath: null, platform: 'darwin' });
  assert.deepEqual(noApp.status(), { state: 'unavailable', installed: 0, total: 3 });
  await assert.rejects(noApp.install(), /installed MoPilot app/);
  const linux = qa.createQuickActions({ home: home(), appPath: APP, platform: 'linux' });
  assert.equal(linux.status().state, 'unavailable');
  await assert.rejects(linux.install(), /installed MoPilot app/);
  await assert.rejects(linux.uninstall(), /Mac feature/);
});

test('without an injected runner the refresh is the system pbs, and a failing one does not fail the install', async () => {
  const cp = require('node:child_process');
  const seen: string[] = [];
  const m = mock.method(
    cp,
    'execFile',
    (f: string, a: string[], _o: object, cb: (e: Error) => void) => (seen.push(`${f} ${a.join(' ')}`), cb(new Error('no pbs'))),
  );
  try {
    const q = qa.createQuickActions({ home: home(), appPath: APP, platform: 'darwin' });
    assert.equal((await q.install()).state, 'on');
    assert.deepEqual(seen, ['/System/Library/CoreServices/pbs -update']);
  } finally {
    m.mock.restore();
  }
});

test('the IPC reports the status and the switch installs or removes', async () => {
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  const calls: string[] = [];
  const actions = {
    status: () => ({ state: 'off' }),
    install: async () => (calls.push('install'), { state: 'on' }),
    uninstall: async () => (calls.push('uninstall'), { state: 'off' }),
  };
  const opened: unknown[] = [];
  ipc.register(
    {},
    {
      app: {},
      handle: (c: string, fn: (...a: unknown[]) => unknown) => (handlers[c] = fn),
      readyMainWindow: async () => (opened.push(1), { webContents: { send() {} }, isMinimized: () => false, show() {}, focus() {} }),
    },
    { actions },
  );
  assert.deepEqual(handlers['quickActions:status'](), { state: 'off' });
  assert.deepEqual(await handlers['quickActions:set'](true), { state: 'on' });
  assert.deepEqual(await handlers['quickActions:set'](false), { state: 'off' });
  assert.deepEqual(await handlers['quickActions:set']('yes'), { state: 'off' });
  assert.deepEqual(calls, ['install', 'uninstall', 'uninstall']);
  // the module also opens links the inbox hands it
  inbox.push(`${edition.desktop.scheme}://chat/new?q=hi`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(opened.length, 0, 'ignored while the Quick Actions are off');
  actions.status = () => ({ state: 'on' });
  inbox.push(`${edition.desktop.scheme}://chat/new?q=hi`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(opened.length, 1);
  actions.status = () => ({ state: 'stale' });
  inbox.push(`${edition.desktop.scheme}://chat/new?q=again`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(opened.length, 2);
  inbox.setHandler(() => {});
});

test('the IPC finds the app bundle for a packaged Mac app and none otherwise', () => {
  const reg = (app: object) => ipc.register({}, { app, handle: () => {}, readyMainWindow: async () => ({}) });
  reg({ isPackaged: false, getPath: () => '/x/y.app/Contents/MacOS/y' });
  reg({ isPackaged: true, getPath: () => '/x/y.app/Contents/MacOS/y' });
  // only a Mac app has a bundle to write the workflows for, whatever machine this runs on
  const onMac = (platform: string) =>
    ipc.register(
      {},
      { app: { isPackaged: true, getPath: () => '/x/y.app/Contents/MacOS/y' }, handle: () => {}, readyMainWindow: async () => ({}) },
      { platform },
    );
  onMac('darwin');
  onMac('linux');
  inbox.setHandler(() => {});
});
