// electron/session/orchestration/childUsage.cjs and its wiring (app/orchestration.cjs): main times each turn it sends a
// linked session and adds it to the session's record when the turn ends however it ended (a restart drops a turn it
// never saw end), and a turn's edits outside the session's declared paths are named in its note and kept for its card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orchestration } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { turnBegan, settleTurn, OUTSIDE_KEPT, OUTSIDE_NAMED } = require('../electron/session/orchestration/childUsage.cjs');
const { OrchestrationJournal } = require('../electron/session/orchestration/journal.cjs');
const { createOrchestration, orchestrationView } = require('../electron/app/orchestration.cjs');

/** A parent with the child `kid` in /repo; `edits` is what the child's harness reported since the last take. */
function linked(rec: any = {}) {
  const h = orchestration();
  let now = 1000;
  h.orch.o.now = () => now;
  const edits: string[][] = [];
  (h.controller as any).editedPaths = { take: (id: string) => (id === 'kid' ? (edits.shift() ?? []) : []) };
  h.journal.change((d: any) => {
    d.children.kid = {
      parentId: 'top',
      name: 'kid',
      title: 'Kid',
      cwd: '/repo',
      useWorktree: false,
      createdAt: 1,
      driven: [],
      lastReport: null,
      ...rec,
    };
    d.parents.top = { wakes: 0, held: false, cutShort: false, notes: [] };
  });
  h.records.set('kid', { meta: {} });
  return {
    ...h,
    edits,
    at: (t: number) => (now = t),
    worked: () => h.journal.child('kid').worked,
    notes: () => h.journal.parent('top').notes,
  };
}

test('a turn sent to a linked session is stamped; a steer, another chat or an unusable journal is not', () => {
  const h = linked();
  turnBegan(h.orch, { chatId: 'kid', kind: 'steer' });
  turnBegan(h.orch, { chatId: 'top', kind: 'turn' });
  assert.equal(h.worked(), undefined);
  assert.equal(h.journal.child('top'), null);
  h.at(2000);
  turnBegan(h.orch, { chatId: 'kid', kind: 'turn' });
  assert.deepEqual(h.worked(), { ms: 0, turns: 0, since: 2000 });
  // a start that never went out left its stamp: the next one replaces it
  h.at(5000);
  turnBegan(h.orch, { chatId: 'kid', kind: 'turn' });
  assert.deepEqual(h.worked(), { ms: 0, turns: 0, since: 5000 });
  h.journal.startupError = 'journal_unavailable';
  h.at(9000);
  turnBegan(h.orch, { chatId: 'kid', kind: 'turn' });
  h.journal.startupError = null;
  assert.equal(h.worked().since, 5000);
});

test('working time adds up across turns that finished, were stopped, failed or lost their harness', () => {
  const h = linked();
  const turn = (start: number, end: number, ending: () => void) => {
    h.at(start);
    turnBegan(h.orch, { chatId: 'kid', kind: 'turn' });
    h.at(end);
    ending();
  };
  turn(1000, 61_000, () => h.orch.finished({ chatId: 'kid', inputToken: 'x', text: 'done', completed: true }));
  assert.deepEqual(h.worked(), { ms: 60_000, turns: 1, since: null });
  h.states.set('kid', { turn: 'running' });
  turn(100_000, 112_000, () => {
    h.orch.stopped('kid');
    h.orch.finished({ chatId: 'kid', inputToken: 'x', text: null, completed: false });
  });
  turn(200_000, 205_000, () => h.orch.finished({ chatId: 'kid', inputToken: 'x', text: null, completed: false }));
  turn(300_000, 330_000, () => h.orch.crashed('kid'));
  assert.deepEqual(h.worked(), { ms: 107_000, turns: 4, since: null });
  const endings = h.notes().map((n: any) => n.body);
  assert.match(endings[0], /finished a turn/);
  assert.match(endings[1], /was stopped/);
  assert.match(endings[2], /ended its turn with an error/);
  assert.match(endings[3], /did not finish its turn/);
  // a turn its harness began on its own was never stamped: its end adds nothing; a clock that went back adds nothing
  h.orch.finished({ chatId: 'kid', inputToken: 'x', text: null, completed: true });
  assert.deepEqual(h.worked(), { ms: 107_000, turns: 4, since: null });
  turn(500_000, 400_000, () => h.orch.finished({ chatId: 'kid', inputToken: 'x', text: null, completed: true }));
  assert.deepEqual(h.worked(), { ms: 107_000, turns: 5, since: null });
});

