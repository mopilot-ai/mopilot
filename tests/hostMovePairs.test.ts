// The pair matrix of #5161: a message sent while Switch host works on a chat (the dialog's plan phase, then the move) reaches the destination Host exactly once and the source Host never, whichever pair of owners the chat moves between (this Mac in-app, This Mac's own Host, a machine, a machine to this Mac) and whichever way it was sent. A move that stalls keeps the messages held (naming the machine) until it ends by its own timeout, then the source gets them once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';
import { selectSegment, setup, tick } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const { remoteRoutes } = require('../electron/host/wiring.cjs');

/** A window as the main process sees it: the events that end a dialog's hold. */
const windowOf = () => new EventEmitter();
type Owner = 'local' | 'mac' | 'box' | 'other';
const req = (to: Owner) => ({ chatId: 'c1', targetHostId: to, cwd: '/srv/app' });
/** The pairs a chat moves between: this Mac in-app (`local`), This Mac's own Host (`mac`, a registered machine like any other), and machines. */
const PAIRS: [Owner, Owner][] = [
  ['local', 'other'],
  ['mac', 'other'],
  ['box', 'other'],
  ['box', 'mac'],
  ['other', 'local'],
  ['mac', 'local'],
];
const WAYS = ['enter', 'phone', 'scheduled'] as const;
type Way = (typeof WAYS)[number];

function pairWorld(t: any, from: Owner, to: Owner) {
  const w = world(t, { epoch: 1 });
  if (from !== 'local') w.remote('c1', from);
  // every Host's journal: what it was sent, by key
  const journal: Record<string, string[]> = { box: [], mac: [], other: [] };
  const hosts: Record<string, any> = {};
  for (const id of Object.keys(journal))
    hosts[id] = { ...w.host, send: async (_c: string, _i: any, o: any) => void journal[id].push(o.key) };
  w.config.hostFor = (id: string) => hosts[id];
  w.config.checkFolder = async () => ({});
  const f = setup();
  selectSegment(f.c, f.chats, 'c1', [['acp:fake', 'native']]);
  f.c.remote = remoteRoutes({ remoteSend: () => w.service });
  const open: Record<string, (v?: any) => void> = {};
  const live: any = {
    hostCodePlan: () =>
      new Promise((resolve, reject) => {
        open.plan = resolve;
        open.planFails = () => reject(Object.assign(new Error('The folder cannot be read.'), { code: 'directory_missing' }));
      }),
    hostContinue: () =>
      new Promise((resolve, reject) => {
        open.lands = () => {
          w.remote('c1', to, 2, '/srv/app');
          resolve({ hostId: to, epoch: 2 });
        };
        open.fails = () => reject(Object.assign(new Error('The machine did not answer.'), { code: 'host_unreachable' }));
      }),
    controller: { state: {} },
  };
  let hostOn = true;
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live, app: { getPath: () => '/nowhere' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: () => ({ list: () => ({ machines: [], resolved: true }), row: () => ({ name: 'the new machine' }) }) as any,
      allowed: () => hostOn,
      makeRemoteSend: (() => () => w.service) as any,
    },
  );
  const call = (c: string, ...a: any[]) => handlers.get(c)({ sender: win }, ...a);
  const win = windowOf();
  /** The window's sends: the composer's Enter, a phone chat.send, a scheduled run. */
  const send = async (way: Way, key: string) => {
    const item = msg(`m-${key.slice(-2)}`, key);
    if (way === 'enter') return from === 'local' ? f.c.send('c1', item, 1, true) : w.service.send('c1', item, 1);
    if (way === 'phone') return from === 'local' ? f.c.send('c1', item, null, true) : w.service.enqueue('c1', item, null);
    return from === 'local' ? f.c.send('c1', item, null, true) : w.service.send('c1', item, null);
  };
  /** Where the message ended: the destination's journal, this Mac's controller (a chat that came back), the source's journal. */
  const landed = (key: string) => ({
    destination: to === 'local' ? w.local.sent.filter(([, i]: any) => i.id === key).length : journal[to].filter((k) => k === key).length,
    source:
      from === 'local'
        ? w.local.sent.filter(([, i]: any) => i.id === key).length + f.execs.length
        : journal[from].filter((k) => k === key).length,
  });
  return {
    w,
    f,
    journal,
    open,
    call,
    win,
    off: () => ((hostOn = false), () => void (hostOn = true)),
    send,
    landed,
    plan: () => call('host:codePlan', req(to)),
    move: () => call('host:continue', req(to)),
  };
}

