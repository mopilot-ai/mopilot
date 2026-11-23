// Claude history pages (core/crates/translate/src/claude) and main's claude:turns, which builds them
// from the whole transcript so only a page crosses to the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurns, transcriptPage } from './support/claude-translate.ts';
import { fakes, load } from './support/electron-claude.ts';
import { readPage } from './support/claude-translate.ts';

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const prompt = (uuid: string, s = 0, text = uuid) => ({ type: 'user', uuid, timestamp: at(s), message: { role: 'user', content: text } });
const reply = (uuid: string, s = 0) => ({
  type: 'assistant',
  uuid,
  timestamp: at(s),
  message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'text', text: `re ${uuid}` }] },
});
/** n prompt/reply pairs: turns h-p0 … h-p<n-1> */
const chat = (n: number) => Array.from({ length: n }, (_, i) => [prompt(`p${i}`, i * 2), reply(`a${i}`, i * 2 + 1)]).flat();
const ids = (turns: { id: string }[]) => turns.map((t) => t.id);

test('transcriptPage: pages of one replay, a live tail only on the latest page, and the tail as it reads closed', () => {
  const msgs = chat(5);
  const latest = transcriptPage(msgs, 'claude:s', '/w', { limit: 2 });
  assert.deepEqual(ids(latest.turns), ['h-p3', 'h-p4']);
  assert.equal(latest.olderCursor, 'h-p3');
  assert.equal(latest.closedTail, null);
  const older = transcriptPage(msgs, 'claude:s', '/w', { limit: 2, before: latest.olderCursor });
  assert.deepEqual(ids(older.turns), ['h-p1', 'h-p2']);
  // the pages are slices of the one replay of the whole transcript
  assert.deepEqual(
    [...transcriptPage(msgs, 'claude:s', '/w', { limit: 2, before: 'h-p1' }).turns, ...older.turns, ...latest.turns],
    buildTurns(msgs, 'claude:s', '/w'),
  );

  // another app's prompt waiting on its reply: the live tail keeps it open, and closed it reads completed
  const live = [...msgs, { ...prompt('p5'), timestamp: new Date().toISOString() }];
  const open = transcriptPage(live, 'claude:s', '/w', { liveTail: true, closedTail: true, limit: 2 });
  assert.equal(open.turns.at(-1)!.status, 'inProgress');
  assert.equal(open.closedTail!.id, 'h-p5');
  assert.equal(open.closedTail!.status, 'completed');
  // not asked for, or nothing left open: no closed tail
  assert.equal(transcriptPage(live, 'claude:s', '/w', { liveTail: true, limit: 2 }).closedTail, null);
  assert.equal(transcriptPage(msgs, 'claude:s', '/w', { liveTail: true, closedTail: true, limit: 2 }).closedTail, null);
  // an older page never holds the last turn, so the live tail is not asked of it
  const before = transcriptPage(live, 'claude:s', '/w', { liveTail: true, closedTail: true, limit: 2, before: 'h-p4' });
  assert.deepEqual(ids(before.turns), ['h-p2', 'h-p3']);
  assert.equal(before.closedTail, null);
  assert.ok(before.turns.every((t) => t.status === 'completed'));
});

test('a turn Claude starts on its own keeps one id across reads, so a page cursor names it every time', () => {
  // the user stopped the turn, and Claude went on by itself
  const msgs = [prompt('p0'), prompt('stop', 1, '[Request interrupted by user]'), reply('a1', 2), prompt('p1', 3), reply('a2', 4)];
  const first = ids(buildTurns(msgs, 'claude:s', '/w'));
  assert.deepEqual(first, ['h-p0', 'auto-a1', 'h-p1']);
  assert.deepEqual(ids(buildTurns(msgs, 'claude:s', '/w')), first);
  assert.deepEqual(ids(transcriptPage(msgs, 'claude:s', '/w', { limit: 1, before: 'h-p1' }).turns), ['auto-a1']);
});

test('claude:turns builds the page in main from the transcript, taking only well-formed options', async () => {
  const t = load();
  const asked: string[] = [];
  fakes.sdk.getSessionMessages = async (sid: string) => (asked.push(sid), chat(4));
  const page = readPage(await t.call('claude:turns', 'sid', { chatId: 'claude:sid', cwd: '/w', limit: 3 }));
  assert.deepEqual(ids(page.turns), ['h-p1', 'h-p2', 'h-p3']);
  assert.equal(page.olderCursor, 'h-p1');
  assert.deepEqual(ids(readPage(await t.call('claude:turns', 'sid', { chatId: 'claude:sid', limit: 3, before: 'h-p1' })).turns), ['h-p0']);
  // options of the wrong shape are not guessed at: the whole history, under the session's own chat id
  const odd = readPage(await t.call('claude:turns', 'sid', { chatId: 3, cwd: 9, limit: '2', before: 7, liveTail: 'yes', closedTail: 1 }));
  assert.equal(odd.turns.length, 4);
  assert.equal(odd.olderCursor, null);
  assert.equal(odd.closedTail, null);
  assert.equal(readPage(await t.call('claude:turns', 'sid', { limit: -1, before: '' })).turns.length, 4);
  assert.equal(readPage(await t.call('claude:turns', 'sid', { limit: 1.5 })).turns.length, 4);
  assert.deepEqual(asked, ['sid', 'sid', 'sid', 'sid', 'sid']);
  // a transcript that cannot be read reaches the window as the failure it is
  fakes.sdk.getSessionMessages = async () => {
    throw new Error('unreadable');
  };
  await assert.rejects(t.call('claude:turns', 'sid', { limit: 3 }), /unreadable/);
});

test("claude:turns puts each turn's saved diff on the page main built, under the session's key", async () => {
  const seen: string[] = [];
  const t = load({
    hooks: {
      pages: () => ({
        liveTurn: (key: string) => (seen.push(`live ${key}`), null),
        diffs: (key: string, turnIds: string[]) => (seen.push(key), Object.fromEntries(turnIds.map((id) => [id, `${key}:${id}`]))),
      }),
    },
  });
  fakes.sdk.getSessionMessages = async () => chat(2);
  const page = readPage(await t.call('claude:turns', 'sid', { chatId: 'claude:sid', limit: 1 }));
  assert.deepEqual(seen, ['live claude:sid', 'claude:sid']);
  assert.deepEqual(page.diffs, { 'h-p1': 'claude:sid:h-p1' });
});

test('a transcript page read `open` keeps its last turn and its running tool call open, however old its last write', () => {
  const old = '2020-01-01T00:00:00Z';
  const messages = [
    { type: 'user', uuid: 'u1', timestamp: old, message: { role: 'user', content: 'run it' } },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: old,
      message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 20' } }] },
    },
  ];
  const open = transcriptPage(messages, 'claude:x', '/repo', { liveTail: true, open: true });
  assert.equal(open.turns.at(-1)?.status, 'inProgress');
  assert.equal((open.turns.at(-1)?.items.at(-1) as any)?.status, 'inProgress');
  const guessed = transcriptPage(messages, 'claude:x', '/repo', { liveTail: true });
  assert.equal(guessed.turns.at(-1)?.status, 'completed', 'the timestamp guess alone closes it');
  // an older page never holds the running turn
  const older = transcriptPage([...messages, { ...messages[0], uuid: 'u2' }], 'claude:x', '/repo', { open: true, before: 'h-u2' });
  assert.equal(older.turns.at(-1)?.status, 'completed');
});
