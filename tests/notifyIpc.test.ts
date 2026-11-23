// registerNotify in electron/platform/notify.cjs: app:notify reaches Electron's Notification, a click
// clears the chat and reports it; plus the Notifier's defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { registerNotify, Notifier, mergedTitle } = require('../electron/platform/notify.cjs');

function setup(supported = true) {
  const made: any[] = [];
  class Notification extends EventEmitter {
    opts: any;
    shown = 0;
    closed = 0;
    static isSupported = () => supported;
    constructor(opts: any) {
      super();
      this.opts = opts;
      made.push(this);
    }
    show() {
      this.shown++;
    }
    close() {
      this.closed++;
    }
  }
  const handlers = new Map<string, any>();
  const clicks: string[] = [];
  const notifier = registerNotify(
    { handle: (ch: string, f: any) => handlers.set(ch, f) },
    { Notification, getMode: () => 'always', onClick: (id: string) => clicks.push(id) },
  );
  return { made, clicks, notifier, call: (...a: any[]) => handlers.get('app:notify')({}, ...a) };
}

test('app:notify shows a native notification; replacing it closes the old one; a click clears and reports', () => {
  const { made, clicks, notifier, call } = setup();
  call('turn', 'c1', { title: 'Done', body: 'b' });
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].opts, { id: 'chat:c1', groupId: 'c1', title: 'Done', body: 'b', silent: false });
  assert.equal(made[0].shown, 1);
  call('approval', 'c1', 'not-an-object');
  assert.equal(made[0].closed, 1);
  assert.equal(made[1].opts.title, '');
  made[1].emit('click');
  assert.deepEqual(clicks, ['c1']);
  assert.equal(notifier.byChat.has('c1'), false);
});

test("a menu action's notice reaches Electron's Notification as a plain banner", () => {
  const { made, notifier } = setup();
  notifier.notice({ title: 'MoPilot', body: 'Recording' });
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].opts, { title: 'MoPilot', body: 'Recording' });
  assert.equal(made[0].shown, 1);
});

test('a click without an onClick handler still clears', () => {
  const handlers = new Map<string, any>();
  let n: any;
  class Notification extends EventEmitter {
    static isSupported = () => true;
    constructor() {
      super();
      n = this;
    }
    show() {}
    close() {}
  }
  const notifier = registerNotify({ handle: (ch: string, f: any) => handlers.set(ch, f) }, { Notification, getMode: () => 'always' });
  handlers.get('app:notify')({}, 'turn', 'c9', null);
  n.emit('click');
  assert.equal(notifier.byChat.has('c9'), false);
});

test('unsupported platforms show nothing but still track the chat', () => {
  const { made, notifier, call } = setup(false);
  call('turn', 'c1', {});
  assert.equal(made.length, 0);
  assert.equal(notifier.byChat.has('c1'), true);
  call('turn', 'c1', {}); // replacing closes the no-op handle
});

test('defaults: every kind on, never focused; clearing an unknown chat is a no-op; goal merges', () => {
  const shown: any[] = [];
  const n = new Notifier({ show: (x: any) => (shown.push(x), { close() {} }), getMode: () => 'unfocused' });
  assert.ok(n.notify('turn', 'a', { viewing: true }));
  n.clear('zzz');
  assert.equal(mergedTitle('goal', false, 2), '2 goals complete');
});

test('a late click from a replaced notification preserves the newer notification and its priority hold', () => {
  const { made, clicks, notifier, call } = setup();
  call('approval', 'c1', { title: 'Old approval' });
  call('goal', 'c1', { title: 'Current paused goal', status: 'blocked' });
  const current = notifier.byChat.get('c1');
  made[0].emit('click');
  assert.equal(notifier.byChat.get('c1'), current);
  assert.equal(made[1].closed, 0);
  assert.equal(notifier.notify('turn', 'c1', { title: 'Done' }), null);
  assert.deepEqual(clicks, ['c1']);
  made[1].emit('click');
  assert.equal(notifier.byChat.has('c1'), false);
  assert.ok(notifier.notify('turn', 'c1', { title: 'Done' }));
});

test('a late merged-notification click cannot dismiss the group that replaced it', () => {
  const { made, clicks, notifier, call } = setup();
  for (const id of ['a', 'b', 'c']) call('approval', id, { title: id });
  const current = notifier.byChat.get('c');
  made[1].emit('click');
  for (const id of ['a', 'b', 'c']) assert.equal(notifier.byChat.get(id), current);
  assert.equal(made[2].closed, 0);
  assert.deepEqual(clicks, ['b']);
  made[2].emit('click');
  assert.equal(notifier.byChat.size, 0);
  assert.deepEqual(clicks, ['b', 'c']);
});

test('the notifier reads the OS idle time in ms through the power monitor, and says unknown without one', () => {
  class Notification extends EventEmitter {
    static isSupported = () => true;
  }
  const ipc = { handle: () => undefined };
  const withMonitor = registerNotify(ipc, {
    Notification,
    getMode: () => 'always',
    powerMonitor: { on: () => undefined, getSystemIdleTime: () => 12 },
  });
  assert.equal(withMonitor.idleMs(), 12_000);
  assert.equal(registerNotify(ipc, { Notification, getMode: () => 'always', powerMonitor: { on: () => undefined } }).idleMs(), null);
  assert.equal(registerNotify(ipc, { Notification, getMode: () => 'always' }).idleMs(), null);
  assert.equal(new Notifier({ getMode: () => 'always', show: () => ({ close() {} }) }).idleMs(), null);
});
