// Quiet hours and push: a banner the quiet hours keep back makes no push either, and a "needs you" among them is pushed once when they end, with the fixed kind and an opaque ref, never a title; the notifier, the push bridge and registerNotify's resume hook agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { Notifier, registerNotify } = require('../electron/platform/notify.cjs');
const { createQuietHold } = require('../electron/platform/quietHold.cjs');
const { createPushBridge } = require('../electron/remote/pushBridge.cjs');
const { openRemote } = require('../electron/remote/runtime.cjs');
const { chatRef } = require('../shared/remote/ref.mjs');

const at = (day: number, h: number, m = 0) => new Date(2030, 0, day, h, m).getTime();
const NIGHT = { start: '22:00', end: '07:00' };

function setup(o: { pairs?: string[]; answer?: () => Promise<string> } = {}) {
  const requests: any[] = [];
  const remote: any = {
    devices: { list: () => (o.pairs ?? ['p1', 'p2']).map((pairId) => ({ pairId })) },
    pushRequest: (req: any) => (requests.push(req), o.answer ? o.answer() : Promise.resolve('sent')),
  };
  const bridge = createPushBridge({ remote: () => remote });
  const state = { now: at(1, 23), quiet: NIGHT as unknown, timers: [] as (() => void)[], shown: [] as any[] };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-push-')), 'held.json');
  const make = () => {
    const notifier: any = new Notifier({
      getMode: () => 'always',
      show: (n: any) => (state.shown.push(n), { close() {} }),
      now: () => state.now,
      onBanner: bridge.onBanner,
      quietHold: createQuietHold({
        quietHours: () => state.quiet,
        deliver: (held: any) => notifier.onCatchUp(held),
        file,
        now: () => state.now,
        schedule: (fn: () => void) => (state.timers.push(fn), 1),
        cancel: () => undefined,
      }),
    });
    notifier.onCatchUp = bridge.catchUp;
    return notifier;
  };
  return { notifier: make(), make, state, requests, fire: () => state.timers.splice(0).forEach((f) => f()) };
}

test('in quiet hours an approval makes no banner and no push; when they end one fixed-kind push per phone names the newest chat', async () => {
  const s = setup();
  assert.equal(s.notifier.notify('approval', 'secret-chat-1', { title: 'Delete prod', body: 'rm -rf', chatTitle: 'Private' }), null);
  assert.equal(s.notifier.notify('approval', 'secret-chat-2', { title: 'Wire money', body: 'x', chatTitle: 'Private' }), null);
  assert.equal(s.notifier.notify('turn', 'chat-3', { title: 'Done' }), null);
  assert.deepEqual([s.state.shown, s.requests], [[], []]);
  s.state.now = at(2, 7, 1);
  s.fire();
  await tick();
  assert.deepEqual(s.requests, [
    { pair: 'p1', kind: 'needsYou', ref: chatRef('p1', 'secret-chat-2') },
    { pair: 'p2', kind: 'needsYou', ref: chatRef('p2', 'secret-chat-2') },
  ]);
  assert.ok(!JSON.stringify(s.requests).match(/secret|Delete|Wire|Private|rm -rf/), 'no chat words, no sealed title');
  assert.deepEqual(s.state.shown, [], 'the Mac shows no banner for it: the person chose quiet');
  s.fire();
  await tick();
  assert.equal(s.requests.length, 2, 'once');
});

test('after the window the banner and its push go out as before', () => {
  const s = setup();
  s.state.now = at(2, 8);
  assert.ok(s.notifier.notify('approval', 'c1', {}));
  assert.deepEqual(
    s.requests.map((r) => r.kind),
    ['needsYou', 'needsYou'],
  );
});

