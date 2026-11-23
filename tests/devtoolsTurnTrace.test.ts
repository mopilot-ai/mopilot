// The turn trace in main (devtools/turnTrace.cjs, app/turnTraces.cjs): a trace begins with a turn's first browser call while the user has it on, follows the agent's tabs, records each action without typed text, is written at the turn's end (or removed when empty), kept per chat and listed for Replay.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TurnTraces, FrameFiles, argsOf, KEEP, MAX_ACTIONS } = require('../electron/capabilities/browser/devtools/turnTrace.cjs');
const { VideoRecorder } = require('../electron/capabilities/browser/devtools/videoRecorder.cjs');
const { createTurnTraces } = require('../electron/app/turnTraces.cjs');

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  dirs.push(d);
  return d;
};
const jpeg = (w = 64, h = 40) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeTab(id = 't1', chatId = 'c1') {
  const dbg = new EventEmitter();
  const tab: any = {
    id,
    chatId,
    url: 'https://a.example/',
    title: 'A',
    console: [] as any[],
    backend: { debugger: dbg },
    send: async (method: string) => (method === 'Runtime.evaluate' ? { result: { value: false } } : {}),
  };
  tab.frame = () => dbg.emit('message', {}, 'Page.screencastFrame', { data: jpeg().toString('base64'), sessionId: 1 }, '');
  tab.net = (method: string, p: any) => dbg.emit('message', {}, method, p, '');
  return tab;
}

function rig(o: { on?: boolean; root?: string | null } = {}) {
  const root = o.root === undefined ? tmp() : o.root;
  let clock = 1_700_000_000_000;
  const saved: any[] = [];
  const state = { on: o.on ?? true };
  const traces = new TurnTraces({
    enabled: () => state.on,
    root: (chatId: string) => (root ? path.join(root, chatId) : null),
    now: () => clock,
    onSaved: (chatId: string, s: any) => saved.push([chatId, s]),
  });
  const advance = (ms: number) => (clock += ms);
  return { traces, root, saved, state, advance };
}

test('a turn trace: frames as files, each action with its before and after frames, the HAR and the console, then trace.json', async () => {
  const { traces, root, saved, advance } = rig();
  const tab = fakeTab();
  const navigate = traces.wrap({
    name: 'browser_navigate',
    handler: async (args: any) => {
      await traces.touch(tab);
      advance(300);
      tab.frame();
      return `went to ${args.url}`;
    },
  });
  assert.equal(await navigate.handler({ url: 'https://a.example/x' }, { chatId: 'c1' }), 'went to https://a.example/x');
  advance(300);
  tab.frame();
  tab.net('Network.requestWillBeSent', {
    requestId: 'r1',
    timestamp: 1,
    wallTime: 1.7e9,
    request: { method: 'GET', url: 'https://a.example/api?token=s', headers: { Cookie: 'x' } },
  });
  tab.net('Network.loadingFinished', { requestId: 'r1', timestamp: 1.1 });
  const type = traces.wrap({
    name: 'browser_computer',
    handler: async () => {
      throw new Error('covered by a dialog\nmore detail');
    },
  });
  await assert.rejects(
    type.handler({ action: 'type', text: 'hunter2', ref: 'ref_1', list: [1, 2], o: { a: 1 }, n: 3 }, { chatId: 'c1' }),
    /covered/,
  );
  // a thrown value that is no Error is kept as its text
  const odd = traces.wrap({ name: 'browser_find', handler: async () => Promise.reject('plain refusal') });
  await assert.rejects(odd.handler({}, { chatId: 'c1' }));
  tab.console.push({ at: 1_700_000_000_400, level: 'error', text: 'boom' }, { at: 1, level: 'log', text: 'before the turn' });
  const summary = await traces.endTurn('c1');
  assert.deepEqual(saved, [['c1', summary]]);
  assert.equal(summary.frames, 2);
  assert.equal(summary.actions, 3);
  const [trace] = traces.list('c1');
  assert.equal(trace.dir, path.join(root as string, 'c1', trace.id));
  assert.deepEqual(
    trace.frames.map((f: any) => f.file),
    ['frames/00001.jpg', 'frames/00002.jpg'],
  );
  assert.ok(fs.existsSync(path.join(trace.dir, trace.frames[0].file)));
  assert.deepEqual(
    trace.actions.map((a: any) => [a.tool, a.ok, a.before, a.after, a.error]),
    [
      ['browser_navigate', true, 0, 1, null],
      ['browser_computer', false, 2, 2, 'covered by a dialog'],
      ['browser_find', false, 2, 2, 'plain refusal'],
    ],
  );
  // typed text is kept as its length only
  assert.deepEqual(trace.actions[1].args, { action: 'type', text: '<7 chars>', ref: 'ref_1', list: '[2]', o: '{…}', n: 3 });
  assert.ok(!JSON.stringify(trace).includes('hunter2'));
  assert.deepEqual(trace.console, [{ at: 1_700_000_000_400, level: 'error', text: 'boom' }]);
  assert.equal(trace.requests, 1);
  const har = JSON.parse(fs.readFileSync(path.join(trace.dir, 'network.har'), 'utf8'));
  assert.equal(har.log.entries[0].request.url, 'https://a.example/api?token=REDACTED');
  // the turn is over: nothing more is traced, and ending again does nothing
  assert.equal(await traces.endTurn('c1'), null);
});

