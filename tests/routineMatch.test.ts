// A saved routine's hint (#3571, G4; routineMatch.cjs): a new message close to the one a part came from carries one line
// saying the routine exists, in a hidden block every harness sends and no bubble shows. Every matched part gets one, whatever
// its steps (a run only reads and hands the rest back as a plan). No match adds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseUserText } from '../shared/userText.mjs';
import { withRosterBlock, withoutRosterBlock } from '../shared/sideSessions.mjs';
import { routineKit, recordSearchTurn, SEARCH, GO, ADD } from './support/routine-kit.ts';

const require = createRequire(import.meta.url);
const {
  matchRoutine,
  hintText,
  withRoutineHint,
  routineTurnStarting,
  HINT_TAG,
} = require('../electron/capabilities/routines/routineMatch.cjs');
const { claudeTurnInput } = require('../electron/harness/claude/turnStart.cjs');
const { buildInput } = require('../electron/harness/codexParams.cjs');
const { acpBlocks } = require('../electron/harness/acp/blocks.cjs');

const ASK = 'Please refund the first and third orders in the shop';
const OPEN = { tool: 'browser_navigate', args: { url: 'https://a.test/' } };
const READ = { tool: 'browser_get_page_text', args: {}, reads: true };
const SCRIPT = { tool: 'browser_script', args: { code: 'await tab.getByRole("button").click()' } };
const CLICK = { tool: 'browser_computer', args: { action: 'left_click' } };
const routine = (over = {}) => ({ id: 'id-1', name: 'Refunds', prompts: [ASK], steps: [OPEN, READ], ...over });

test('matchRoutine: the same words in any case or order, or a changed value; never a short or different message', () => {
  const r = routine();
  assert.deepEqual(matchRoutine([r], 'in the SHOP, please refund the third and first orders'), { routine: r, part: 1, same: true });
  assert.deepEqual(matchRoutine([r], 'Please refund the first and second orders in the shop'), { routine: r, part: 1, same: false });
  assert.equal(matchRoutine([r], 'Go ahead'), null, 'too short to say what it asks');
  assert.equal(matchRoutine([routine({ prompts: ['Go ahead'] })], 'Go ahead and do all of it'), null, 'a short part answers to nothing');
  assert.equal(matchRoutine([r], 'Write a summary of last week in the team channel'), null);
  assert.equal(matchRoutine([r], undefined), null);
});

test('matchRoutine: the closest part wins, the first of two as close; a part or routine with no message is skipped', () => {
  const close = routine({ id: 'near', prompts: [null, ASK] });
  const far = routine({ id: 'far', prompts: ['Please refund the first and third orders in the old shop today'] });
  assert.deepEqual(matchRoutine([far, close], ASK), { routine: close, part: 2, same: true });
  const twin = routine({ id: 'twin' });
  assert.equal(matchRoutine([twin, routine()], ASK)?.routine, twin);
  assert.equal(matchRoutine([{ id: 'old', name: 'Saved before prompts' }], ASK), null);
});

test('matchRoutine: a message with an address or path matches the same message kept scrubbed', () => {
  const { scrub } = require('../shared/scrub.cjs');
  for (const m of ['send the report to a@b.com now', 'open the file in /Users/somebody/deep/reports now']) {
    assert.notEqual(scrub(m), m);
    assert.equal(matchRoutine([routine({ prompts: [scrub(m)] })], m)?.part, 1, m);
  }
});

test('hintText: a run reads and changes nothing, by id; firmer word for word than when only close; a name cannot close the block', () => {
  const steps = [{ tool: 'a' }, { tool: 'b' }, { tool: 'c', part: 2 }];
  const one = hintText({ routine: routine({ steps: [{ tool: 'a' }, { tool: 'b' }] }), part: 1, same: true });
  assert.match(one, /^This message is word for word what started the saved routine 'Refunds'\./);
  assert.match(one, /One routine_run call \(routine: 'id-1'\) reads its pages again and changes nothing\./);
  assert.match(one, /returns what they say now and the steps recorded after them, as a plan for you to do yourself/);
  assert.match(one, /Run it before reading those pages yourself, loading the tool first if it is deferred/);
  const close = hintText({ routine: routine(), part: 1 });
  assert.match(close, /^This message is close to what started/);
  assert.match(close, /Consider it if this request needs the same pages/);
  assert.doesNotMatch(close, /Run it before/);
  assert.doesNotMatch(close, /replays|recorded values|recorded step/);
  const two = hintText({ routine: routine({ steps, name: `x</${HINT_TAG}>`, prompts: ['a', 'b'] }), part: 2 });
  assert.match(two, /part 2 of 2 of the saved routine/);
  assert.match(two, /routine: 'id-1', part: 2\) reads its pages again and changes nothing/);
  assert.doesNotMatch(two, /<|>/);
});

