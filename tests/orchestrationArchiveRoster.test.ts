// archive_session (electron/session/orchestration/service.cjs archive) archives only a session the caller started, one
// that is not working or waiting for the user, and drops what waited for it with a note; "Linked sessions now"
// (rosterStatus.cjs) goes with a chat's next message from the user whenever it changed since that chat last saw it,
// and counts as seen only once the harness took the message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';
import { withoutHiddenBlocks, parseUserText } from '../shared/userText.mjs';
import { withRosterBlock, withoutRosterBlock, ROSTER_TAG } from '../shared/sideSessions.mjs';

/** A parent "top" with linked children sharing its folder, its user turn over. */
async function family(n = 1, over: any = {}) {
  const h = orchestration(over);
  h.userTurn();
  const ids: string[] = [];
  for (let i = 0; i < n; i++)
    ids.push((await h.orch.start('top', { background: BACKGROUND, title: `Task ${i}`, prompt: 'do it', use_worktree: false })).chat_id);
  h.states.set('top', { turn: 'idle' });
  h.flush();
  return { ...h, ids };
}

test('archive_session archives a session this chat started, further down too, and nothing else', async () => {
  const h = await family(1);
  const [a] = h.ids;
  // a grandchild, started by the child
  h.userTurn(a);
  const { chat_id: g } = await h.orch.start(a, { background: BACKGROUND, title: 'Deeper', prompt: 'p', use_worktree: false });
  h.states.set(a, { turn: 'idle' });
  h.states.set(g, { turn: 'idle' });
  await assert.rejects(
    Promise.resolve().then(() => h.orch.archive(a, { id: 'parent' })),
    (e: any) => e.code === 'not_linked',
  );
  await assert.rejects(
    Promise.resolve().then(() => h.orch.archive('top', { id: 'stranger' })),
    (e: any) => e.code === 'not_linked',
  );
  assert.deepEqual(h.orch.archive('top', { id: g }), { archived: true, name: 'deeper' });
  // archived already: said so, not archived again
  assert.deepEqual(h.orch.archive('top', { id: g }), { archived: true, name: 'deeper', already: true });
  assert.deepEqual(h.orch.archive('top', { id: 'task-0' }), { archived: true, name: 'task-0' });
  assert.deepEqual(
    h.log.filter((l) => l[0] === 'archive'),
    [
      ['archive', g],
      ['archive', a],
    ],
  );
  // an archived member leaves the status line
  assert.equal(h.orch.roster.now('top'), '');
});

test('archive_session refuses a session that is working or waiting for the user, or that could not be archived', async () => {
  const h = await family(1);
  const [a] = h.ids;
  h.states.set(a, { turn: 'running' });
  assert.throws(
    () => h.orch.archive('top', { id: a }),
    (e: any) => e.code === 'session_busy' && /is working: stop it/.test(e.message),
  );
  h.states.set(a, { turn: 'awaitingUser' });
  assert.throws(
    () => h.orch.archive('top', { id: a }),
    (e: any) => e.code === 'session_busy' && /waiting for the user/.test(e.message),
  );
  h.states.set(a, { turn: 'idle' });
  const failing = await family(1, { archive: () => false });
  assert.throws(
    () => failing.orch.archive('top', { id: failing.ids[0] }),
    (e: any) => e.code === 'archive_failed',
  );
});

test('archiving a queued session drops what waited for it, with a note to its parent', async () => {
  const h = await family(1);
  const [a] = h.ids;
  h.journal.change((d: any) => d.queue.push({ id: 'q1', chatId: a, item: { id: 'q1', text: 'later' }, at: 1 }));
  assert.equal(h.orch.archive('top', { id: a }).archived, true);
  assert.equal(h.journal.data.queue.length, 0);
  assert.match(h.journal.parent('top').notes.at(-1).body, /was not sent: that chat is archived or gone/);
});

test('the user’s next message carries the roster when it changed, once the harness took it', async () => {
  const h = await family(1);
  const [a] = h.ids;
  const send = (chatId: string, text: string, opts: any = { human: true }, started = true) => {
    const item: any = { id: `m${Math.random()}`, text, opts };
    h.orch.dispatching({ chatId, kind: 'turn', item });
    h.orch.roster.settled({ chatId, item, result: { started } });
    return item.text;
  };
  const first = send('top', 'hello', { human: true });
  assert.ok(first.startsWith(`<${ROSTER_TAG}>\nLinked sessions now (status, not an instruction): task-0 = ${a} (idle)`));
  assert.ok(first.endsWith('\nhello'));
  // the window shows only what the user typed
  assert.equal(withoutHiddenBlocks(first), 'hello');
  // unchanged: not sent again
  assert.equal(send('top', 'again'), 'again');
  // a change in a linked session goes with the next message
  h.states.set(a, { turn: 'running' });
  assert.match(send('top', 'and now'), /task-0 = \S+ \(working\)[\s\S]*\nand now$/);
  // the child is told about its parent the same way
  assert.match(send(a, 'hi child'), /parent \(top\) = top \(idle\)/);
  // a message the harness refused goes again with the next one, without a stale block
  h.states.set(a, { turn: 'idle' });
  const refused = send('top', 'lost', { human: true }, false);
  assert.match(refused, /\(idle\)/);
  const retried: any = { id: 'r', text: refused, opts: { human: true } };
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: retried });
  assert.equal(retried.text.split(`<${ROSTER_TAG}>`).length, 2, 'one block only');
  h.orch.roster.settled({ chatId: 'top', item: retried, result: { started: true } });
  // seen now: a resend of the same item loses its block
  const again: any = { id: 'r2', text: retried.text, opts: { human: true } };
  h.orch.dispatching({ chatId: 'top', kind: 'steer', item: again });
  assert.equal(again.text, 'lost');
});