test('nothing is traced while the user has it off, for a chat with no folder, or for tools that are not the browser’s', async () => {
  const off = rig({ on: false });
  await off.traces.touch(fakeTab());
  assert.equal(off.traces.chats.size, 0);
  const none = rig({ root: null });
  await none.traces.touch(fakeTab());
  assert.equal(none.traces.chats.size, 0);
  const tool = { name: 'update_task_list', handler: async () => 'ok' };
  assert.equal(rig().traces.wrap(tool), tool);
  // a browser tool called with no trace running (or no chat) just runs
  const { traces } = rig();
  const t = traces.wrap({ name: 'chrome_find', handler: async () => 'found' });
  assert.equal(await t.handler({}, {}), 'found');
  assert.equal(await t.handler({}, { chatId: 'c9' }), 'found');
});

test('an empty turn leaves no folder; a turn with steps but no frame keeps its steps; the newest KEEP traces stay', async () => {
  const { traces, root, advance } = rig();
  const tab = fakeTab();
  await traces.touch(tab);
  assert.equal(await traces.endTurn('c1'), null);
  assert.deepEqual(fs.readdirSync(path.join(root as string, 'c1')), []);
  for (let i = 0; i < KEEP + 2; i++) {
    advance(1000);
    const t = traces.wrap({ name: 'browser_find', handler: async () => (await traces.touch(tab), 'ok') });
    await t.handler({ query: 'q' }, { chatId: 'c1' });
    assert.equal((await traces.endTurn('c1')).frames, 0);
  }
  const list = traces.list('c1');
  assert.equal(list.length, KEEP);
  assert.ok(list[0].startedAt < list.at(-1).startedAt, 'oldest first');
  // a folder without its trace.json (still being written, or broken) is left out of the list
  fs.mkdirSync(path.join(root as string, 'c1', 'zzzz'));
  assert.equal(traces.list('c1').length, KEEP);
  assert.deepEqual(traces.list('nobody'), []);
  assert.deepEqual(rig({ root: null }).traces.list('c1'), []);
});

test('a trace follows the agent to another tab, caps its actions, and a failed save is noted', async () => {
  const { traces, root } = rig();
  const a = fakeTab('a');
  const b = fakeTab('b');
  await traces.touch(a);
  a.frame();
  await traces.touch(b);
  // the earlier tab's frames no longer count
  a.frame();
  b.frame();
  await tick();
  const t = traces.chats.get('c1');
  t.actions.length = MAX_ACTIONS;
  const call = traces.wrap({ name: 'browser_read_page', handler: async () => 'tree' });
  await call.handler({}, { chatId: 'c1' });
  assert.equal(t.dropped, 1);
  // the chat's folder went away under the trace: nothing is thrown
  fs.rmSync(path.join(root as string, 'c1'), { recursive: true, force: true });
  assert.equal(await traces.endTurn('c1'), null);
  // a touch that fails (the tab has no chat id to key it) is noted
  await traces.touch(null);
});

test('FrameFiles keeps JPEGs up to its cap; argsOf keeps no typed text', () => {
  const f = new FrameFiles(tmp(), 1);
  assert.equal(f.finish(), null);
  assert.equal(f.add(Buffer.from('not a jpeg'), 1), false);
  assert.equal(f.add(jpeg(10, 20), 1), true);
  assert.equal(f.add(jpeg(), 2), false, 'past the cap');
  assert.deepEqual(f.finish(), { frames: 1, width: 10, height: 20, bytes: jpeg().length });
  assert.deepEqual(argsOf(null), {});
  assert.deepEqual(argsOf('x'), {});
  assert.deepEqual(argsOf({ value: 'abc', url: 'u'.repeat(300) }).value, '<3 chars>');
  // what the agent searches for is its own text, kept for the step's line
  assert.equal(argsOf({ query: 'Add to cart' }).query, 'Add to cart');
  assert.equal([...argsOf({ url: 'u'.repeat(300) }).url].length, 200);
});

