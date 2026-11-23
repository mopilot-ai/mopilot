// The open-loop half of MoMo's memory pass (#2139 P4, electron/momo/memoryPass.cjs with openLoopsPass.cjs): a pass over MoMo's main chat asks for loops with each user line's time in the user's zone, lands only loops quoted from the user's own words (never a tool result, MoMo's reply, or MoMo's own message such as a nudge or a routine's result, so a nudge never re-extracts itself), never from a routine's run or a reflection, and nothing after a reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch, momoStore } from './support/momo-memory.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createMemoryPass, turnText } = require('../electron/momo/memoryPass.cjs');
const { OpenLoopStore } = require('../electron/momo/openLoops.cjs');
const { loopsPrompt, parseLoops, saidOf, saidAtOf } = require('../electron/momo/openLoopsPass.cjs');

const SAID = Date.UTC(2030, 2, 4, 15, 0); // Mon 10:00 in New York
const userTurn = (id: string, items: any[]) => ({ id, items, itemTimes: { u1: { start: SAID } } });

function setup(o: { turns: any[]; kind?: string; authored?: string[] }) {
  const { s } = momoStore();
  const loops = new OpenLoopStore({ dir: path.join(scratch(), 'momo'), safeStorage: fakeSafe(), now: () => SAID + 60_000 });
  const sent: string[] = [];
  let n = 0;
  const pass = createMemoryPass({
    store: s,
    allowed: () => true,
    kindOf: () => o.kind ?? 'main',
    readTurns: async () => o.turns,
    brain: async () => ({ harness: 'codex' }),
    atLimit: () => false,
    startChat: async () => `pass-${++n}`,
    send: async (_c: string, text: string) => void sent.push(text),
    discardChat: () => {},
    seen: { get: () => null, set: () => {} },
    looksSecret: () => false,
    budget: { spend: async () => {}, left: () => 1_000_000 },
    now: () => SAID + 60_000,
    authoredIds: () => new Set(o.authored ?? []),
    loops: { store: loops, tz: () => 'America/New_York' },
  });
  return { pass, loops, sent };
}

const LOOP_REPLY = (quote: string, extra = '') =>
  `{"ops":[],"loops":[{"op":"add","kind":"promise","text":"Call the landlord","quote":"${quote}","due":"2030-03-06","confidence":"sure"}${extra}]}`;

test('a main-chat pass asks for loops with each user line’s time, and lands one quoted from the user’s words with its due date', async () => {
  const t = setup({
    turns: [
      userTurn('t1', [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'I’ll call the landlord by Wednesday' }] },
        { type: 'agentMessage', text: 'Got it.' },
      ]),
    ],
  });
  assert.equal(await t.pass.start('momo-main'), true);
  assert.match(t.sent[0], /User \[Mon 2030-03-04 10:00\]: I’ll call the landlord by Wednesday/);
  assert.match(t.sent[0], /It is now Mon 2030-03-04 10:01/);
  assert.match(t.sent[0], /Open loops:\n\(none\)/);
  const r = await t.pass.finished({ chatId: 'pass-1', text: LOOP_REPLY('call the landlord by Wednesday') });
  assert.deepEqual(r.loops, { added: 1, renewed: 0, closed: 0, refused: 0, dropped: [] });
  const [l] = t.loops.list();
  assert.equal(l.dueAt, Date.UTC(2030, 2, 7, 4, 59), 'Wednesday’s end in New York');
  assert.deepEqual(l.source, { chatId: 'momo-main', harness: 'codex', turnId: 't1' });
  assert.equal(l.saidAt, SAID);
});

test('a loop whose quote appears only in a tool result is rejected', async () => {
  const t = setup({
    turns: [
      userTurn('t1', [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'What’s on my calendar?' }] },
        { type: 'toolCall', name: 'calendar_events', result: 'Call the landlord about the deposit' },
        { type: 'agentMessage', text: 'One event.' },
      ]),
    ],
  });
  await t.pass.start('momo-main');
  const r = await t.pass.finished({ chatId: 'pass-1', text: LOOP_REPLY('Call the landlord about the deposit') });
  assert.deepEqual(r.loops.dropped, [{ op: 'add', reason: 'not in the user’s words' }]);
  assert.deepEqual(t.loops.list(), []);
});

