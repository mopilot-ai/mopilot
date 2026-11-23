// electron/session/userWords.cjs: the user's own words of a chat's current turn (its message and their steers), and
// whether they name a harness, model or effort; agent, peer and automatic input never counts (#2084).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createUserWords,
  userWordsOf,
  mentions,
  picks,
  namesHarness,
  namesModel,
  cheaperModel,
  namesEffort,
  userChoice,
} = require('../electron/session/userWords.cjs');

function fakeController() {
  const rts = new Map<string, any>();
  return { rts, rt: (id: string) => rts.get(id) ?? (rts.set(id, { inputToken: null, token: null }), rts.get(id)) };
}
const human = (text: any, over: any = {}) => ({ text, opts: { human: true }, ...over });

test('a turn keeps the user’s message and their steers into it; a new turn, or one the user didn’t start, starts over', () => {
  const c = fakeController();
  const w = createUserWords(c);
  c.rts.set('a', { inputToken: 'pending-1', token: 'pending-1' });
  w.dispatching({ chatId: 'a', kind: 'turn', item: human('split this out') });
  w.dispatching({ chatId: 'a', kind: 'steer', item: human('use Codex for it') });
  // a peer's message, the agent's own input and a steer with no text add nothing
  w.dispatching({ chatId: 'a', kind: 'steer', item: human('use claude', { peer: { from: 'b' } }) });
  w.dispatching({ chatId: 'a', kind: 'steer', item: { text: 'acp:kimi', opts: { human: false } } });
  w.dispatching({ chatId: 'a', kind: 'steer', item: human(undefined) });
  assert.equal(w.said('a'), 'split this out\nuse Codex for it');
  assert.equal(w.said('other'), '');
  // the turn moved on (its token changed): the old words no longer count
  c.rts.set('a', { inputToken: null, token: 'ct-2' });
  assert.equal(w.said('a'), '');
  // a steer into a turn the words weren't from starts that turn's words
  w.dispatching({ chatId: 'a', kind: 'steer', item: human('now on claude') });
  assert.equal(w.said('a'), 'now on claude');
  // an automatic turn (a wake-up, a family message) has no words of the user's
  c.rts.set('a', { inputToken: 'pending-3', token: 'pending-3' });
  w.dispatching({ chatId: 'a', kind: 'turn', item: { text: 'wake', opts: {} } });
  assert.equal(w.said('a'), '');
  // a chat whose turn has no token yet keeps its words under none
  w.dispatching({ chatId: 'fresh', kind: 'turn', item: human('on codex') });
  assert.equal(w.said('fresh'), 'on codex');
  w.dispatching({ chatId: 'a', kind: 'turn', item: human('x'.repeat(40000)) });
  assert.equal(w.said('a').length, 32768);
});

test('userWordsOf installs one recorder per controller, beside the dispatch hook already there', async () => {
  const c: any = fakeController();
  const seen: string[] = [];
  c.beforeDispatch = async () => void seen.push('earlier');
  const w = userWordsOf(c);
  assert.equal(userWordsOf(c), w);
  c.rts.set('a', { inputToken: 'pending-1' });
  await c.beforeDispatch({ chatId: 'a', kind: 'turn', item: human('on codex') });
  assert.deepEqual(seen, ['earlier']);
  assert.equal(w.said('a'), 'on codex');
});

test('a name counts only as a word, any case, beside Chinese text, and with a dash, dot or space for a dash', () => {
  assert.equal(mentions('Use Codex here', 'codex'), true);
  assert.equal(mentions('用codex开一个', 'codex'), true);
  assert.equal(mentions('codexify it', 'codex'), false);
  assert.equal(mentions('anything', ''), false);
  assert.equal(mentions('anything', undefined), false);
  assert.equal(mentions(undefined, 'codex'), false);
  assert.equal(mentions('on gpt 5.5 please', 'gpt-5.5'), true);
  assert.equal(mentions('a (weird) name', '(weird)'), true);
});