for (const [from, to] of PAIRS)
  for (const way of WAYS) {
    test(`${from} -> ${to}, sent by ${way} during the dialog's plan and then the move: held, then once on the destination and never on the source`, async (t) => {
      const p = pairWorld(t, from, to);
      const planning = p.plan();
      await tick();
      const first = await p.send(way, UUID(1));
      assert.equal(first.action, 'queued', 'told it is kept');
      assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 0 }, 'nothing runs while the dialog works');
      p.open.plan(null);
      await planning;
      // between the plan's answer and the continue the chat stays held
      await tick();
      assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 0 });
      const moving = p.move();
      await tick();
      // no timer decides: an hour passes between the plan and the continue and it is still held
      p.w.clock.advance(60 * 60_000);
      await tick();
      await p.send(way, UUID(2));
      assert.deepEqual(
        p.w.queues.get('c1')?.map((q: any) => q.waitingFor),
        ['hostMoving', 'hostMoving'],
      );
      assert.deepEqual([p.landed(UUID(1)), p.landed(UUID(2))], Array(2).fill({ destination: 0, source: 0 }), 'held while the move runs');
      p.open.lands();
      await moving;
      assert.deepEqual(
        [p.landed(UUID(1)), p.landed(UUID(2))],
        Array(2).fill({ destination: 1, source: 0 }),
        'exactly once, on the destination',
      );
      await p.w.service.resume();
      await p.w.service.rebase('c1');
      assert.deepEqual([p.landed(UUID(1)), p.landed(UUID(2))], Array(2).fill({ destination: 1, source: 0 }), 'nothing is sent again');
    });
  }

for (const [from, to] of PAIRS) {
  test(`${from} -> ${to}, the destination stops answering: the rows stay held naming the machine, nothing runs on the source, and when the move fails by its own timeout the source gets each message once`, async (t) => {
    const p = pairWorld(t, from, to);
    const moving = p.move();
    await tick();
    await p.send('enter', UUID(1));
    p.w.clock.advance(60 * 60_000);
    await tick();
    await p.send('phone', UUID(2));
    assert.deepEqual(
      p.w.queues.get('c1')?.map((q: any) => [q.waitingFor, q.movingTo]),
      Array(2).fill(['hostMoving', 'the new machine']),
    );
    assert.deepEqual([p.landed(UUID(1)), p.landed(UUID(2))], Array(2).fill({ destination: 0, source: 0 }));
    p.open.fails();
    const answer = await moving;
    assert.equal(answer.error?.code, 'host_unreachable', 'the person is told why');
    assert.deepEqual(
      [p.landed(UUID(1)), p.landed(UUID(2))],
      Array(2).fill({ destination: 0, source: 1 }),
      'the chat did not move: each message goes to the owner it still has, once',
    );
  });
}

test('a plan that asks the person something releases the chat: the person decides, and what is sent meanwhile goes to the owner it has', async (t) => {
  const p = pairWorld(t, 'mac', 'other');
  const planning = p.plan();
  await tick();
  await p.send('enter', UUID(1));
  assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 0 }, 'held while the dialog works');
  p.open.plan({ plan: { files: 2 } });
  await planning;
  await tick();
  assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 1 }, 'the dialog asks: nothing is held while they read it');
});