test('MoMo’s own message (a nudge or a routine’s result) is never the user’s words: a nudge can’t re-extract itself', async () => {
  const nudge = '[Nudge, not from the user] Open loop: call the landlord by Wednesday';
  const t = setup({
    authored: ['n1'],
    turns: [
      userTurn('t1', [
        // by its id in the chat's authored record
        { id: 'n1', type: 'userMessage', content: [{ type: 'text', text: 'Remember: call the landlord by Wednesday' }] },
        // by its mark, when the harness's saved history lost the id it was sent with
        { id: 'n2', type: 'userMessage', content: [{ type: 'text', text: nudge }] },
        { type: 'agentMessage', text: 'Reminder: call the landlord by Wednesday.' },
      ]),
    ],
  });
  await t.pass.start('momo-main');
  assert.doesNotMatch(t.sent[0], /\nUser \[/, 'no line of it is shown as the user’s');
  assert.match(t.sent[0], /MoMo: \[Nudge, not from the user\]/);
  const r = await t.pass.finished({ chatId: 'pass-1', text: LOOP_REPLY('call the landlord by Wednesday') });
  assert.deepEqual(r.loops.dropped, [{ op: 'add', reason: 'not in the user’s words' }]);
  assert.deepEqual(t.loops.list(), []);
});

test('a routine’s run feeds no loops; a reply without loops lands none; a reset while the facts land stops the loops', async () => {
  const routine = setup({
    kind: 'routine',
    turns: [userTurn('t1', [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'I’ll call the landlord by Wednesday' }] }])],
  });
  await routine.pass.start('momo-main');
  assert.doesNotMatch(routine.sent[0], /open loops/);
  assert.doesNotMatch(routine.sent[0], /\nUser \[/, 'no times either');
  const r = await routine.pass.finished({ chatId: 'pass-1', text: LOOP_REPLY('call the landlord by Wednesday') });
  assert.equal(r.loops, undefined);
  assert.deepEqual(routine.loops.list(), []);

  const none = setup({
    turns: [userTurn('t1', [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'I’ll call the landlord by Wednesday' }] }])],
  });
  await none.pass.start('momo-main');
  assert.equal(await none.pass.finished({ chatId: 'pass-1', text: 'nothing to keep' }), null);
  await none.pass.start('momo-main');
  assert.equal(await none.pass.finished({ chatId: 'pass-2', text: '{"ops":[],"loops":[]}' }).then((x: any) => x.loops), undefined);

  const reset = setup({
    turns: [userTurn('t1', [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'I’ll call the landlord by Wednesday' }] }])],
  });
  await reset.pass.start('momo-main');
  const landing = reset.pass.finished({ chatId: 'pass-1', text: LOOP_REPLY('call the landlord by Wednesday') });
  reset.pass.cancelAll();
  await landing;
  assert.deepEqual(reset.loops.list(), []);
});

test('a reply with loops but no facts still lands its loops and moves the pass on', async () => {
  const t = setup({
    turns: [userTurn('t1', [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'I’ll call the landlord by Wednesday' }] }])],
  });
  await t.pass.start('momo-main');
  const r = await t.pass.finished({
    chatId: 'pass-1',
    text: '{"loops":[{"op":"add","kind":"todo","text":"Call the landlord","quote":"call the landlord"}]}',
  });
  assert.equal(r.loops.added, 1);
  assert.equal(r.change, undefined);
});

test('the loop prompt, reply parsing, what was said and when', () => {
  assert.match(loopsPrompt({ open: [{ id: 'L1', text: 'Call mum' }], now: 'Mon' }), /- \[L1\] Call mum/);
  assert.equal(parseLoops('none'), null);
  assert.equal(parseLoops(null), null);
  assert.equal(parseLoops('} then {'), null);
  assert.equal(parseLoops('{not json}'), null);
  assert.equal(parseLoops('{bad'), null);
  assert.equal(parseLoops('x {"loops":1} y'), null);
  assert.deepEqual(parseLoops('```json\n{"loops":[{"op":"mention","id":"L1"}]}\n```'), [{ op: 'mention', id: 'L1' }]);
  assert.equal(saidAtOf({ id: 'u1' }, { itemTimes: { u1: { start: 5 } } }, 9), 5);
  assert.equal(saidAtOf({ id: 'u2' }, { itemTimes: { a: { start: 7 }, b: { start: 6 }, c: {} } }, 9), 6);
  assert.equal(saidAtOf({}, { itemTimes: null }, 9), 9);
  assert.equal(saidAtOf({}, null, 9), 9);
  const said = saidOf(
    [
      {
        id: 't1',
        items: [
          { id: 'u1', clientId: 'c1', type: 'userMessage', content: [{ type: 'text', text: 'mine' }] },
          { type: 'userMessage', content: [{ type: 'text', text: 'ours' }], clientId: 'c2' },
          { type: 'tool', out: 1 },
          null,
        ],
      },
      { items: 'x' },
      { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'no turn id' }] }] },
      null,
    ],
    new Set(['c2']),
    3,
  );
  assert.deepEqual(said.user, [
    { text: 'mine', at: 3, turnId: 't1' },
    { text: 'no turn id', at: 3, turnId: '' },
  ]);
  assert.deepEqual(said.other, ['ours', '{"type":"tool","out":1}', 'null']);
  assert.equal(turnText({ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hi' }] }] }), 'User: hi');
  assert.equal(
    turnText({ items: [{ type: 'userMessage', content: [{ type: 'text', text: '[Routine result, not from the user] done' }] }] }),
    'MoMo: [Routine result, not from the user] done',
  );
});

test('MoMo’s block ahead of a user message (its memory, the nudges it showed) is never the user’s words', async () => {
  const block =
    '<momo-context>\nMoMo\'s memory, from MoPilot.\n\nReminders MoMo showed the user lately\n- about "Lease": "renew the lease by Friday"\n</momo-context>';
  const t = setup({
    turns: [
      userTurn('t1', [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: `${block}\nI’ll call the landlord by Wednesday` }] },
        { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: block }] },
        { id: 'u3', type: 'userMessage', content: [{ type: 'text', text: '[REDACTED:momo-context] hi there' }] },
      ]),
    ],
  });
  await t.pass.start('momo-main');
  assert.match(t.sent[0], /\nUser \[[^\]]+\]: I’ll call the landlord by Wednesday/);
  assert.match(t.sent[0], /\nUser \[[^\]]+\]: hi there/);
  assert.doesNotMatch(t.sent[0], /What was said:[\s\S]*renew the lease by Friday/, 'the block never reaches the pass as said');
  const r = await t.pass.finished({ chatId: 'pass-1', text: LOOP_REPLY('renew the lease by Friday') });
  assert.deepEqual(r.loops.dropped, [{ op: 'add', reason: 'not in the user’s words' }]);
  const { withoutMomoBlock } = require('../shared/momoContext.mjs');
  assert.equal(withoutMomoBlock(null), '');
  assert.equal(withoutMomoBlock(`${block}\n\nhello`), 'hello');
});

