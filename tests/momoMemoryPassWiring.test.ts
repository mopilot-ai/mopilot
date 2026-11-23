// How main runs MoMo's memory pass (electron/app/momoBackground.cjs openMemoryPass): a pass chat is a MoMo background chat started isolated and unattended, on the brain's cheap model where its harness has one; what each chat is to the pass; the turns come from the peer runtime; progress per chat is sealed on disk and its tokens count in the day's background budget it shares with the search aliases; nothing runs while MoMo is paused or being reset; and the background service hands the pass every turn's end and stops it when MoMo goes off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch, momoStore } from './support/momo-memory.ts';
import { world } from './support/momoAppWorld.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { openMemoryPass, passKind } = require('../electron/app/momoBackground.cjs');
const { cheapBrain } = require('../electron/momo/cheapBrain.cjs');
const { UNATTENDED, ISOLATION } = require('../electron/momo/routines.cjs');
const { setMomoContextProvider } = require('../electron/momo/contract/context.cjs');
const { SealedJson } = require('../electron/gateway/sealedFile.cjs');
const { budgetIn, DAILY_TOKENS, KIND_TOKENS } = require('../electron/momo/backgroundBudget.cjs');
const { MAX_PASS_TOKENS } = require('../electron/momo/memoryPass.cjs');

test('cheapBrain picks the cheap model only where the harness has one, always at low effort; passKind tells MoMo’s chats apart', async () => {
  // the user's effort for MoMo's replies never reaches a background pass
  assert.deepEqual(await cheapBrain({ harness: 'claude', account: 'a', model: 'opus', effort: 'max' }), {
    harness: 'claude',
    account: 'a',
    model: 'haiku',
    effort: 'low',
  });
  const codex = { harness: 'codex', model: 'gpt', effort: 'xhigh' };
  const low = { ...codex, effort: 'low' };
  const list = async () => ({
    data: [
      { model: 'gpt-big', description: 'Frontier model' },
      { model: 'gpt-hidden', hidden: true, description: 'Fast and affordable agentic coding model' },
      { model: 'gpt-luna', description: 'Fast and affordable model for easier tasks' },
    ],
  });
  assert.deepEqual(
    await cheapBrain(codex, list),
    { harness: 'codex', model: 'gpt-luna', effort: 'low' },
    'Codex: the listed model it calls cheap',
  );
  assert.deepEqual(await cheapBrain(codex), low, 'no list: the brain’s own model');
  assert.deepEqual(await cheapBrain(codex, async () => ({ data: [{ model: 'gpt-big' }, null] })), low, 'none called cheap');
  assert.deepEqual(await cheapBrain(codex, async () => ({})), low, 'no data');
  assert.deepEqual(
    await cheapBrain(codex, async () => {
      throw new Error('app-server down');
    }),
    low,
    'a list that fails: the brain’s own model',
  );
  assert.equal(await cheapBrain(null), null);
  const acp = { harness: 'acp:kimi', model: 'k2' };
  // its thought level is the session's own: brainOf drops the effort (momoBrainEffort.test.ts)
  assert.deepEqual(await cheapBrain(acp, list), { ...acp, effort: 'low' }, 'an ACP harness names no cheap model: its own');
  assert.equal(passKind({ momo: 'main' }), 'main');
  assert.equal(passKind({ momo: 'routine' }), 'routine');
  assert.equal(passKind({ momo: 'memory' }), 'pass');
  assert.equal(passKind({}), null);
  assert.equal(passKind(undefined), null);
});

function deps(o: { paused?: boolean; allowed?: boolean; held?: boolean } = {}) {
  const { s } = momoStore();
  const dir = scratch();
  const started: any[] = [];
  const patched: any[] = [];
  const sent: any[] = [];
  const discarded: string[] = [];
  const d = {
    core: { dir, memory: s, mainChat: { current: () => 'momo-main' } },
    live: {
      peerRuntime: {
        readReference: async (id: string) => ({
          turns:
            id === 'momo-main'
              ? [{ id: 't1', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'I moved to Lisbon' }] }] }]
              : [],
        }),
      },
      sessions: { patch: (id: string, p: any) => void patched.push([id, p]) },
    },
    meta: (id: string) => (id === 'momo-main' ? { momo: 'main' } : undefined),
    allowed: () => o.allowed ?? true,
    safeStorage: fakeSafe(),
    startChat: async (brain: any, tag: any) => (started.push([brain, tag]), 'pass-1'),
    send: async (id: string, item: any) => void sent.push([id, item]),
    authored: (id: string, text: string, show: any) => ({ id, text, show }),
    discardChat: (id: string) => void discarded.push(id),
    limitOf: () => (o.held ? { held: 'out of usage' } : { go: {} }),
    momoPrefs: () => ({ brain: { main: { harness: 'claude', model: 'opus' } }, ...(o.paused ? { paused: true } : {}) }),
  };
  return { d, s, dir, started, patched, sent, discarded };
}

