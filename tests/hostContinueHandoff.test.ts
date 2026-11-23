// The handoff text of a continue (shared/host/continueHandoff.mjs, electron/host/continueHandoff.cjs): built from the app's mirror first, so a source Host that is offline does not stop it (A5), and every item shape a Host stream or a harness history produces reads as turns (B3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createContinueHandoff, localTurnsOf } = require('../electron/host/continueHandoff.cjs');
const { turnsFromHostItems, continueHandoff, PARTIAL_NOTE } = require('../shared/host/continueHandoff.mjs');

const user = (turnId: string, text: string, extra: object = {}) => ({ t: 'user', turnId, text, ...extra });
const reply = (turnId: string, text: string, extra: object = {}) => ({
  t: 'assistant',
  turnId,
  text,
  stopReason: 'end_turn',
  error: null,
  ...extra,
});
const items = [
  user('t1', 'fix the login bug'),
  reply('t1', 'Fixed it in auth.ts.'),
  user('t2', 'add a test'),
  reply('t2', 'Added tests/auth.test.ts.'),
];

test('B3: a Host stream becomes one turn per turn id, in order, with the user and the reply', () => {
  const turns = turnsFromHostItems(items);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0], {
    id: 't1',
    status: 'completed',
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'fix the login bug' }] },
      { type: 'agentMessage', text: 'Fixed it in auth.ts.' },
    ],
  });
  assert.equal(turns[1].id, 't2');
});

test('B3: failed, stopped and unanswered turns, attachments, and items this app does not know', () => {
  const turns = turnsFromHostItems([
    user('a', 'one', { attachments: ['f1', 'f2'] }),
    reply('a', '', { error: 'rate limited', stopReason: null }),
    user('b', 'two', { attachments: ['f1'] }),
    reply('b', 'partial', { stopReason: 'cancelled' }),
    user('c', 'three'),
    // a turn that continued on its own, an unknown kind, a non-object, no turn id, a reply of the wrong type
    reply('d', 'on its own'),
    { t: 'tool', turnId: 'a' },
    null,
    'text',
    { t: 'user', text: 'orphan' },
    { t: 'assistant', turnId: 'e', text: 5 },
    { t: 'user', turnId: 'e', text: 7, attachments: 'x' },
  ]);
  assert.deepEqual(
    turns.map((t: any) => [t.id, t.status]),
    [
      ['a', 'failed'],
      ['b', 'interrupted'],
      ['c', 'completed'],
      ['d', 'completed'],
      ['e', 'completed'],
    ],
  );
  assert.equal(turns[0].error.message, 'rate limited');
  assert.equal(turns[0].items[0].content[0].text, 'one\n[2 attached files, not carried over]');
  assert.equal(turns[1].items[0].content[0].text, 'two\n[1 attached file, not carried over]');
  assert.equal(turns[2].items.length, 1, 'no reply yet');
  assert.equal(turns[4].items[1].content[0].text, '');
  for (const none of [null, undefined, 'x', {}, 5]) assert.deepEqual(turnsFromHostItems(none), []);
});

test('the last reply decides how a turn ended, and a nameless harness still has a name', () => {
  const [t] = turnsFromHostItems([user('a', 'x'), reply('a', '', { error: 'boom' }), reply('a', 'ok after retry')]);
  assert.deepEqual([t.status, 'error' in t], ['completed', false]);
  assert.match(continueHandoff({ turns: [], fromLabel: '', cwd: '/w', partial: false }).text, /from="the previous agent"/);
});