test('a mode that shows nothing holds nothing, MoMo keeps its own quiet hours, and an answered approval is taken back', async () => {
  const s = setup();
  const never = new Notifier({
    getMode: () => 'never',
    show: () => ({ close() {} }),
    now: () => s.state.now,
    quietHold: { hold: () => assert.fail('held'), retract() {} },
  });
  assert.equal(never.notify('approval', 'c1', {}), null);

  assert.ok(
    s.notifier.notify('momo', 'momo:chat:m1', { status: 'needs', title: 'MoMo needs you' }),
    'MoMo’s notice is MoMo’s own business',
  );

  s.notifier.notify('approval', 'c1', {});
  s.notifier.retract('c1');
  s.state.now = at(2, 8);
  s.fire();
  await tick();
  assert.deepEqual(
    s.requests.filter((r) => r.kind === 'needsYou' && r.ref === chatRef('p1', 'c1')),
    [],
  );
});

test('the Mac restarts before the window ends: the new run says it once, at the end', async () => {
  const s = setup();
  s.notifier.notify('approval', 'c1', {});
  s.state.now = at(2, 7, 5);
  s.state.timers.length = 0;
  const restarted = s.make();
  s.fire();
  await tick();
  assert.equal(s.requests.length, 2);
  assert.ok(restarted);
});

test('no phone is paired: nothing is sent and nothing waits', async () => {
  const s = setup({ pairs: [] });
  s.notifier.notify('approval', 'c1', {});
  s.state.now = at(2, 8);
  s.fire();
  await tick();
  assert.deepEqual(s.requests, []);
  assert.equal(s.notifier.quietHold.size, 0);
});

test('the relay is down or fails: it is tried again, and once it takes it, it is not sent again', async () => {
  const answers = ['reject', 'failed', 'sent'];
  const s = setup({
    pairs: ['p1'],
    answer: () => {
      const a = answers.shift();
      return a === 'reject' ? Promise.reject(new Error('relay down')) : Promise.resolve(a as string);
    },
  });
  s.notifier.notify('approval', 'c1', {});
  s.state.now = at(2, 8);
  for (let i = 0; i < 4; i++) {
    s.fire();
    await tick();
  }
  assert.equal(s.requests.length, 3);
  assert.equal(s.notifier.quietHold.size, 0);
});

test('a phone that has it is not sent it again when another one’s push failed: the retry goes to the one that missed', async () => {
  const answers = ['failed', 'sent', 'no_token'];
  const s = setup({ answer: () => Promise.resolve(answers.shift() as string) });
  s.notifier.notify('approval', 'c1', {});
  s.state.now = at(2, 8);
  s.fire();
  await tick();
  assert.equal(s.notifier.quietHold.size, 1, 'p1 missed it, so it is kept');
  s.fire();
  await tick();
  assert.deepEqual(
    s.requests.map((r) => r.pair),
    ['p1', 'p2', 'p1'],
  );
  assert.equal(s.notifier.quietHold.size, 0, 'a final answer such as no token ends it');
  s.fire();
  await tick();
  assert.equal(s.requests.length, 3);
});

test('Mobile Remote not up yet is not "no one to tell": it is kept and said once the phones are known', async () => {
  const requests: any[] = [];
  let up: any = null;
  const bridge = createPushBridge({ remote: () => up });
  assert.equal(await bridge.catchUp({ chatId: 'c1', at: 1 }), false, 'not running');
  up = { devices: null, pushRequest: () => Promise.resolve('sent') };
  assert.equal(await bridge.catchUp({ chatId: 'c1', at: 1 }), false, 'starting');
  up = { devices: { list: () => [] }, pushRequest: () => Promise.resolve('sent') };
  assert.equal(await bridge.catchUp({ chatId: 'c1', at: 1 }), true, 'running with no phone paired');
  up = { devices: { list: () => [{ pairId: 'p1' }] }, pushRequest: (r: any) => (requests.push(r), Promise.resolve('sent')) };
  assert.equal(await bridge.catchUp({ chatId: 'c1', at: 1 }), true);
  assert.deepEqual(requests, [{ pair: 'p1', kind: 'needsYou', ref: chatRef('p1', 'c1') }]);
});

test('batches that keep failing are remembered only a few at a time', async () => {
  const bridge = createPushBridge({
    remote: () => ({ devices: { list: () => [{ pairId: 'p1' }] }, pushRequest: () => Promise.reject(new Error('down')) }) as any,
  });
  for (let i = 0; i < 25; i++) assert.equal(await bridge.catchUp({ chatId: 'c', at: i }), false);
});