test('the user picks a harness by its family or a basic harness’s id, as where the work runs; a mention is not a pick', () => {
  for (const said of [
    'run it in Claude Code',
    'use claude',
    'put it on Claude Code',
    'a Claude Code session',
    'Claude Code 上跑',
    '用 claude 开',
  ])
    assert.equal(namesHarness(said, 'claude'), true, said);
  for (const said of ['use Codex', 'run it in a Codex session', '用codex开一个', 'switch to codex', 'move it to Codex', 'codex instead'])
    assert.equal(namesHarness(said, 'codex'), true, said);
  for (const said of ['fix the Codex adapter in its own session', 'split the Codex stop bug out', 'codexify it', 'what does codex do?'])
    assert.equal(namesHarness(said, 'codex'), false, said);
  assert.equal(namesHarness('run it in Claude Code', 'codex'), false);
  assert.equal(namesHarness('try it with kimi', 'acp:kimi'), true);
  assert.equal(namesHarness('try it with kimi', 'acp:opencode'), false);
  assert.equal(namesHarness('use codex', 'gpt'), false);
  assert.equal(picks('use it', ''), false);
  assert.equal(picks('use it', undefined), false);
  assert.equal(picks(undefined, 'codex'), false);
});

test('an effort counts as the user’s when they name it as an effort, or when it is a cheap one', () => {
  for (const [said, level] of [
    ['at high effort', 'high'],
    ['effort: max', 'max'],
    ['reasoning high', 'high'],
    ['go xhigh', 'xhigh'],
    ['max thinking', 'max'],
  ])
    assert.equal(namesEffort(said, level), true, said);
  for (const [said, level] of [
    ['this is high priority', 'high'],
    ['max retries 3', 'max'],
    ['', 'high'],
  ])
    assert.equal(namesEffort(said, level), false, said);
  assert.equal(namesEffort('', 'low'), true);
  assert.equal(namesEffort('', 'Minimal'), true);
  assert.equal(namesEffort('high effort', ''), false);
  assert.equal(namesEffort('high effort', undefined), false);
  assert.equal(namesEffort(undefined, 'high'), false);
});

test('a model of the chat’s own Claude family or a cheaper one needs no words; a pricier one, or any non-Claude one, does', () => {
  assert.equal(cheaperModel('claude-haiku-5-5', 'opus'), true);
  assert.equal(cheaperModel('sonnet[1m]', 'claude-sonnet-5-5'), true);
  assert.equal(cheaperModel('opus', 'sonnet'), false);
  assert.equal(cheaperModel('gpt-5.5-mini', 'opus'), false);
  assert.equal(cheaperModel('haiku', 'gpt-5.5'), false);
  assert.equal(cheaperModel('haiku', null), false);
});

test('the user names a model by its id or, for a Claude model, its family', () => {
  assert.equal(namesModel('use sonnet for the helper', 'claude-sonnet-5-5'), true);
  assert.equal(namesModel('use sonnet for the helper', 'claude-opus-5-5'), false);
  assert.equal(namesModel('on gpt-5.5-mini', 'gpt-5.5-mini'), true);
  assert.equal(namesModel('on mini', 'gpt-5.5-mini'), false);
  assert.equal(namesModel('claude please', 'claude-x'), false);
  assert.equal(namesModel('opus', null), false);
});

test('a choice stands when it is none, the chat’s own, or one the user named; otherwise it is set aside with why', () => {
  const pick = (chosen: any, named = false) =>
    userChoice({ chosen, own: 'claude', named: () => named, what: 'harness', instead: 'it stays' });
  assert.deepEqual(pick(undefined), { value: null, ignored: null });
  assert.deepEqual(pick('claude'), { value: 'claude', ignored: null });
  assert.deepEqual(pick('codex', true), { value: 'codex', ignored: null });
  assert.deepEqual(pick('codex'), {
    value: null,
    ignored: `harness "codex" was set aside: the user didn't name it this turn, so it stays`,
  });
});
