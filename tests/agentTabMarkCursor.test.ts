// The agent's marks on its tabs in the user's Chrome (0.3.3 PR 4), main's side: AgentCursor carrying the chat's turn to the tabs it
// holds (status), the turn end's mark (clear), Review reaching onReview, and the app's wiring (the session patch, Review opening the
// chat). The page's side is in agentTabMark.test.ts.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MARK_SOURCE } = require('../electron/capabilities/browser/agentTabMark.cjs');
const { AgentCursor } = require('../electron/capabilities/browser/agentCursor.cjs');
const { STOP_BINDING } = require('../electron/capabilities/browser/agentControlFrame.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

/* ---------- main: AgentCursor ---------- */

function fakeTab(chatId = 'chat-1') {
  let ctx = 0;
  const calls: any[] = [];
  const dbg: any = new EventEmitter();
  Object.assign(dbg, { isAttached: () => true, sendCommand: async () => ({}) });
  const tab: any = {
    calls,
    chatId,
    wc: { isDestroyed: () => false, debugger: dbg },
    get backend() {
      return this.wc;
    },
    async send(method: string, params: any = {}) {
      calls.push([method, params]);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: ++ctx };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
  };
  return { tab, dbg };
}
const exprs = (tab: any) =>
  tab.calls
    .filter((c: any) => c[0] === 'Runtime.evaluate' && c[1].expression.startsWith('globalThis.__mopilotCursor.'))
    .map((c: any) => c[1].expression.slice('globalThis.__mopilotCursor.'.length));

test('AgentCursor.status: the chat tabs it holds follow its turn; other chats and tabs not held hear nothing; the overlay carries the mark', async () => {
  const cursor = new AgentCursor({ frame: true });
  const a = fakeTab('c1').tab;
  const b = fakeTab('c2').tab;
  const idle = fakeTab('c1').tab;
  await cursor.hold(a);
  await cursor.hold(b);
  const inject = a.calls.find((c: any) => c[0] === 'Runtime.evaluate' && c[1].expression.includes(MARK_SOURCE));
  assert.ok(inject, 'the mark script goes in with the frame');
  await cursor.status('c1', 'waiting');
  assert.deepEqual(exprs(a), ['show({"frame":true})', 'status("waiting")']);
  assert.deepEqual(exprs(b), ['show({"frame":true})']);
  assert.deepEqual(exprs(idle), []);
  // a page loaded while it waits starts waiting
  await cursor.mark(a);
  assert.equal(exprs(a).at(-1), 'show({"frame":true,"status":"waiting"})');
  await cursor.status('c1', 'running');
  assert.equal(exprs(a).at(-1), 'status("running")');
  await cursor.mark(a);
  assert.equal(exprs(a).at(-1), 'show({"frame":true})');
  // done: nothing to send (the turn end clears), and the next turn starts working
  await cursor.status('c1', 'waiting');
  const n = exprs(a).length;
  await cursor.status('c1', 'done');
  assert.equal(exprs(a).length, n);
  assert.equal(cursor.waiting.has('c1'), false);
  assert.equal(cursor.holding.has(a), false, 'the chat tabs are let go');
  assert.equal(cursor.holding.has(b), true, 'another chat keeps its own');
  await cursor.hold(a);
  cursor.held.delete(a);
  await cursor.hold(a);
  // the turn end leaves the tab's mark; a tab never drawn on has nothing to clear
  assert.equal(await cursor.clear(a, 'deliverable'), true);
  assert.equal(exprs(a).at(-1), 'clear("deliverable")');
  assert.equal(cursor.holding.has(a), false);
  await cursor.status('c1', 'waiting');
  assert.equal(exprs(a).at(-1), 'clear("deliverable")', 'not held any more');
  assert.equal(await cursor.clear(idle, 'handoff'), false);
  // without the frame (the in-app browser), the turn changes nothing
  const plain = new AgentCursor();
  await plain.status('c1', 'waiting');
  assert.equal(plain.waiting.size, 0);
  // a draw that failed lets go of the tab
  const slow = fakeTab('c3').tab;
  slow.send = async (m: string) => (m === 'Page.getFrameTree' ? Promise.reject(new Error('busy')) : {});
  assert.equal(await cursor.hold(slow), null);
  assert.equal(cursor.holding.has(slow), false);
  // an action holds the tab too
  const acted = fakeTab('c4').tab;
  await cursor.act(acted, { kind: 'click', x: 1, y: 1 });
  assert.equal(cursor.holding.has(acted), true);
});

test('AgentCursor: Review on the page opens the chat (onReview), Stop still stops it; a failing Review is noted', async () => {
  const reviewed: string[] = [];
  const stopped: string[] = [];
  const cursor = new AgentCursor({
    frame: true,
    onReview: (t: any) => reviewed.push(t.chatId),
    onStop: (t: any) => stopped.push(t.chatId),
  });
  const { tab, dbg } = fakeTab('c7');
  await cursor.hold(tab);
  dbg.emit('message', {}, 'Runtime.bindingCalled', { name: STOP_BINDING, payload: 'review' });
  dbg.emit('message', {}, 'Runtime.bindingCalled', { name: STOP_BINDING, payload: 'stop' });
  assert.deepEqual(reviewed, ['c7']);
  assert.deepEqual(stopped, ['c7']);
  const failing = new AgentCursor({
    frame: true,
    onReview: () => {
      throw new Error('no window');
    },
  });
  const other = fakeTab('c8');
  await failing.hold(other.tab);
  other.dbg.emit('message', {}, 'Runtime.bindingCalled', { name: STOP_BINDING, payload: 'review' });
  assert.ok(recentIgnored().some((e: any) => /open a chat from the page/.test(JSON.stringify(e))));
  new AgentCursor({ frame: true }).onReview(tab);
});

/* ---------- the app ---------- */

test('setupChromeRelay: a session patch reaches the cursor; Review opens the chat in MoPilot', async () => {
  const appRelay = require('../electron/app/chromeRelay.cjs');
  const opened: string[] = [];
  const base = {
    registry: { register: () => () => undefined },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => true,
  };
  const r = appRelay.setupChromeRelay({ ...base, openChat: (id: string) => opened.push(id) });
  const cursor = r.tabs.o.cursor;
  const status = mock.method(cursor, 'status');
  r.onSessionPatch({ chatId: 'c1', patch: { turn: 'awaitingUser' } });
  r.onSessionPatch({ chatId: 'c1', patch: { turn: 'idle' } });
  r.onSessionPatch({ chatId: 'c1', patch: { title: 'x' } });
  assert.deepEqual(
    status.mock.calls.map((c: any) => c.arguments),
    [
      ['c1', 'waiting'],
      ['c1', 'done'],
    ],
  );
  cursor.onReview({ chatId: 'c1' });
  assert.deepEqual(opened, ['c1']);
  r.stop();
  // no opener given: Review does nothing
  const quiet = appRelay.setupChromeRelay(base);
  quiet.tabs.o.cursor.onReview({ chatId: 'c1' });
  quiet.stop();
});

test('letGo: the tab the agent finished on is left as deliverable, a tab with its own mark keeps it, a closed tab is not the last', async () => {
  const { letGo } = require('../electron/capabilities/browser/hostTabState.cjs');
  const cleared: any[] = [];
  const cursor = { clear: (t: any, final: any) => cleared.push([t.id, final]) };
  const tab = (id: string, used: number, o: any = {}) => ({
    id,
    used,
    wc: { isDestroyed: () => true },
    get backend() {
      return this.wc;
    },
    ...o,
  });
  await letGo(cursor, [tab('a', 1), tab('b', 3), tab('gone', 9, { closed: true }), tab('h', 2, { mark: 'handoff', markTurn: 4 })], 4);
  assert.deepEqual(cleared, [
    ['a', null],
    ['b', 'deliverable'],
    ['gone', null],
    ['h', 'handoff'],
  ]);
  // no cursor (a host without one), no tabs
  await letGo(null, [tab('a', 1)], 0);
  await letGo(cursor, [], 0);
});
