// bench/lib/chromePipe.mjs: the DevTools pipe client and loading MoPilot's extension into the bench's Chrome on
// every start, checked by its service worker running (#1561).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  autoPair,
  loadExtension,
  MOPILOT_EXTENSION_ID,
  PIPE_ARGS,
  PIPE_STDIO,
  pipeClient,
  pipeLaunch,
  runningOn,
  startOutcome,
  userDataDirOf,
  waitExtensionOn,
} from '../bench/lib/chromePipe.mjs';

const { hostPairUrl } = createRequire(import.meta.url)('../electron/capabilities/browser/chromeExtensionTransport.cjs');

/** A fake Chrome on the pipe: `answer(msg)` returns the reply object for each command, or null to stay silent. */
function fakeChrome(answer: (m: any) => any) {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const sent: any[] = [];
  let rest = '';
  toChrome.on('data', (d) => {
    const parts = (rest + String(d)).split('\0');
    rest = parts.pop() ?? '';
    for (const line of parts) {
      const m = JSON.parse(line);
      sent.push(m);
      const r = answer(m);
      if (r) fromChrome.write(`${JSON.stringify({ id: m.id, ...r })}\0`);
    }
  });
  return { toChrome, fromChrome, sent };
}

test('the pipe switches and stdio: Chrome reads fd 3, writes fd 4, and may load unpacked extensions', () => {
  assert.deepEqual(PIPE_ARGS, ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging']);
  assert.deepEqual([...PIPE_STDIO], ['inherit', 'inherit', 'inherit', 'pipe', 'pipe']);
  assert.equal(MOPILOT_EXTENSION_ID, 'jhnfobeoiefjfneilcdkljfnapchmoej');
});

test('pipeClient: NUL-framed JSON, results by id, protocol errors, messages split across chunks, and junk lines', async () => {
  const f = fakeChrome((m) =>
    m.method === 'Bad.call'
      ? { error: { message: 'no such method' } }
      : m.method === 'Raw.error'
        ? { error: 42 }
        : { result: { echo: m.params } },
  );
  const c = pipeClient(f.toChrome, f.fromChrome);
  assert.deepEqual(await c.send('Target.getTargets'), { echo: {} });
  assert.deepEqual(await c.send('X.y', { a: 1 }), { echo: { a: 1 } });
  await assert.rejects(c.send('Bad.call'), /Bad\.call: no such method/);
  await assert.rejects(c.send('Raw.error'), /Raw\.error: 42/);
  assert.deepEqual(
    f.sent.map((m) => m.id),
    [1, 2, 3, 4],
  );

  // a reply cut in two, junk, an unknown id and a reply without a result
  const g = { toChrome: new PassThrough(), fromChrome: new PassThrough() };
  const d = pipeClient(g.toChrome, g.fromChrome);
  const p = d.send('A.b');
  const q = d.send('C.d');
  g.fromChrome.write('not json\0{"id":99,"result":{}}\0{"id":1,"res');
  g.fromChrome.write('ult":{"ok":true}}\0{"id":2}\0');
  assert.deepEqual(await p, { ok: true });
  assert.deepEqual(await q, {});
});

test('pipeClient: a command without an answer times out; a closed pipe or a failed write fails what waits', async () => {
  const silent = fakeChrome(() => null);
  const c = pipeClient(silent.toChrome, silent.fromChrome, { timeoutMs: 20 });
  await assert.rejects(c.send('Slow.call'), /Slow\.call: no answer in 20 ms/);

  const closing = fakeChrome(() => null);
  const d = pipeClient(closing.toChrome, closing.fromChrome);
  const waits = [d.send('A.a'), d.send('B.b')];
  closing.fromChrome.emit('close');
  await assert.rejects(waits[0], /A\.a: Chrome closed the pipe/);
  await assert.rejects(waits[1], /B\.b: Chrome closed the pipe/);

  const broken = fakeChrome(() => null);
  const e = pipeClient(broken.toChrome, broken.fromChrome);
  const w = e.send('C.c');
  broken.toChrome.emit('error', new Error('write EPIPE'));
  await assert.rejects(w, /C\.c: write EPIPE/);

  // a writer without events (a plain object) is fine
  const plain = { write: () => true };
  const from = new PassThrough();
  const h = pipeClient(plain, from);
  const x = h.send('D.d');
  from.write('{"id":1,"result":{"v":1}}\0');
  assert.deepEqual(await x, { v: 1 });
});

/** A clock the sleeps advance. */
const clock = () => {
  let t = 1000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};
const sw = (id: string) => ({ type: 'service_worker', url: `chrome-extension://${id}/background.mjs` });

test('loadExtension: loads the folder, then waits for the extension’s service worker to run', async () => {
  let polls = 0;
  const f = fakeChrome((m) => {
    if (m.method === 'Extensions.uninstall') return { error: { message: 'Uninstall failed. No extension with the given id' } };
    if (m.method === 'Extensions.loadUnpacked') return { result: { id: MOPILOT_EXTENSION_ID } };
    polls++;
    // other targets first; the worker shows on the third poll
    return { result: { targetInfos: polls < 3 ? [{ type: 'page', url: 'about:blank' }, sw('other')] : [sw(MOPILOT_EXTENSION_ID)] } };
  });
  const c = clock();
  const r = await loadExtension(pipeClient(f.toChrome, f.fromChrome), '/ext', { ...c, pollMs: 100 });
  assert.deepEqual(r, { id: MOPILOT_EXTENSION_ID, ms: 200 });
  // the profile's earlier load goes first, so its service worker can't keep running old files (#1642)
  assert.deepEqual(f.sent[0], { id: 1, method: 'Extensions.uninstall', params: { id: MOPILOT_EXTENSION_ID } });
  assert.deepEqual(f.sent[1], { id: 2, method: 'Extensions.loadUnpacked', params: { path: '/ext' } });
  assert.equal(polls, 3);
});

test('loadExtension: another extension’s id, a worker that never starts, a refusal and a reply without targets fail loudly', async () => {
  const other = fakeChrome(() => ({ result: { id: 'abcdefabcdefabcdefabcdefabcdefab' } }));
  await assert.rejects(
    loadExtension(pipeClient(other.toChrome, other.fromChrome), '/wrong'),
    /\/wrong loaded as abcdefabcdefabcdefabcdefabcdefab, not MoPilot's extension jhnfobeoiefjfneilcdkljfnapchmoej/,
  );

  const idle = fakeChrome((m) => (m.method === 'Extensions.loadUnpacked' ? { result: { id: 'x' } } : { result: {} }));
  const c = clock();
  await assert.rejects(
    loadExtension(pipeClient(idle.toChrome, idle.fromChrome), '/ext', { id: 'x', waitMs: 1000, pollMs: 300, ...c }),
    /extension x loaded, but its service worker did not start in 1000 ms/,
  );
  assert.equal(c.now(), 2200, 'it polled until the wait was over');

  const refused = fakeChrome(() => ({ error: { message: 'Method not available.' } }));
  await assert.rejects(
    loadExtension(pipeClient(refused.toChrome, refused.fromChrome), '/ext'),
    /Extensions\.loadUnpacked: Method not available\./,
  );
});

test('loadExtension: the default sleep and clock wait for real', async () => {
  let polls = 0;
  const f = fakeChrome((m) => {
    if (m.method === 'Extensions.uninstall') return { result: {} };
    if (m.method === 'Extensions.loadUnpacked') return { result: { id: MOPILOT_EXTENSION_ID } };
    return { result: { targetInfos: ++polls > 1 ? [sw(MOPILOT_EXTENSION_ID)] : [] } };
  });
  const r = await loadExtension(pipeClient(f.toChrome, f.fromChrome), '/ext', { pollMs: 5 });
  assert.equal(r.id, MOPILOT_EXTENSION_ID);
  assert.ok(r.ms >= 0);
});

test('pipeClient: events go to their listeners with their session; a command can name a flat session', async () => {
  const f = fakeChrome((m) => ({ result: { session: m.sessionId ?? null } }));
  const c = pipeClient(f.toChrome, f.fromChrome);
  const heard: any[] = [];
  c.on('Target.targetCreated', (p: any, sid?: string) => heard.push(['a', p, sid]));
  c.on('Target.targetCreated', (p: any) => heard.push(['b', p]));
  c.on('Other.event', () => heard.push(['other']));
  f.fromChrome.write(
    '{"method":"Target.targetCreated","params":{"x":1},"sessionId":"S"}\0{"method":"Target.targetCreated"}\0{"method":"Nobody.listens"}\0',
  );
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(heard, [
    ['a', { x: 1 }, 'S'],
    ['b', { x: 1 }],
    ['a', {}, undefined],
    ['b', {}],
  ]);
  assert.deepEqual(await c.send('Runtime.evaluate', {}, 'S1'), { session: 'S1' });
  assert.deepEqual(await c.send('Runtime.evaluate'), { session: null });
  assert.equal(f.sent[0].sessionId, 'S1');
  assert.equal('sessionId' in f.sent[1], false);
});

test('runningOn: a SingletonLock naming a live process; none, a dead one, a malformed one or another user’s', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'running-on-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(runningOn(dir), false, 'no lock');
  fs.symlinkSync(`host-${process.pid}`, path.join(dir, 'SingletonLock'));
  assert.equal(runningOn(dir), true, 'this process is alive');
  assert.equal(
    runningOn(dir, { readlink: () => 'Manageds-Virtual-Machine.local-58066', alive: () => false }),
    false,
    'a lock left by a restart',
  );
  assert.equal(runningOn(dir, { readlink: () => 'no-pid-here', alive: () => true }), false);
  assert.equal(runningOn(dir, { readlink: () => 'host-0', alive: () => true }), false);
  // the real liveness check: pid 1 belongs to root (EPERM, alive); a pid past the limit is gone
  assert.equal(runningOn(dir, { readlink: () => 'host-1' }), true);
  assert.equal(runningOn(dir, { readlink: () => 'host-99999999' }), false);
});

