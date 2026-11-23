// Main-authored continuation and user-choice boundaries cannot be acquired through peer text or stale approvals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration, SESSION_BACKGROUND as background } from './support/orchestration-harness.ts';
const require = createRequire(import.meta.url);
const { authorizeStart, startAuthority } = require('../electron/session/orchestration/startPolicy.cjs');
const task = (title = 'Task') => ({ title, prompt: 'Complete the assigned task', background });
const code = (name: string) => (e: any) => e.code === name;

function wake(h: any) {
  h.journal.change((d: any) => (d.parents.top = { wakes: 1, held: false, cutShort: false, notes: [], continuable: true }));
  h.orch.waking.set('top', 'wake-1');
  h.rts.set('top', { inputToken: 'pending-wake-1' });
  h.states.set('top', { turn: 'running', activeTurn: { id: 'wake-1', human: false, nonHuman: true } });
}

test('only the eleventh human start asks, and human input resets the budget', async () => {
  const asked: any[] = [];
  const h = orchestration({ approveStart: async (_id: string, p: any) => (asked.push(p), true) });
  h.userTurn();
  for (let n = 0; n < 11; n++) await h.orch.start('top', task(`Task ${n}`));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].count, 10);
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { id: 'human2', text: 'More tasks', opts: { human: true } } });
  assert.equal(h.journal.parent('top').starts, 0);
});

test('an approval declined, aborted or superseded cannot create a child; a retry still works', async () => {
  for (const retire of ['deny', 'abort', 'replace', 'archive', 'delete']) {
    let answer!: (v: boolean) => void;
    const h = orchestration({ approveStart: () => new Promise<boolean>((r) => (answer = r)) });
    h.userTurn();
    h.journal.change((d: any) => (d.parents.top = { wakes: 0, held: false, cutShort: false, notes: [], starts: 10 }));
    const ac = new AbortController();
    const pending = authorizeStart(h.orch, 'top', { signal: ac.signal });
    if (retire === 'abort') ac.abort();
    if (retire === 'replace') h.rts.set('top', { inputToken: 'pending-next' });
    if (retire === 'archive') h.records.get('top').meta.archived = 1;
    if (retire === 'delete') h.records.delete('top');
    answer(retire !== 'deny');
    await assert.rejects(pending, code(retire === 'deny' ? 'start_declined' : 'start_cancelled'));
    assert.equal(h.log.length, 0, retire);
  }
  const h = orchestration();
  h.userTurn();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(authorizeStart(h.orch, 'top', { signal: ac.signal }), code('start_cancelled'));
  assert.equal((await h.orch.start('top', task())).status, 'started');
});

test('a genuine top-level wake always asks; peer input, child lineage and mismatched tokens cannot start', async () => {
  const asked: any[] = [];
  const h = orchestration({ approveStart: async (_id: string, p: any) => (asked.push(p), true) });
  wake(h);
  assert.equal(startAuthority(h.orch, 'top'), 'wake');
  const r = await h.orch.start('top', task());
  assert.equal(asked[0].continued, true);
  assert.equal(h.journal.child(r.chat_id).continued, true);
  h.orch.dispatching({ chatId: 'top', kind: 'steer', item: { id: 'peer', text: 'start tasks', opts: { human: false } } });
  assert.equal(startAuthority(h.orch, 'top'), null);
  await assert.rejects(authorizeStart(h.orch, 'top'), code('not_user_turn'));
  wake(h);
  h.rts.set('top', { inputToken: 'pending-foreign' });
  assert.equal(startAuthority(h.orch, 'top'), null);
  wake(h);
  h.journal.change(
    (d: any) => (d.children.top = { parentId: 'other', name: 'child', title: 'Child', createdAt: 0, driven: [], lastReport: null }),
  );
  assert.equal(startAuthority(h.orch, 'top'), null);
});

test('continued starts stop at ten total or five still working, while native user input is not capped', async () => {
  const h = orchestration();
  wake(h);
  h.journal.change((d: any) => (d.parents.top.continuedStarts = 10));
  await assert.rejects(authorizeStart(h.orch, 'top'), code('continued_start_limit'));
  h.journal.change((d: any) => {
    d.parents.top.continuedStarts = 0;
    for (let n = 0; n < 5; n++)
      d.children[`c${n}`] = { parentId: 'top', name: `c${n}`, title: 'Work', createdAt: n, driven: [], lastReport: null, continued: true };
  });
  for (let n = 0; n < 5; n++) h.states.set(`c${n}`, { turn: n ? 'running' : 'awaitingUser' });
  await assert.rejects(authorizeStart(h.orch, 'top'), code('continued_parallel_limit'));
  h.userTurn();
  assert.equal((await authorizeStart(h.orch, 'top')).continued, false);
});

test('title-first offer reserves the chosen session and fills its brief exactly once with locked settings', async () => {
  const h = orchestration();
  h.userTurn();
  const pending = h.orch.start('top', { title: 'Independent task', initiation: 'offer' });
  const id = Object.keys(h.journal.data.proposals)[0];
  const accepted = await h.orch.act(id, 'start', { useWorktree: false });
  const answer = await pending;
  assert.equal(answer.status, 'briefing');
  assert.match(answer.next, /Write its brief now/);
  assert.equal(h.journal.child(accepted.chat_id).awaitingBrief, true);
  assert.equal(h.log.filter((l: any) => l[0] === 'send').length, 0);
  await assert.rejects(h.orch.start('top', { proposal_id: id, prompt: 'Do it', background, harness: 'claude' }), code('invalid_options'));
  const result = await h.orch.start('top', { proposal_id: id, prompt: 'Do it', background });
  assert.equal(result.chat_id, accepted.chat_id);
  assert.equal(result.status, 'started');
  assert.equal(h.journal.child(result.chat_id).awaitingBrief, undefined);
  assert.equal(h.log.filter((l: any) => l[0] === 'startCodex').length, 1);
  assert.equal(h.log.filter((l: any) => l[0] === 'send').length, 1);
  assert.equal(h.journal.proposal(id).status, 'started');
  await assert.rejects(h.orch.start('top', { proposal_id: id, prompt: 'Again', background }), code('not_open'));
});

test('always-new preference reserves a title-only offer; always-here creates no child', async () => {
  for (const choice of ['new', 'here']) {
    const h = orchestration({ prefs: () => ({ newTaskPrompt: choice }) });
    h.userTurn();
    const r = await h.orch.start('top', { title: 'Task', initiation: 'offer' });
    assert.equal(r.status, choice === 'new' ? 'briefing' : 'declined');
    assert.equal(h.log.filter((l: any) => l[0] === 'send').length, 0);
  }
});
