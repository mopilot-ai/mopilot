// electron/session/switch.cjs edge cases: unreadable or fresh histories, paged Codex threads, a chat
// without a folder, a failed git read, Claude summaries, and switches back to a segment with no count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptHost } from './support/acp-transcript.ts';

const require = createRequire(import.meta.url);
// Codex's sessions folder, empty: a thread's rollout file is only what a test writes there
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-codex-home-'));
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const runner = (o: any = {}) => {
  const events: any[] = [];
  const calls: any[] = [];
  const r = new SwitchRunner({
    home: '/home/me',
    prefs: () => ({ claudeBin: '/bin/claude', permission: 'default' }),
    emit: (e: any, target: any) => events.push({ ...e, target }),
    invalidate: () => calls.push('invalidate'),
    claim: () => {},
    unclaim: () => {},
    changed: (id: string) => calls.push(`changed ${id}`),
    permissionParams: () => ({}),
    git: {
      info: async () => {
        throw new Error('not a repo');
      },
      status: async () => ({}),
    },
    ...o,
    codex: {
      ensureResumed: async () => {
        throw new Error('gone');
      },
      cwdOf: () => null,
      summarize: async () => 'codex note',
      ...o.codex,
    },
    claude: {
      isFresh: () => false,
      cwdOf: () => '',
      summarize: async (...a: any[]) => (calls.push(['summarize', ...a]), 'claude note'),
      accountOf: () => 'acct',
      ...o.claude,
    },
  });
  return { r, events, calls };
};

test('Claude history: a fresh session has none, an unreadable transcript reads as none', async () => {
  let read = 0;
  const { r } = runner({
    claude: {
      isFresh: (k: string) => k === 'claude:new',
      allTurns: async () => {
        read++;
        throw new Error('no file');
      },
    },
  });
  const failed: any[] = [];
  assert.deepEqual(await r.claudeTurns('c', 'new', '/', failed), []);
  assert.equal(read, 0);
  assert.equal(failed.length, 0);
  assert.deepEqual(await r.claudeTurns('c', 'old', '/', failed), []);
  assert.equal(read, 1);
  // the caller can tell an unreadable transcript from an empty one
  assert.deepEqual(
    failed.map((f) => [f.kind, f.error.message]),
    [['claude', 'no file']],
  );
});

test('Codex history: pages are read until there is no cursor; a page without data or a failing read stops there', async () => {
  const pages: any[] = [];
  const { r } = runner({
    codex: {
      threadTurns: async (_id: string, p: any) => {
        pages.push(p.cursor);
        if (p.cursor === null) return { nextCursor: 'p2' };
        if (p.cursor === 'p2') return { data: [], nextCursor: 'p3' };
        throw new Error('thread has no messages');
      },
    },
  });
  const failed: any[] = [];
  assert.deepEqual(await r.codexTurns('t', failed), []);
  assert.deepEqual(pages, [null, 'p2', 'p3']);
  assert.deepEqual(
    failed.map((f) => [f.kind, f.error.message]),
    [['codex', 'thread has no messages']],
  );
});

test("Codex down: a thread's turns and folder come from its rollout file, so switching away still carries the chat", async () => {
  clearIgnored();
  const rollout = {
    path: '/x',
    cwd: '/work/repo',
    turns: [{ id: 'r1', status: 'completed', items: [{ type: 'userMessage', id: 'u', content: [] }] }],
    nextCursor: null,
  };
  const asked: string[] = [];
  const { r } = runner({
    rollouts: { history: async (id: string) => (asked.push(id), rollout) },
    codex: {
      threadTurns: async (_id: string, p: any) => {
        if (p.cursor === null) return { data: [{ id: 'partial', status: 'completed', items: [] }], nextCursor: 'p2' };
        throw new Error("Codex isn't connected");
      },
    },
  });
  const failed: any[] = [];
  // the pages read before the app-server failed are replaced by the whole file, and nothing is missing
  assert.deepEqual(
    (await r.codexTurns('t', failed, true)).map((t: any) => t.id),
    ['r1'],
  );
  assert.deepEqual(failed, []);
  // the folder this app-server run doesn't know is the one the rollout records
  assert.equal(await r.cwdOf({ kind: 'codex', id: 't' }), '/work/repo');
  assert.deepEqual(asked, ['t', 't']);
  // a rollout that names no folder, or no rollout: home
  const bare = runner({ rollouts: { history: async () => ({ ...rollout, cwd: null }) } });
  assert.equal(await bare.r.cwdOf({ kind: 'codex', id: 't' }), '/home/me');
  // an unreadable rollout reads as none: the app-server's failure is what is reported
  const broken = runner({
    rollouts: {
      history: async () => {
        throw new Error('bad frame');
      },
    },
    codex: {
      threadTurns: async () => {
        throw new Error("Codex isn't connected");
      },
    },
  });
  const lost: any[] = [];
  assert.deepEqual(await broken.r.codexTurns('t', lost, true), []);
  assert.deepEqual(
    lost.map((f) => f.error.message),
    ["Codex isn't connected"],
  );
  assert.ok(recentIgnored().some((e: any) => /rollout file/.test(e.context) && e.message === 'bad frame'));
});

