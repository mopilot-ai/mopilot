// MoMo's background memory pass (#2139 P3, electron/momo/memoryPass.cjs) over a real memory store with a fake brain: a chat idle for IDLE_MS gets one pass on its new turns only, the reply's ops checked (only words that were said, no secrets) and applied through the store's rules, the pass chat discarded; nothing runs or lands when MoMo is off, the brain is at its limit or MoMo was reset; the daily reflection; and the prompt and reply parsing.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { src, momoStore as store } from './support/momo-memory.ts';

const require = createRequire(import.meta.url);
const {
  createMemoryPass,
  passPrompt,
  cappedPrompt,
  parseOps,
  checkOps,
  turnText,
  IDLE_MS,
  REFLECT_MS,
  MAX_PASS_TOKENS,
  PASS_REPLY_TOKENS,
} = require('../electron/momo/memoryPass.cjs');
const { estimateTokens } = require('../electron/momo/memoryFacts.cjs');

const turn = (user: string, momo: string, id = 't1') => ({
  id,
  items: [
    { type: 'userMessage', content: [{ type: 'text', text: user }] },
    { type: 'agentMessage', text: momo },
    { type: 'toolCall', text: 'ignored' },
  ],
});

/** A pass over a real store with fake timers, chats and brain; `reply` is what the pass chat answers. */
function setup(
  o: {
    allowed?: () => boolean;
    atLimit?: boolean;
    turns?: any[];
    brain?: any;
    kind?: string | null;
    /** the memory share left in the day's background budget */
    left?: number;
    /** steps a test holds open: each awaits its promise first */
    hold?: { readTurns?: Promise<unknown>; brain?: Promise<unknown>; startChat?: Promise<unknown>; spend?: Promise<unknown> };
    /** the progress save lands a moment after it is asked for, as the app's sealed write does */
    slowSeen?: boolean;
    /** the idle before a pass (a development build's) */
    idleMs?: number;
    /** the prompt fails to send while `on` */
    sendFails?: { on: boolean };
  } = {},
) {
  const { s } = store();
  const timers: any[] = [];
  const intervals: any[] = [];
  const sent: { chat: string; text: string }[] = [];
  const discarded: string[] = [];
  const seen = new Map<string, string>();
  let spent = 0;
  const spends: [string, number][] = [];
  let n = 0;
  const pass = createMemoryPass({
    store: s,
    allowed: o.allowed ?? (() => true),
    kindOf: (id: string) => (o.kind !== undefined ? o.kind : id.startsWith('momo-') ? 'main' : null),
    readTurns: async () => (await o.hold?.readTurns, o.turns ?? [turn('I moved to Lisbon last month', 'Noted, Lisbon it is.')]),
    brain: async () => (await o.hold?.brain, o.brain !== undefined ? o.brain : { harness: 'claude', model: 'haiku' }),
    atLimit: () => !!o.atLimit,
    startChat: async () => {
      const id = `pass-${++n}`;
      await o.hold?.startChat;
      return id;
    },
    send: async (chat: string, text: string) => {
      if (o.sendFails?.on) throw new Error('send failed');
      sent.push({ chat, text });
    },
    discardChat: (chat: string) => void discarded.push(chat),
    seen: {
      get: (id: string) => seen.get(id) ?? null,
      set: (id: string, v: string) =>
        o.slowSeen ? new Promise<void>((r) => setTimeout(() => (seen.set(id, v), r()), 10)) : void seen.set(id, v),
    },
    looksSecret: (t: string) => /sk-[a-z0-9]{8,}/.test(t),
    idleMs: o.idleMs,
    budget: {
      spend: async (kind: string, t: number) => {
        spends.push([kind, t]);
        spent += t;
        await o.hold?.spend;
      },
      left: (kind: string) => (kind === 'memory' ? (o.left ?? 1e9) - spent : 0),
    },
    mainChat: () => 'momo-main',
    timers: {
      setTimeout: (fn: () => void, ms: number) => (timers.push({ fn, ms, live: true }), timers.length - 1),
      clearTimeout: (i: number) => i !== undefined && timers[i] && (timers[i].live = false),
      setInterval: (fn: () => void, ms: number) => (intervals.push({ fn, ms, live: true }), intervals.length - 1),
      clearInterval: (i: number) => (intervals[i].live = false),
    },
  });
  const fire = async () => {
    for (const t of timers.filter((x) => x.live)) {
      t.live = false;
      t.fn();
    }
    await new Promise((r) => setImmediate(r));
  };
  return { s, pass, timers, intervals, sent, discarded, seen, fire, spent: () => spent, spends, started: () => n };
}