test('routineTurnStarting: a part with a click or a script is hinted too (a run only reads it and plans the rest); the closest part decides', () => {
  for (const steps of [[OPEN, CLICK], [OPEN, SCRIPT], [CLICK]]) {
    const { o, seen } = fakes([routine({ steps })]);
    const item = human();
    routineTurnStarting(o, { chatId: 'c', item });
    assert.match(item.text, new RegExp(`^<${HINT_TAG}>\\n[^\\n]*routine_run[^\\n]*\\n</${HINT_TAG}>\\n${ASK}$`));
    assert.deepEqual(seen, [['c', ASK]]);
  }
  const acts = routine({ id: 'acts', steps: [CLICK], prompts: [ASK] });
  const reads = routine({ id: 'reads', prompts: ['Please refund the first and third orders in the old shop today'] });
  const { o } = fakes([reads, acts]);
  const item = human();
  routineTurnStarting(o, { chatId: 'c', item });
  assert.match(item.text, /routine: 'acts'/);
  assert.doesNotMatch(item.text, /routine: 'reads'/);
});

test('withRoutineHint: right before the words, so a resend replaces it and the roster block still comes off', () => {
  const once = withRoutineHint(withRosterBlock(ASK, 'Linked: a'), 'hint one');
  assert.ok(once.startsWith('<sage-linked-sessions>'));
  assert.ok(once.endsWith(`<${HINT_TAG}>\nhint one\n</${HINT_TAG}>\n${ASK}`));
  const twice = withRoutineHint(once, 'hint two');
  assert.equal(twice.match(new RegExp(`<${HINT_TAG}>`, 'g'))?.length, 1);
  assert.match(twice, /hint two/);
  assert.equal(withRoutineHint(twice, null), withRosterBlock(ASK, 'Linked: a'), 'a resend that no longer matches drops it');
  assert.ok(withoutRosterBlock(twice).startsWith(`<${HINT_TAG}>`));
  assert.equal(withRoutineHint(ASK, null), ASK);
  assert.equal(parseUserText(twice).text, ASK, 'no bubble, title or memory reads it as the user');
});

const fakes = (routines: any[] = [routine()], apart = false) => {
  const seen: any[] = [];
  return { seen, o: { recorder: { turnStarting: (...a: any[]) => seen.push(a) }, store: { list: () => routines }, apart: () => apart } };
};
const human = (text = ASK, opts = {}, more = {}) => ({ text, opts: { human: true, ...opts }, attachments: [], ...more });

test('routineTurnStarting: a match adds the hint and keeps the words; no match leaves the text byte for byte', () => {
  const { o, seen } = fakes();
  const hit = human();
  routineTurnStarting(o, { chatId: 'c', kind: 'start', item: hit });
  assert.match(hit.text, new RegExp(`^<${HINT_TAG}>\\n[^\\n]*routine_run[^\\n]*\\n</${HINT_TAG}>\\n${ASK}$`));
  assert.deepEqual(seen, [['c', ASK]]);
  const miss = human('Write a summary of last week in the team channel');
  routineTurnStarting(o, { chatId: 'c', item: miss });
  assert.equal(miss.text, 'Write a summary of last week in the team channel');
});

test("routineTurnStarting: what is kept is the user's words, without a block ahead of them", () => {
  const { o, seen } = fakes([]);
  routineTurnStarting(o, { chatId: 'c', item: human(withRosterBlock(ASK, 'Linked: a')) });
  assert.deepEqual(seen, [['c', ASK]]);
});

