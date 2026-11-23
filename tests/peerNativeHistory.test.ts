import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTurns } from './support/claude-translate.ts';
import { acpTurnsOf, transcriptHost } from './support/acp-transcript.ts';
const require = createRequire(import.meta.url);
// Codex's sessions folder, empty: a thread's rollout file is only what a test gives the reader
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-codex-home-'));
const { createPeerNativeReader, claudePeerSource, acpPeerSource } = require('../electron/session/peerNativeHistory.cjs');

test('shared native readers normalize all harness histories without starting or resuming a turn', async () => {
  const calls: string[] = [];
  const read = createPeerNativeReader({
    claudeTurns: async (id: string, cwd: string, o: any) => {
      calls.push(`claude:${id}`);
      return buildTurns(
        [
          { type: 'user', uuid: 'u', message: { role: 'user', content: 'Request' } },
          { type: 'assistant', uuid: 'a', message: { id: 'a', content: [{ type: 'text', text: 'Answer' }] } },
        ],
        id,
        cwd,
        o,
      );
    },
    acpTurns: acpTurnsOf((id: string) => {
      calls.push(id);
      return [
        { t: 'user', turnId: 'at', user: { id: 'u', clientId: 'peer', content: [{ type: 'text', text: 'Request' }] } },
        { t: 'update', turnId: 'at', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Answer' } } },
        { t: 'end', turnId: 'at', stopReason: 'end_turn' },
      ];
    }),
    codexTurns: async (id: string, opts: any) => {
      calls.push(`codex:${id}`);
      return opts.cursor
        ? { data: [{ id: 'old', status: 'completed', items: [] }] }
        : { data: [{ id: 'new', status: 'completed', items: [] }], nextCursor: 'older' };
    },
  });
  for (const kind of ['claude', 'acp:test']) {
    const page = await read({ kind, nativeId: 'native' });
    assert.equal(page.truncated, false);
    assert.deepEqual(
      page.turns[0].items.map((item: any) => item.type),
      ['userMessage', 'agentMessage'],
    );
    assert.equal(page.turns[0].items[1].text, 'Answer');
    assert.ok(page.turns[0].itemTimes);
  }
  const codex = await read({ kind: 'codex', nativeId: 'native' });
  assert.deepEqual(
    codex.turns.map((turn: any) => turn.id),
    ['old', 'new'],
  );
  assert.deepEqual(calls, ['claude:native', 'acp:test:native', 'codex:native', 'codex:native']);
});

test('aborts, missing adapters, read failures and repeated native cursors cannot fabricate complete history', async () => {
  let calls = 0;
  const read = createPeerNativeReader({
    codexTurns: async () => {
      calls++;
      return { data: [], nextCursor: 'same' };
    },
    claudeTurns: async () => {
      throw new Error('offline');
    },
  });
  const page = await read({ kind: 'codex', nativeId: 'n' });
  assert.equal(page.truncated, true);
  assert.equal(calls, 2);
  await assert.rejects(read({ kind: 'other', nativeId: 'n' }), /unsupported_history_adapter/);
  await assert.rejects(read({ kind: 'claude', nativeId: 'n' }), /offline/);
  await assert.rejects(read({ kind: 'codex', nativeId: 'n' }, { aborted: true }), /aborted/);
  assert.equal(calls, 2);
});

test("a peer reads an ACP chat's turns through its host", async () => {
  const record = { t: 'user', turnId: 't', user: { id: 'u', clientId: null, content: [] } };
  const { turns } = await acpPeerSource(transcriptHost(() => [record])).acpTurns('acp:kimi:s', 's', { cwd: '/w' });
  assert.deepEqual([turns[0].id, turns[0].status], ['t', 'interrupted']);
});

test('history translation reads project context from each original native segment', async () => {
  const projects: any[] = [];
  const read = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: acpTurnsOf(() => []),
    projectOf: async (seg: any) => {
      projects.push(seg);
      return '/recipient-project';
    },
  });
  await read({ kind: 'claude', nativeId: 'old' });
  await read({ kind: 'acp:test', nativeId: 'current' });
  assert.deepEqual(projects, [
    { kind: 'claude', nativeId: 'old' },
    { kind: 'acp:test', nativeId: 'current' },
  ]);
});

test('an ACP transcript that names its folder is read once: the folder comes from its own session record', async () => {
  const asked: any[] = [];
  let reads = 0;
  const read = createPeerNativeReader({
    acpTurns: acpTurnsOf(() => (reads++, [{ t: 'session', cwd: '/from-transcript' }])),
    projectOf: async (seg: any) => (asked.push(seg), '/elsewhere'),
  });
  assert.equal((await read({ kind: 'acp:test', nativeId: 'named' })).truncated, false);
  assert.equal(reads, 1);
  assert.deepEqual(asked, []);
});