test('a switch whose earlier conversation cannot be read goes on with what was read, and says so', async () => {
  clearIgnored();
  const committed: any[] = [];
  const { r, events } = runner({
    rollouts: { history: async () => null },
    ref: () => ({ kind: 'claude', id: 's1' }),
    chats: {
      record: () => ({
        segments: [
          { kind: 'codex', nativeId: 't1', start: 0, count: 2, model: 'gpt' },
          { kind: 'claude', nativeId: 's1', start: 2, count: null, model: 'opus' },
        ],
      }),
      commit: (rec: any) => committed.push(rec),
    },
    codex: {
      threadTurns: async () => {
        throw new Error('app-server is down');
      },
    },
    claude: {
      allTurns: async () => {
        throw new Error('transcript unreadable');
      },
    },
  });
  const res = await r.perform('c', { harness: 'codex', model: 'gpt', mode: 'auto' }, 4);
  assert.equal(res.ready, true);
  assert.equal(committed.length, 1);
  assert.deepEqual(events[0], {
    kind: 'toast',
    level: 'error',
    text: "Couldn't read the earlier conversation from Codex and Claude Code (app-server is down); the handoff includes only what could be read",
    target: 4,
  });
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    [
      'resume the Codex thread for a handoff',
      'read the Codex thread for a handoff',
      'read the Claude Code transcript for a handoff',
      'read Git details for a handoff',
    ],
  );
});

test('a switch from sessions that may never have had a message reads them as empty, without a warning', async () => {
  clearIgnored();
  const fromCodex = runner({
    ref: () => ({ kind: 'codex', id: 't1' }),
    chats: { record: () => ({ segments: [{ kind: 'codex', nativeId: 't1', start: 0, count: null }] }), commit: () => true },
    codex: {
      threadTurns: async () => {
        throw new Error('thread has no messages');
      },
    },
    claude: { registerSession: () => {} },
  });
  assert.equal((await fromCodex.r.perform('c', { harness: 'claude', model: 'opus', mode: 'auto' })).ready, true);
  assert.deepEqual(
    fromCodex.events.filter((e) => e.level === 'error'),
    [],
  );
  // a Claude session made before a restart is no longer known to be fresh: its missing transcript is no loss
  const fromClaude = runner({
    ref: () => ({ kind: 'claude', id: 's1' }),
    chats: { record: () => ({ segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }] }), commit: () => true },
    codex: { startThread: async () => ({ thread: { id: 't2' } }) },
    claude: {
      allTurns: async () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      },
    },
  });
  assert.equal((await fromClaude.r.perform('c', { harness: 'codex', model: 'gpt', mode: 'auto' })).ready, true);
  assert.deepEqual(
    fromClaude.events.filter((e) => e.level === 'error'),
    [],
  );
  assert.equal(
    recentIgnored().some((e: any) => e.context === 'read the Claude Code transcript for a handoff'),
    false,
  );
});

test('history reads each native session once', async () => {
  let reads = 0;
  const { r } = runner({ codex: { threadTurns: async () => (reads++, { data: [], nextCursor: null }) } });
  const h = await r.history(
    'c',
    [
      { kind: 'codex', nativeId: 't' },
      { kind: 'codex', nativeId: 't' },
    ],
    '/',
  );
  assert.deepEqual([...h.keys()], ['t']);
  assert.equal(reads, 1);
});