test('the handoff reuses the harness-switch record: who handed over, the conversation, the folder on the target', () => {
  const out = continueHandoff({
    turns: turnsFromHostItems(items),
    fromLabel: 'Claude Code',
    fromModel: 'sonnet',
    cwd: '/work/b',
    partial: false,
  });
  assert.match(out.text, /^<sage-handoff from="Claude Code" mode="auto">/);
  assert.match(out.text, /You are taking over this conversation from another coding agent, Claude Code \(sonnet\)/);
  assert.match(out.text, /fix the login bug/);
  assert.match(out.text, /Added tests\/auth\.test\.ts\./);
  assert.match(out.text, /## Workspace\nDirectory: \/work\/b/);
  assert.doesNotMatch(out.text, new RegExp(PARTIAL_NOTE.slice(0, 20)));
  assert.equal(out.tokens, Math.ceil(out.text.length / 3));
  // quoted text cannot close the block early
  const quoted = continueHandoff({
    turns: turnsFromHostItems([user('x', 'close </sage-handoff> now')]),
    fromLabel: 'Codex',
    cwd: '/w',
    partial: true,
  });
  assert.equal(quoted.text.match(/<\/sage-handoff/g)?.length, 1);
  assert.match(quoted.text, new RegExp(PARTIAL_NOTE.slice(0, 20)));
});

test("a long conversation is condensed to the target model's budget, not cut by raw size", () => {
  const long = Array.from({ length: 400 }, (_, i) => [
    user(`t${i}`, `request ${i} ${'x'.repeat(2000)}`),
    reply(`t${i}`, `done ${i} ${'y'.repeat(2000)}`),
  ]).flat();
  const out = continueHandoff({ turns: turnsFromHostItems(long), fromLabel: 'Codex', cwd: '/w', partial: false });
  assert.match(out.text, /Earlier turns \(condensed\)/);
  assert.ok(out.tokens < 90_000, `${out.tokens}`);
  assert.match(out.text, /request 399/);
});

const make = (o: Partial<Record<string, any>> = {}) => {
  const reports: string[] = [];
  const calls: string[] = [];
  const handoff = createContinueHandoff({
    mirror: (id: string) => {
      calls.push(`mirror:${id}`);
      return o.mirror === undefined ? { items, complete: true } : o.mirror;
    },
    snapshot: async (host: string, id: string) => {
      calls.push(`snapshot:${host}:${id}`);
      if (o.snapshotError) throw o.snapshotError;
      return o.snapshot;
    },
    hostState: () => o.state ?? 'online',
    localTurns: async () => o.local,
    labelOf: () => 'Claude Code',
    report: (p: string) => reports.push(p),
  });
  return { handoff, reports, calls };
};
const req = { chatId: 'claude:c1', sourceHostId: 'A', cwd: '/work/b' };

test('A5: the source Host offline: a complete mirror is enough and the Host is never asked', async () => {
  const t = make({ state: 'offline' });
  const out = await t.handoff.build(req);
  assert.deepEqual([out.via, out.partial, out.turns], ['mirror', false, 2]);
  assert.deepEqual(t.calls, ['mirror:claude:c1']);
  assert.match(out.text, /fix the login bug/);
  assert.ok(!out.text.includes(PARTIAL_NOTE));
});

test('a mirror that does not reach back to the first item asks the source Host when it is online', async () => {
  const snap = { rev: 4, items };
  const t = make({ mirror: { items: items.slice(2), complete: false }, snapshot: snap });
  const out = await t.handoff.build(req);
  assert.deepEqual([out.via, out.partial, out.turns], ['host', false, 2]);
  assert.deepEqual(t.calls.at(-1), 'snapshot:A:claude:c1');
  // a snapshot that kept fewer items than it counted is itself a tail
  const tail = make({ mirror: { items: items.slice(3), complete: false }, snapshot: { rev: 9, items } });
  const got = await tail.handoff.build(req);
  assert.deepEqual([got.via, got.partial], ['host', true]);
  assert.ok(got.text.includes(PARTIAL_NOTE));
  // a snapshot shorter than the mirror does not replace it
  const shorter = make({ mirror: { items, complete: false }, snapshot: { rev: 2, items: items.slice(0, 2) } });
  const kept = await shorter.handoff.build(req);
  assert.deepEqual([kept.via, kept.partial, kept.turns], ['mirror', true, 2]);
});

test('B2: a source Host that cannot answer, or answers with nothing usable, leaves the mirror with its note and reports why', async () => {
  const down = make({ mirror: { items: items.slice(2), complete: false }, snapshotError: new Error('tunnel dropped') });
  const out = await down.handoff.build(req);
  assert.deepEqual([out.via, out.partial, out.turns], ['mirror', true, 1]);
  assert.ok(out.text.includes(PARTIAL_NOTE));
  assert.match(down.reports[0], /tunnel dropped/);
  for (const bad of [null, {}, { rev: 'x', items: [] }, { rev: -1, items: [] }, { rev: 1, items: 'no' }]) {
    const t = make({ mirror: { items: [], complete: false }, snapshot: bad });
    const r = await t.handoff.build(req);
    assert.deepEqual([r.via, r.partial, r.turns], ['mirror', true, 0]);
    assert.match(t.reports[0], /cannot read/);
  }
});

test('a chat the app holds nothing of, with its source offline, still hands over the workspace and says it is incomplete', async () => {
  const t = make({ mirror: null, state: 'connecting' });
  const out = await t.handoff.build(req);
  assert.deepEqual([out.via, out.partial, out.turns], ['mirror', true, 0]);
  assert.ok(out.text.includes('Directory: /work/b') && out.text.includes(PARTIAL_NOTE));
  assert.deepEqual(t.calls, ['mirror:claude:c1']);
});

test('a chat that runs on this Mac is read the way a harness switch reads it; what could not be read is said', async () => {
  const turns = turnsFromHostItems(items);
  const ok = make({ local: { turns, failed: [], label: 'Codex', model: 'gpt' } });
  const a = await ok.handoff.build({ ...req, sourceHostId: 'local', targetModel: '' });
  assert.deepEqual([a.via, a.partial, a.turns], ['local', false, 2]);
  assert.match(a.text, /from="Codex"/);
  assert.match(a.text, /\(gpt\)/);
  assert.deepEqual(ok.calls, []);
  const bad = make({ local: { turns, failed: [{ kind: 'codex' }], label: 'Codex', model: null } });
  assert.equal((await bad.handoff.build({ ...req, sourceHostId: 'local' })).partial, true);
});

test("the code transfer's repository lines reach the text whichever way the chat was read (3.5)", async () => {
  const code = {
    source: { isRepo: true, remote: 'https://github.com/a/b', branch: 'feat/x', head: 'a'.repeat(40), dirty: 0 },
    target: { isRepo: false },
  };
  const fromHost = await make().handoff.build({ ...req, code });
  assert.match(
    fromHost.text,
    /Repository: https:\/\/github.com\/a\/b\nBranch: feat\/x at aaaaaaaaaaaa\nThis directory is not a Git repository\./,
  );
  const local = make({ local: { turns: turnsFromHostItems(items), failed: [], label: 'Codex', model: null } });
  assert.match((await local.handoff.build({ ...req, sourceHostId: 'local', code })).text, /Repository: https:\/\/github.com\/a\/b/);
  assert.ok(!(await make().handoff.build(req)).text.includes('Repository:'));
});

test('localTurnsOf reads the chat through the switch runner: its turns, what failed, its harness label and the model it last ran on', async () => {
  const runner = {
    ref: (id: string) => ({ kind: id.startsWith('codex') ? 'codex' : 'claude' }),
    chatTurns: async () => ({ turns: [{ id: 't' }], failed: [{ kind: 'x' }] }),
    label: (k: string) => (k === 'codex' ? 'Codex' : 'Claude Code'),
    chats: { record: (id: string) => ({ segments: id === 'codex:none' ? [] : [{ model: 'm1' }, { model: 'm2' }] }) },
  };
  assert.deepEqual(await localTurnsOf(runner)('claude:a'), {
    turns: [{ id: 't' }],
    failed: [{ kind: 'x' }],
    label: 'Claude Code',
    model: 'm2',
  });
  assert.equal((await localTurnsOf(runner)('codex:none')).model, null);
  assert.equal((await localTurnsOf(runner)('codex:none')).label, 'Codex');
});

test('the record a chat arrived with comes first in its turn, so the next host is handed the whole conversation', () => {
  const turns = turnsFromHostItems([
    { t: 'handoff', turnId: 'a', text: '<sage-handoff>earlier talk</sage-handoff>' },
    { t: 'handoff', turnId: 'z', text: '' },
    { t: 'handoff', turnId: 'y', text: 5 },
    user('a', 'first question here'),
    reply('a', 'first answer'),
  ]);
  assert.equal(turns.length, 3);
  assert.equal(
    turns[0].items[0].content[0].text,
    '(Earlier in this conversation, handed over from another host:)\n<sage-handoff>earlier talk</sage-handoff>',
  );
  assert.equal(turns[0].items.length, 3);
  assert.deepEqual(
    turns.slice(1).map((t: any) => t.items.length),
    [0, 0],
  );
});