test('a message sent between the plan and the continue is held (no window in which it runs on the source): destination once, source never, however long the continue takes', async (t) => {
  const p = pairWorld(t, 'box', 'other');
  const planning = p.plan();
  await tick();
  p.open.plan(null);
  await planning;
  p.w.clock.advance(60 * 60_000);
  await tick();
  await p.send('enter', UUID(1));
  assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 0 });
  const moving = p.move();
  await tick();
  assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 0 });
  p.open.lands();
  await moving;
  assert.deepEqual(p.landed(UUID(1)), { destination: 1, source: 0 });
});

/** Each way the dialog ends without a continue: what was kept goes to the owner the chat has, once, and the hold is gone. */
const exits: [string, (p: ReturnType<typeof pairWorld>) => Promise<void>][] = [
  ['the window is closed (destroyed)', async (p) => void p.win.emit('destroyed')],
  [
    'the dialog is closed or cancelled (the window stays: the dialog tells main)',
    async (p) => void (await p.call('host:planRelease', 'c1')),
  ],
  ['the renderer crashes', async (p) => void p.win.emit('render-process-gone')],
  ['the window navigates away (a reload)', async (p) => void p.win.emit('did-navigate', {}, 'app://x', 200, 'OK')],
];
for (const [name, exit] of exits)
  test(`the dialog ends without a continue: ${name}: the chat is released to its owner once`, async (t) => {
    const p = pairWorld(t, 'box', 'other');
    const planning = p.plan();
    await tick();
    p.open.plan(null);
    await planning;
    await p.send('enter', UUID(1));
    assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 0 });
    await exit(p);
    await tick();
    assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 1 });
    assert.equal(p.w.service.moving('c1'), false);
    p.win.emit('destroyed');
    await tick();
    assert.equal(p.landed(UUID(1)).source, 1, 'a second end sends nothing again');
  });

test("the window goes away while the plan runs: released at once, and the plan's late answer leaks nothing", async (t) => {
  const p = pairWorld(t, 'box', 'other');
  const planning = p.plan();
  await tick();
  await p.send('enter', UUID(1));
  p.win.emit('destroyed');
  await tick();
  assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 1 });
  p.open.plan(null);
  await planning;
  assert.equal(p.w.service.moving('c1'), false);
});

test('the plan fails (an error): the chat is released to its owner once and nothing is held', async (t) => {
  const p = pairWorld(t, 'mac', 'other');
  const planning = p.plan();
  await tick();
  await p.send('enter', UUID(1));
  p.open.planFails();
  assert.equal((await planning).error.code, 'directory_missing');
  await tick();
  assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 1 });
  assert.equal(p.w.service.moving('c1'), false);
});

test('Host is turned off while the dialog works: the continue still takes over the plan hold, nothing leaks, the chat is not left held', async (t) => {
  const p = pairWorld(t, 'box', 'other');
  const planning = p.plan();
  await tick();
  p.open.plan(null);
  await planning;
  assert.equal(p.w.service.moving('c1'), true);
  // Host access ends: main's service is gone, the continue is refused
  const off = p.off();
  const refused = await p.move();
  assert.ok(refused.error, 'the continue is refused');
  await tick();
  assert.equal(p.w.service.moving('c1'), true, 'the plan hold waits for its window');
  p.win.emit('destroyed');
  await tick();
  assert.equal(p.w.service.moving('c1'), false);
  off();
});

test('a continue refused before it starts (an incomplete request) releases the plan hold: the chat is not left held', async (t) => {
  const p = pairWorld(t, 'box', 'other');
  const planning = p.plan();
  await tick();
  p.open.plan(null);
  await planning;
  await p.send('enter', UUID(1));
  const refused = await p.call('host:continue', { chatId: 'c1', targetHostId: 'other', cwd: '' });
  assert.equal(refused.error.code, 'invalid');
  await tick();
  assert.deepEqual(p.landed(UUID(1)), { destination: 0, source: 1 });
  assert.equal(p.w.service.moving('c1'), false);
});