test('pipeLaunch: switches with the pipe’s and a blank page; the pages it was asked for open later', () => {
  assert.deepEqual(pipeLaunch(['--user-data-dir=/p', 'chrome-extension://x/options.html#pair=c', '--no-first-run', 'http://a/']), {
    args: ['--user-data-dir=/p', '--no-first-run', ...PIPE_ARGS, 'about:blank'],
    urls: ['chrome-extension://x/options.html#pair=c', 'http://a/'],
  });
  assert.deepEqual(pipeLaunch(['--user-data-dir=/p']), { args: ['--user-data-dir=/p', ...PIPE_ARGS, 'about:blank'], urls: [] });
  assert.equal(userDataDirOf(['--x', '--user-data-dir=/w/p', 'u']), '/w/p');
  assert.equal(userDataDirOf(['--user-data-dir=']), null);
  assert.equal(userDataDirOf([]), null);
});

/** A pipe client double for autoPair: answers by method, records calls, and lets the test emit events. */
function pairDouble(answer: (method: string, params: any, sid?: string) => any) {
  const calls: any[] = [];
  const listeners = new Map<string, ((p: any) => void)[]>();
  return {
    calls,
    emit: (method: string, params: any) => (listeners.get(method) ?? []).forEach((f) => f(params)),
    client: {
      send: async (method: string, params: any = {}, sid?: string) => {
        calls.push([method, sid ?? null]);
        return answer(method, params, sid);
      },
      on: (method: string, f: (p: any) => void) => void listeners.set(method, [...(listeners.get(method) ?? []), f]),
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test('autoPair: presses Pair once per claim code on MoPilot’s pairing page, waiting for the code to show', async () => {
  let looks = 0;
  const d = pairDouble((method) =>
    method === 'Target.attachToTarget'
      ? { sessionId: 'S1' }
      : method === 'Runtime.evaluate'
        ? { result: { value: ++looks > 2 ? 'pressed' : 'waiting' } }
        : {},
  );
  const said: string[] = [];
  await autoPair(d.client as any, { report: (w) => said.push(w), sleep: async () => {} });
  assert.deepEqual(d.calls, [['Target.setDiscoverTargets', null]]);
  const page = `chrome-extension://${MOPILOT_EXTENSION_ID}/options.html`;
  // Only manual claim pages belong to this helper; native host pages run their own reconnect flow.
  for (const [i, url] of [hostPairUrl(), `${page}#pair=%68ost`, `${page}#x=1&pair=host`].entries()) {
    const native = { targetId: `native-${i}`, type: 'page', url };
    d.emit('Target.targetCreated', { targetInfo: native });
    d.emit('Target.targetInfoChanged', { targetInfo: native });
    d.emit('Target.targetInfoChanged', { targetInfo: { ...native, url: page } });
  }
  // Unrelated pages and workers do not offer a claim either.
  d.emit('Target.targetCreated', { targetInfo: { targetId: 'A', type: 'page', url: 'http://x/#pair=1' } });
  d.emit('Target.targetCreated', { targetInfo: { targetId: 'B', type: 'page', url: page } });
  d.emit('Target.targetCreated', { targetInfo: { targetId: 'C', type: 'service_worker', url: `${page}#pair=1` } });
  d.emit('Target.targetInfoChanged', { targetInfo: { targetId: 'D', type: 'page', url: 'chrome-extension://other/options.html#pair=1' } });
  await settle();
  assert.equal(d.calls.length, 1);
  d.emit('Target.targetCreated', { targetInfo: { targetId: 'P', type: 'page', url: `${page}#pair=claim-1` } });
  // the same claim again (the page changing): pressed once
  d.emit('Target.targetInfoChanged', { targetInfo: { targetId: 'P', type: 'page', url: `${page}#x=1&pair=claim-1` } });
  await settle();
  assert.deepEqual(d.calls.slice(1), [
    ['Target.attachToTarget', null],
    ['Runtime.evaluate', 'S1'],
    ['Runtime.evaluate', 'S1'],
    ['Runtime.evaluate', 'S1'],
  ]);
  assert.deepEqual(said, ["pressed Pair on MoPilot's pairing page (P)"]);
});

test('autoPair: a page that never shows its code, and an attach that fails, are reported', async () => {
  const quiet = pairDouble((method) =>
    method === 'Target.attachToTarget' ? { sessionId: 'S' } : method === 'Runtime.evaluate' ? { result: {} } : {},
  );
  const said: string[] = [];
  await autoPair(quiet.client as any, { id: 'x', report: (w) => said.push(w), tries: 3, sleep: async () => {} });
  quiet.emit('Target.targetCreated', { targetInfo: { targetId: 'P', type: 'page', url: 'chrome-extension://x/options.html#pair=c' } });
  await settle();
  assert.equal(quiet.calls.filter(([m]) => m === 'Runtime.evaluate').length, 3);

  const broken = pairDouble((method) => {
    if (method === 'Target.attachToTarget') throw new Error('No target with given id found');
    return {};
  });
  await autoPair(broken.client as any, { id: 'x', report: (w) => said.push(w) });
  broken.emit('Target.targetCreated', { targetInfo: { targetId: 'Q', type: 'page', url: 'chrome-extension://x/options.html#pair=d' } });
  await settle();
  assert.deepEqual(said, ['the pairing page never showed its code (P)', 'could not press Pair (Q): No target with given id found']);

  // the defaults: no report, real sleeps
  let n = 0;
  const real = pairDouble((method) =>
    method === 'Target.attachToTarget'
      ? { sessionId: 'S' }
      : method === 'Runtime.evaluate'
        ? { result: { value: ++n > 1 ? 'pressed' : 'waiting' } }
        : {},
  );
  await autoPair(real.client as any);
  real.emit('Target.targetCreated', {
    targetInfo: { targetId: 'R', type: 'page', url: `chrome-extension://${MOPILOT_EXTENSION_ID}/options.html#pair=e` },
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(n, 2);
});

test('waitExtensionOn: waits until the profile reads on; says what it read when time runs out', async () => {
  const states = ['missing', null, 'on'];
  let i = 0;
  const c = clock();
  assert.equal(await waitExtensionOn(() => states[i++], { ...c, pollMs: 1000 }), 2000);
  const d = clock();
  await assert.rejects(
    waitExtensionOn(() => 'off', { ...d, waitMs: 3000 }),
    /does not show MoPilot's extension on after 3000 ms \(it reads off\)/,
  );
  await assert.rejects(
    waitExtensionOn(() => null, { ...clock(), waitMs: 0 }),
    /\(it reads nothing\)/,
  );
  assert.equal(await waitExtensionOn(() => 'on', clock()), 0);
  // the default sleep
  const seq = ['missing', 'on'];
  assert.ok((await waitExtensionOn(() => seq.shift() ?? 'on', { pollMs: 5 })) >= 0);
});

test('startOutcome: what a start appended to the profile’s log: runs, handed over, failed, or nothing yet', () => {
  assert.equal(startOutcome(''), null);
  assert.equal(startOutcome('2026 something else\n'), null);
  const t = '2026-10-19T05:44:59.932Z';
  assert.deepEqual(startOutcome(`${t} MoPilot's extension jhnf runs (335 ms after loading)\n`), {
    outcome: 'runs',
    line: `${t} MoPilot's extension jhnf runs (335 ms after loading)`,
  });
  assert.equal(startOutcome(`${t} a Chrome already runs on this profile: handing the start over to it\n`)?.outcome, 'handed');
  assert.equal(
    startOutcome(`x\n${t} /e loaded as y, not MoPilot's extension z. Quitting this Chrome: browser use needs the extension.\n`)?.outcome,
    'failed',
  );
});

test('windowless cold pre-launch requests no startup page while preserving delayed URLs', () => {
  const switches = ['--user-data-dir=/bench/profile', '--no-startup-window'];
  assert.deepEqual(pipeLaunch(switches), { args: [...switches, ...PIPE_ARGS], urls: [] });
  assert.deepEqual(pipeLaunch([...switches, 'http://fixture.localhost/']), {
    args: [...switches, ...PIPE_ARGS],
    urls: ['http://fixture.localhost/'],
  });
});
