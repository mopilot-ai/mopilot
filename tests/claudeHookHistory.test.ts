// Native hook notices survive the real SDK's history filtering and main's transcript reader without reviving retired branches.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { fakes, load, home } from './support/electron-claude.ts';
import { claudeLimitNotifications, CLAUDE_LIMIT_TEXT } from './fixtures/claude-limit-notifications.mjs';
import { subagentItems } from './support/claude-translate.ts';
import { readPage } from './support/claude-translate.ts';

const require = createRequire(import.meta.url);
const { readHookRecords, withHookNotices: restoreNotices } = require('../electron/platform/claudeTranscriptNotices.cjs');
const withHookNotices = async (messages: any[], file: string | null, cutoff?: string) =>
  restoreNotices(messages, await readHookRecords(file), cutoff);
const { createTranscripts } = require('../electron/harness/claude/transcripts.cjs');
// Resolve by file URL so this boundary is the installed SDK, rather than the Electron fixture's SDK mock.
const sdk = await import(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', import.meta.url).href);
const row = (uuid: string, parentUuid: string | null, type: string, extra: any = {}) => ({
  uuid,
  parentUuid,
  type,
  timestamp: '2026-10-22T12:00:00Z',
  ...extra,
});
const user = (id: string, parent: string | null) => row(id, parent, 'user', { message: { role: 'user', content: id } });
const reply = (id: string, parent: string) =>
  row(id, parent, 'assistant', { message: { id, role: 'assistant', content: [{ type: 'text', text: id }] } });
const notice = (id: string, parent: string | null, extra: any = {}) =>
  row(id, parent, 'system', { subtype: 'informational', level: 'warning', content: id, ...extra });

function fixture(records: any[]) {
  const t = load();
  const sid = randomUUID();
  const file = path.join(home, '.claude', 'projects', sid, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const options: any[] = [];
  fakes.sdk.getSessionMessages = async (id: string, opts: any) => {
    options.push(opts);
    return sdk.getSessionMessages(id, { ...opts, sessionStore: { load: async () => records }, dir: '/repo' });
  };
  return { t, sid, file, options };
}

test('typed assistant failures survive the actual SDK and repeated background limits replay as one status', async () => {
  const records = claudeLimitNotifications();
  const f = fixture(records);
  const rawSdk = await sdk.getSessionMessages(f.sid, { sessionStore: { load: async () => records }, dir: '/repo' });
  assert.equal(rawSdk.at(-1).error, undefined, 'the SDK strips the native failure type');
  const messages = await f.t.claude.messages(f.sid);
  assert.deepEqual(
    messages.filter((m: any) => m.error).map((m: any) => m.error),
    ['rate_limit', 'rate_limit'],
  );
  const page = readPage(await f.t.call('claude:turns', f.sid, { cwd: '/repo' }));
  const items = page.turns.flatMap((t: any) => t.items);
  assert.deepEqual(
    items.filter((i: any) => i.kind === 'limit').map((i: any) => i.text),
    [CLAUDE_LIMIT_TEXT],
  );
  assert.deepEqual(
    items.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text),
    ['The checks are running.'],
  );
});

test('subagent errors survive the actual SDK sidecar reader and preserve separate recovery episodes', async () => {
  const f = fixture([user('parent', null)]);
  const agentId = 'a0123456789abcdef';
  const limited = (id: string, parent: string, text: string) => ({
    ...reply(id, parent),
    error: 'rate_limit',
    message: { role: 'assistant', id, model: '<synthetic>', content: [{ type: 'text', text }] },
  });
  const records = [user('u', null), limited('first', 'u', 'First limit'), reply('ok', 'first'), limited('second', 'ok', 'Second limit')];
  const file = path.join(path.dirname(f.file), f.sid, 'subagents', `agent-${agentId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((m) => JSON.stringify(m)).join('\n') + '\n');
  fakes.sdk.getSubagentMessages = (id: string, aid: string) =>
    sdk.getSubagentMessages(id, aid, { sessionStore: { load: async () => records } });
  const sdkOnly = await fakes.sdk.getSubagentMessages(f.sid, agentId);
  assert.equal(sdkOnly.at(-1).error, undefined);
  const read = async () =>
    JSON.parse(
      String(await f.t.call('claude:subagentItems', f.sid, agentId, { chatId: 'chat', cwd: '/repo', settled: false, dir: '/repo' })),
    );
  assert.deepEqual(
    (await read()).items.map((i: any) => i.text),
    ['First limit', 'ok', 'Second limit'],
  );
  fs.rmSync(file);
  assert.deepEqual(
    (await read()).items,
    subagentItems(sdkOnly, 'chat', '/repo'),
    'a missing sidecar leaves the selected SDK messages intact',
  );
});

test('error metadata cannot revive a retired branch or survive a current rewind', async () => {
  const records = [user('u', null), { ...reply('old-limit', 'u'), error: 'rate_limit' }, reply('new', 'u')];
  const f = fixture(records);
  const messages = await f.t.claude.messages(f.sid);
  assert.deepEqual(
    messages.map((m: any) => m.uuid),
    ['u', 'new'],
  );
  assert.ok(messages.every((m: any) => !m.error));
  const current = [...records, { ...reply('current-limit', 'new'), error: 'rate_limit' }];
  fs.writeFileSync(f.file, current.map((m) => JSON.stringify(m)).join('\n') + '\n');
  fakes.sdk.getSessionMessages = (id: string, opts: any) =>
    sdk.getSessionMessages(id, { ...opts, sessionStore: { load: async () => current }, dir: '/repo' });
  const reader = createTranscripts({ sdk: async () => fakes.sdk, resumeAt: new Map([[`claude:${f.sid}`, 'new']]) });
  assert.deepEqual(
    (await reader.messages(f.sid)).map((m: any) => m.uuid),
    ['u', 'new'],
  );
});

test('restored authentication errors remain a failed historical turn with a readable error', async () => {
  const records = [user('u', null), { ...reply('auth', 'u'), error: 'authentication_failed' }];
  const f = fixture(records);
  const page = readPage(await f.t.call('claude:turns', f.sid, { cwd: '/repo' }));
  assert.equal(page.turns[0].status, 'failed');
  assert.deepEqual(page.turns[0].error, { message: 'auth' });
  assert.ok(page.turns[0].items.every((i: any) => i.type !== 'agentMessage'));
});

test('typed metadata recovery preserves unchanged selected arrays and ignores malformed error types', async () => {
  const records = [user('u', null), { ...reply('a', 'u'), error: 'rate_limit' }, { ...reply('bad', 'a'), error: 42 }];
  const f = fixture(records);
  const selected = [records[0], records[1], { ...records[2], error: undefined }];
  assert.equal(await withHookNotices(selected, f.file), selected);
  assert.equal((await readHookRecords(f.file)).get('a').message, undefined, 'the metadata scan retains no duplicate body');
});

test('main restores a notice-only rejected prompt omitted by the actual SDK', async () => {
  const records = [notice('blocked', null, { prevent_continuation: true })];
  const f = fixture(records);
  assert.deepEqual(
    await sdk.getSessionMessages(f.sid, { includeSystemMessages: true, sessionStore: { load: async () => records }, dir: '/repo' }),
    [],
  );
  const page = readPage(await f.t.call('claude:turns', f.sid, { cwd: '/repo' }));
  assert.deepEqual(
    page.turns.map((t: any) => [t.id, t.status, t.items[0].fragments[0].text]),
    [['notice-blocked', 'completed', 'blocked']],
  );
  assert.equal(f.options[0].includeSystemMessages, true);
});

test('main restores notice fields stripped by the actual SDK and combines historical sibling notices in order', async () => {
  const records = [
    user('u', null),
    notice('in-chain', 'u'),
    reply('a', 'in-chain'),
    notice('sibling-1', 'a'),
    notice('sibling-2', 'a'),
    user('u2', 'a'),
    reply('a2', 'u2'),
  ];
  const f = fixture(records);
  const messages = await f.t.claude.messages(f.sid);
  assert.deepEqual(
    messages.map((m: any) => m.uuid),
    ['u', 'in-chain', 'a', 'sibling-1', 'sibling-2', 'u2', 'a2'],
  );
  assert.equal(messages[1].subtype, 'informational');
  assert.equal(messages[1].level, 'warning');
  assert.equal(messages[1].content, 'in-chain');
  const page = readPage(await f.t.call('claude:turns', f.sid, { cwd: '/repo' }));
  assert.deepEqual(
    page.turns.flatMap((t: any) => t.items.filter((i: any) => i.type === 'hookPrompt').map((i: any) => i.fragments[0].text)),
    ['in-chain', 'sibling-1', 'sibling-2'],
  );
});

test('main preserves raw notice order when an omitted notice shares an older ancestor', async () => {
  const records = [user('u', null), notice('first', 'u'), reply('a', 'first'), notice('second', 'u'), user('u2', 'a'), reply('a2', 'u2')];
  const f = fixture(records);
  assert.deepEqual(
    (await sdk.getSessionMessages(f.sid, { includeSystemMessages: true, sessionStore: { load: async () => records }, dir: '/repo' })).map(
      (m: any) => m.uuid,
    ),
    ['u', 'first', 'a', 'u2', 'a2'],
  );
  assert.deepEqual(
    (await f.t.claude.messages(f.sid)).map((m: any) => m.uuid),
    records.map((m) => m.uuid),
  );
});

test('main excludes notices that belong to a retired conversation branch and respects an edit cutoff', async () => {
  const records = [
    user('u', null),
    notice('old-notice', 'u'),
    reply('old-a', 'old-notice'),
    reply('new-a', 'u'),
    notice('new-notice', 'new-a'),
  ];
  const f = fixture(records);
  assert.deepEqual(
    (await f.t.claude.messages(f.sid)).map((m: any) => m.uuid),
    ['u', 'new-a', 'new-notice'],
  );
  const reader = createTranscripts({ sdk: async () => fakes.sdk, resumeAt: new Map([[`claude:${f.sid}`, 'u']]) });
  assert.deepEqual(
    (await reader.messages(f.sid)).map((m: any) => m.uuid),
    ['u'],
  );
});

test('raw recovery ignores malformed, hidden, unanchored and cyclic records, keeping independent valid notices', async () => {
  const f = fixture([]);
  const records = [
    notice('root', null),
    notice('nested', 'root'),
    notice('side', null, { isSidechain: true }),
    notice('team', null, { teamName: 'other' }),
    notice('meta', null, { isMeta: true }),
    notice('unanchored', 'missing'),
    notice('cycle', 'cycle'),
    { uuid: 5, type: 'system' },
    row('bridge', null, 'progress'),
    notice('via-bridge', 'bridge'),
    notice('updated', null, { content: 'old' }),
    notice('updated', null, { content: 'new' }),
  ];
  fs.writeFileSync(f.file, records.map((m) => JSON.stringify(m)).join('\n') + '\nnull\n[]\n{truncated');
  const restored = await withHookNotices([], f.file);
  assert.deepEqual(
    restored.map((m: any) => [m.uuid, m.content]),
    [
      ['root', 'root'],
      ['nested', 'nested'],
      ['via-bridge', 'via-bridge'],
      ['updated', 'new'],
    ],
  );
  assert.deepEqual(await withHookNotices([{ uuid: 'missing-raw', type: 'user' }], f.file), [{ uuid: 'missing-raw', type: 'user' }]);
  assert.deepEqual(await withHookNotices([], null), []);
  await assert.rejects(withHookNotices([], `${f.file}.missing`), /ENOENT/);
});

test('raw recovery does not follow a notice through an excluded user, a hidden ancestor or a parent cycle', async () => {
  const f = fixture([]);
  const records = [
    user('u', null),
    reply('a', 'u'),
    notice('retired-before-user', 'u'),
    user('retired-user', 'retired-before-user'),
    notice('retired-after-user', 'retired-user'),
    row('hidden', 'a', 'progress', { isSidechain: true }),
    notice('hidden-child', 'hidden'),
    row('cycle-a', 'cycle-b', 'progress'),
    row('cycle-b', 'cycle-a', 'progress'),
    notice('cycle-child', 'cycle-a'),
    notice('unknown-parent', 'missing'),
    notice('root-in-conversation', null),
    notice('valid', 'a'),
  ];
  fs.writeFileSync(f.file, records.map((m) => JSON.stringify(m)).join('\n') + '\n');
  assert.deepEqual(
    (await withHookNotices(records.slice(0, 2), f.file)).map((m: any) => m.uuid),
    ['u', 'a', 'valid'],
  );
  assert.deepEqual(await withHookNotices([], f.file), []);
});

test('a rewind during an SDK read applies the current cutoff before any reply or notice is returned', async () => {
  const records = [user('u', null), reply('a', 'u'), notice('after', 'a')];
  const f = fixture(records);
  let resolveSdk!: (messages: any[]) => void;
  let sdkStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    sdkStarted = resolve;
  });
  const sdkPending = new Promise<any[]>((resolve) => {
    resolveSdk = resolve;
  });
  const resumeAt = new Map();
  const reader = createTranscripts({
    sdk: async () => ({
      getSessionMessages: () => {
        sdkStarted();
        return sdkPending;
      },
    }),
    resumeAt,
  });
  const pending = reader.messages(f.sid);
  await started;
  resumeAt.set(`claude:${f.sid}`, 'u');
  resolveSdk(records.slice(0, 2));
  assert.deepEqual(
    (await pending).map((m: any) => m.uuid),
    ['u'],
  );
});

test('rewind and new-send changes during the raw read both use the latest cutoff', async () => {
  for (const remove of [false, true]) {
    const records = [user('u', null), reply('a', 'u'), notice('after', 'a')];
    const f = fixture(records);
    const resumeAt = new Map(remove ? [[`claude:${f.sid}`, 'u']] : []);
    const stream = new PassThrough();
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const real = fs.createReadStream;
    const read = mock.method(fs, 'createReadStream', (file: string, ...rest: any[]) => {
      if (file !== f.file) return real(file, ...rest);
      readStarted();
      return stream;
    });
    try {
      const reader = createTranscripts({ sdk: async () => fakes.sdk, resumeAt });
      const pending = reader.messages(f.sid);
      await started;
      if (remove) resumeAt.delete(`claude:${f.sid}`);
      else resumeAt.set(`claude:${f.sid}`, 'u');
      stream.end(records.map((m) => JSON.stringify(m)).join('\n') + '\n');
      assert.deepEqual(
        (await pending).map((m: any) => m.uuid),
        remove ? ['u', 'a', 'after'] : ['u'],
      );
    } finally {
      read.mock.restore();
    }
  }
});
