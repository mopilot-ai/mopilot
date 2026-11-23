// A draft note's way from the chat's history to the surfaces (A3): withChatNotes puts it after its turn with its words, the panel's rows (which a phone reads) carry it as a note row with the draft, a note that is not a draft is not a row, a draft counts toward a row page's weight, and the tool is a trusted MoMo tool of its own with its own line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rowsOf, MAX_TOTAL } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { withChatNotes } = require('../shared/chatNotes.mjs');
const { trustClassOf } = require('../electron/momo/toolTrust.cjs');
const { momoTool } = require('../electron/momo/contract/toolIsolation.cjs');

const turns = [{ id: 'ct-1', items: [{ type: 'agentMessage', id: 'i1', text: 'Here is a draft.' }] }];
const draft = { to: ['sam@example.com'], subject: 'Re: lunch', body: 'Friday works.' };
const note = (extra: object = {}) => ({
  id: 'draft-1-1',
  kind: 'draft',
  text: 'Draft · Re: lunch',
  turnId: 'ct-1',
  turn: 0,
  at: 1,
  draft,
  ...extra,
});

test('a draft note goes after its turn as a statusNote with its draft', () => {
  const placed = withChatNotes(turns, [note()]);
  assert.deepEqual(placed[0].items.at(-1), { type: 'statusNote', id: 'draft-1-1', kind: 'draft', text: 'Draft · Re: lunch', draft });
});

test('the panel’s rows carry a draft as a note row a phone draws as a card; a note that is not a draft is no row', () => {
  const rows = rowsOf(withChatNotes(turns, [note()])).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].role, 'note');
  assert.equal(rows[1].text, 'Draft · Re: lunch');
  assert.deepEqual(rows[1].draft, draft);
  for (const bad of [{ draft: undefined }, { draft: { body: '' } }, { draft: { to: ['nope'], body: 'x' } }]) {
    assert.equal(rowsOf(withChatNotes(turns, [note(bad)])).rows.length, 1, JSON.stringify(bad));
  }
});

test('a draft’s body counts toward what a page of rows weighs', () => {
  const big = (i: number) => note({ id: `d${i}`, draft: { to: [], subject: '', body: 'x'.repeat(5000) } });
  const notes = Array.from({ length: Math.ceil(MAX_TOTAL / 5000) + 5 }, (_, i) => big(i));
  const { rows, clipped } = rowsOf(withChatNotes(turns, notes));
  assert.equal(clipped, true);
  assert.ok(rows.length < notes.length);
});

test('momo_draft is a MoMo tool that sends nothing out, and an unknown tool of its kind has no class', () => {
  assert.equal(trustClassOf('momo_draft'), 'own');
  assert.equal(momoTool('momo_draft'), true);
  assert.equal(trustClassOf('momo_send_mail'), null, 'there is no class to make a send tool callable');
});