test('a MoMo chat idle for IDLE_MS gets one pass on its new turns; the checked ops land and the pass chat goes', async () => {
  const t = setup();
  assert.equal(await t.pass.finished({ chatId: 'momo-main' }), null);
  await t.pass.finished({ chatId: 'momo-main' });
  assert.equal(t.timers.filter((x) => x.live).length, 1, 'a second turn restarts the one idle clock');
  assert.equal(t.timers[0].ms, IDLE_MS);
  await t.fire();
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].text, /User: I moved to Lisbon last month/);
  assert.match(t.sent[0].text, /Facts kept:\n\(none\)/);
  assert.equal(t.pass.pending(), 1);
  const result = await t.pass.finished({
    chatId: 'pass-1',
    text: 'Sure:\n```json\n{"ops":[{"op":"add","text":"Moved to Lisbon last month","confidence":"sure"},{"op":"add","text":"Owns a yacht"}]}\n```',
  });
  assert.deepEqual(result.dropped, [{ op: 'add', reason: 'not said: owns, yacht' }]);
  assert.equal(result.change.by, 'pass');
  assert.equal(result.change.reason, 'chat idle');
  const fact = t.s.list().facts[0];
  assert.deepEqual(
    [fact.text, fact.origin, fact.source],
    ['Moved to Lisbon last month', 'extracted', { chatId: 'momo-main', harness: 'claude' }],
  );
  assert.deepEqual(t.discarded, ['pass-1']);
  assert.equal(t.seen.get('momo-main'), 't1', 'the last turn read');
  assert.ok(t.spent() > 0);
  // nothing new since: the next idle starts no pass
  await t.pass.finished({ chatId: 'momo-main' });
  await t.fire();
  assert.equal(t.sent.length, 1);
});

test('no pass runs for a chat that is not MoMo’s, while MoMo is off, without a brain, or at its limit; a pass chat that starts as MoMo goes off is dropped', async () => {
  const other = setup({ kind: null });
  await other.pass.finished({ chatId: 'coding-1' });
  assert.equal(other.timers.length, 0);
  for (const t of [setup({ allowed: () => false }), setup({ atLimit: true }), setup({ brain: null })]) {
    assert.equal(await t.pass.start('momo-main'), false);
    assert.equal(t.sent.length, 0);
  }
  let on = true;
  const t = setup({ allowed: () => on });
  const started = t.pass.start('momo-main');
  on = false;
  assert.equal(await started, false);
  assert.deepEqual(t.discarded, ['pass-1'], 'the chat made while MoMo went off is discarded');
  assert.equal(await setup({ turns: [] }).pass.start('momo-main'), false, 'nothing said: no pass');
});

test('one pass per chat at a time; MoMo going off or a reset drops a pass under way, and a bad reply changes nothing', async () => {
  const t = setup();
  assert.equal(await t.pass.start('momo-main'), true);
  assert.equal(await t.pass.start('momo-main'), false, 'already running');
  t.pass.cancelAll();
  assert.equal(await t.pass.finished({ chatId: 'pass-1', text: '{"ops":[{"op":"add","text":"Moved to Lisbon"}]}' }), null);
  assert.deepEqual(t.s.list().facts, []);
  assert.deepEqual(t.discarded, ['pass-1'], 'still discarded');
  assert.equal(t.seen.get('momo-main'), undefined, 'its turns are read again next time');
  assert.equal(await t.pass.start('momo-main'), true, 'running again after the reset');
  assert.equal(await t.pass.finished({ chatId: 'pass-2', text: 'I could not decide.' }), null);
  assert.deepEqual(t.s.list().facts, []);
  // a reset also stops the idle clocks
  await t.pass.finished({ chatId: 'momo-main' });
  t.pass.cancelAll();
  assert.equal(t.timers.filter((x) => x.live).length, 0);
});