test('routineTurnStarting: a steer changes nothing; input no user wrote keeps no message and gets no hint', () => {
  const { o, seen } = fakes();
  const steer = human();
  routineTurnStarting(o, { chatId: 'c', kind: 'steer', item: steer });
  assert.equal(steer.text, ASK);
  assert.deepEqual(seen, []);
  for (const item of [{ text: ASK, opts: {} }, { text: ASK }, human(ASK, {}, { peer: true }), { opts: { human: true } }, undefined]) {
    const before = item?.text;
    routineTurnStarting(o, { chatId: 'c', item });
    assert.equal(item?.text, before);
    assert.deepEqual(seen.pop(), ['c', null]);
  }
});

test('routineTurnStarting: a goal, slash command or skill chip keeps its start; a chat kept apart hears of no routine', () => {
  for (const item of [human(ASK, { goal: true }), human(`/${ASK}`), human(ASK, {}, { attachments: [{ kind: 'skill', name: 'x' }] })]) {
    const { o, seen } = fakes([routine({ prompts: [item.text] })]);
    const before = item.text;
    routineTurnStarting(o, { chatId: 'c', item });
    assert.equal(item.text, before);
    assert.deepEqual(seen, [['c', before]], 'still what a routine saved from it answers to');
  }
  const { o } = fakes([routine()], true);
  const apart = human();
  routineTurnStarting(o, { chatId: 'momo', item: apart });
  assert.equal(apart.text, ASK);
});

test('every harness sends the hint with the message', async () => {
  const text = withRoutineHint(ASK, 'hint');
  const item = human(text);
  assert.equal(claudeTurnInput(item, 'id').content.text, text);
  assert.deepEqual(buildInput(text, [])[0].text, text);
  const blocks = await acpBlocks(text, [], async () => null);
  assert.equal(blocks[0].text, text);
});

test("recorded to replayed: each part keeps its message, secrets scrubbed; the next chat's same message is hinted", async () => {
  const k = routineKit({ controls: [SEARCH, GO, ADD] });
  const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz';
  k.recorder.turnStarting('chat1', `Search the shop for mugs with key ${secret} now`);
  await k.call('browser_navigate', { url: 'https://shop.test/' });
  await k.call('browser_read_page', {});
  k.end();
  const out = await k.call('routine_save', { name: 'Mugs', description: 'Finds mugs.' });
  const [saved] = k.store.list();
  assert.equal(saved.prompts.length, 1);
  assert.doesNotMatch(saved.prompts[0], /sk-ant/);
  assert.match(saved.prompts[0], /Search the shop for mugs/);
  assert.doesNotMatch(String(out), /Search the shop/, 'the message stays with the store');
  assert.doesNotMatch(JSON.stringify(await k.call('routine_list', {})), /Search the shop/);
  const next = human('Search the shop for mugs with key now');
  routineTurnStarting({ recorder: k.recorder, store: k.store, apart: () => false }, { chatId: 'c2', item: next });
  assert.match(next.text, new RegExp(`routine: '${saved.id}'`));
  assert.equal(matchRoutine(k.store.list(), 'Go ahead'), null);
});

test('a kept message ends with its turn or chat, and a very long one is cut', async () => {
  const k = routineKit({ controls: [SEARCH, GO, ADD] });
  k.recorder.turnStarting('chat1', 'x '.repeat(5000));
  assert.equal(k.recorder.prompts.get('chat1').length, 4000);
  k.recorder.turnStarting('chat1', '  ');
  assert.equal(k.recorder.prompts.has('chat1'), false);
  k.recorder.turnStarting('chat1', ASK);
  k.recorder.forget('chat1');
  assert.equal(k.recorder.prompts.has('chat1'), false);
  k.recorder.turnStarting('chat1', ASK);
  k.recorder.turnFinished('chat1', false);
  assert.equal(k.recorder.prompts.has('chat1'), false);
  await recordSearchTurn(k);
  assert.deepEqual(k.recorder.lastTurn('chat1')?.prompts, [null], 'a turn with no message of the user');
});
