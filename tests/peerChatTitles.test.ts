// list_chats names a chat as the sidebar does on every harness (#3364): electron/app/ipc/chatList.cjs chatTitleReader feeds
// electron/session/peerRuntime.cjs directory, so a fleet of Codex, Claude Code and ACP chats finds each other by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chatTitleReader, register } = require('../electron/app/ipc/chatList.cjs');
const { nativeIdsOf } = require('../electron/platform/chats.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { PeerRuntime } = require('../electron/session/peerRuntime.cjs');

const records = () =>
  new Map<string, any>([
    ['C', { segments: [{ kind: 'codex', nativeId: 'thread-C' }], meta: {}, updatedAt: 3 }],
    ['A', { segments: [{ kind: 'claude', nativeId: 'native-A' }], meta: {}, updatedAt: 2 }],
    // switched from Claude Code to an ACP harness: its first session names it
    [
      'S',
      {
        segments: [
          { kind: 'claude', nativeId: 'native-S' },
          { kind: 'acp:kimi', nativeId: 'k1' },
        ],
        meta: {},
        updatedAt: 1,
      },
    ],
  ]);
const keys = (recs: Map<string, any>) => new Map<string, string[]>(nativeIdsOf(recs));

test('every harness names its chats, a switched chat keeps its first name, and a failing list names only its own chats', async () => {
  const recs = records();
  const k = keys(recs);
  const seen: unknown[] = [];
  const sources = {
    codex: async (archived: boolean) => (
      seen.push(archived), [{ key: k.get('C')![0], title: 'MoPilot iOS new chat screens', cwd: null, at: 1 }]
    ),
    claude: async () => [
      { key: k.get('A')![0], title: 'MoMo开发', cwd: null, at: 2 },
      { key: k.get('S')![0], title: 'mopilot Remote Run', cwd: null, at: 3 },
      { key: 'claude:untitled', title: null, cwd: null, at: 4 },
    ],
    acp: async () => [{ key: k.get('S')![1], title: 'later segment', cwd: null, at: 5 }],
  };
  const read = chatTitleReader({ chats: { records: recs } }, null, sources);
  const titles = await read();
  assert.deepEqual(Object.fromEntries(titles), { C: 'MoPilot iOS new chat screens', A: 'MoMo开发', S: 'mopilot Remote Run' });
  // archived chats are listed too, so they are named
  assert.deepEqual(seen, [true]);
  // Claude Code's list fails (as an Error or anything else): Codex and ACP chats keep their names
  for (const failure of [new Error('claude down'), 'claude down']) {
    const broken = chatTitleReader({ chats: { records: recs } }, null, { ...sources, claude: async () => Promise.reject(failure) });
    assert.deepEqual(Object.fromEntries(await broken()), { C: 'MoPilot iOS new chat screens', S: 'later segment' });
  }
  // a list that never answers (an app server still starting) names none of its chats instead of holding list_chats
  const stalled = chatTitleReader({ chats: { records: recs } }, null, { ...sources, codex: () => new Promise(() => {}) }, 20);
  assert.deepEqual(Object.fromEntries(await stalled()), { A: 'MoMo开发', S: 'mopilot Remote Run' });
});

test('list_chats and list_sidebar share one read of each harness list per app, archived Codex threads included', async () => {
  const recs = records();
  const k = keys(recs);
  const reads: string[] = [];
  const live = {
    chats: { records: recs },
    codex: {
      threadList: async ({ archived }: any) => (
        reads.push(`codex:${archived}`),
        { data: archived ? [{ id: k.get('C')![0], name: 'Archived iOS', updatedAt: 1 }] : [], nextCursor: null }
      ),
    },
    acpHost: { list: async () => (reads.push('acp'), []) },
  };
  const claude = { listSessions: async () => (reads.push('claude'), []) };
  const first = chatTitleReader(live, claude);
  const second = chatTitleReader(live, claude);
  assert.deepEqual(Object.fromEntries(await first()), { C: 'Archived iOS' });
  await second();
  assert.deepEqual(reads.sort(), ['acp', 'claude', 'codex:false', 'codex:true']);
});

function runtime(t: any, titles?: () => Promise<Map<string, string>>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-titles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = new Registry();
  const controller: any = {
    rt: () => ({ token: null }),
    state: { get: () => ({ turn: 'idle' }) },
    send: () => ({ action: 'queued' }),
    peerCapabilities: () => ({ messaging: true, read: true, steer: false }),
  };
  new PeerRuntime({
    file: path.join(dir, 'journal.json'),
    controller,
    chats: { records: records() },
    registry,
    sourceWindow: () => null,
    gate: () => null,
    read: () => ({}),
    ...(titles ? { titles } : {}),
  });
  return registry;
}

test('list_chats finds a chat on another harness by the name the user calls it', async (t) => {
  const registry = runtime(
    t,
    async () =>
      new Map([
        ['A', 'MoMo开发'],
        ['S', 'mopilot Remote Run'],
        ['C', 'MoPilot iOS new chat screens'],
      ]),
  );
  const found = await registry.invoke('C', 'thread-C', 'list_chats', { query: 'momo' });
  const list = JSON.parse(found.content[0].text);
  assert.deepEqual(
    list.chats.map((c: any) => [c.id, c.title]),
    [['A', 'MoMo开发']],
  );
  const remote = JSON.parse((await registry.invoke('A', 'claude:native-A', 'list_chats', { query: 'Remote Run' })).content[0].text);
  assert.deepEqual(
    remote.chats.map((c: any) => c.id),
    ['S'],
  );
});

test('without titles, or when reading them fails, list_chats still lists every chat by id', async (t) => {
  const none = JSON.parse((await runtime(t).invoke('C', 'thread-C', 'list_chats', {})).content[0].text);
  assert.deepEqual(
    none.chats.map((c: any) => c.title),
    ['A', 'S'],
  );
  const failing = runtime(t, async () => Promise.reject(new Error('lists down')));
  const listed = JSON.parse((await failing.invoke('C', 'thread-C', 'list_chats', {})).content[0].text);
  assert.deepEqual(
    listed.chats.map((c: any) => c.id),
    ['A', 'S'],
  );
});

test('wired in main: registering IPC names the peer runtime’s chats, so list_chats finds a Claude Code chat by name', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-titles-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recs = records();
  const registry = new Registry();
  const peerRuntime = new PeerRuntime({
    file: path.join(dir, 'journal.json'),
    controller: {
      rt: () => ({ token: null }),
      state: { get: () => ({ turn: 'idle' }) },
      send: () => ({ action: 'queued' }),
      peerCapabilities: () => ({ messaging: true, read: true, steer: false }),
    },
    chats: { records: recs },
    registry,
    sourceWindow: () => null,
    gate: () => null,
    read: () => ({}),
  });
  const live = {
    peerRuntime,
    capabilities: new Registry(),
    chats: { records: recs },
    codex: { threadList: async () => ({ data: [], nextCursor: null }) },
    acpHost: { list: async () => [] },
  };
  const claude = { listSessions: async () => [{ sessionId: 'native-A', customTitle: 'MoMo开发', lastModified: 1 }] };
  register(null, { live, app: { getPath: () => dir }, readState: () => ({ prefs: {} }), claude });
  const found = JSON.parse((await registry.invoke('C', 'thread-C', 'list_chats', { query: 'MoMo' })).content[0].text);
  assert.deepEqual(
    found.chats.map((c: any) => [c.id, c.title]),
    [['A', 'MoMo开发']],
  );
});
