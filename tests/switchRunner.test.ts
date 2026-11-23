// A harness switch settled in main (electron/session/switch.cjs): the chat's history is read from each
// native session, the new segment is written to the v2 chat file and the handoff record comes back for
// the message to carry. Sessions and the app-server are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTurns } from './support/claude-translate.ts';

const require = createRequire(import.meta.url);
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { switchAccount } = require('../electron/session/switchAccount.cjs');

const codexTurn = (id: string, user: string, reply: string) => ({
  id,
  status: 'completed',
  startedAt: 1,
  completedAt: 2,
  durationMs: 1000,
  error: null,
  items: [
    { type: 'userMessage', id: `${id}-u`, content: [{ type: 'text', text: user, text_elements: [] }] },
    { type: 'agentMessage', id: `${id}-a`, text: reply },
  ],
});
const claudeTranscript = (...pairs: [string, string][]) =>
  pairs.flatMap(([user, reply], i) => [
    { type: 'user', uuid: `u${i}`, timestamp: `2026-01-01T00:0${i}:00Z`, message: { role: 'user', content: user } },
    {
      type: 'assistant',
      uuid: `a${i}`,
      timestamp: `2026-01-01T00:0${i}:05Z`,
      message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: reply }] },
    },
  ]);

function setup(
  o: {
    codexTurns?: any[];
    claudeMessages?: any[];
    summary?: string;
    startFails?: boolean | string;
    whileSummarizing?: () => void;
    putAccount?: (chats: any) => (e: any) => any;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-switch-'));
  const chats = new ChatsStore(path.join(dir, 'threads'));
  const events: any[] = [];
  const log: string[] = [];
  const sessions: [string, any][] = [];
  const ref = (id: string) => {
    const seg = chats.record(id).segments.at(-1);
    return { kind: seg.kind, id: seg.nativeId, instance: null, key: seg.kind === 'codex' ? seg.nativeId : `${seg.kind}:${seg.nativeId}` };
  };
  const runner = new SwitchRunner({
    chats,
    ref,
    invalidate: () => log.push('invalidate'),
    // the claims themselves are covered in switchClaimsNative.test.ts
    claim: () => {},
    unclaim: () => {},
    changed: (id: string) => log.push(`changed ${id}`),
    prefs: () => ({ permission: 'default', serviceTier: null, claudeBin: null }),
    home: '/home/me',
    emit: (e: any, target: any) => events.push({ ...e, target }),
    git: { info: async () => ({ branch: 'main' }), status: async () => ({ files: [{ code: ' M', path: 'a.ts', added: 3, removed: 1 }] }) },
    codex: {
      startThread: async (p: any) => {
        log.push(`startThread ${p.cwd} ${p.model}`);
        if (o.startFails) throw new Error(typeof o.startFails === 'string' ? o.startFails : 'app-server is down');
        return { thread: { id: 'cx-new' } };
      },
      ensureResumed: async () => {},
      threadTurns: async (_id: string, page: any) =>
        page.cursor ? { data: [], nextCursor: null } : { data: [...(o.codexTurns ?? [])].reverse(), nextCursor: null },
      summarize: async () => {
        o.whileSummarizing?.();
        return o.summary ?? 'Codex note';
      },
      cwdOf: () => '/repo',
    },
    claude: {
      registerSession: (key: string, info: any) => sessions.push([key, info]),
      isFresh: () => false,
      cwdOf: () => '/repo',
      accountOf: () => 'default',
      allTurns: async (id: string, read: any) => buildTurns(o.claudeMessages ?? [], read.chatId, read.cwd),
      summarize: async () => o.summary ?? 'Claude note',
    },
    permissionParams: () => ({}),
    putAccount: o.putAccount?.(chats),
  });
  return { runner, chats, events, log, sessions };
}
const ps = (o: any = {}) => ({ harness: 'claude', model: 'opus', modelLabel: 'Opus', mode: 'auto', ...o });

test('Codex → Claude Code: the segment is written, a session is registered, the record carries the conversation', async () => {
  const { runner, chats, events, sessions, log } = setup({
    codexTurns: [codexTurn('t1', 'fix the login bug', 'Fixed it.'), codexTurn('t2', 'add a test', 'Added.')],
  });
  const r = await runner.perform('c1', ps(), 7);
  assert.equal(r.ready, true);
  const segs = chats.record('c1').segments;
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].kind, segs[0].nativeId, segs[0].start, segs[0].count], ['codex', 'c1', 0, 2]);
  assert.deepEqual([segs[1].kind, segs[1].start, segs[1].count, segs[1].model], ['claude', 2, null, 'opus']);
  assert.equal(segs[1].handoff.mode, 'auto');
  assert.equal(segs[1].handoff.text, r.prefix);
  // the new Claude session starts with the first message, in the chat's folder
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0][0], `claude:${segs[1].nativeId}`);
  assert.deepEqual(sessions[0][1], { cwd: '/repo' });
  assert.ok(log.includes('invalidate'));
  // every window is told the chat's segments changed
  assert.ok(log.includes('changed c1'));
  // the record
  assert.match(r.prefix, /^<sage-handoff from="Codex" mode="auto">/);
  assert.match(r.prefix, /You are taking over this conversation from another coding agent, Codex/);
  assert.match(r.prefix, /### Turn 1\nUser: fix the login bug\nAssistant: Fixed it\./);
  assert.match(r.prefix, /### Turn 2\nUser: add a test/);
  assert.match(r.prefix, /Directory: \/repo\nBranch: main\nUncommitted changes \(git status\):\n {2} M a\.ts \(\+3 −1\)/);
  assert.equal(r.note.kind, 'switch');
  assert.match(r.note.text, /^Codex → Claude Code · Opus$/);
  assert.equal(r.note.handoff, r.prefix);
  // windows learn the chat is on Claude now
  const sw = events.find((e) => e.kind === 'switched');
  assert.deepEqual(
    { ...sw, target: undefined },
    {
      kind: 'switched',
      chatId: 'c1',
      harness: 'claude',
      key: `claude:${segs[1].nativeId}`,
      model: 'opus',
      fresh: true,
      start: 2,
      target: undefined,
    },
  );
});

