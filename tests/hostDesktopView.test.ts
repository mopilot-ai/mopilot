// The pane's window onto a Host chat's desktop (electron/capabilities/hostDesktopView.cjs): frames of the Host's display pushed to the watching window, and the user's input forwarded only after they took over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { registerRemoteDesktopView, inputCall } = require('../electron/capabilities/hostDesktopView.cjs');

const SHOT = {
  png: Buffer.from('PNGDATA').toString('base64'),
  width: 1000,
  height: 500,
  pixelsPerPoint: 0.5,
  display: { id: 1, x: 100, y: 50, width: 2000, height: 1000 },
};

function rig(over: { desktop?: any } = {}) {
  const handlers = new Map<string, any>();
  const sent: any[] = [];
  const sender: any = {
    id: 1,
    isDestroyed: () => false,
    send: (c: string, m: any) => sent.push([c, m]),
    once: (_: string, fn: any) => (sender.destroy = fn),
  };
  const calls: any[] = [];
  const leases: any[] = [];
  const shots: any[] = [];
  const taken = new Set<string>();
  const agent = new Set<string>();
  const hosts: Record<string, string> = {};
  const lost: string[] = [];
  const reports: any[] = [];
  const desktop = over.desktop ?? {
    command: async (chat: string, method: string, params: any) => (
      calls.push([chat, method, params]), method === 'screenshot' ? SHOT : { ok: true }
    ),
    lease: async (chat: string, apps: string) => void leases.push(['lease', chat, apps]),
    release: async (chat: string) => void leases.push(['release', chat]),
  };
  let watcher: any = null;
  const polls: any[] = [];
  const activity: any[] = [];
  const view = registerRemoteDesktopView({
    ipcMain: { handle: (c: string, fn: any) => handlers.set(c, fn) },
    remoteOf: (host: string) => (host === 'hoff' ? null : desktop),
    hostOf: (chat: string) => (chat === 'gone' ? null : (hosts[chat] ?? 'h1')),
    takenOver: (chat: string) => taken.has(chat),
    frameVersion: (host: string, chat: string, shot: any) => (shots.push([host, chat, shot.display.width]), 7),
    agentHolds: (chat: string) => agent.has(chat),
    settled: async () => void leases.push(['settled']),
    hostLost: (h: string) => lost.push(h),
    report: (w: string, e: unknown) => reports.push([w, e]),
    poller: (o: any) => ({
      watch: (w: any) => {
        watcher = { o, w };
        return {
          stop: () => polls.push('stop'),
          setActive: (on: boolean) => activity.push(['active', on]),
          refresh: () => activity.push(['refresh']),
          setVisible: (on: boolean) => polls.push(['visible', on]),
          setTakeover: (on: boolean) => polls.push(['takeover', on]),
        };
      },
    }),
  });
  const ipc = (name: string, ...a: any[]) => handlers.get(name)({ sender }, ...a);
  return { activity, ipc, sent, calls, leases, shots, taken, agent, hosts, lost, reports, polls, view, sender, watcher: () => watcher };
}