test('a routine chat is read too; a reply landing after MoMo went off is dropped', async () => {
  let on = true;
  const t = setup({ kind: 'routine', allowed: () => on });
  await t.pass.finished({ chatId: 'momo-run' });
  await t.fire();
  on = false;
  assert.equal(await t.pass.finished({ chatId: 'pass-1', text: '{"ops":[{"op":"add","text":"Moved to Lisbon"}]}' }), null);
  assert.deepEqual(t.s.list().facts, []);
});

test('the daily reflection reviews the kept facts as from the main chat and may supersede them', async () => {
  const t = setup();
  await t.s.save({ text: 'Works at Acme', source: src });
  await t.s.save({ text: 'Works at Globex since May', source: src });
  t.pass.startDaily();
  t.pass.startDaily();
  assert.equal(t.intervals.length, 1, 'started once');
  assert.equal(t.intervals[0].ms, REFLECT_MS);
  t.intervals[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.match(t.sent[0].text, /^Review MoMo's memory/);
  assert.doesNotMatch(t.sent[0].text, /What was said/);
  const r = await t.pass.finished({ chatId: 'pass-1', text: '{"ops":[{"op":"supersede","id":"f1","text":"Works at Globex since May"}]}' });
  assert.equal(r.change, null, 'the same text as a kept fact is a duplicate');
  assert.equal(r.change?.reason ?? 'reflection', 'reflection');
  t.pass.cancelAll();
  assert.equal(t.intervals[0].live, false);
  // nothing kept: no reflection
  const empty = setup();
  assert.equal(await empty.pass.start('momo-main', true), false);
});

test('the daily reflection without a main chat starts nothing', async () => {
  const t = setup();
  const pass = createMemoryPass({
    ...({} as any),
    store: t.s,
    allowed: () => true,
    kindOf: () => null,
    readTurns: async () => [],
    brain: async () => ({}),
    atLimit: () => false,
    startChat: async () => 'x',
    send: async () => {},
    discardChat: () => {},
    seen: { get: () => null, set: () => {} },
    looksSecret: () => false,
    timers: { setTimeout, clearTimeout, setInterval: (fn: any) => (fn(), 1), clearInterval: () => {} },
  });
  pass.startDaily();
  pass.cancelAll();
  assert.equal(pass.pending(), 0);
});

test('checkOps keeps only facts made of what was said, never a secret, and leaves malformed ops to the store', () => {
  const facts = [{ id: 'f1', text: 'Works at Acme' }];
  const { kept, dropped } = checkOps(
    [
      { op: 'add', text: 'The user lives in Berlin' },
      { op: 'supersede', id: 'f1', text: 'Works at Acme in Berlin' },
      { op: 'add', text: 'Key is sk-abcdefgh123' },
      { op: 'add', text: '用户 柏林' },
      { op: 'add', text: 'Lives in Paris' },
      { op: 'noop' },
      { op: 'add', text: 42 },
    ],
    { sourceText: 'I live in Berlin now. 我住在 柏林', facts, looksSecret: (t: string) => t.includes('sk-') },
  );
  assert.equal(kept.length, 5);
  assert.deepEqual(dropped, [
    { op: 'add', reason: 'looks like a secret' },
    { op: 'add', reason: 'not said: paris' },
  ]);
});

test('parseOps reads the first JSON object with ops; turnText keeps what the user and MoMo said; the prompt names its parts', () => {
  assert.deepEqual(parseOps('{"ops":[]}'), []);
  assert.deepEqual(parseOps('here: {"ops":[{"op":"noop"}]} done'), [{ op: 'noop' }]);
  for (const bad of [null, '', 'no json', '} {', '{"ops":3}', '{not json}']) assert.equal(parseOps(bad), null, String(bad));
  assert.equal(turnText(turn('hi', 'hello')), 'User: hi\nMoMo: hello');
  assert.equal(turnText({}), '');
  assert.equal(turnText({ items: [{ type: 'userMessage' }] }), '');
  // the words are the content's text parts; MoMo's block ahead of them, or a message that is only that block, is not said
  const block = "<momo-context>\nMoMo's memory, from MoPilot.\n\nLikes tea\n</momo-context>";
  assert.equal(
    turnText({
      items: [
        {
          type: 'userMessage',
          content: [
            { type: 'text', text: `${block}\nI moved` },
            { type: 'image', url: 'x' },
            { type: 'text', text: 'to Lisbon' },
          ],
        },
        { type: 'userMessage', content: [{ type: 'text', text: block }] },
        { type: 'userMessage', content: [{ type: 'text', text: '[REDACTED:momo-context] hi' }] },
        { type: 'userMessage', text: 'a made-up field is no words' },
      ],
    }),
    'User: I moved\nto Lisbon\nUser: hi',
  );
  const p = passPrompt({ sourceText: 'said', facts: [{ id: 'f1', text: 'kept' }], reflect: false });
  assert.match(p, /- \[f1\] kept/);
  assert.match(p, /What was said:\nsaid$/);
});

test('a pass reads only the turns after the last one read, all of them when that one left the reference, and nothing when no turn has an id', async () => {
  const turns = [turn('I play chess', 'Nice.', 'a'), turn('I moved to Lisbon', 'Noted.', 'b')];
  const t = setup({ turns });
  t.seen.set('momo-main', 'a');
  await t.pass.start('momo-main');
  assert.match(t.sent[0].text, /Lisbon/);
  assert.doesNotMatch(t.sent[0].text, /chess/);
  const gone = setup({ turns });
  gone.seen.set('momo-main', 'old');
  await gone.pass.start('momo-main');
  assert.match(gone.sent[0].text, /chess[\s\S]*Lisbon/);
  const noIds = setup({ turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'I moved to Lisbon' }] }] }] });
  await noIds.pass.start('momo-main');
  await noIds.pass.finished({ chatId: 'pass-1', text: '{"ops":[]}' });
  assert.equal(noIds.seen.get('momo-main'), undefined, 'no id to remember');
});

