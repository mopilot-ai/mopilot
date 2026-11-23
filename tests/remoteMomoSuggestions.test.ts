// A paired phone's suggestions (momo.suggestions.list and momo.suggestions.act: electron/remote/methods/momo.cjs over remote/momoOps.cjs over momoSuggestions:list and :act): the phone reads what MoMo suggested with each one's source line and score, and its own Add, Start or Hide goes through the Mac's one handler, so Start sends the first step on the Mac; both are listed and answered only for an invited account and only while the Mac has the Tasks panel on; a change is told to phones as `memory`; a request outside the schema is refused.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ok, fail, askSlow, momoRig, MOMO_METHODS, UNINVITED } from './support/remote-momo-kit.ts';
import { SUGGESTIONS_METHOD, SUGGESTION_ACT_METHOD, parseSuggestions } from '../mobile/src/momo/suggestionsContract';

const require = createRequire(import.meta.url);
const { PARSERS, parseParams } = require('../shared/remote/schema.mjs');
const methods = require('../electron/remote/methods/momo.cjs');

const one = (over: Record<string, unknown> = {}) => ({
  title: 'Reply to Sam',
  why: 'He asked on Monday.',
  source: 'Mail: Sam, Lease',
  step: 'Draft a reply to Sam',
  from: 'mail',
  ref: 't1',
  kind: 'reply',
  ...over,
});
function rig(o: Parameters<typeof momoRig>[0] = {}) {
  const m = momoRig(o);
  m.tasksPanel.on = true;
  m.suggestionsFlag.on = true;
  return { ...m, p: m.r.phone('p1') };
}

test('the phone reads the suggestions with their source line, reason, first step and score, and its parser takes every one', async () => {
  const t = rig();
  await t.suggestions.add(one({ cost: 'person', confidence: 'high' }));
  const res = ok(await askSlow(t.p, SUGGESTIONS_METHOD));
  assert.equal(res.shown, 6);
  const view = parseSuggestions(res);
  assert.deepEqual(
    view.suggestions.map((s) => [s.title, s.source, s.why, s.step, s.status]),
    [['Reply to Sam', 'Mail: Sam, Lease', 'He asked on Monday.', 'Draft a reply to Sam', 'new']],
  );
  assert.deepEqual(view.suggestions[0].score, { urgency: 0.3, cost: 0.9, confidence: 0.9, novelty: 1 });
});

test('Add keeps it, Hide drops it, Start sends the first step on the Mac; each is the Mac’s own handler and each tells phones', async () => {
  const t = rig();
  const a = await t.suggestions.add(one());
  const b = await t.suggestions.add(one({ ref: 't2' }));
  const c = await t.suggestions.add(one({ ref: 't3' }));
  const act = async (id: string, action: string) => ok(await askSlow(t.p, SUGGESTION_ACT_METHOD, { id, action }));
  assert.deepEqual(await act(a.id, 'add'), { id: a.id, action: 'add', channel: 'main' });
  assert.equal((await act(b.id, 'hide')).action, 'hide');
  assert.equal((await act(c.id, 'start')).action, 'start');
  assert.deepEqual(
    t.suggestionStarts.map(([id, text]) => [id, text]),
    [[c.id, 'Start: Reply to Sam\nFirst step: Draft a reply to Sam\n(From your suggestion, Mail: Sam, Lease)']],
  );
  const left = parseSuggestions(ok(await askSlow(t.p, SUGGESTIONS_METHOD)));
  assert.deepEqual(
    left.suggestions.map((s) => [s.id, s.status]),
    [[a.id, 'added']],
  );
  assert.equal(t.told.filter(([ch]) => ch === 'momoSuggestions:changed').length, 3);
});

test('momo.state.get says suggestions only while the flag is on', async () => {
  const t = rig();
  assert.equal(ok(await askSlow(t.p, 'momo.state.get')).suggestions, true);
  t.suggestionsFlag.on = false;
  assert.equal(ok(await askSlow(t.p, 'momo.state.get')).suggestions, undefined);
});