test('a chat without a folder runs in home; a folder that is not a repo still gets a workspace note', async () => {
  const { r } = runner();
  assert.equal(await r.cwdOf({ kind: 'codex', id: 't' }), '/home/me');
  assert.equal(await r.cwdOf({ kind: 'claude', id: 's' }), '/home/me');
  assert.equal(typeof (await r.workspace('/tmp/x')), 'string');
});

test("a summary note from a Codex chat for a basic harness; Claude summaries use its binary and the chat's account", async () => {
  const held = [{ surface: 'iab', id: 'tab-1', title: 'Docs', url: 'https://x.test' }];
  const { r, calls } = runner({ ref: () => ({ kind: 'codex', id: 't' }), chats: { record: () => ({ segments: [] }) }, held: () => held });
  const text = await r.summaryNote('c', 'Kimi');
  assert.match(text, /codex note/);
  // the tabs and locks stay with the chat that holds them: a new chat is not told about them
  assert.doesNotMatch(text, /Tabs and targets this chat holds/);
  assert.equal(await r.summarize('c', 'claude', { id: 's' }, '/w'), 'claude note');
  const fromClaude = runner({ ref: () => ({ kind: 'claude', id: 's' }), chats: { record: () => ({ segments: [{ model: 'opus' }] }) } });
  assert.match(await fromClaude.r.summaryNote('c', 'Kimi'), /claude note/);
  assert.deepEqual(calls.at(-1), ['summarize', 's', '/w', calls.at(-1)[3], '/bin/claude', 'acct', 'c']);
});

test('unknown or malformed harness kinds are refused without reading a chat', async () => {
  const { r, events } = runner({ ref: () => ({ kind: 'codex', id: 't1' }), chats: { record: () => assert.fail('no read') } });
  const refusal = 'This harness cannot take over this chat';
  for (const harness of ['gemini', 'acp:', 'acp:kimi:session']) {
    const result = await r.perform('c', { harness, model: '', mode: 'auto' }, 2);
    assert.equal(result.ready, false);
    assert.match(result.error, /Your message is kept in the queue/);
    await assert.rejects(r.startNative('c', harness, '/', '', []), new RegExp(refusal));
  }
  assert.equal(events.length, 3);
  await assert.rejects(r.summarize('c', 'acp:kimi', { id: 's1' }, '/w'), /no isolated summary/);
  const failed: any[] = [];
  const h = await r.history('c', [{ kind: 'unknown', nativeId: 's1' }], '/', failed);
  assert.deepEqual(h.get('unknown:s1'), []);
  assert.equal(failed.length, 1);
});

const acpUser = (turnId: string, text: string) => ({
  t: 'user',
  turnId,
  user: { id: `u-${turnId}`, clientId: turnId, content: [{ type: 'text', text, text_elements: [] }] },
  at: 1000,
});
const acpReply = (turnId: string, text: string) => ({
  t: 'update',
  turnId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  at: 2000,
});
const acpEnd = (turnId: string) => ({ t: 'end', turnId, stopReason: 'end_turn', at: 3000 });