test('a brain that names no harness is told as such, and a pass reply with no text changes nothing', async () => {
  const t = setup({ brain: {} });
  await t.pass.start('momo-main');
  assert.equal(await t.pass.finished({ chatId: 'pass-1' }), null);
  assert.deepEqual(t.discarded, ['pass-1']);
});

test('a pass prompt stays under MAX_PASS_TOKENS: the oldest of what was said goes first, then the least related facts', () => {
  const long = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(' ');
  const c = cappedPrompt({ sourceText: long, facts: [], reflect: false });
  assert.ok(estimateTokens(c.prompt) <= MAX_PASS_TOKENS);
  assert.ok(long.endsWith(c.sourceText), 'the newest part is kept');
  const facts = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, text: `fact ${i} `.repeat(30) }));
  const r = cappedPrompt({ sourceText: '', facts, reflect: true });
  assert.ok(estimateTokens(r.prompt) <= MAX_PASS_TOKENS);
  assert.ok(r.facts.length < 200 && r.facts[0].id === 'f0', 'the most related facts are kept');
  const one = cappedPrompt({ sourceText: 'x'.repeat(150), facts: [{ id: 'a', text: 'y'.repeat(40_000) }], reflect: false });
  assert.deepEqual([one.sourceText.length, one.facts], [150, []], 'a short chat stays whole; a fact too long goes');
});

