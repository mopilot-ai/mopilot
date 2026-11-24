// The brief card's kept-quiet lines are part of the view contract (shared/momoView.ts `MomoBriefView.keptQuiet`): the Host's brief view IS that type, each line that has a rule offers "Undo rule" as the existing intent `rule.undo { id: ruleId }` (which the intent table accepts), a line with no rule offers none, and a brief from an older Host has no field at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Brief } from '../shared/momoNotice/brief.ts';
import { briefView } from '../shared/momoNotice/views.ts';
import type { MomoBriefView } from '../shared/momoView.ts';
// @ts-ignore: plain ESM without declarations
import { argsFit, INTENT_TABLE } from '../shared/momoIntents.mjs';

const brief = (over: Partial<Brief> = {}): Brief =>
  ({ dayKey: '2026-11-23', name: 'Du', needsYou: [], checked: { mail: 3 }, keptQuiet: [], ...over }) as unknown as Brief;
const kept = (matterKey: string, quietRule?: { ruleId: string; label: string }) => ({
  matterKey,
  title: `Mail ${matterKey}`,
  summary: 's',
  pending: true,
  suspect: false,
  ...(quietRule ? { quietRule } : {}),
});

/** What a client does for "Undo rule" on a line: the intent it sends, or nothing when the line has no rule. */
const undoOf = (line: NonNullable<MomoBriefView['keptQuiet']>[number]) => (line.ruleId ? { kind: 'rule.undo', id: line.ruleId } : null);

test('each kept-quiet line of the brief view undoes its rule with an intent the table takes, and a line with no rule offers nothing', () => {
  const view: MomoBriefView = briefView(brief({ keptQuiet: [kept('gmail:a', { ruleId: 'r1', label: 'acme.com' }), kept('gmail:b')] }), []);
  const lines = view.keptQuiet ?? [];
  assert.equal(lines.length, 2);
  const [withRule, without] = lines as [(typeof lines)[number], (typeof lines)[number]];
  assert.deepEqual(undoOf(withRule), { kind: 'rule.undo', id: 'r1' });
  assert.equal(undoOf(without), null);
  const intent = undoOf(withRule)!;
  assert.equal(INTENT_TABLE[intent.kind].lane, 'gate');
  assert.equal(argsFit(intent.kind, intent), true);
});

test('a brief from an older Host has no keptQuiet field, and a client treats that as no lines', () => {
  const older: MomoBriefView = {
    day: '2026-11-23',
    greeting: 'Good morning.',
    attention: null,
    offers: [],
    overnight: { read: 0, notesUpdated: 0, rulesLearned: 0 },
    leftOut: [],
  };
  assert.deepEqual(older.keptQuiet ?? [], []);
});