test("a new chat from a basic-harness chat carries that chat's conversation, read from its transcript", async () => {
  const read: string[] = [];
  const asked: string[] = [];
  const records = [
    { t: 'session', sessionId: 'native', cwd: '/proj' },
    acpUser('t1', 'Fix the build'),
    acpReply('t1', 'Fixed the import.'),
    acpEnd('t1'),
    // a turn still running in the chat: handed over as far as it got
    acpUser('t2', 'Now run the tests'),
    acpReply('t2', 'Running them'),
  ];
  const { r } = runner({
    ref: () => ({ kind: 'acp:opencode', id: 's1', key: 'acp:opencode:s1' }),
    chats: { record: () => assert.fail('a basic chat has one segment: nothing to read there') },
    acpHost: transcriptHost((key: string) => (read.push(key), records)),
    acpQuirks: { describe: (id: string) => (id === 'opencode' ? { label: 'OpenCode' } : null) },
    codex: { summarize: async () => (asked.push('summarize'), 'x') },
  });
  const text = await r.summaryNote('c', 'Codex');
  assert.deepEqual(read, ['acp:opencode:s1']);
  assert.deepEqual(asked, [], 'no other harness is asked to summarize a conversation it never saw');
  assert.match(text, /^<sage-handoff from="OpenCode" mode="auto">/);
  assert.match(text, /taking over this conversation from another coding agent, OpenCode\./);
  assert.match(text, /## Conversation so far/);
  assert.match(text, /User: Fix the build/);
  assert.match(text, /Assistant: Fixed the import\./);
  assert.match(text, /User: Now run the tests[\s\S]*Assistant: Running them/);
  assert.doesNotMatch(text, /cancel/i);
  // the folder the harness's session ran in
  assert.match(text, /Directory: \/proj/);

  // a chat that never ran (no transcript) hands over the workspace alone, in the home folder; a harness the build
  // can't name is named by its kind; the renderer's key form is used when main's ref lacks one
  const empty = runner({
    ref: () => ({ kind: 'acp:zed', id: 's2' }),
    acpHost: transcriptHost((key: string) => (read.push(key), [])),
    acpQuirks: { describe: () => null },
  });
  const bare = await empty.r.summaryNote('c', 'Claude Code');
  assert.equal(read.at(-1), 'acp:zed:s2');
  assert.match(bare, /^<sage-handoff from="acp:zed" mode="auto">/);
  assert.doesNotMatch(bare, /## Conversation/);
  assert.match(bare, /Directory: \/home\/me/);
  // a runner given no basic-harness host reads no transcript; the harness is named by its quirks file
  const unwired = runner({ ref: () => ({ kind: 'acp:kimi', id: 's3' }) });
  assert.match(await unwired.r.summaryNote('c', 'Codex'), /^<sage-handoff from="Kimi Code" mode="auto">/);
});

test('a handoff that misses part of the history names the harness it could not read', async () => {
  const { r, events } = runner({
    ref: () => ({ kind: 'codex', id: 't1' }),
    chats: {
      record: () => ({
        segments: [
          { kind: 'acp:kimi', nativeId: 'k1', start: 0, count: 1 },
          { kind: 'codex', nativeId: 't1', start: 1, count: null },
        ],
      }),
      commit: () => true,
    },
    codex: { threadTurns: async () => ({ data: [], nextCursor: null }), startThread: async () => ({ thread: { id: 'n' } }) },
    claude: { isFresh: () => true, registerSession: () => {} },
  });
  const res = await r.perform('c', { harness: 'claude', model: 'opus', mode: 'workspace' }, 4);
  assert.equal(res.ready, true);
  assert.match(events[0].text, /^Couldn't read the earlier conversation from Kimi Code/);
});

test('switching back to a harness whose segment has no count, and a target that will not start', async () => {
  const committed: any[] = [];
  const segs = [
    { kind: 'claude', nativeId: 's1', start: 0, count: null, model: 'opus' },
    { kind: 'codex', nativeId: 't1', start: 0, count: null, model: 'gpt' },
  ];
  const { r, events } = runner({
    ref: () => ({ kind: 'codex', id: 't1' }),
    chats: { record: () => ({ id: 'c', segments: segs }), commit: (rec: any) => committed.push(rec) },
    codex: {
      threadTurns: async () => ({ data: [], nextCursor: null }),
      startThread: async () => {
        throw 'quota';
      },
    },
    claude: { isFresh: () => true },
  });
  const res = await r.perform('c', { harness: 'claude', model: 'opus', mode: 'auto' });
  assert.equal(res.ready, true);
  const added = committed[0].segments.at(-1);
  assert.equal(added.handoff.mode, 'delta');
  assert.equal(added.handoff.caught, 0);
  assert.equal(res.note.kind, 'switch');

  const toCodex = runner({
    ref: () => ({ kind: 'claude', id: 's9' }),
    chats: { record: () => ({ segments: [{ kind: 'claude', nativeId: 's9', start: 0, count: null }] }) },
    codex: {
      startThread: async () => {
        throw 'quota';
      },
    },
    claude: { isFresh: () => true },
  });
  assert.deepEqual(await toCodex.r.perform('c', { harness: 'codex', model: 'gpt', mode: 'auto' }, 3), {
    ready: false,
    error:
      "Couldn't start Codex: quota. Your message is kept in the queue: fix that and send it again, or cancel the switch to send it here.",
  });
  assert.deepEqual(toCodex.events, [{ kind: 'toast', level: 'error', text: "Couldn't start Codex: quota", target: 3 }]);
  assert.equal(events.length > 0, true);
});

test('a summary handoff that fails falls back to the workspace note, naming a non-Error reason', async () => {
  const { r, events } = runner({
    ref: () => ({ kind: 'codex', id: 't1' }),
    chats: { record: () => ({ segments: [{ kind: 'codex', nativeId: 't1', start: 0, count: null }] }), commit: () => true },
    codex: {
      threadTurns: async () => ({ data: [], nextCursor: null }),
      summarize: async () => {
        throw 'busy';
      },
    },
    claude: { isFresh: () => true, registerSession: () => {} },
  });
  const res = await r.perform('c', { harness: 'claude', model: 'opus', mode: 'summary' });
  assert.equal(res.ready, true);
  assert.ok(events.some((e) => e.text === 'Handoff note failed (busy); continuing with the workspace only'));
});

test('segment end: a settled switch hands the old and new segment to its handler after the commit; a failing handler does not undo the switch', async () => {
  let segs: any[] = [{ kind: 'codex', nativeId: 't1', start: 0, count: null }];
  const order: string[] = [];
  const ended: any[] = [];
  const make = (segmentEnded: any) =>
    runner({
      ref: () => ({ kind: segs.at(-1).kind, key: segs.at(-1).nativeId }),
      chats: {
        record: () => ({ id: 'c', segments: segs }),
        commit: (rec: any) => {
          order.push('commit');
          segs = rec.segments;
          return true;
        },
      },
      codex: { threadTurns: async () => ({ data: [], nextCursor: null }) },
      claude: { isFresh: () => true, registerSession: () => {} },
      segmentEnded,
    });
  const { r } = make((e: any) => {
    order.push('ended');
    ended.push(e);
  });
  assert.equal((await r.perform('c', { harness: 'claude', model: 'opus', mode: 'workspace' })).ready, true);
  assert.deepEqual(order, ['commit', 'ended']);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].chatId, 'c');
  assert.deepEqual(ended[0].from, { kind: 'codex', key: 't1' });
  assert.deepEqual(ended[0].to, { kind: 'claude', key: segs.at(-1).nativeId });

  clearIgnored();
  const failing = make(() => {
    throw new Error('store gone');
  });
  assert.equal((await failing.r.perform('c', { harness: 'codex', model: 'gpt', mode: 'workspace' })).ready, true);
  assert.equal(segs.at(-1).kind, 'codex');
  assert.ok(recentIgnored().some((e: any) => e.context === "retire a chat's earlier segment after a switch"));
});

test("a settled switch takes the chat's model and effort off the harness it left: the target's model, the rest kept", async () => {
  let rec: any = {
    id: 'c',
    segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }],
    meta: { pinned: true, config: { model: 'opus', effort: 'max', permission: 'plan' } },
  };
  const { r } = runner({
    ref: () => ({ kind: rec.segments.at(-1).kind, key: rec.segments.at(-1).nativeId, id: rec.segments.at(-1).nativeId }),
    chats: {
      record: () => rec,
      commit: (next: any) => ((rec = next), true),
    },
    claude: { isFresh: () => true, allTurns: async () => [] },
    codex: { threadTurns: async () => ({ data: [], nextCursor: null }), startThread: async () => ({ thread: { id: 't1' } }) },
  });
  assert.equal((await r.perform('c', { harness: 'codex', model: 'gpt-a', mode: 'workspace' })).ready, true);
  // a Claude model would reach Codex as its model (codexParams chatPrefs reads any saved key)
  assert.deepEqual(rec.meta, { pinned: true, config: { permission: 'plan', model: 'gpt-a' } });
  assert.deepEqual(rec.segments[0].kept, { effort: 'max' });
  // Codex's first turn keeps its own; back on Claude, the chat runs on the effort it had there, not the default
  rec = { ...rec, meta: { ...rec.meta, config: { ...rec.meta.config, effort: 'low', serviceTier: 'priority' } } };
  assert.equal((await r.perform('c', { harness: 'claude', model: 'sonnet', mode: 'workspace' })).ready, true);
  assert.deepEqual(rec.meta.config, { permission: 'plan', model: 'sonnet', effort: 'max' });
  assert.deepEqual(rec.segments[1].kept, { effort: 'low', serviceTier: 'priority' });
  // an effort the switch itself picked (set_session_harness) wins over the one that harness's segment kept
  assert.equal((await r.perform('c', { harness: 'codex', model: 'gpt-a', effort: 'medium', mode: 'workspace' })).ready, true);
  assert.deepEqual(rec.meta.config, { permission: 'plan', model: 'gpt-a', effort: 'medium', serviceTier: 'priority' });
});