test('a pass draws on the memory share of the day’s background budget: prompt and reply count, and none starts past it', async () => {
  const t = setup({ turns: [turn('I moved to Lisbon', 'ok', 'tx')] });
  assert.equal(await t.pass.start('momo-main'), true);
  const [[kind, prompt]] = t.spends;
  assert.equal(kind, 'memory');
  assert.equal(prompt, estimateTokens(t.sent[0].text), 'the prompt as sent is counted when it is sent');
  await t.pass.finished({ chatId: 'pass-1', text: '{"ops":[]}' });
  assert.deepEqual(t.spends[1], ['memory', estimateTokens('{"ops":[]}')], 'and the reply when it lands');
  // a share left that can't hold a prompt and its reply: nothing starts, nothing is counted
  const need = estimateTokens(cappedPrompt({ sourceText: turnText(turn('I moved to Lisbon', 'ok')), facts: [], reflect: false }).prompt);
  const tight = setup({ turns: [turn('I moved to Lisbon', 'ok', 'tx')], left: need + PASS_REPLY_TOKENS - 1 });
  assert.equal(await tight.pass.start('momo-main'), false);
  assert.deepEqual([tight.started(), tight.spends.length], [0, 0]);
  const fits = setup({ turns: [turn('I moved to Lisbon', 'ok', 'tx')], left: need + PASS_REPLY_TOKENS });
  assert.equal(await fits.pass.start('momo-main'), true, 'one that holds both starts');
});

/** A promise a test settles when it wants: `open()` lets the held step go on. */
function gate() {
  let open = () => {};
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

test('#3431: a pass of a retired generation landing late never frees the chat a newer pass holds', async () => {
  const t = setup();
  assert.equal(await t.pass.start('momo-main'), true, 'A: pass-1');
  t.pass.cancelAll();
  assert.equal(await t.pass.start('momo-main'), true, 'B: pass-2, after the reset');
  assert.equal(await t.pass.finished({ chatId: 'pass-1', text: '{"ops":[]}' }), null, 'A is dropped');
  assert.equal(await t.pass.start('momo-main'), false, 'B still holds the chat: no C overlaps it');
  await t.pass.finished({ chatId: 'pass-2', text: '{"ops":[]}' });
  assert.equal(await t.pass.start('momo-main'), false, 'B landed and read every turn: nothing new');
  assert.deepEqual(t.discarded, ['pass-1', 'pass-2']);
});

for (const step of ['readTurns', 'brain', 'startChat'] as const) {
  test(`#3431: a start held at ${step} across a reset sends nothing and leaves the new generation's state alone`, async () => {
    const g = gate();
    const t = setup({ hold: { [step]: g.p } });
    const stale = t.pass.start('momo-main');
    await new Promise((r) => setImmediate(r));
    t.pass.cancelAll();
    g.open();
    assert.equal(await stale, false, 'the retired start does not publish');
    assert.equal(t.sent.length, 0, 'nothing sent');
    assert.equal(t.pass.pending(), 0);
    assert.equal(t.spends.length, 0, 'no token counted');
    // a chat it had made is discarded, never left running
    assert.deepEqual(t.discarded, step === 'startChat' ? ['pass-1'] : []);
  });
}

test('#3431: a newer start that holds the chat is not freed by an older start that gave up after the reset', async () => {
  const g = gate();
  const hold: any = { brain: g.p };
  const t = setup({ hold });
  const stale = t.pass.start('momo-main');
  await new Promise((r) => setImmediate(r));
  t.pass.cancelAll();
  hold.brain = undefined;
  assert.equal(await t.pass.start('momo-main'), true, 'B starts in the new generation');
  g.open();
  assert.equal(await stale, false);
  assert.equal(await t.pass.start('momo-main'), false, 'B still holds the chat');
});

test('#3431: a reset while a pass’s ops are being written leaves the new generation’s progress alone', async () => {
  const t = setup();
  const g = gate();
  const apply = t.s.applyPass.bind(t.s);
  t.s.applyPass = async (...a: any[]) => {
    await g.p;
    return apply(...a);
  };
  assert.equal(await t.pass.start('momo-main'), true);
  const landing = t.pass.finished({ chatId: 'pass-1', text: '{"ops":[]}' });
  await new Promise((r) => setImmediate(r));
  t.pass.cancelAll();
  g.open();
  await landing;
  assert.equal(t.seen.get('momo-main'), undefined, 'how far the retired pass read is not written after the reset');
});

test('#3431: a pass whose prompt can’t be sent frees its chat and discards its pass chat; a reset discards a pass under way', async () => {
  const fail = { on: true };
  const t = setup({ sendFails: fail });
  await assert.rejects(t.pass.start('momo-main'), /send failed/);
  assert.equal(t.pass.pending(), 0);
  assert.deepEqual(t.discarded, ['pass-1'], 'the pass chat that was never sent goes');
  fail.on = false;
  assert.equal(await t.pass.start('momo-main'), true, 'the chat is free: the next pass runs');
  t.pass.cancelAll();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.pass.pending(), 0);
  assert.deepEqual(t.discarded, ['pass-1', 'pass-2'], 'a reset discards the pass under way, without waiting for its turn');
  assert.equal(await t.pass.finished({ chatId: 'pass-2', text: '{"ops":[]}' }), null, 'its late turn end is not a pass any more');
  assert.deepEqual(t.discarded, ['pass-1', 'pass-2']);
});