test('a pass chat starts isolated and unattended on the cheap model, reads the chat’s turns and seals its progress', async () => {
  const t = deps();
  const pass = openMemoryPass(t.d);
  assert.equal(await pass.start('momo-main'), true);
  assert.equal(t.started[0][0].model, 'haiku');
  assert.deepEqual(t.started[0][1], { momo: 'memory', forChat: 'momo-main', isolation: ISOLATION });
  assert.deepEqual(t.patched, [['pass-1', { scheduled: UNATTENDED }]]);
  assert.equal(t.sent[0][1].show.title, 'Memory');
  assert.match(t.sent[0][1].text, /I moved to Lisbon/);
  await pass.finished({ chatId: 'pass-1', text: '{"ops":[{"op":"add","text":"Moved to Lisbon"}]}' });
  assert.deepEqual(
    t.s.list().facts.map((f: any) => f.text),
    ['Moved to Lisbon'],
  );
  // progress is sealed on disk, and read back by a pass made again (a restart)
  const sealed = new SealedJson({ file: path.join(t.dir, 'memory-pass.json'), safeStorage: t.d.safeStorage, shape: (v: any) => v ?? {} });
  await waitFor(() => sealed.read()['momo-main'] === 't1', 'progress to be sealed');
  assert.ok(!fs.readFileSync(path.join(t.dir, 'memory-pass.json'), 'utf8').includes('t1'), 'sealed');
  const again = openMemoryPass(t.d);
  assert.equal(await again.start('momo-main'), false, 'nothing said since t1');
  assert.ok(budgetIn(t.dir, t.d.safeStorage).byKind().memory > 0, 'the prompt and reply count in the shared day, on disk');
  assert.equal(passKind(t.d.meta('momo-main')), 'main');
  assert.equal(await again.finished({ chatId: 'momo-main' }), null, 'a MoMo chat’s turn starts its idle clock');
  again.cancelAll();
});

test('the pass draws on the shared day: past the memory share none starts, and its old day counts are dropped on the next write', async () => {
  const t = deps();
  const sealed = new SealedJson({ file: path.join(t.dir, 'memory-pass.json'), safeStorage: t.d.safeStorage, shape: (v: any) => v ?? {} });
  await sealed.change((v: any) => {
    v['#passes'] = [Date.now()];
    v['#tokens'] = [[Date.now(), 100]];
  });
  const budget = budgetIn(t.dir, t.d.safeStorage);
  await budget.spend('memory', KIND_TOKENS.memory - 100);
  assert.equal(await openMemoryPass({ ...t.d, budget }).start('momo-main'), false, 'the memory share is spent');
  assert.equal(t.started.length, 0);
  // the aliases' share is apart: another day's budget lets it run, and the old keys go with the next progress write
  const pass = openMemoryPass({ ...t.d, budget: { spend: async () => {}, left: () => 1e9 } });
  assert.equal(await pass.start('momo-main'), true);
  await pass.finished({ chatId: 'pass-1', text: '{"ops":[]}' });
  await waitFor(() => sealed.read()['momo-main'] === 't1', 'progress to be sealed');
  assert.deepEqual(sealed.read(), { 'momo-main': 't1' });
  pass.cancelAll();
});

test('no pass runs while MoMo is paused, off, or its brain is at its limit; progress that can’t be read counts as none', async () => {
  for (const o of [{ paused: true }, { allowed: false }, { held: true }]) {
    const t = deps(o);
    assert.equal(await openMemoryPass(t.d).start('momo-main'), false, JSON.stringify(o));
    assert.equal(t.started.length, 0);
  }
  const t = deps();
  t.d.safeStorage = { ...fakeSafe(), isEncryptionAvailable: () => false };
  const pass = openMemoryPass(t.d);
  assert.equal(await pass.start('momo-main'), true, 'unreadable progress: the turns are read from the start');
  await pass.finished({ chatId: 'pass-1', text: '{"ops":[]}' });
  // the failed write of progress is noted, never thrown
  await new Promise((r) => setTimeout(r, 20));
  const none = deps();
  none.d.live = {} as any;
  assert.equal(await openMemoryPass(none.d).start('momo-main'), false, 'no peer runtime: no turns');
});

test('the background service hands the pass each turn’s end and stops it when MoMo goes off', async () => {
  const w = world({ allowed: true });
  const seen: string[] = [];
  let cancelled = 0;
  let daily = 0;
  w.m.memoryPass.finished = async (e: any) => void seen.push(e.chatId);
  w.m.memoryPass.cancelAll = () => void cancelled++;
  w.m.memoryPass.startDaily = () => void daily++;
  await w.live.controller.onFinished({ chatId: 'mc' });
  await waitFor(() => seen.length, 'the finished chat to be seen');
  assert.deepEqual(seen, ['mc']);
  for (const cb of w.access) cb(false);
  assert.equal(cancelled, 1);
  for (const cb of w.access) cb(true);
  assert.equal(daily, 1, 'on again: the daily reflection starts again');
  await w.m.close();
  setMomoContextProvider(null);
});

