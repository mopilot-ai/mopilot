// The dev host's stand-in for a draft MoMo wrote (scripts/mobile-dev-host/fakeMomoDraft.mjs): the rows `momo-draft` puts in the fake MoMo chat are drafts the Mac's own check accepts, a long one is over what a mail link carries but under what a draft may hold, off removes them, and a shape it does not know is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raiseDraft, SHAPES } from '../scripts/mobile-dev-host/fakeMomoDraft.mjs';
import { raiseSentDraft } from '../scripts/mobile-dev-host/fakeMomoDraftSent.mjs';
import { readSend } from '../shared/momoDraftSend.mjs';
import { momoDraftScenario } from '../scripts/mobile-dev-host/scenariosMomoDraft.mjs';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createScenarios } from '../scripts/mobile-dev-host/scenarios.mjs';
import { MAX_BODY, MAX_MAILTO, mailtoOf, readDraft } from '../shared/momoDraft.mjs';

const chat = () => ({ id: 'c', rows: [{ role: 'assistant', text: 'Hi' }] as any[] });

test('one is a draft for two people the Mac would accept, with a link that fits', () => {
  const c = chat();
  assert.match(
    raiseDraft('one', c, () => 5),
    /for two people/,
  );
  const row = c.rows.at(-1);
  assert.equal(row.role, 'note');
  assert.equal(row.at, 5);
  assert.equal(row.id, 'c-r2');
  assert.equal(row.text, `Draft · ${row.draft.subject}`);
  assert.deepEqual(readDraft(row.draft), { ok: true, draft: row.draft });
  assert.equal(mailtoOf(row.draft).ok, true);
});

test('long is over what a mail link carries and under what a draft may hold', () => {
  const c = chat();
  assert.match(
    raiseDraft('long', c, () => 5),
    /too long/,
  );
  const draft = c.rows.at(-1).draft;
  assert.ok(draft.body.length > MAX_MAILTO / 2 && draft.body.length <= MAX_BODY);
  assert.equal(readDraft(draft).ok, true);
  assert.equal(mailtoOf(draft).ok, false);
});

test('off takes the drafts out and keeps the rest, saying how many; none is none', () => {
  const c = chat();
  assert.equal(
    raiseDraft('off', c, () => 5),
    "0 drafts removed from MoMo's chat",
  );
  raiseDraft('one', c, () => 5);
  assert.equal(
    raiseDraft('off', c, () => 5),
    "1 draft removed from MoMo's chat",
  );
  raiseDraft('one', c, () => 5);
  raiseDraft('long', c, () => 5);
  assert.equal(
    raiseDraft('off', c, () => 5),
    "2 drafts removed from MoMo's chat",
  );
  assert.deepEqual(c.rows, [{ role: 'assistant', text: 'Hi' }]);
});

test('a shape it does not know is refused, and the scenario defaults to one', async () => {
  assert.throws(() => raiseDraft('many', chat(), () => 5), /one, long, sent, asked, unsure, off/);
  assert.deepEqual([...SHAPES], ['one', 'long', 'sent', 'asked', 'unsure', 'off']);
  const asked: string[] = [];
  const scenario = momoDraftScenario(() => ({ momoDraft: async (shape: string) => (asked.push(shape), 'ok') }));
  assert.equal(scenario.usage, 'momo-draft [one|long|sent|asked|unsure|off]');
  await scenario.run([]);
  await scenario.run(['off']);
  assert.deepEqual(asked, ['one', 'off']);
});

test('the host console lists momo-draft and passes its shape to the host’s controls', async () => {
  const asked: string[] = [];
  const app = createFakeApp({
    repo: '/repo',
    log: () => undefined,
    now: () => 9_000_000,
    sleep: async () => undefined,
    status: async () => '',
  });
  const scenarios = createScenarios({
    app,
    now: () => 9_000_000,
    controls: { momoDraft: async (shape: string) => (asked.push(shape), 'draft done') } as any,
  });
  assert.ok(scenarios.list().some((s: any) => s.usage === 'momo-draft [one|long|sent|asked|unsure|off]'));
  assert.equal(await scenarios.run('momo-draft'), 'draft done');
  assert.equal(await scenarios.run('momo-draft', ['long']), 'draft done');
  assert.deepEqual(asked, ['one', 'long']);
});

test("sent, asked and unsure put a read-only draft in the chat that the Mac's own check accepts; off takes them out", () => {
  for (const state of ['sent', 'asked', 'unsure']) {
    const c = chat();
    assert.match(
      raiseDraft(state, c, () => 7),
      /read only/,
    );
    const row = c.rows.at(-1);
    assert.equal(row.role, 'note');
    assert.equal(row.id, 'c-r2');
    assert.deepEqual(readDraft(row.draft), { ok: true, draft: row.draft });
    assert.equal(readSend(row.send)?.state, state);
    assert.equal(row.send.from.account, 'home@mail.test');
    assert.equal(
      raiseDraft('off', c, () => 7),
      "1 draft removed from MoMo's chat",
    );
  }
  assert.throws(() => raiseSentDraft('later', chat(), () => 7), /sent, asked, unsure/);
});