test("a switch that resumes nothing starts the target on its model; Codex gets a thread with the chat's permissions", async () => {
  const { runner, chats, log, sessions } = setup({ claudeMessages: claudeTranscript(['hello', 'hi there']) });
  chats.commit({ ...chats.record('cl'), segments: [{ ...chats.record('cl').segments[0], kind: 'claude', nativeId: 's1' }] });
  const r = await runner.perform('cl', ps({ harness: 'codex', model: 'gpt-x', modelLabel: 'GPT X', mode: 'workspace' }));
  assert.equal(r.ready, true);
  assert.ok(log.includes('startThread /repo gpt-x'));
  assert.equal(sessions.length, 0);
  const segs = chats.record('cl').segments;
  assert.deepEqual([segs[1].kind, segs[1].nativeId], ['codex', 'cx-new']);
  // workspace only: no conversation
  assert.doesNotMatch(r.prefix, /## Conversation/);
  assert.match(r.prefix, /mode="workspace"/);
  assert.match(r.prefix, /from="Claude Code"/);
});

test('back to a harness the chat used before: its session resumes and gets only what it missed', async () => {
  const { runner, chats, log, sessions } = setup({
    codexTurns: [codexTurn('t1', 'first question', 'first answer')],
    claudeMessages: claudeTranscript(['second question', 'second answer'], ['third question', 'third answer']),
  });
  const first = chats.record('c1').segments[0];
  chats.commit({
    ...chats.record('c1'),
    segments: [
      { ...first, count: 1 },
      { ...first, kind: 'claude', nativeId: 's2', start: 1, count: null, model: 'opus', handoff: { mode: 'auto', tokens: 10, text: 'x' } },
    ],
  });
  const r = await runner.perform('c1', ps({ harness: 'codex', model: 'gpt-x', modelLabel: 'GPT X' }));
  const segs = chats.record('c1').segments;
  assert.equal(segs.length, 3);
  // no new thread: the first segment's own thread comes back
  assert.equal(segs[2].nativeId, 'c1');
  assert.equal(log.filter((l) => l.startsWith('startThread')).length, 0);
  assert.equal(sessions.length, 0);
  assert.deepEqual([segs[1].start, segs[1].count], [1, 2]);
  assert.deepEqual([segs[2].kind, segs[2].start, segs[2].handoff.mode, segs[2].handoff.caught], ['codex', 3, 'delta', 2]);
  // only the turns Codex missed
  assert.match(r.prefix, /You worked on this conversation earlier\. Since then another agent, Claude Code \(opus\)/);
  assert.match(r.prefix, /## Conversation since you last worked on it/);
  assert.doesNotMatch(r.prefix, /first question/);
  assert.match(r.prefix, /### Turn 2\nUser: second question/);
  assert.match(r.prefix, /### Turn 3\nUser: third question/);
  assert.equal(r.note.text, 'Back on Codex');
});

test('a summary handoff asks the source harness for a note; when it comes back empty the record falls back to the workspace', async () => {
  const ok = setup({ codexTurns: [codexTurn('t1', 'q', 'a')], summary: 'We fixed the bug; tests remain.' });
  const r = await ok.runner.perform('c1', ps({ mode: 'summary' }), 3);
  assert.match(r.prefix, /## Handoff note from Codex\n\nWe fixed the bug; tests remain\./);
  assert.doesNotMatch(r.prefix, /## Conversation/);
  assert.match(r.note.text, /^Codex → Claude Code · Opus$/);
  assert.ok(ok.events.some((e) => e.kind === 'toast' && /Codex is writing a handoff note/.test(e.text) && e.target === 3));

  const empty = setup({ codexTurns: [codexTurn('t1', 'q', 'a')], summary: '' });
  const r2 = await empty.runner.perform('c1', ps({ mode: 'summary' }));
  assert.match(r2.prefix, /mode="workspace"/);
  assert.equal(empty.chats.record('c1').segments[1].handoff.mode, 'workspace');
  const err = empty.events.find((e) => e.kind === 'toast' && e.level === 'error');
  assert.match(err.text, /^Handoff note failed \(The summary came back empty\); continuing with the workspace only$/);
  assert.match(r2.note.text, /^Codex → Claude Code · Opus$/);
});

test('what changes in the chat while the handoff note is written stays (pin, project, notes)', async () => {
  const s = setup({
    codexTurns: [codexTurn('t1', 'q', 'a')],
    whileSummarizing: () => s.chats.patchMeta('c1', { pinned: true, projectId: 'p2', notes: ['n'] }),
  });
  s.chats.ensure('c1');
  const r = await s.runner.perform('c1', ps({ mode: 'summary' }));
  assert.equal(r.ready, true);
  const rec = s.chats.record('c1');
  assert.equal(rec.segments.length, 2);
  assert.deepEqual([rec.meta.pinned, rec.meta.projectId, rec.meta.notes], [true, 'p2', ['n']]);
});

test('a goal the user continues is sent again on the new harness, as that harness takes it', async () => {
  const { runner } = setup({ codexTurns: [codexTurn('t1', 'q', 'a')] });
  const toClaude = await runner.perform('c1', ps({ goal: 'tests pass' }));
  assert.deepEqual(toClaude.after, [{ text: '/goal tests pass', opts: {} }]);
  const s2 = setup({ claudeMessages: claudeTranscript(['q', 'a']) });
  s2.chats.commit({ ...s2.chats.record('cl'), segments: [{ ...s2.chats.record('cl').segments[0], kind: 'claude', nativeId: 's1' }] });
  const toCodex = await s2.runner.perform('cl', ps({ harness: 'codex', goal: 'tests pass' }));
  assert.deepEqual(toCodex.after, [{ text: 'tests pass', opts: { goal: 'tests pass' } }]);
});

test('nothing is switched when the target cannot start, or when there is nothing to switch', async () => {
  const down = setup({ codexTurns: [codexTurn('t1', 'q', 'a')], startFails: true });
  const cl = down.chats.record('cl');
  down.chats.commit({ ...cl, segments: [{ ...cl.segments[0], kind: 'claude', nativeId: 's1' }] });
  const r = await down.runner.perform('cl', ps({ harness: 'codex' }), 4);
  assert.deepEqual(r, {
    ready: false,
    error:
      "Couldn't start Codex: app-server is down. Your message is kept in the queue: fix that and send it again, or cancel the switch to send it here.",
  });
  assert.equal(down.chats.record('cl').segments.length, 1);
  assert.deepEqual(
    down.events.map((e) => [e.kind, e.level, e.text, e.target]),
    [['toast', 'error', "Couldn't start Codex: app-server is down", 4]],
  );

  // a reason that already ends in a full stop gets no second one before what to do
  const stop = setup({ codexTurns: [codexTurn('t1', 'q', 'a')], startFails: 'Codex is signed out. Sign in from Settings.' });
  const cl2 = stop.chats.record('cl');
  stop.chats.commit({ ...cl2, segments: [{ ...cl2.segments[0], kind: 'claude', nativeId: 's1' }] });
  const stopped = await stop.runner.perform('cl', ps({ harness: 'codex' }), 4);
  assert.match(stopped.error!, /^Couldn't start Codex: Codex is signed out\. Sign in from Settings\. Your message is kept/);

  const same = setup({ codexTurns: [codexTurn('t1', 'q', 'a')] });
  assert.deepEqual(await same.runner.perform('c1', ps({ harness: 'codex' })), { ready: true });
  assert.deepEqual(await same.runner.perform('c1', null), { ready: true });
  assert.equal(same.chats.record('c1').segments.length, 1);
  assert.equal(same.events.length, 0);
});

test('a new chat on a basic harness takes a summary written by the harness the chat is on', async () => {
  const { runner } = setup({ summary: 'Where we are' });
  const text = await runner.summaryNote('c1', 'Kimi Code');
  assert.match(text, /^<sage-handoff from="Codex" mode="summary">/);
  assert.match(text, /## Handoff note from Codex\n\nWhere we are/);
  assert.match(text, /Directory: \/repo/);
  const bad = setup({ summary: '' });
  await assert.rejects(() => bad.runner.summaryNote('c1', 'Kimi Code'), /came back empty/);
});

/* ---------- the chat's account on the new segment (design/multi-account R-2, R-5) ---------- */
function withAccounts(o: any = {}) {
  const pins: any[] = [];
  const own: any[] = [];
  // ClaudeTurns' per-chat picks: a model the chat chose stays when its login is set
  const ownMap = new Map<string, any>([
    ['c1', { model: 'opus', effort: 'high', account: null }],
    ['c2', { model: null, effort: null, account: null }],
  ]);
  const t = setup({
    ...o,
    putAccount: (chats: any) =>
      switchAccount({
        chats,
        activateSelection: true,
        codex: () => ({ get: (id: string) => id !== 'gone', pinChat: (thread: string, id: string) => pins.push([thread, id]) }),
        claude: { own: ownMap, setOwn: (chatId: string, v: any) => (own.push([chatId, v.account]), ownMap.set(chatId, v)) },
      }),
  });
  return { ...t, pins, own, ownMap };
}

test('a switch to Codex on an account picked for this chat pins its new thread before the first turn', async () => {
  const { runner, chats, events, pins } = withAccounts({ claudeMessages: claudeTranscript(['hello', 'hi']) });
  chats.commit({ ...chats.record('cl'), segments: [{ ...chats.record('cl').segments[0], kind: 'claude', nativeId: 's1' }] });
  const r = await runner.perform('cl', ps({ harness: 'codex', model: 'gpt-x', modelLabel: 'GPT X', account: 'b' }));
  assert.equal(r.ready, true);
  assert.deepEqual(pins, [['cx-new', 'b']]);
  assert.ok(events.some((e) => e.kind === 'switched'));
  // and the global default is never touched: only the chat's thread is pinned
  assert.equal(chats.record('cl').meta.account, null);
});

test('a switch to Codex without a pick leaves the thread to the pin it had, or to the pool', async () => {
  const { runner, pins } = withAccounts({ codexTurns: [codexTurn('t1', 'q', 'a')] });
  // a picked account that is not a string (an older window's pending switch) is no pick
  await runner.perform('c1', ps({ harness: 'claude', account: 7 }));
  await runner.perform('c1', ps({ harness: 'codex', model: 'gpt-x', modelLabel: 'GPT X' }));
  assert.deepEqual(pins, []);
});

test('explicit automatic clears earlier pins on both harnesses before continuing', async () => {
  const { runner, chats, pins, ownMap, own } = withAccounts({ codexTurns: [codexTurn('t1', 'q', 'a')] });
  chats.patchMeta('c1', { account: { id: 'work', pinned: true } });
  ownMap.set('c1', { model: 'opus', effort: 'high', account: 'work' });
  await runner.perform('c1', ps({ automaticAccount: true }));
  assert.equal(chats.record('c1').meta.account, null);
  assert.deepEqual(own.at(-1), ['c1', null]);
  await runner.perform('c1', ps({ harness: 'codex', model: 'gpt-x', modelLabel: 'GPT X', automaticAccount: true }));
  assert.deepEqual(pins.at(-1), ['c1', null]);
});

test('an automatic switch that cannot clear its saved Claude pin keeps the message for retry', async () => {
  const { runner, chats } = withAccounts({ codexTurns: [codexTurn('t1', 'q', 'a')] });
  chats.patchMeta('c1', { account: { id: 'work', pinned: true } });
  const commit = chats.commit.bind(chats);
  chats.commit = () => false;
  const result = await runner.perform('c1', ps({ automaticAccount: true }));
  assert.equal(result.ready, false);
  assert.equal(chats.record('c1').meta.account.id, 'work');
  assert.equal(chats.record('c1').segments.at(-1).kind, 'codex');
  chats.commit = commit;
  const retry = await runner.perform('c1', ps({ automaticAccount: true }));
  assert.equal(retry.ready, true);
  assert.equal(chats.record('c1').meta.account, null);
  assert.ok(retry.prefix, 'the retry still carries the handoff');
});

test('automatic switch without an account step waits for retry', async () => {
  const bare = setup({ claudeMessages: claudeTranscript(['hello', 'hi']) });
  bare.chats.commit({ ...bare.chats.record('cl'), segments: [{ ...bare.chats.record('cl').segments[0], kind: 'claude', nativeId: 's1' }] });
  let r = await bare.runner.perform('cl', ps({ harness: 'codex', automaticAccount: true }));
  assert.equal(r.ready, false);
});

test('a throwing segment write restores the Codex pin, and says so when it cannot', async () => {
  for (const rollbackFails of [false, true]) {
    const writes: Array<string | null> = [];
    const pool = {
      state: { chatPins: { 'cx-new': 'old' } },
      pinChat: (_t: string, id: string | null) => {
        if (rollbackFails && id === 'old') throw new Error('disk full during rollback');
        writes.push(id);
      },
    };
    const { runner, chats } = setup({
      claudeMessages: claudeTranscript(['hello', 'hi']),
      putAccount: (store: any) =>
        switchAccount({ chats: store, codex: () => pool, claude: { own: new Map(), setOwn() {} }, activateSelection: true }),
    });
    chats.commit({ ...chats.record('cl'), segments: [{ ...chats.record('cl').segments[0], kind: 'claude', nativeId: 's1' }] });
    chats.commit = () => {
      throw new Error('write failed');
    };
    const r = await runner.perform('cl', ps({ harness: 'codex', automaticAccount: true }));
    assert.equal(r.ready, false);
    assert.match(String((r as any).error?.message ?? (r as any).error), rollbackFails ? /restore the previous account/ : /write failed/);
  }
});

test('automatic Codex switch waits when its account pool is unavailable', async () => {
  const { runner, chats } = setup({
    claudeMessages: claudeTranscript(['hello', 'hi']),
    putAccount: (store: any) =>
      switchAccount({ chats: store, codex: () => null, claude: { own: new Map(), setOwn() {} }, activateSelection: true }),
  });
  chats.commit({ ...chats.record('cl'), segments: [{ ...chats.record('cl').segments[0], kind: 'claude', nativeId: 's1' }] });
  const result = await runner.perform('cl', ps({ harness: 'codex', automaticAccount: true }));
  assert.equal(result.ready, false);
  assert.equal(chats.record('cl').segments.at(-1).kind, 'claude');
});

test('automatic Codex switch restores its old pin when the segment cannot be saved', async () => {
  const pins: Array<string | null> = [];
  const pool = { state: { chatPins: { 'cx-new': 'old' } }, pinChat: (_thread: string, id: string | null) => pins.push(id) };
  const { runner, chats } = setup({
    claudeMessages: claudeTranscript(['hello', 'hi']),
    putAccount: (store: any) =>
      switchAccount({ chats: store, codex: () => pool, claude: { own: new Map(), setOwn() {} }, activateSelection: true }),
  });
  chats.commit({ ...chats.record('cl'), segments: [{ ...chats.record('cl').segments[0], kind: 'claude', nativeId: 's1' }] });
  chats.commit = () => false;
  const result = await runner.perform('cl', ps({ harness: 'codex', automaticAccount: true }));
  assert.equal(result.ready, false);
  assert.deepEqual(pins, [null, 'old']);
  assert.equal(chats.record('cl').segments.at(-1).kind, 'claude');
});

test('a failed segment write and failed rollback leave the original Codex pin recoverable', async () => {
  let writes = 0;
  const pool: any = {
    state: { chatPins: { 'cx-new': 'old' } },
    pinChat: (_thread: string, id: string | null) => {
      if (++writes === 2) throw new Error('disk full during rollback');
      pool.state.chatPins = id ? { 'cx-new': id } : {};
    },
  };
  const { runner, chats } = setup({
    claudeMessages: claudeTranscript(['hello', 'hi']),
    putAccount: (store: any) =>
      switchAccount({ chats: store, codex: () => pool, claude: { own: new Map(), setOwn() {} }, activateSelection: true }),
  });
  chats.commit({ ...chats.record('cl'), segments: [{ ...chats.record('cl').segments[0], kind: 'claude', nativeId: 's1' }] });
  chats.commit = () => false;
  const result = await runner.perform('cl', ps({ harness: 'codex', automaticAccount: true }));
  assert.equal(result.ready, false);
  assert.equal(pool.state.chatPins['cx-new'], 'old');
});

test("a switch to Claude Code on a picked account makes it the chat's pin there; a later switch back keeps the pin", async () => {
  const { runner, chats, own, ownMap } = withAccounts({ codexTurns: [codexTurn('t1', 'q', 'a')] });
  await runner.perform('c1', ps({ account: 'work' }));
  assert.deepEqual(chats.record('c1').meta.account, { id: 'work', pinned: true });
  assert.deepEqual(own, [['c1', 'work']]);
  // The newly committed switch owns the model/effort; an old live own entry cannot override it.
  assert.deepEqual(ownMap.get('c1'), { model: 'opus', effort: null, account: 'work' });
  // Codex and back: main is told the pin again before the first turn (a restart forgot it)
  await runner.perform('c1', ps({ harness: 'codex', model: 'gpt-x', modelLabel: 'GPT X' }));
  await runner.perform('c1', ps());
  assert.deepEqual(own, [
    ['c1', 'work'],
    ['c1', 'work'],
  ]);
});

test('a switch to Claude Code without a pick leaves a chat the pool placed to the login in use', async () => {
  const { runner, chats, own } = withAccounts({ codexTurns: [codexTurn('t1', 'q', 'a')] });
  chats.patchMeta('c1', { account: { id: 'home', pinned: false } });
  await runner.perform('c1', ps());
  assert.deepEqual(own, [['c1', null]], 'model activation preserves the unpinned login choice');
  assert.deepEqual(chats.record('c1').meta.account, { id: 'home', pinned: false });
});

test("an account that can't be applied is said, and the switch still goes on", async () => {
  const { runner, events } = setup({
    codexTurns: [codexTurn('t1', 'q', 'a')],
    putAccount: () => () => Promise.reject(new Error('no such login')),
  });
  const r = await runner.perform('c1', ps({ account: 'gone' }), 3);
  assert.equal(r.ready, true);
  const t = events.find((e) => e.kind === 'toast');
  assert.deepEqual(
    [t.level, t.text, t.target],
    ['error', "Couldn't put this chat on that Claude Code account (no such login); it uses the one in use", 3],
  );
});

test('the runner builds its account step from the Codex pool and ClaudeTurns it is given; a missing pool pins nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-switch-acct-'));
  const chats = new ChatsStore(path.join(dir, 'threads'));
  const own = new Map([['c', { model: 'old', effort: 'high', account: null }]]);
  const runner = new SwitchRunner({
    chats,
    accounts: { codex: () => null, claude: { own, setOwn: (id, value) => own.set(id, value) } },
  } as any);
  assert.equal(typeof runner.putAccount, 'function');
  // no Codex pool (no ChatGPT sign-in yet): a picked account has nowhere to go
  assert.equal(runner.putAccount({ chatId: 'c', harness: 'codex', nativeId: 't', account: 'a' }), undefined);
  chats.patchMeta('c', { config: { model: 'selected', effort: null } });
  runner.putAccount({ chatId: 'c', harness: 'claude', nativeId: 's', account: null });
  assert.deepEqual(own.get('c'), { model: 'selected', effort: null, account: null });
  assert.equal(new SwitchRunner({ chats } as any).putAccount, null);
});

test('a picked Codex account removed before the message went is said, never dropped silently', async () => {
  const { runner, chats, events, pins } = withAccounts({ claudeMessages: claudeTranscript(['hello', 'hi']) });
  chats.commit({ ...chats.record('cl'), segments: [{ ...chats.record('cl').segments[0], kind: 'claude', nativeId: 's1' }] });
  const r = await runner.perform('cl', ps({ harness: 'codex', model: 'gpt-x', modelLabel: 'GPT X', account: 'gone' }), 2);
  assert.equal(r.ready, true);
  assert.deepEqual(pins, []);
  assert.equal(
    events.find((e) => e.kind === 'toast')?.text,
    "Couldn't put this chat on that Codex account (that account was removed); it uses the one in use",
  );
});

test('a chat with no model or effort of its own there goes on its picked Claude login with neither', async () => {
  const { runner, ownMap } = withAccounts({ codexTurns: [codexTurn('t1', 'q', 'a')] });
  await runner.perform('c2', ps({ account: 'work', model: null, modelLabel: '' }));
  assert.deepEqual(ownMap.get('c2'), { model: null, effort: null, account: 'work' });
  // nothing picked yet in this window: no own entry at all
  await runner.perform('c3', ps({ account: 'home', model: null, modelLabel: '' }));
  assert.deepEqual(ownMap.get('c3'), { model: null, effort: null, account: 'home' });
});