test('the mode or a switch turned off while the hours last drops what it covered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-still-'));
  let now = at(1, 23);
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const kinds: Record<string, boolean> = {};
    let mode = 'always';
    const handlers = new Map<string, any>();
    class FakeNotification {
      static isSupported = () => true;
      on() {}
      show() {}
      close() {}
    }
    const notifier = registerNotify(
      { handle: (ch: string, f: any) => handlers.set(ch, f) },
      {
        Notification: FakeNotification,
        getMode: () => mode,
        getKinds: () => kinds,
        getQuietHours: () => NIGHT,
        quietFile: path.join(dir, 'held.json'),
      },
    );
    const said: any[] = [];
    notifier.onCatchUp = (h: any) => (said.push(h), true);
    await handlers.get('app:notify')({}, 'approval', 'c1', {});
    await handlers.get('app:notify')({}, 'auth', 'c2', {});
    await handlers.get('app:notify')({}, 'goal', 'c3', { status: 'stopped' });
    kinds.approval = false;
    now = at(2, 8);
    await notifier.quietChanged();
    assert.deepEqual(said, [{ chatId: 'c3', at: at(1, 23), count: 2 }], 'the approval switch is off: only auth and the goal are said');
    mode = 'never';
    await handlers.get('app:notify')({}, 'auth', 'c4', {});
    assert.equal(notifier.quietHold.size, 0, 'a mode that shows nothing holds nothing');
  } finally {
    Date.now = realNow;
  }
});

test('a notifier made without a bridge says nothing yet and keeps what waited', async () => {
  const s = setup();
  const bare: any = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }), now: () => s.state.now });
  assert.equal(bare.onCatchUp({ chatId: 'c', count: 1 }), false);
  assert.equal(bare.quietHold, null);
  assert.equal(bare.quietChanged(), undefined, 'nothing to look at without quiet hours');
});

test('registerNotify holds through the setting, says it through onCatchUp, and looks again when the Mac wakes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-reg-'));
  let now = at(1, 23);
  const handlers = new Map<string, any>();
  const power: Record<string, () => void> = {};
  const made: any[] = [];
  class FakeNotification {
    static isSupported = () => true;
    constructor(o: any) {
      made.push(o);
    }
    on() {}
    show() {}
    close() {}
  }
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const notifier = registerNotify(
      { handle: (ch: string, f: any) => handlers.set(ch, f) },
      {
        Notification: FakeNotification,
        getMode: () => 'always',
        getKinds: () => ({}),
        getQuietHours: () => NIGHT,
        quietFile: path.join(dir, 'held.json'),
        powerMonitor: { on: (ev: string, fn: () => void) => void (power[ev] = fn) },
      },
    );
    const said: any[] = [];
    notifier.onCatchUp = (h: any) => (said.push(h), true);
    await handlers.get('app:notify')({}, 'approval', 'c1', {});
    assert.deepEqual(made, [], 'nothing shows in quiet hours');
    now = at(2, 9);
    power.resume();
    await tick();
    assert.deepEqual(said, [{ chatId: 'c1', at: at(1, 23), count: 1 }]);
  } finally {
    Date.now = realNow;
  }
});

test('registerNotify without quiet hours or a power monitor works as before', async () => {
  const handlers = new Map<string, any>();
  const made: any[] = [];
  class FakeNotification {
    static isSupported = () => true;
    constructor(o: any) {
      made.push(o);
    }
    on() {}
    show() {}
    close() {}
  }
  const notifier = registerNotify(
    { handle: (ch: string, f: any) => handlers.set(ch, f) },
    { Notification: FakeNotification, getMode: () => 'always' },
  );
  assert.equal(notifier.quietHold, null);
  await handlers.get('app:notify')({}, 'approval', 'c1', {});
  assert.equal(made.length, 1);
});

test('opening the remote gives the app notifier the bridge’s catch-up', () => {
  const notifier: any = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }) });
  openRemote({
    userData: fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-open-')),
    live: { mopilot: {}, notifier },
    flagOn: () => false,
  });
  assert.equal(typeof notifier.onBanner, 'function');
  assert.equal(typeof notifier.onCatchUp, 'function');
});