test('after a restart a turn that ran when the app quit is not counted; the time before it is kept', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'orchestration.json');
  const first = new OrchestrationJournal({ file });
  first.change((d: any) => {
    d.children.kid = {
      parentId: 'top',
      name: 'kid',
      title: 'K',
      createdAt: 1,
      driven: [],
      lastReport: null,
      worked: { ms: 42_000, turns: 3, since: 900 },
    };
    d.children.other = { parentId: 'top', name: 'o', title: 'O', createdAt: 1, driven: [], lastReport: null };
  });
  const again = new OrchestrationJournal({ file });
  assert.deepEqual(again.child('kid').worked, { ms: 42_000, turns: 3, since: null });
  assert.equal(again.child('other').worked, undefined);
  const h = orchestration({ journal: again });
  (h.controller as any).editedPaths = { take: () => [] };
  h.records.set('kid', { meta: {} });
  h.orch.finished({ chatId: 'kid', inputToken: 'x', text: 'late', completed: true });
  assert.deepEqual(h.journal.child('kid').worked, { ms: 42_000, turns: 3, since: null });
});

test('edits outside the declared paths are named in the turn’s note and kept on the record for its card', () => {
  const h = linked({ paths: ['src/api/**', 'docs'] });
  h.edits.push(['/repo/src/api/a.ts', '/repo/src/web/b.ts', '/tmp/c.ts', '/repo/docs/x.md']);
  h.orch.finished({ chatId: 'kid', inputToken: 'x', text: 'done', completed: true });
  assert.match(
    h.notes()[0].body,
    / Edited outside its declared paths \(src\/api\/\*\*, docs\): src\/web\/b\.ts, \/tmp\/c\.ts\. Check those files before you rely on them\.$/,
  );
  assert.deepEqual(h.journal.child('kid').outside, ['src/web/b.ts', '/tmp/c.ts']);
  // a turn that kept to them adds nothing, and the record keeps the earlier ones
  h.edits.push(['/repo/src/api/z.ts']);
  h.orch.finished({ chatId: 'kid', inputToken: 'x', text: 'again', completed: true });
  assert.doesNotMatch(h.notes()[1].body, /Edited outside/);
  assert.deepEqual(h.journal.child('kid').outside, ['src/web/b.ts', '/tmp/c.ts']);
  // a lost turn's edits count too; a name with a line break is made inert; many are counted after the first few
  const many = Array.from({ length: OUTSIDE_KEPT + 5 }, (_, i) => `/repo/lib/f${i}.ts`);
  h.edits.push(['/repo/src/web/b.ts', '/repo/odd\nname.ts', ...many]);
  h.orch.crashed('kid');
  const body = h.notes()[2].body;
  assert.match(body, /src\/web\/b\.ts, odd ⏎ name\.ts, lib\/f0\.ts/);
  assert.match(body, new RegExp(`and ${OUTSIDE_KEPT + 7 - OUTSIDE_NAMED} more\\.`));
  assert.equal(h.journal.child('kid').outside.length, OUTSIDE_KEPT);
  // the newest first, so a full list still shows the latest turn's
  assert.deepEqual(h.journal.child('kid').outside.slice(0, 3), ['src/web/b.ts', 'odd\nname.ts', 'lib/f0.ts']);
  assert.ok(!h.journal.child('kid').outside.includes('/tmp/c.ts'), 'the oldest went once the list was full');
});

test('a session with no declared paths, or a turn with no edits, gets no warning; its edits are still taken', () => {
  const h = linked();
  h.edits.push(['/repo/anything.ts']);
  h.orch.finished({ chatId: 'kid', inputToken: 'x', text: 'done', completed: true });
  assert.doesNotMatch(h.notes()[0].body, /Edited outside/);
  assert.equal(h.edits.length, 0, 'taken, so they do not reach the next turn');
  assert.equal(h.journal.child('kid').outside, undefined);
  const scoped = linked({ paths: ['src/**'] });
  scoped.orch.finished({ chatId: 'kid', inputToken: 'x', text: 'done', completed: true });
  assert.doesNotMatch(scoped.notes()[0].body, /Edited outside/);
  // with no collector (no wiring), nothing is taken
  const bare = orchestration();
  const rec: any = { paths: ['a'], cwd: '/repo' };
  assert.equal(settleTurn(bare.orch, 'kid', rec), '');
  assert.equal(rec.outside, undefined);
});