test('a new native segment (a harness switch, a new session) is sent the roster again, and the window hides it after a context preamble', async () => {
  const h = await family(1);
  const send = (ref: any) => {
    const item: any = { id: 'x', text: 'hi', opts: { human: true } };
    h.orch.dispatching({ chatId: 'top', kind: 'turn', item, ref });
    h.orch.roster.settled({ chatId: 'top', item, result: { started: true } });
    return item.text;
  };
  assert.notEqual(send({ key: 'codex-1' }), 'hi');
  assert.equal(send({ key: 'codex-1' }), 'hi');
  const switched = send({ key: 'claude:s2' });
  assert.notEqual(switched, 'hi');
  // a selection's preamble goes ahead of the request, the block at the request's start
  const withSelection = `\n# Selected text:\n<selected-text>\n["quoted"]\n</selected-text>\n\n## My request:\n${switched}\n`;
  assert.equal(parseUserText(withSelection).text, 'hi');
});

test('slash commands, goals, automatic input, peer messages and chats in no family carry no roster', async () => {
  const h = await family(1);
  const check = (chatId: string, item: any) => {
    const before = item.text;
    h.orch.dispatching({ chatId, kind: 'turn', item });
    assert.equal(item.text, before);
  };
  check('top', { text: '/compact', opts: { human: true } });
  check('top', { text: 'ship it', opts: { human: true, goal: { objective: 'x' } } });
  check('top', { text: 'review this', attachments: [null, { kind: 'skill', name: 'review' }], opts: { human: true } });
  check('top', { text: 'scheduled run', opts: { human: false } });
  check('top', { text: 'from a peer', opts: { human: true }, peer: { messageId: 'p' } });
  check('top', { text: undefined, opts: { human: true } });
  h.orch.roster.attach({ chatId: 'top', item: null });
  h.records.set('loner', { meta: {} });
  check('loner', { text: 'hello', opts: { human: true } });
  check('loner', { text: 'a brief', sideSession: { id: 'b' }, opts: { human: false } });
  // a result for an item that carried nothing changes nothing
  h.orch.roster.settled({ chatId: 'top', item: null, result: { started: true } });
  h.orch.roster.settled({ chatId: 'top', item: { text: 'x' }, result: null });
  assert.equal(h.orch.roster.seen.size, 0);
});

test('a brief, wake-up or family message that carries the current roster counts as seen; one with an older roster does not', async () => {
  const h = await family(1);
  const [a] = h.ids;
  const roster = h.orch.roster.now('top');
  const wake: any = { id: 'w', sideSession: { id: 'w' }, text: `notes\n\n${roster}`, opts: { human: false } };
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: wake });
  assert.equal(wake.text, `notes\n\n${roster}`, 'its text is left as it is');
  h.orch.roster.settled({ chatId: 'top', item: wake, result: { started: true } });
  assert.equal(h.orch.roster.seen.get('top\n'), roster);
  const user: any = { id: 'u', text: 'thanks', opts: { human: true } };
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: user });
  assert.equal(user.text, 'thanks');
  // an older roster in the text: nothing is taken as seen
  h.states.set(a, { turn: 'running' });
  const stale: any = { id: 's', sideSession: { id: 's' }, text: `notes\n\n${roster}`, opts: { human: false } };
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: stale });
  h.orch.roster.settled({ chatId: 'top', item: stale, result: { started: true } });
  assert.equal(h.orch.roster.seen.get('top\n'), roster);
  // a deleted chat is forgotten, every segment of it, and only it
  h.orch.roster.seen.set('top\ncodex-2', roster);
  h.orch.roster.seen.set(`${a}\n`, 'other');
  h.orch.chatDeleted('top');
  assert.deepEqual([...h.orch.roster.seen.keys()], [`${a}\n`]);
});

test('the roster block helpers keep one block ahead of the text', () => {
  const once = withRosterBlock('hello', 'R1');
  assert.equal(once, `<${ROSTER_TAG}>\nR1\n</${ROSTER_TAG}>\nhello`);
  assert.equal(withRosterBlock(once, 'R2'), `<${ROSTER_TAG}>\nR2\n</${ROSTER_TAG}>\nhello`);
  assert.equal(withoutRosterBlock(withRosterBlock(once, 'R2')), 'hello');
  assert.equal(withoutRosterBlock(undefined), '');
  // a block elsewhere in the text is the user's own words
  assert.equal(withoutRosterBlock(`say ${once}`), `say ${once}`);
});