test('a reset or MoMo going off while a pass’s prompt is counted: nothing is sent, its chat goes once, and the slot is free', async () => {
  for (const cut of ['cancelAll', 'off'] as const) {
    const g = gate();
    let on = true;
    const hold: any = { spend: g.p };
    const t = setup({ hold, allowed: () => on });
    const starting = t.pass.start('momo-main');
    await waitFor(() => t.spends.length > 0, 'the first spend').catch(() => {});
    assert.equal(t.spends.length, 1, cut);
    if (cut === 'cancelAll') t.pass.cancelAll();
    else on = false;
    g.open();
    assert.equal(await starting, false, cut);
    assert.equal(t.sent.length, 0, `${cut}: never sent`);
    assert.deepEqual(t.discarded, ['pass-1'], `${cut}: its chat goes, once`);
    assert.equal(t.pass.pending(), 0, cut);
    assert.equal(await t.pass.finished({ chatId: 'pass-1', text: '{"ops":[]}' }), null, `${cut}: a late turn end is not a pass`);
    // the chat is free again: the next pass runs
    on = true;
    hold.spend = undefined;
    assert.equal(await t.pass.start('momo-main'), true, cut);
    assert.equal(t.sent[0].chat, 'pass-2', cut);
  }
});

test('a chat that goes quiet again while its pass runs gets one more pass once it lands; a reflection or a reset asks for none', async () => {
  const turns: any[] = [turn('I play chess', 'Nice.', 'a')];
  const t = setup({ turns, idleMs: 1234 });
  await t.pass.finished({ chatId: 'momo-main' });
  assert.equal(t.timers[0].ms, 1234, 'the idle a development build may shorten');
  assert.equal(await t.pass.start('momo-main'), true);
  turns.push(turn('I moved to Lisbon', 'Noted.', 'b'));
  assert.equal(await t.pass.start('momo-main'), false, 'busy: asks for one more');
  assert.equal(await t.pass.start('momo-main', true), false);
  await t.pass.finished({ chatId: 'pass-1', text: '{"ops":[]}' });
  await waitFor(() => t.sent.length >= 2, 'the second pass to be sent').catch(() => {});
  assert.equal(t.sent.length, 2, 'one more pass');
  assert.match(t.sent[1].text, /User: I moved to Lisbon/);
  await t.pass.finished({ chatId: 'pass-2', text: '{"ops":[]}' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.sent.length, 2, 'and only one');
  const r = setup({ turns });
  await r.pass.start('momo-main');
  await r.pass.start('momo-main');
  r.pass.cancelAll();
  await r.pass.start('momo-main');
  await r.pass.finished({ chatId: 'pass-2', text: '{"ops":[]}' });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.sent.length, 2, 'the one asked for before the reset is dropped');
});

test('the next pass reads from where the last one saved, once that save landed', async () => {
  const turns: any[] = [turn('I play chess', 'Nice.', 'a')];
  // the app's save is a sealed write that lands a moment later
  const t = setup({ turns, slowSeen: true });
  await t.pass.start('momo-main');
  turns.push(turn('I moved to Lisbon', 'Noted.', 'b'));
  await t.pass.start('momo-main');
  await t.pass.finished({ chatId: 'pass-1', text: '{"ops":[]}' });
  await waitFor(() => t.sent.length >= 2, 'the second pass to be sent').catch(() => {});
  assert.doesNotMatch(t.sent[1].text, /I play chess/, 'the rerun starts after the turn the first pass saved');
  assert.match(t.sent[1].text, /I moved to Lisbon/);
});
