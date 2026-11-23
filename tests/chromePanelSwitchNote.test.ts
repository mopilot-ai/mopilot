// A chat on a machine that moved to another agent shows the move on the panel and the phone as a note row (#4775): the Host's journaled switch is the chat's `switch` note on the Mac, and the rows the phone reads carry it first in the turn it settled in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { withChatNotes } from '../shared/chatNotes.mjs';

const require = createRequire(import.meta.url);
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');

const user = (id: string, text: string) => ({ type: 'userMessage', id, content: [{ type: 'text', text }] });
const turns = () => [
  { id: 'h-t0', items: [user('u0', 'first')] },
  { id: 'h-t1', items: [user('u1', 'second')] },
];
const note = {
  id: 'switch-t1',
  kind: 'switch',
  text: 'Moved from Claude Code to Codex',
  turnId: 't1',
  turn: Number.MAX_SAFE_INTEGER,
  at: 5000,
  lead: true,
};

test('A: a switch note is a note row, first in the turn it names', () => {
  const { rows } = rowsOf(withChatNotes(turns(), [note]));
  assert.deepEqual(
    rows.map((r: any) => [r.role, r.text]),
    [
      ['user', 'first'],
      ['note', 'Moved from Claude Code to Codex'],
      ['user', 'second'],
    ],
  );
});

test('B: a switch note with no words, or a chat with none, adds no row', () => {
  assert.equal(rowsOf(withChatNotes(turns(), [{ ...note, text: '' }])).rows.length, 2);
  assert.equal(rowsOf(withChatNotes(turns(), [])).rows.length, 2);
});
