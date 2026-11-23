// Stable-chat switching through ACP adapters, including identity collisions, reopen and failure recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY } from '../src/harness/registry.ts';
import { transcriptItems } from './support/acp-transcript.ts';

export const GUARDS = ['electron/', 'shared/', 'src/harness/'];

const require = createRequire(import.meta.url);
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { ChatsStore, toRendererSegment } = require('../electron/platform/chats.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { switchLabel, switchAdapter } = require('../electron/session/switchAdapters.cjs');
const target = (harness: string, extra = {}) => ({ harness, model: '', modelLabel: '', mode: 'auto', ...extra });

test('adapter discovery rejects malformed kinds and labels custom or obsolete adapters accurately', () => {
  for (const kind of [null, undefined, 'other', 'acp:', 'acp:kimi:session']) assert.equal(switchAdapter(kind), null);
  assert.equal(switchLabel('acp:custom', { describe: () => null }), 'custom');
  assert.equal(switchLabel('acp:custom', { describe: () => ({}) }), 'custom');
  assert.equal(switchLabel('future', null), 'another harness');
  assert.equal(switchLabel(undefined, null), 'another harness');
});

function setup(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-chat-switch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chats = new ChatsStore(path.join(dir, 'threads'), { legacyMirror: false });
  const events: any[] = [];
  const claims = new Map<string, string>();
  const logs = new Map<string, any[]>();
  const sessions = new Map<string, any>();
  const ref = (id: string) => {
    const seg = chats.record(id).segments.at(-1);
    return { kind: seg.kind, id: seg.nativeId, key: toRendererSegment(seg).nativeId, instance: null };
  };
  const acpHost = {
    chats: sessions,
    items: transcriptItems((key) => logs.get(key) ?? []),
    history: async (key: string) => logs.get(key) ?? [],
    ensure: async (key: string, opts: any) => {
      assert.equal(claims.get(key), opts.chatId, 'tools see the stable chat before session/new');
      if (sessions.has(key)) return sessions.get(key);
      const chat = {
        key,
        harness: key.split(':')[1],
        cwd: opts.cwd,
        fresh: true,
        state: { configOptions: null, modes: null },
        agent: { caps: {} },
      };
      sessions.set(key, chat);
      logs.set(key, [...(logs.get(key) ?? []), { t: 'session', cwd: opts.cwd, sessionId: 'replacement' }]);
      return chat;
    },
    emitEvent: (e: any) => events.push(e),
  };
  const runner = new SwitchRunner({
    chats,
    ref,
    acpHost,
    claim: (key: string, id: string) => claims.set(key, id),
    unclaim: (key: string) => claims.delete(key),
    invalidate() {},
    changed() {},
    prefs: () => ({ permission: 'default' }),
    home: '/home/me',
    emit: (e: any) => events.push(e),
    git: { info: async () => null, status: async () => null },
    permissionParams: () => ({}),
    codex: {
      ensureResumed: async () => {},
      cwdOf: () => '/repo',
      threadTurns: async () => ({ data: [], nextCursor: null }),
      startThread: async () => ({ thread: { id: 'cx-next' } }),
    },
    claude: {
      isFresh: () => true,
      cwdOf: () => '/repo',
      messages: async () => [],
      registerSession() {},
    },
  });
  return { runner, chats, events, claims, logs, sessions, acpHost, ref, ChatController };
}

test('Codex → ACP keeps the chat and claims its native session before opening tools', async (t) => {
  const s = setup(t);
  s.chats.patchMeta('chat', { pinned: true, projectId: 'project' });
  const r = await s.runner.perform('chat', target('acp:opencode'));
  assert.equal(r.ready, true);
  const rec = s.chats.record('chat');
  assert.equal(rec.segments.length, 2);
  assert.equal(rec.segments[1].kind, 'acp:opencode');
  assert.equal(rec.meta.pinned, true);
  assert.equal(rec.meta.projectId, 'project');
  assert.equal(s.chats.records.size, 1);
  assert.equal(s.claims.size, 0);
  assert.match(r.note.text, /Codex → opencode/);
  assert.match(r.prefix, /Directory: \/repo/);
});

const transcript = (text: string, cwd = '/repo') => [
  { t: 'session', cwd, sessionId: 'agent-native' },
  { t: 'user', turnId: 't', at: 1, user: { id: 'u', content: [{ type: 'text', text }] } },
  { t: 'update', turnId: 't', at: 2, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer ${text}` } } },
  { t: 'end', turnId: 't', at: 3, stopReason: 'end_turn' },
];

for (const from of Object.keys(REGISTRY)) {
  for (const to of Object.keys(REGISTRY)) {
    if (from === to) continue;
    test(`${from} → ${to} keeps one durable chat and identifies the full native kind`, async (t) => {
      const s = setup(t);
      s.chats.commit({ ...s.chats.record('chat'), segments: [{ kind: from, nativeId: 'same', start: 0, count: null }] });
      if (from.startsWith('acp:')) s.logs.set(`${from}:same`, transcript(from));
      const r = await s.runner.perform('chat', target(to));
      assert.equal(r.ready, true);
      assert.equal(s.chats.records.size, 1);
      assert.equal(s.ref('chat').kind, to);
      assert.doesNotMatch(r.note.text, /undefined/);
      assert.match(r.prefix, /Directory: \/repo/);
      if (from.startsWith('acp:')) assert.match(r.prefix, new RegExp(`User: ${from}`));
      const reload = new ChatsStore(s.chats.dir, { legacyMirror: false });
      assert.equal(reload.record('chat').segments.at(-1).kind, to);
    });
  }
}

for (const replaced of [false, true]) {
  test(`returning to ACP ${replaced ? 'replays full context when session/new replaced it' : 'resumes the live session with only the missed turns'}`, async (t) => {
    const s = setup(t);
    const chat = 'acp:opencode:original';
    s.logs.set(chat, transcript('original question'));
    s.sessions.set(chat, { key: chat, cwd: '/repo', state: {}, agent: { caps: {} }, harness: 'opencode' });
    await s.runner.perform(chat, target('acp:kimi'));
    const kimi = s.ref(chat).key;
    s.logs.set(kimi, transcript('intervening question'));
    if (replaced) s.sessions.delete(chat);
    const r = await s.runner.perform(chat, target('acp:opencode'));
    assert.equal(r.ready, true);
    assert.equal(s.ref(chat).key, chat);
    assert.match(r.prefix, /intervening question/);
    if (replaced) assert.match(r.prefix, /original question/);
    else assert.doesNotMatch(r.prefix, /original question/);
    assert.equal(s.chats.record(chat).segments[2].handoff.mode, replaced ? 'auto' : 'delta');
  });
}

test('native ids shared by different ACP harnesses never alias histories', async (t) => {
  const s = setup(t);
  const segs = [
    { kind: 'acp:opencode', nativeId: 'same:id', start: 0, count: 1 },
    { kind: 'acp:kimi', nativeId: 'same:id', start: 1, count: null },
  ];
  s.logs.set('acp:opencode:same:id', transcript('OpenCode only'));
  s.logs.set('acp:kimi:same:id', transcript('Kimi only'));
  s.chats.commit({ ...s.chats.record('chat'), segments: segs });
  const r = await s.runner.perform('chat', target('claude'));
  assert.equal(r.ready, true);
  assert.match(r.prefix, /OpenCode only/);
  assert.match(r.prefix, /Kimi only/);
  assert.equal(s.chats.record('chat').segments.at(-1).start, 2);
});

test('history loss evidence belongs to the full native kind even when another harness has the same id', async (t) => {
  const s = setup(t);
  s.runner.rollouts = { history: async () => null };
  s.runner.codex.threadTurns = async () => {
    throw new Error('Codex unavailable');
  };
  for (const count of [null, 1]) {
    const failed: any[] = [];
    await s.runner.history(
      'chat',
      [
        { kind: 'acp:opencode', nativeId: 'same', start: 0, count: 1 },
        { kind: 'codex', nativeId: 'same', start: 1, count },
      ],
      '/repo',
      failed,
    );
    assert.deepEqual(
      failed.map((f) => f.kind),
      count ? ['codex'] : [],
    );
  }
});

test('ACP startup failure and a refused segment write retain the old owner and release claims', async (t) => {
  const s = setup(t);
  const original = s.acpHost.ensure;
  s.acpHost.ensure = async () => {
    throw new Error('Sign in first');
  };
  const failed = await s.runner.perform('chat', target('acp:opencode'));
  assert.equal(failed.ready, false);
  assert.match(failed.error, /opencode: Sign in first.*message is kept/);
  assert.equal(s.ref('chat').kind, 'codex');
  assert.equal(s.claims.size, 0);
  s.acpHost.ensure = original;
  const commit = s.chats.commit.bind(s.chats);
  s.chats.commit = () => false;
  assert.equal((await s.runner.perform('chat', target('acp:opencode'))).ready, false);
  assert.equal(s.ref('chat').kind, 'codex');
  assert.equal(s.claims.size, 0);
  s.chats.commit = commit;
  assert.equal((await s.runner.perform('chat', target('acp:opencode'))).ready, true);
});

test('ACP history failures are named while the readable conversation still transfers', async (t) => {
  const s = setup(t);
  const chat = 'acp:opencode:old';
  s.acpHost.items.flush = async () => {
    throw new Error('disk unreadable');
  };
  // The live session still supplies the workspace when its history cannot be read.
  s.sessions.set(chat, { cwd: '/repo' });
  const r = await s.runner.perform(chat, target('codex'));
  assert.equal(r.ready, true);
  assert.match(s.events.find((e) => e.kind === 'toast').text, /opencode.*disk unreadable/);
});

test('a custom admitted ACP adapter activates without a static label or permission anchors', async (t) => {
  const s = setup(t);
  s.runner.acpQuirks = { describe: () => null };
  const r = await s.runner.perform('chat', target('acp:custom'));
  assert.equal(r.ready, true);
  assert.match(r.note.text, /Codex → custom/);
  assert.deepEqual(s.events.find((e) => e.kind === 'session').anchors, {});
});