test('the daily reflection is told as from MoMo’s main chat', async () => {
  const t = deps();
  await t.s.save({ text: 'Works at Acme', source: { chatId: 'momo-main', harness: 'claude' } });
  const pass = openMemoryPass({
    ...t.d,
    timers: { setTimeout, clearTimeout, setInterval: (fn: any) => (fn(), 1), clearInterval: () => {} },
  });
  pass.startDaily();
  await waitFor(() => t.sent.length, 'the daily pass to send');
  assert.equal(t.started[0][1].forChat, 'momo-main');
  assert.match(t.sent[0][1].text, /^Review MoMo's memory/);
  pass.cancelAll();
});

test("a chat of the memory pass gets none of MoMo's memory tools in the app", async () => {
  const w = world({ allowed: true });
  w.chats.commit({
    id: 'mp',
    segments: [{ kind: 'claude', nativeId: 'mp', start: 0, count: null }],
    meta: { momo: 'memory', forChat: 'mc' },
  });
  w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 'mc', start: 0, count: null }], meta: { momo: 'main' } });
  const names = (chatId: string) => w.live.capabilities.list({ chatId }).map((t: any) => t.name);
  assert.ok(names('mc').includes('momo_memory_save'));
  assert.ok(!names('mp').some((n: string) => n.startsWith('momo_memory_')));
  // the Memory IPC reads the app's one background budget: the day's cap, each share, and nothing spent yet
  const bg = await w.call('momoMemory:background');
  assert.deepEqual(bg, {
    ok: true,
    limits: {
      daily: { cap: DAILY_TOKENS, today: 0 },
      memory: { cap: KIND_TOKENS.memory, today: 0 },
      aliases: { cap: KIND_TOKENS.aliases, today: 0 },
      maxTokensPerPass: MAX_PASS_TOKENS,
    },
  });
  await w.m.close();
  setMomoContextProvider(null);
});

test('a development build may shorten the pass’s idle; nothing else can', () => {
  const { passIdleMs } = require('../electron/app/momoBackground.cjs');
  assert.equal(passIdleMs({ MOPILOT_MOMO_DEV: '1', MOPILOT_MOMO_PASS_IDLE_MS: '2000' }), 2000);
  assert.equal(passIdleMs({ MOPILOT_MOMO_PASS_IDLE_MS: '2000' }), undefined);
  assert.equal(passIdleMs({ MOPILOT_MOMO_DEV: '1', MOPILOT_MOMO_PASS_IDLE_MS: '10' }), undefined);
  assert.equal(passIdleMs({ MOPILOT_MOMO_DEV: '1' }), undefined);
  // the default reads this process's environment
  const saved = { dev: process.env.MOPILOT_MOMO_DEV, ms: process.env.MOPILOT_MOMO_PASS_IDLE_MS };
  try {
    process.env.MOPILOT_MOMO_DEV = '1';
    process.env.MOPILOT_MOMO_PASS_IDLE_MS = '3000';
    assert.equal(passIdleMs(), 3000);
  } finally {
    for (const [k, v] of [
      ['MOPILOT_MOMO_DEV', saved.dev],
      ['MOPILOT_MOMO_PASS_IDLE_MS', saved.ms],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test('a message MoMo sent in the chat (its meta’s authored record) is never read as the user’s words; with open loops, lines carry their time', async () => {
  const { OpenLoopStore } = require('../electron/momo/openLoops.cjs');
  const t = deps();
  const said = (text: string, id?: string) => ({ ...(id ? { id } : {}), type: 'userMessage', content: [{ type: 'text', text }] });
  t.d.live.peerRuntime.readReference = async () => ({
    turns: [{ id: 't1', items: [said('Routine says: you moved to Paris', 'r1'), said('I moved to Lisbon')] }],
  });
  t.d.meta = (id: string) => (id === 'momo-main' ? { momo: 'main', authored: { r1: { by: 'momo', title: 'Routine', at: 1 } } } : undefined);
  (t.d.core as any).loops = new OpenLoopStore({ dir: t.dir, safeStorage: t.d.safeStorage });
  const pass = openMemoryPass(t.d);
  assert.equal(await pass.start('momo-main'), true);
  assert.match(t.sent[0][1].text, /MoMo: Routine says: you moved to Paris/);
  assert.doesNotMatch(t.sent[0][1].text, /User( \[[^\]]*\])?: Routine says/);
  assert.match(t.sent[0][1].text, /It is now \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(t.sent[0][1].text, /\nUser \[\w{3} [^\]]+\]: I moved to Lisbon/);
  pass.cancelAll();
});