test('an ACP turn main runs now (open) keeps its pending call running; read as history it is a turn that was cut off, and its call failed', async () => {
  // a turn with one call waiting on the user's approval: the prompt has no end record
  const records = [
    { t: 'user', turnId: 'at', user: { id: 'u', clientId: 'peer', content: [{ type: 'text', text: 'Open the site' }] } },
    {
      t: 'update',
      turnId: 'at',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'sage_3f880302123f_chrome_navigate',
        kind: 'other',
        status: 'in_progress',
      },
    },
  ];
  const read = createPeerNativeReader({ acpTurns: acpTurnsOf(() => records) });
  const call = (page: any) => page.turns.at(-1).items.find((i: any) => i.type === 'mcpToolCall');
  const seg = { kind: 'acp:test', nativeId: 'open' };
  const open = await read(seg, undefined, { open: true });
  assert.equal(open.turns.at(-1).status, 'inProgress');
  assert.equal(call(open).status, 'inProgress');
  // not open (a reference, a peer's read): the same records are a turn that never ended, and its call is cut off
  const closed = await read(seg);
  assert.equal(closed.turns.at(-1).status, 'interrupted');
  assert.equal(call(closed).status, 'failed');
  assert.equal(call(await read(seg, undefined, { open: false })).status, 'failed');
});

test('codex history honours a live abort signal between pages and tolerates pages without data', async () => {
  const signal = { aborted: false };
  const read = createPeerNativeReader({
    codexTurns: async (_id: string, opts: any) => {
      if (opts.cursor) {
        signal.aborted = true;
        return { nextCursor: 'later' };
      }
      return { nextCursor: 'older' };
    },
  });
  await assert.rejects(read({ kind: 'codex', nativeId: 'n' }, signal), /aborted/);
  const empty = createPeerNativeReader({ codexTurns: async () => ({}) });
  assert.deepEqual(await empty({ kind: 'codex', nativeId: 'n' }, { aborted: false }), { turns: [], truncated: false });
});

test("Codex down: a Codex segment's history comes from its rollout file; with none, the read's failure stands", async () => {
  const down = async () => {
    throw new Error("Codex isn't connected");
  };
  const read = createPeerNativeReader({
    codexTurns: down,
    codexRollout: async (id: string) => ({ turns: [{ id: `${id}-1`, status: 'completed', items: [] }] }),
  });
  const page = await read({ kind: 'codex', nativeId: 'n' });
  assert.deepEqual(
    page.turns.map((t: any) => t.id),
    ['n-1'],
  );
  assert.equal(page.truncated, false);
  const none = createPeerNativeReader({ codexTurns: down, codexRollout: async () => null });
  await assert.rejects(none({ kind: 'codex', nativeId: 'n' }), /isn't connected/);
  const broken = createPeerNativeReader({
    codexTurns: down,
    codexRollout: async () => {
      throw new Error('bad frame');
    },
  });
  await assert.rejects(broken({ kind: 'codex', nativeId: 'n' }), /isn't connected/);
  // the default reader looks in Codex's own sessions folder, where this thread has none
  await assert.rejects(createPeerNativeReader({ codexTurns: down })({ kind: 'codex', nativeId: 'n' }), /isn't connected/);
});

test('a prose-only read of a Claude chat goes to the replies reader with the folder, and nothing parses the messages in main', async () => {
  const calls: string[] = [];
  const read = createPeerNativeReader({
    claudeTurns: async () => {
      calls.push('messages');
      return [];
    },
    claudeReplies: async (id: string, cwd: string) => (calls.push(`replies:${id}:${cwd}`), [{ id: 't', status: 'completed', items: [] }]),
    projectOf: async () => '/repo',
    acpTurns: acpTurnsOf(() => []),
    codexTurns: async () => ({ data: [] }),
  });
  const page = await read({ kind: 'claude', nativeId: 'n' }, undefined, { assistantOnly: true });
  assert.deepEqual(page, { turns: [{ id: 't', status: 'completed', items: [] }], truncated: false });
  assert.deepEqual(calls, ['replies:n:/repo']);
  // the full read, and a reader without the replies path, parse the messages
  await read({ kind: 'claude', nativeId: 'n' }, undefined, { assistantOnly: false });
  await read({ kind: 'claude', nativeId: 'n' });
  assert.deepEqual(calls.slice(1), ['messages', 'messages']);
  const plain = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: acpTurnsOf(() => []),
    codexTurns: async () => ({ data: [] }),
  });
  assert.deepEqual(await plain({ kind: 'claude', nativeId: 'n' }, undefined, { assistantOnly: true }), { turns: [], truncated: false });
  // no project known: the replies reader gets an empty folder
  const noProject = createPeerNativeReader({
    claudeTurns: async () => [],
    claudeReplies: async (_id: string, cwd: string) => [{ cwd }],
    acpTurns: acpTurnsOf(() => []),
    codexTurns: async () => ({ data: [] }),
  });
  assert.deepEqual((await noProject({ kind: 'claude', nativeId: 'n' }, undefined, { assistantOnly: true })).turns, [{ cwd: '' }]);
});

test('the Claude source reads whole messages by id and replies by id with the folder', async () => {
  const seen: unknown[] = [];
  const source = claudePeerSource({
    allTurns: async (id: string, opts: unknown) => (seen.push(['turns', id, opts]), []),
    replies: async (id: string, opts: unknown) => (seen.push(['replies', id, opts]), []),
  });
  await source.claudeTurns('a', '/a', { open: true });
  await source.claudeReplies('b', '/repo');
  assert.deepEqual(seen, [
    ['turns', 'a', { chatId: 'a', cwd: '/a', open: true }],
    ['replies', 'b', { cwd: '/repo' }],
  ]);
});