test('a chat that went quiet again while its pass ran gets one more pass once it lands, never after a reset', async () => {
  const turns: any[] = [userTurn('t1', [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Hello there' }] }])];
  const t = setup({ turns });
  assert.equal(await t.pass.start('momo-main'), true);
  // the user said more while the pass ran: its idle finds the chat busy
  turns.push(userTurn('t2', [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'I’ll call the landlord by Wednesday' }] }]));
  assert.equal(await t.pass.start('momo-main'), false);
  assert.equal(await t.pass.start('momo-main', true), false, 'a reflection asks for no rerun');
  await t.pass.finished({ chatId: 'pass-1', text: '{"ops":[]}' });
  await waitFor(() => !(t.sent.length < 2), 'a second memory pass');
  assert.equal(t.sent.length, 2, 'one more pass');
  assert.match(t.sent[1], /I’ll call the landlord by Wednesday/);
  await t.pass.finished({ chatId: 'pass-2', text: '{"ops":[]}' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.sent.length, 2, 'and only one');

  const reset = setup({ turns });
  await reset.pass.start('momo-main');
  await reset.pass.start('momo-main');
  reset.pass.cancelAll();
  await reset.pass.start('momo-main');
  await reset.pass.finished({ chatId: 'pass-2', text: '{"ops":[]}' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reset.sent.length, 2, 'the rerun asked before the reset is dropped');
});

test('a user message as the transcript has it (content text parts) is read as the user’s words, by the facts and the loops', async () => {
  const { userMessageText } = require('../electron/momo/turnItems.cjs');
  const said = (text: string, extra: any = {}) => ({
    id: 'u1',
    type: 'userMessage',
    clientId: null,
    content: [
      { type: 'text', text, text_elements: [] },
      { type: 'image', url: 'x' },
    ],
    ...extra,
  });
  const t = setup({
    authored: ['r1'],
    turns: [
      userTurn('t1', [
        said('I’ll call the landlord by Wednesday'),
        said('[Routine result, not from the user] call the landlord by Wednesday', { id: 'r2' }),
        said('Routine says hi', { id: 'r1' }),
        { type: 'agentMessage', text: 'Noted.' },
      ]),
    ],
  });
  await t.pass.start('momo-main');
  assert.match(t.sent[0], /\nUser \[[^\]]+\]: I’ll call the landlord by Wednesday\n/);
  assert.match(t.sent[0], /\nMoMo: Routine says hi/);
  // the quote is in the routine's message too: not the user's alone
  const r = await t.pass.finished({ chatId: 'pass-1', text: LOOP_REPLY('call the landlord by Wednesday') });
  assert.deepEqual(r.loops.dropped, [{ op: 'add', reason: 'not in the user’s words' }]);
  const t2 = setup({ turns: [userTurn('t1', [said('I’ll call the landlord by Wednesday'), { type: 'agentMessage', text: 'Noted.' }])] });
  await t2.pass.start('momo-main');
  assert.equal((await t2.pass.finished({ chatId: 'pass-1', text: LOOP_REPLY('call the landlord by Wednesday') })).loops.added, 1);
  assert.equal(userMessageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text' }] }), 'a\nb');
  assert.equal(userMessageText({ text: 'made up' }), '', 'a field no builder writes is no words');
  assert.equal(userMessageText(null), '');
});