test('windows read each session’s working time, declared paths and edits outside them', () => {
  const view = orchestrationView({
    children: {
      a: {
        parentId: 'p',
        name: 'a',
        title: 'A',
        driven: [],
        lastReport: null,
        worked: { ms: 5, turns: 1 },
        paths: ['src/**'],
        outside: ['x.ts'],
      },
      b: { parentId: 'p', name: 'b', title: 'B', driven: [], lastReport: null, worked: { ms: 0, turns: 0, since: 7 } },
    },
    parents: {},
    deliveries: {},
  });
  assert.deepEqual(view.children.a.worked, { ms: 5, turns: 1, since: null });
  assert.deepEqual(view.children.a.paths, ['src/**']);
  assert.deepEqual(view.children.a.outside, ['x.ts']);
  assert.deepEqual(view.children.b.worked, { ms: 0, turns: 0, since: 7 });
  assert.equal(view.children.b.paths, null);
});

test('the wiring times linked turns before they go out and collects edits beside the other live-event readers', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-usage-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen: string[] = [];
  const controller: any = {
    state: { get: () => ({ turn: 'idle', queue: [], approvals: [], activeTurn: null }) },
    rt: () => ({ inputToken: 'pending-1' }),
    ref: () => ({ kind: 'claude', id: 'n', key: 'k' }),
    chatOf: (key: string) => (key === 'kid-key' ? 'kid' : key),
    requestChat: (thread: string) => (thread === 'kid-thread' ? 'kid' : thread),
    // another reader of the live events, already there (Chrome's side panel)
    onLiveEvent: (family: string) => seen.push(family),
  };
  const orch = createOrchestration({
    file: path.join(dir, 'orchestration.json'),
    live: { controller, chats: { records: new Map([['top', { meta: {} }]]) }, capabilities: null, peerRuntime: {} },
    starter: { prefs: () => ({}) },
    usable: async () => true,
    send: async () => ({ started: true }),
    projectOf: async () => dir,
    worktreeInfo: () => null,
    owner: () => null,
    ipcMain: { handle: () => {} },
    broadcastAll: () => {},
  });
  orch.o.now = () => 4000;
  orch.journal.change((d: any) => {
    d.children.kid = { parentId: 'top', name: 'kid', title: 'K', cwd: dir, createdAt: 1, driven: [], lastReport: null, paths: ['src/**'] };
    d.children.free = { parentId: 'top', name: 'free', title: 'F', cwd: dir, createdAt: 1, driven: [], lastReport: null };
  });
  await controller.beforeDispatch({ chatId: 'kid', kind: 'turn', item: { opts: {} }, ref: controller.ref() });
  assert.deepEqual(orch.journal.child('kid').worked, { ms: 0, turns: 0, since: 4000 });
  const edit = (thread: string, file: string) => ({
    method: 'item/completed',
    params: { threadId: thread, item: { type: 'fileChange', status: 'completed', changes: [{ path: path.join(dir, file) }] } },
  });
  controller.onLiveEvent('codex', edit('kid-thread', 'lib/out.ts'));
  controller.onLiveEvent('codex', edit('free', 'lib/free.ts'));
  controller.onLiveEvent('claude', {
    kind: 'message',
    key: 'kid-key',
    msg: {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: path.join(dir, 'src/in.ts') } }] },
    },
  });
  controller.onLiveEvent('claude', {
    kind: 'message',
    key: 'kid-key',
    msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w' }] } },
  });
  assert.deepEqual(seen, ['codex', 'codex', 'claude', 'claude'], 'the reader already there still gets every event');
  assert.deepEqual(controller.editedPaths.take('free'), [], 'a session with no declared paths is not collected');
  orch.o.now = () => 9000;
  controller.onFinished({ chatId: 'kid', inputToken: 'x', text: 'done', completed: true });
  assert.deepEqual(orch.journal.child('kid').worked, { ms: 5000, turns: 1, since: null });
  assert.deepEqual(orch.journal.child('kid').outside, ['lib/out.ts']);
  // a failure of the collector never reaches the harness's event handling
  controller.editedPaths.event = () => {
    throw new Error('collector bug');
  };
  assert.doesNotThrow(() => controller.onLiveEvent('acp', {}));
});
