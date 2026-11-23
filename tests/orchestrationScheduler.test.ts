// electron/session/orchestration/scheduler.cjs: at most the Settings cap of linked sessions work at once; a parent's
// briefs and follow-ups beyond it wait first in first out, each going once its chat is idle and a slot is free, kept
// across restarts; one for a chat gone or archived is dropped with a note to its parent, never silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SESSION_BACKGROUND as BACKGROUND, orchestration } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { capOf, runningChildren, queuePosition, DEFAULT_CAP, MAX_CAP } = require('../electron/session/orchestration/scheduler.cjs');
const { OrchestrationJournal } = require('../electron/session/orchestration/journal.cjs');

const sends = (h: any) => h.log.filter((l: any) => l[0] === 'send');
// each in this folder, writing its own files (writeScope.cjs)
const task = (title: string) => ({ background: BACKGROUND, title, prompt: `do ${title}`, use_worktree: false, paths: [`${title}/**`] });

test('legacy parallel preferences no longer impose an app-wide cap', async () => {
  for (const maxParallelChildren of [undefined, 'x', 0, 1, 4, 99]) assert.equal(capOf({ maxParallelChildren }), Infinity);
  assert.equal(capOf(), DEFAULT_CAP);
  assert.equal(MAX_CAP, Infinity);
  const h = orchestration({ prefs: () => ({ maxParallelChildren: 1 }) });
  h.userTurn();
  for (const title of ['a', 'b', 'c', 'd']) {
    const r = await h.orch.start('top', task(title));
    assert.equal(r.status, 'started');
    h.states.set(r.chat_id, { turn: 'running' });
  }
  assert.equal(runningChildren(h.orch), 4);
  assert.equal(h.journal.data.queue.length, 0);
});

test('an item for a busy chat waits without holding up the next chat’s; a follow-up to a busy child waits too', async () => {
  const h = orchestration({ prefs: () => ({ maxParallelChildren: 3 }) });
  h.userTurn();
  const { chat_id: a } = await h.orch.start('top', task('a'));
  const { chat_id: b } = await h.orch.start('top', task('b'));
  h.states.set(a, { turn: 'running' });
  const first = await h.orch.message('top', { to: a, message: 'more for a' });
  assert.deepEqual([first.status, first.queue_position], ['queued', 1]);
  // with something waiting, a new item goes behind it even for an idle chat, then the pump sends it
  const second = await h.orch.message('top', { to: b, message: 'more for b' });
  assert.equal(second.status, 'queued', 'pump dispatch is not native acceptance');
  assert.equal(sends(h).at(-1)[1], b);
  assert.equal(queuePosition(h.orch, a), 1);
  // two items for one chat: only the first goes when it frees up
  await h.orch.message('top', { to: a, message: 'and more' });
  h.states.set(a, { turn: 'idle' });
  h.orch.pump();
  assert.equal(sends(h).filter((l: any) => l[1] === a).length, 2, 'the brief and the first follow-up');
  assert.equal(queuePosition(h.orch, a), 1);
});

