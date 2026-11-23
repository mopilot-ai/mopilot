// A compacted Claude chat read back keeps the conversation before its compaction (electron/platform/claudeCompactedHistory.cjs):
// the SDK's reader stops at the compact_boundary, so main joins the folded messages to it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fakes, load, home } from './support/electron-claude.ts';
import { readPage } from './support/claude-translate.ts';

const require = createRequire(import.meta.url);
const { compactedHistory } = require('../electron/platform/claudeCompactedHistory.cjs');
// Resolve by file URL so this boundary is the installed SDK, rather than the Electron fixture's SDK mock.
const sdk = await import(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', import.meta.url).href);
const at = '2026-10-22T12:00:00Z';
const row = (uuid: string, parentUuid: string | null, type: string, extra: any = {}) => ({
  uuid,
  parentUuid,
  type,
  timestamp: at,
  ...extra,
});
const user = (id: string, parent: string | null, extra: any = {}) =>
  row(id, parent, 'user', { message: { role: 'user', content: id }, ...extra });
const reply = (id: string, parent: string) =>
  row(id, parent, 'assistant', { message: { id, role: 'assistant', content: [{ type: 'text', text: id }], stop_reason: 'end_turn' } });
const boundary = (id: string, logicalParent: string) =>
  row(id, null, 'system', {
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    logicalParentUuid: logicalParent,
    compactMetadata: { trigger: 'manual', preTokens: 9 },
  });
const summary = (id: string, parent: string) => user(id, parent, { isCompactSummary: true });

function fixture(records: any[]) {
  const t = load();
  const sid = randomUUID();
  const file = path.join(home, '.claude', 'projects', sid, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((m) => JSON.stringify(m)).join('\n') + '\n');
  fakes.sdk.getSessionMessages = (id: string, opts: any) =>
    sdk.getSessionMessages(id, { ...opts, sessionStore: { load: async () => records }, dir: '/repo' });
  return { t, sid, file };
}

const once = [
  user('u1', null),
  reply('a1', 'u1'),
  user('u2', 'a1'),
  reply('a2', 'u2'),
  boundary('b1', 'a2'),
  summary('s1', 'b1'),
  user('u3', 's1'),
  reply('a3', 'u3'),
];

test('the SDK stops at the compaction, and main puts the folded conversation back before it', async () => {
  const f = fixture(once);
  const raw = await sdk.getSessionMessages(f.sid, { includeSystemMessages: true, sessionStore: { load: async () => once }, dir: '/repo' });
  assert.deepEqual(
    raw.map((m: any) => m.uuid).filter((id: string) => /^[ua]\d$/.test(id)),
    ['u3', 'a3'],
    'the reader the bug came from drops u1..a2',
  );
  const messages = await f.t.claude.messages(f.sid);
  assert.deepEqual(
    messages.map((m: any) => m.uuid),
    ['u1', 'a1', 'u2', 'a2', 'b1', 's1', 'u3', 'a3'],
  );
  const items = readPage(await f.t.call('claude:turns', f.sid, { cwd: '/repo' })).turns.flatMap((t: any) => t.items);
  assert.deepEqual(
    items.filter((i: any) => i.type === 'userMessage').map((i: any) => i.content[0].text),
    ['u1', 'u2', 'u3'],
  );
  assert.equal(items.filter((i: any) => i.type === 'contextCompaction').length, 1, 'one divider, where the compaction was');
});

test('every earlier compaction keeps its own boundary, and a chat never compacted is read as before', async () => {
  const twice = [
    user('u1', null),
    reply('a1', 'u1'),
    boundary('b1', 'a1'),
    summary('s1', 'b1'),
    user('u2', 's1'),
    reply('a2', 'u2'),
    boundary('b2', 'a2'),
    summary('s2', 'b2'),
    user('u3', 's2'),
    reply('a3', 'u3'),
  ];
  const f = fixture(twice);
  assert.deepEqual(
    (await f.t.claude.messages(f.sid)).map((m: any) => m.uuid),
    ['u1', 'a1', 'b1', 's1', 'u2', 'a2', 'b2', 's2', 'u3', 'a3'],
  );
  // each compaction is one divider: an earlier boundary is listed bare, as the SDK lists the last, so only its summary draws one
  const items = readPage(await f.t.call('claude:turns', f.sid, { cwd: '/repo' })).turns.flatMap((t: any) => t.items);
  assert.equal(items.filter((i: any) => i.type === 'contextCompaction').length, 2);
  const plain = fixture([user('u1', null), reply('a1', 'u1')]);
  assert.deepEqual(
    (await plain.t.claude.messages(plain.sid)).map((m: any) => m.uuid),
    ['u1', 'a1'],
  );
});

test('the chain goes through records that are no messages, and a line written twice comes back once', async () => {
  const note = row('att1', 'a1', 'attachment');
  const rows = [
    user('u1', null),
    reply('a1', 'u1'),
    note,
    user('u2', 'att1'),
    user('u2', 'att1'),
    reply('a2', 'u2'),
    boundary('b1', 'a2'),
    summary('s1', 'b1'),
  ];
  const f = fixture(rows);
  assert.deepEqual(
    (await f.t.claude.messages(f.sid)).map((m: any) => m.uuid),
    ['u1', 'a1', 'u2', 'a2', 'b1', 's1'],
  );
});

test('only the chat’s own messages come back: no sidechain, no loop, nothing the SDK already gave, no file', async () => {
  const f = fixture(once);
  const side = { ...user('side', 'a1'), isSidechain: true };
  const loop = [user('x1', 'x2'), reply('x2', 'x1'), boundary('bx', 'x2'), summary('sx', 'bx')];
  const file = (rows: any[]) => {
    const p = path.join(home, `${randomUUID()}.jsonl`);
    fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return p;
  };
  const kept = [
    { uuid: 'bx', type: 'system' },
    { uuid: 'sx', isCompactSummary: true },
  ];
  assert.deepEqual(
    (
      await compactedHistory(file([...once.slice(0, 4), side, ...once.slice(4)]), [{ uuid: 'b1' }, { uuid: 's1', isCompactSummary: true }])
    ).map((m: any) => m.uuid),
    ['u1', 'a1', 'u2', 'a2'],
  );
  assert.deepEqual(
    (await compactedHistory(file(loop), kept)).map((m: any) => m.uuid),
    ['x1', 'x2'],
    'a looping parent chain ends',
  );
  assert.deepEqual(
    await compactedHistory(file(once), [
      ...['u1', 'a1', 'u2', 'a2', 'b1'].map((uuid) => ({ uuid })),
      { uuid: 's1', isCompactSummary: true },
    ]),
    [],
    'a message the SDK already gave is not given twice',
  );
  // a meta line the CLI wrote (not a prompt) keeps its flag, so it is still no turn of its own
  const meta = [user('m1', null, { isMeta: true }), reply('a1', 'm1'), boundary('b1', 'a1'), summary('s1', 'b1')];
  const back = await compactedHistory(file(meta), [{ uuid: 'b1' }, { uuid: 's1', isCompactSummary: true }]);
  assert.deepEqual(
    back.map((m: any) => [m.uuid, m.is_meta ?? false]),
    [
      ['m1', true],
      ['a1', false],
    ],
  );
  assert.deepEqual(await compactedHistory(null, kept), []);
  assert.deepEqual(await compactedHistory(file(once), [{ uuid: 'u3' }]), [], 'no summary: nothing was compacted');
  assert.equal(f.sid.length > 0, true);
});