test('a pane watches a chat whose desktop is on a connected Host; one that is not gets nothing, and bad arguments are refused', async () => {
  const r = rig();
  assert.equal(await r.ipc('desktop:remoteWatch', '', 'c1', 'h1'), false);
  assert.equal(await r.ipc('desktop:remoteWatch', 'p1', 7, 'h1'), false);
  assert.equal(await r.ipc('desktop:remoteWatch', 'p1', 'c1', ''), false, 'the pane names its machine');
  assert.equal(await r.ipc('desktop:remoteWatch', 'p1', 'gone', 'h1'), false);
  assert.equal(await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h2'), false, 'the chat is on another machine than the pane’s');
  assert.equal(await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1'), true);
  assert.equal(r.view.watching(), 1);
  assert.equal(await r.ipc('desktop:remoteStop', 'p1'), true);
  assert.equal(await r.ipc('desktop:remoteStop', 'p1'), false);
  assert.equal(r.view.watching(), 0);
});

test('a frame is one screenshot of the Host’s display under the chat’s own lease, pushed to the window with its size; no lease says the agent is not using it; other failures are said in words', async () => {
  const r = rig();
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  const { o, w } = r.watcher();
  await r.ipc('desktop:remoteView', 'p1', { visible: true });
  const frame = await o.fetch('c1');
  assert.deepEqual(r.calls[0], ['c1', 'screenshot', { format: 'jpeg', quality: 0.6, maxSide: 1280 }]);
  assert.equal(frame.mime, 'image/png');
  w.onFrame(frame);
  assert.equal(r.sent[0][0], 'desktop:remoteFrame');
  assert.deepEqual(
    { ...r.sent[0][1], data: Buffer.from(r.sent[0][1].data, 'base64').toString() },
    { paneId: 'p1', data: 'PNGDATA', mime: 'image/png', width: 1000, height: 500, pixelsPerPoint: 0.5, display: SHOT.display, version: 7 },
  );
  w.onError(Object.assign(new Error('x'), { code: 'no_lease' }));
  assert.deepEqual(r.sent[1][1], { paneId: 'p1', idle: true });
  w.onError(new Error('The Host did not answer.'));
  assert.equal(r.sent[2][1].paneId, 'p1');
  assert.ok(typeof r.sent[2][1].error === 'string' && r.sent[2][1].error.length > 0);
  r.hosts.off = 'hoff';
  assert.equal(await r.ipc('desktop:remoteWatch', 'p2', 'off', 'hoff'), true, 'a machine that is offline at open is still watched');
  await assert.rejects(r.watcher().o.fetch('off'), (e: any) => e.code === 'not_connected');
  assert.deepEqual(r.lost, ['hoff'], 'a takeover on a machine that is not connected ends');
});

test('a shot with no picture is an empty frame; visible alone and takeover alone are told to the poller on their own', async () => {
  const r = rig({ desktop: { command: async () => ({ ...SHOT, png: undefined, mimeType: 'image/webp' }) } });
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  await r.ipc('desktop:remoteView', 'p1', { visible: true });
  const f = await r.watcher().o.fetch('c1');
  assert.equal(f.data.length, 0);
  assert.equal(f.mime, 'image/webp');
  await r.ipc('desktop:remoteView', 'p1', { visible: false });
  assert.deepEqual(r.polls, [
    ['visible', true],
    ['visible', false],
  ]);
});

test('a JPEG frame keeps its type; a window that was destroyed is not written to', async () => {
  const r = rig({ desktop: { command: async () => ({ ...SHOT, png: undefined, jpeg: Buffer.from('J').toString('base64') }) } });
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  const { o, w } = r.watcher();
  await r.ipc('desktop:remoteView', 'p1', { visible: true });
  const f = await o.fetch('c1');
  assert.equal(f.mime, 'image/jpeg');
  r.sender.isDestroyed = () => true;
  w.onFrame(f);
  assert.deepEqual(r.sent, []);
  r.sender.destroy();
  assert.equal(r.view.watching(), 0, 'the watch ends with the window');
});

test('the pane shows and hides; a takeover waits for the agent’s side to be let go, then takes its own lease; handing back releases it', async () => {
  const r = rig();
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  r.taken.add('c1');
  assert.equal(await r.ipc('desktop:remoteView', 'nope', { visible: true }), false);
  assert.equal(await r.ipc('desktop:remoteView', 'p1', null), false);
  assert.equal(await r.ipc('desktop:remoteView', 'p1', { visible: true, takeover: true }), true);
  await r.ipc('desktop:remoteView', 'p1', { takeover: true });
  await new Promise((res) => setImmediate(res));
  await r.ipc('desktop:remoteView', 'p1', { takeover: false, visible: 'yes' });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(r.leases, [['settled'], ['lease', 'c1', '*'], ['release', 'c1']]);
  assert.deepEqual(r.polls, [
    ['visible', true],
    ['takeover', true],
    ['takeover', false],
  ]);
});

test('a failing hand-over is reported and said in the pane', async () => {
  const r = rig({
    desktop: { command: async () => SHOT, lease: async () => Promise.reject(new Error('busy')), release: async () => undefined },
  });
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  r.taken.add('c1');
  await r.ipc('desktop:remoteView', 'p1', { takeover: true });
  await new Promise((res) => setImmediate(res));
  assert.equal(r.reports.length, 1);
  assert.equal(r.sent.at(-1)[1].paneId, 'p1');
  assert.ok(r.sent.at(-1)[1].error);
  assert.ok(!r.polls.some((p) => p[0] === 'takeover'), 'a takeover that could not lease does not poll as one');
});

test('a chat that moves to another machine stops the watch, shows no stale geometry and cannot be driven', async () => {
  const r = rig();
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  const { w, o } = r.watcher();
  await r.ipc('desktop:remoteView', 'p1', { visible: true });
  w.onFrame(await o.fetch('c1'));
  r.taken.add('c1');
  await r.ipc('desktop:remoteView', 'p1', { takeover: true });
  r.hosts.c1 = 'h2';
  assert.equal(await r.ipc('desktop:remoteInput', 'p1', { kind: 'click', x: 1, y: 1 }), false, 'not machine h1’s any more');
  await assert.rejects(o.fetch('c1'), (e: any) => e.code === 'moved');
  assert.equal(r.view.watching(), 0, 'the old pane’s watch ended');
});

test('input reaches the Host’s desktop only after the user took over, in the display’s points', async () => {
  const r = rig();
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  const { w, o } = r.watcher();
  await r.ipc('desktop:remoteView', 'p1', { visible: true });
  w.onFrame(await o.fetch('c1'));
  r.calls.length = 0;
  assert.equal(await r.ipc('desktop:remoteInput', 'p1', { kind: 'click', x: 100, y: 40 }), false, 'watching only');
  await r.ipc('desktop:remoteView', 'p1', { takeover: true });
  assert.equal(await r.ipc('desktop:remoteInput', 'p1', { kind: 'click', x: 100, y: 40 }), false, 'the pane says so, main’s tab does not');
  r.taken.add('c1');
  await r.ipc('desktop:remoteView', 'p1', { takeover: true });
  assert.equal(await r.ipc('desktop:remoteInput', 'p1', { kind: 'click', x: 100, y: 40, count: 2 }), true);
  assert.deepEqual(r.calls[0], ['c1', 'input.click', { x: 300, y: 130, button: 'left', count: 2 }]);
  assert.equal(await r.ipc('desktop:remoteInput', 'p1', { kind: 'bogus' }), false);
  assert.equal(await r.ipc('desktop:remoteInput', 'nope', { kind: 'key', key: 'a' }), false);
});

test('a forward that fails is reported and answers false', async () => {
  const r = rig({
    desktop: {
      command: async (_c: string, m: string) => (m === 'screenshot' ? SHOT : Promise.reject(new Error('lost'))),
      lease: async () => undefined,
      release: async () => undefined,
    },
  });
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  const { w, o } = r.watcher();
  await r.ipc('desktop:remoteView', 'p1', { visible: true });
  w.onFrame(await o.fetch('c1'));
  r.taken.add('c1');
  await r.ipc('desktop:remoteView', 'p1', { takeover: true });
  await new Promise((res) => setImmediate(res));
  assert.equal(await r.ipc('desktop:remoteInput', 'p1', { kind: 'key', key: 'Return' }), false);
  assert.equal(r.reports.length, 1);
  assert.ok(r.sent.at(-1)[1].error, 'a lost lease is said in the pane');
  r.view.stopAll();
  assert.equal(r.view.watching(), 0);
});

test('inputCall: what the pane may forward, and nothing else', () => {
  const frame = { pixelsPerPoint: 2, display: { x: 10, y: 20 } };
  assert.deepEqual(inputCall({ kind: 'click', x: 100, y: 40 }, frame), {
    method: 'input.click',
    params: { x: 60, y: 40, button: 'left', count: 1 },
  });
  assert.deepEqual(inputCall({ kind: 'scroll', x: 0, y: 0, dx: 0, dy: -3 }, frame), {
    method: 'input.scroll',
    params: { x: 10, y: 20, dx: 0, dy: -3 },
  });
  assert.deepEqual(inputCall({ kind: 'key', key: 'Escape' }, frame), { method: 'input.key', params: { key: 'Escape' } });
  assert.deepEqual(inputCall({ kind: 'text', text: 'hi' }, frame), { method: 'input.type', params: { text: 'hi' } });
  for (const bad of [
    null,
    'x',
    { kind: 'click', x: 'a', y: 1 },
    { kind: 'click', x: 1, y: 1, button: 'back' },
    { kind: 'click', x: 1, y: 1, count: 9 },
    { kind: 'scroll', x: 1, y: 1, dx: 'a', dy: 1 },
    { kind: 'key', key: '' },
    { kind: 'key', key: 'x'.repeat(65) },
    { kind: 'text', text: '' },
    { kind: 'text', text: 'x'.repeat(10_001) },
    { kind: 'drag' },
  ])
    assert.equal(inputCall(bad, frame), null, JSON.stringify(bad));
  assert.equal(inputCall({ kind: 'click', x: 1, y: 1 }, null), null, 'no frame shown yet: no point to translate');
  assert.equal(inputCall({ kind: 'click', x: 1, y: 1 }, { pixelsPerPoint: 0, display: { x: 0, y: 0 } }), null);
});

test('the user’s lease is given back once, and not when the agent holds the desktop again; closing the pane while driving gives it back', async () => {
  const flush = () => new Promise((res) => setImmediate(res));
  // a late hand back after the next turn's agent leased must not end the agent's lease
  const a = rig();
  await a.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  a.taken.add('c1');
  await a.ipc('desktop:remoteView', 'p1', { takeover: true });
  await flush();
  a.taken.delete('c1');
  a.agent.add('c1');
  await a.ipc('desktop:remoteView', 'p1', { takeover: false });
  await flush();
  assert.deepEqual(a.leases, [['settled'], ['lease', 'c1', '*']], 'no release of the agent’s lease');
  assert.equal(await a.ipc('desktop:remoteStop', 'p1'), true);
  await flush();
  assert.equal(a.leases.length, 2, 'nothing more to give back');
  // closing the pane (and a window that goes away) while driving releases it, once
  const b = rig();
  await b.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  b.taken.add('c1');
  await b.ipc('desktop:remoteView', 'p1', { takeover: true });
  await flush();
  await b.ipc('desktop:remoteStop', 'p1');
  await flush();
  assert.deepEqual(b.leases.at(-1), ['release', 'c1']);
  assert.equal(b.leases.filter((l) => l[0] === 'release').length, 1);
  // handed back while the lease was still being taken: given back as soon as it is held
  const c = rig();
  await c.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  c.taken.add('c1');
  await c.ipc('desktop:remoteView', 'p1', { takeover: true });
  await c.ipc('desktop:remoteView', 'p1', { takeover: false });
  await flush();
  assert.deepEqual(
    c.leases.map((l) => l[0]),
    ['settled', 'lease', 'release'],
  );
  // a failing give-back is reported
  const d = rig({
    desktop: { command: async () => SHOT, lease: async () => undefined, release: async () => Promise.reject(new Error('gone')) },
  });
  await d.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  d.taken.add('c1');
  await d.ipc('desktop:remoteView', 'p1', { takeover: true });
  await flush();
  await d.ipc('desktop:remoteStop', 'p1');
  await flush();
  assert.equal(d.reports.length, 1);
});

test('the agent’s cursor goes to the panes that watch its chat on that machine, and to no other', async () => {
  const r = rig();
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  await r.ipc('desktop:remoteWatch', 'p2', 'c2', 'h1');
  const hide = (hostId: string) => ({ kind: 'hide', id: 0, hostId });
  r.view.cursorTo('c1', hide('h1'));
  r.view.cursorTo('nobody', hide('h1'));
  r.view.cursorTo('c1', hide('h2'));
  assert.deepEqual(
    r.sent.map((s: any) => s[1]),
    [{ paneId: 'p1', cursor: hide('h1') }],
    'only a pane of that machine',
  );
  // the chat moved to another machine: the old pane gets nothing of the old machine's cursor
  r.hosts.c1 = 'h2';
  r.view.cursorTo('c1', hide('h1'));
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.shots, []);
});

test('an overtaken capture (stale_frame) shows nothing and keeps the frame the user’s input is mapped by', async () => {
  const r = rig();
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  await r.ipc('desktop:remoteView', 'p1', { visible: true });
  const { w, o } = r.watcher();
  w.onFrame(await o.fetch('c1'));
  const before = r.sent.length;
  w.onError(Object.assign(new Error('This desktop frame is no longer current.'), { code: 'stale_frame' }));
  assert.equal(r.sent.length, before, 'nothing was pushed');
  r.taken.add('c1');
  await r.ipc('desktop:remoteView', 'p1', { takeover: true });
  await new Promise((res) => setImmediate(res));
  assert.equal(await r.ipc('desktop:remoteInput', 'p1', { kind: 'click', x: 100, y: 40 }), true, 'the last frame still maps the click');
});

test('a quiet capture while the chat’s own action runs is not shown as an error; with no action it is', async () => {
  const r = rig();
  await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
  await r.ipc('desktop:remoteView', 'p1', { visible: true });
  const { w } = r.watcher();
  const timeout = () => Object.assign(new Error('The page did not answer.'), { code: 'fetch_timeout' });
  w.onError(timeout());
  assert.ok(r.sent.at(-1)[1].error, 'no action: the pane says so');
  const before = r.sent.length;
  let done: () => void = () => undefined;
  const running = r.view.aroundAction('h1', 'c1', 'input.click', () => new Promise<void>((res) => (done = res)));
  w.onError(timeout());
  assert.equal(r.sent.length, before, 'the action holds captures, so a quiet pane is not a broken one');
  done();
  await running;
  w.onError(timeout());
  assert.ok(r.sent.length > before);
});

for (const retirement of ['hidden', 'moved', 'generation', 'stopped', 'replaced']) {
  test(`frame publication rechecks ${retirement} after capture resolves`, async () => {
    let generation = 1;
    const remote = { generation: () => generation, command: async () => SHOT };
    const r = rig({ desktop: remote });
    await r.ipc('desktop:remoteWatch', 'p1', 'c1', 'h1');
    await r.ipc('desktop:remoteView', 'p1', { visible: true });
    const { o, w } = r.watcher();
    const frame = await o.fetch('c1');
    if (retirement === 'hidden') await r.ipc('desktop:remoteView', 'p1', { visible: false });
    if (retirement === 'moved') r.hosts.c1 = 'h2';
    if (retirement === 'generation') generation++;
    if (retirement === 'stopped') await r.ipc('desktop:remoteStop', 'p1');
    if (retirement === 'replaced') await r.ipc('desktop:remoteWatch', 'p1', 'c2', 'h1');
    w.onFrame(frame);
    if (retirement !== 'generation') w.onError(new Error('obsolete error'));
    assert.deepEqual(r.sent, []);
    r.view.stopAll();
  });
}

test('a click on the small JPEG frame lands on the same display point as on the full-size frame', () => {
  // a 1024 x 768 pt display at (0, 0): the full frame is 2000 px wide, the pane's frame is capped at 1280
  const full = { pixelsPerPoint: 2000 / 1024, display: { x: 0, y: 0 } };
  const small = { pixelsPerPoint: 1280 / 1024, display: { x: 0, y: 0 } };
  const onFull = inputCall({ kind: 'click', x: 2000 / 2, y: 1500 / 4 }, full);
  const onSmall = inputCall({ kind: 'click', x: 1280 / 2, y: 960 / 4 }, small);
  assert.deepEqual(onFull?.params, onSmall?.params);
  assert.deepEqual({ x: onSmall?.params.x, y: onSmall?.params.y }, { x: 512, y: 192 });
  // a display not at the origin
  const second = inputCall({ kind: 'click', x: 640, y: 480 }, { pixelsPerPoint: 1.25, display: { x: 1024, y: -100 } });
  assert.deepEqual({ x: second?.params.x, y: second?.params.y }, { x: 1536, y: 284 });
});