test('an item for a chat that is gone or archived is dropped and its parent told; nothing goes when the journal cannot be written', async () => {
  const h = orchestration({ prefs: () => ({ maxParallelChildren: 1 }) });
  h.userTurn();
  const { chat_id: a } = await h.orch.start('top', task('a'));
  h.states.set(a, { turn: 'running' });
  const { chat_id: b } = await h.orch.start('top', task('b'));
  const { chat_id: c } = await h.orch.start('top', task('c'));
  h.states.set(b, { turn: 'running' });
  h.states.set(c, { turn: 'running' });
  await h.orch.message('top', { to: b, message: 'queued b' });
  await h.orch.message('top', { to: c, message: 'queued c' });
  h.deleted.add(b);
  h.records.set(c, { meta: { archived: 1 } });
  h.orch.pump();
  assert.equal(h.journal.data.queue.length, 0);
  const notes = h.journal.parent('top').notes;
  assert.deepEqual(
    notes.map((n: any) => [n.childId, n.wakes]),
    [
      [b, false],
      [c, false],
    ],
  );
  assert.match(notes[0].body, /was not sent: that chat is archived or gone/);
  // an orphaned queue entry (its child record gone too) is dropped without a note
  h.journal.change((d: any) => d.queue.push({ id: 'x', chatId: 'stranger', item: { id: 'x', text: 't' }, at: 1 }));
  h.orch.pump();
  assert.equal(h.journal.data.queue.length, 0);
  assert.equal(h.journal.parent('top').notes.length, 2);
  // the journal can't be written: the item stays queued and nothing is sent
  const { chat_id: d } = await h.orch.start('top', task('d'));
  h.states.set(d, { turn: 'running' });
  await h.orch.message('top', { to: d, message: 'queued d' });
  h.states.set(d, { turn: 'idle' });
  h.states.set(a, { turn: 'idle' });
  const commit = h.journal.commit.bind(h.journal);
  h.journal.commit = () => {
    throw new Error('disk full');
  };
  const before = sends(h).length;
  h.orch.pump();
  assert.equal(sends(h).length, before);
  h.journal.commit = commit;
  assert.equal(queuePosition(h.orch, d), 1);
  // an unavailable journal pumps nothing
  h.journal.startupError = 'journal_unavailable';
  h.orch.pump();
  assert.equal(sends(h).length, before);
});

test('a queued send the harness refuses is noted; the queue survives a restart and is checked when read', async (t) => {
  const h = orchestration({
    prefs: () => ({ maxParallelChildren: 1 }),
    send: async (id: string, item: any) =>
      id.startsWith('codex') && id.endsWith('2') && item.text.includes('queued')
        ? Promise.reject(new Error('refused'))
        : (h.log.push(['send', id, item]), { started: true }),
  });
  h.userTurn();
  const { chat_id: a } = await h.orch.start('top', task('a'));
  h.states.set(a, { turn: 'running' });
  const { chat_id: b } = await h.orch.start('top', task('b'));
  h.states.set(b, { turn: 'running' });
  await h.orch.message('top', { to: b, message: 'queued' });
  h.states.set(b, { turn: 'idle' });
  h.states.set(a, { turn: 'idle' });
  h.orch.crashed(a);
  h.flush();
  await new Promise((r) => setImmediate(r));
  assert.equal(
    h.journal.data.queue.length,
    1,
    'a rejected dispatch remains in the durable fallback when controller bookkeeping is unavailable',
  );
  assert.match(h.journal.data.queue[0].item.text, /<mopilot-side-session-message[\s\S]*\nqueued\n[\s\S]*<\/mopilot-side-session-message>/);
  assert.match(h.journal.parent('top').notes.at(-1).body, /did not start:.*refused/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'orchestration.json');
  const before = new OrchestrationJournal({ file });
  before.change((d: any) => d.queue.push({ id: 'q1', chatId: 'c1', item: { id: 'q1', text: 'brief' }, at: 1 }));
  assert.deepEqual(
    new OrchestrationJournal({ file }).data.queue.map((e: any) => e.id),
    ['q1'],
  );
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, children: {}, parents: {}, deliveries: {}, queue: [{ id: 'q1' }] }));
  assert.equal(new OrchestrationJournal({ file }).startupError, 'journal_unavailable');
});

test('a new chat with no saved record yet keeps its queued message until that recipient is idle', async () => {
  const h = orchestration({ prefs: () => ({ maxParallelChildren: 1 }) });
  h.userTurn();
  const { chat_id: a } = await h.orch.start('top', task('a'));
  h.states.set(a, { turn: 'running' });
  const { chat_id: b, status } = await h.orch.start('top', task('b'));
  assert.equal(status, 'started');
  h.states.set(b, { turn: 'running' });
  await h.orch.message('top', { to: b, message: 'queued' });
  // a Claude Code or basic-harness chat has no record until its first message is saved
  h.records.delete(b);
  h.states.set(b, { turn: 'idle' });
  h.states.set(a, { turn: 'idle' });
  h.orch.pump();
  assert.equal(sends(h).at(-1)[1], b);
  assert.equal(h.journal.parent('top').notes.length, 0);
});