test('VideoRecorder takes a writer of its own and, following, moves to the chat’s other tab', async () => {
  const frames: any[] = [];
  const writer = { width: 0, bytes: 0, add: (j: Buffer, at: number) => (frames.push(at), true), finish: () => ({ frames: frames.length }) };
  const v = new VideoRecorder({ follow: true, gapMs: 0 });
  const a = fakeTab('a');
  const b = fakeTab('b');
  await v.start('c1', a, '', writer);
  a.frame();
  await v.touch(b);
  a.frame();
  b.frame();
  assert.equal(frames.length, 2);
  assert.deepEqual(v.stop('c1').saved, { frames: 2 });
  // a tab of another chat is not followed
  await v.touch(fakeTab('z', 'c2'));
  assert.equal(v.chats.size, 0);
});

test('createTurnTraces: on only with the flag and the setting, saving under the chat folder, ending with each turn and listing over IPC', async () => {
  const dir = tmp();
  const handlers: Record<string, any> = {};
  const ends: ((id: string) => void)[] = [];
  const sent: any[] = [];
  const flags: Record<string, boolean> = { 'shared.browser.turnTrace': true };
  let prefs: any = { browserTurnTrace: true };
  const local: any = {};
  const traces = createTurnTraces({
    ipcMain: { handle: (ch: string, fn: any) => (handlers[ch] = fn) },
    hostTabs: { local, onTurnEnd: (fn: any) => ends.push(fn) },
    dir,
    isFlagEnabled: (k: string) => !!flags[k],
    readState: () => {
      if (prefs === 'throw') throw new Error('bad state file');
      return { prefs };
    },
    browserGrants: { riskOf: () => ({ level: 'normal' }) },
    broadcastAll: (ch: string, p: any) => sent.push([ch, p]),
  });
  assert.equal(local.traces, traces);
  assert.equal(traces.o.enabled(), true);
  prefs = { browserTurnTrace: false };
  assert.equal(traces.o.enabled(), false);
  prefs = 'throw';
  assert.equal(traces.o.enabled(), false);
  prefs = {};
  assert.equal(traces.o.enabled(), false);
  prefs = { browserTurnTrace: true };
  flags['shared.browser.turnTrace'] = false;
  assert.equal(traces.o.enabled(), false);
  flags['shared.browser.turnTrace'] = true;
  // one turn with a step, ended through the turn-end listener
  const tab = fakeTab();
  const t = traces.wrap({ name: 'browser_find', handler: async () => (await traces.touch(tab), 'ok') });
  await t.handler({}, { chatId: 'c1' });
  // a frame is checked against the site's risk (browserGrants) before it is kept
  tab.frame();
  for (const fn of ends) fn('c1');
  await tick();
  assert.equal(sent[0][0], 'browser:traceSaved');
  assert.equal(sent[0][1].chatId, 'c1');
  const listed = handlers['browser:turnTraces']({}, 'c1');
  assert.equal(listed.length, 1);
  assert.ok(listed[0].dir.startsWith(path.join(dir, 'browser-traces', 'c1')));
  assert.deepEqual(handlers['browser:turnTraces']({}, ''), []);
  assert.deepEqual(handlers['browser:turnTraces']({}, 42), []);
  // frames are files of their own: none is re-encoded
  assert.equal(traces.video.images, null);
  // the registry the browser tools register on records them; anything else passes through
  const registered: any[] = [];
  const registry = traces.recording({ register: (tool: any) => (registered.push(tool), () => undefined), size: 3 });
  const plain = { name: 'browser_find', handler: async () => 'x' };
  registry.register(plain);
  assert.notEqual(registered[0], plain);
  assert.equal(registered[0].name, 'browser_find');
  assert.equal(registry.size, 3);
});

test('a call begins the turn’s trace itself (a navigation passes no page gate first); steps that never reached a tab keep no HAR', async () => {
  const { traces } = rig();
  const tab = fakeTab();
  const navigate = traces.wrap({ name: 'browser_navigate', handler: async () => 'went' });
  const find = traces.wrap({ name: 'browser_find', handler: async () => (await traces.touch(tab), 'found') });
  await navigate.handler({ url: 'https://a.example/' }, { chatId: 'c1' });
  await find.handler({ query: 'Add to cart' }, { chatId: 'c1' });
  await traces.endTurn('c1');
  const [trace] = traces.list('c1');
  assert.deepEqual(
    trace.actions.map((a: any) => a.tool),
    ['browser_navigate', 'browser_find'],
  );
  assert.equal(trace.actions[1].args.query, 'Add to cart');
  // a turn whose only call was refused before it reached a tab: its step, no HAR
  await navigate.handler({ url: 'https://b.example/' }, { chatId: 'c2' });
  await traces.endTurn('c2');
  const [only] = traces.list('c2');
  assert.equal(only.actions.length, 1);
  assert.equal(only.har, null);
  assert.equal(only.requests, 0);
});