test('a suggestion that is gone says so; a request outside the schema is refused before the Mac sees it', async () => {
  const t = rig();
  fail(await askSlow(t.p, SUGGESTION_ACT_METHOD, { id: 'nope', action: 'start' }), 'failed', /gone/);
  for (const bad of [{ action: 'start' }, { id: 'x' }, { id: 'x', action: 'finish' }, { id: 'bad id', action: 'start' }])
    fail(await askSlow(t.p, SUGGESTION_ACT_METHOD, bad), 'invalid');
  assert.deepEqual(parseParams(SUGGESTION_ACT_METHOD, { id: 's-1', action: 'hide', extra: 1 }), { id: 's-1', action: 'hide' });
  assert.deepEqual(t.suggestionStarts, []);
});

test('with the suggestions flag off the Mac answers unavailable, whatever the Tasks panel is, and an account MoMo is not allowed for gets nothing (main refuses too)', async () => {
  const off = rig();
  const s = await off.suggestions.add(one());
  off.suggestionsFlag.on = false;
  fail(await askSlow(off.p, SUGGESTIONS_METHOD), 'failed', /Suggestions are off/);
  fail(await askSlow(off.p, SUGGESTION_ACT_METHOD, { id: s.id, action: 'start' }), 'failed', /Suggestions are off/);
  assert.deepEqual(off.suggestionStarts, []);
  const t = rig({ allowed: false });
  fail(await t.p.ask(SUGGESTIONS_METHOD), 'forbidden', UNINVITED);
  t.r.service.momoAllowed = () => true;
  fail(await t.p.ask(SUGGESTIONS_METHOD), 'forbidden', UNINVITED);
  fail(await t.p.ask(SUGGESTION_ACT_METHOD, { id: 's', action: 'start' }), 'forbidden', UNINVITED);
});

test('the Mac lists both methods for an invited phone, and says so when MoMo is not made yet', async () => {
  const t = rig();
  const listed = ok(await t.p.ask('machine.hello')).capabilities.methods;
  assert.ok(listed.includes(SUGGESTIONS_METHOD) && listed.includes(SUGGESTION_ACT_METHOD));
  t.r.service.momo = () => null;
  fail(await t.p.ask(SUGGESTIONS_METHOD), 'failed', /not ready/);
  for (const m of [SUGGESTIONS_METHOD, SUGGESTION_ACT_METHOD]) {
    assert.equal(typeof methods[m], 'function');
    assert.equal(typeof PARSERS[m], 'function');
    assert.ok(MOMO_METHODS.includes(m));
  }
});

test('the phone’s parser keeps the rows it understands, fills what is missing and throws on a reply that is not a list', () => {
  const row = {
    id: 'a',
    title: 'T',
    source: 'S',
    why: 'W',
    step: 'P',
    status: 'added',
    score: { urgency: 1, cost: 1, confidence: 1, novelty: 1 },
  };
  const view = parseSuggestions({
    shown: 3.7,
    suggestions: [row, { id: 'b', title: 'T2', source: 'S2' }, { ...row, id: '' }, { ...row, title: '' }, { ...row, source: '' }, 5, null],
  });
  assert.equal(view.shown, 3);
  assert.deepEqual(
    view.suggestions.map((s) => [s.id, s.status, s.why, s.step, s.score.novelty]),
    [
      ['a', 'added', 'W', 'P', 1],
      ['b', 'new', '', '', 0],
    ],
  );
  assert.equal(parseSuggestions({ suggestions: [], shown: 0 }).shown, 6);
  assert.equal(parseSuggestions({ suggestions: [{ ...row, score: { urgency: 'x' } }] }).suggestions[0].score.urgency, 0);
  for (const bad of [null, [], 'x', {}, { suggestions: 'x' }]) assert.throws(() => parseSuggestions(bad), /Could not read the suggestions/);
});
