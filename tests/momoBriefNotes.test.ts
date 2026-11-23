// How the morning brief reaches the clients (A7): its Scheduled row in the Tasks panel's derivation (electron/momo/tasksPanel.cjs), the suggestion card a brief note carries (shared/momoBriefNote.mjs), a brief note put back among a chat's turns (shared/chatNotes.mjs) and read as a phone's row (electron/capabilities/browser/chromePanelLive.cjs), and Try again as a paired phone's request (momo.brief.runNow over momoBrief:runNow); nothing here is reachable by an uninvited account.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ok, fail, askSlow, momoRig, MOMO_METHODS, UNINVITED } from './support/remote-momo-kit.ts';
import { briefCardOfRow } from '../mobile/src/momo/stateContract';
import { parseTaskPanel } from '../mobile/src/momo/taskPanelContract';

const require = createRequire(import.meta.url);
const { deriveTaskPanel } = require('../electron/momo/tasksPanel.cjs');
const { briefCardOf } = require('../shared/momoBriefNote.mjs');
const { withChatNotes } = require('../shared/chatNotes.mjs');
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { RunSkipped } = require('../electron/platform/scheduler.cjs');
const methods = require('../electron/remote/methods/momo.cjs');
const { PARSERS } = require('../shared/remote/schema.mjs');

const NOW = Date.UTC(2026, 10, 16, 6);
const base = { runs: [], routineName: () => null, routines: [], nextRun: () => null, loops: [], cards: [], marks: {}, now: NOW };

test('the Scheduled tab gets the brief’s row first: scheduled with its next time, paused when suspended, failed with its reason; none while the brief is off', () => {
  const row = (brief: any) => deriveTaskPanel({ ...base, brief }).find((t: any) => t.kind === 'brief');
  assert.equal(row(null), undefined);
  assert.equal(row(undefined), undefined);
  assert.deepEqual(
    (({ id, tab, state, title, detail, ref, paused, nextAt }) => ({ id, tab, state, title, detail, ref, paused, nextAt }))(
      row({ state: 'scheduled', nextAt: NOW + 3600_000, reason: null }),
    ),
    {
      id: 'brief:morning',
      tab: 'scheduled',
      state: 'scheduled',
      title: 'Morning brief',
      detail: null,
      ref: 'momo.brief',
      paused: false,
      nextAt: NOW + 3600_000,
    },
  );
  assert.deepEqual(
    [row({ state: 'suspended', nextAt: null, reason: 'Paused because you were away for a week.' })].map((t) => [
      t.state,
      t.paused,
      t.nextAt,
      t.detail,
    ]),
    [['scheduled', true, null, 'Paused because you were away for a week.']],
  );
  assert.deepEqual(
    [row({ state: 'failed', nextAt: NOW, reason: 'No brain.' })].map((t) => [t.state, t.paused, t.detail]),
    [['failed', false, 'No brain.']],
  );
  // before the routines in the same tab
  const both = deriveTaskPanel({
    ...base,
    routines: [{ id: 'r1', name: 'Daily', status: 'ACTIVE', rrule: 'R' }],
    nextRun: () => new Date(NOW),
    brief: { state: 'scheduled', nextAt: null, reason: null },
  });
  assert.deepEqual(
    both.map((t: any) => t.id),
    ['brief:morning', 'routine:r1'],
  );
  // and the phone's parser reads it
  assert.equal(parseTaskPanel({ v: 2, tasks: both, paused: false, now: NOW })!.tasks[0].kind, 'brief');
});

test('a brief card is an id the store gave, a title and a source line; anything else is no card', () => {
  assert.deepEqual(briefCardOf({ id: 's1', title: 'T', source: 'S', extra: 1 }), { id: 's1', title: 'T', source: 'S' });
  assert.deepEqual(briefCardOf({ id: 'abc-1.2:3', title: 'T' }), { id: 'abc-1.2:3', title: 'T', source: '' });
  assert.equal(briefCardOf({ id: 'x'.repeat(65), title: 'T' }), null);
  for (const bad of [null, 'x', 5, {}, { id: 'a b', title: 'T' }, { id: 's1' }, { id: 's1', title: 5 }, { id: 5, title: 'T' }])
    assert.equal(briefCardOf(bad), null);
  assert.equal(briefCardOf({ id: 's1', title: 'T'.repeat(300), source: 'S'.repeat(300) })!.title.length, 120);
  assert.equal(briefCardOf({ id: 's1', title: 'T', source: 'S'.repeat(300) })!.source.length, 100);
});

test('a brief note goes back among the chat’s turns with its suggestion and reaches a phone as a note row with the card; a bad card is only the line', () => {
  const note = (id: string, extra: object = {}) => ({
    id,
    kind: 'brief',
    text: `line ${id}`,
    turnId: null,
    turn: Number.MAX_SAFE_INTEGER,
    at: NOW,
    ...extra,
  });
  const turns = [{ id: 'ct-1', items: [{ type: 'agentMessage', id: 'i1', text: 'Hi' }] }];
  const notes = [
    note('b1'),
    note('b2', { suggestion: { id: 's1', title: 'Reply to Sam', source: 'Mail: Sam' } }),
    note('b3', { suggestion: { id: 'bad id' } }),
  ];
  const items = withChatNotes(turns, notes)[0].items;
  assert.deepEqual(
    items.slice(1).map((i: any) => [i.kind, i.text, i.suggestion?.id ?? null]),
    [
      ['brief', 'line b1', null],
      ['brief', 'line b2', 's1'],
      ['brief', 'line b3', 'bad id'],
    ],
  );
  const { rows } = rowsOf(withChatNotes(turns, notes));
  const briefRows = rows.filter((r: any) => r.role === 'note');
  assert.deepEqual(
    briefRows.map((r: any) => [r.text, r.suggestion ?? null]),
    [
      ['line b1', null],
      ['line b2', { id: 's1', title: 'Reply to Sam', source: 'Mail: Sam' }],
      ['line b3', null],
    ],
  );
  assert.deepEqual(briefCardOfRow(briefRows[1]), { id: 's1', title: 'Reply to Sam', source: 'Mail: Sam' });
  assert.equal(briefCardOfRow(briefRows[0]), null);
  assert.equal(briefCardOfRow({ role: 'user', suggestion: { id: 's1', title: 'T' } }), null);
  assert.equal(briefCardOfRow(null), null);
  // a line with no text is no row
  assert.equal(rowsOf(withChatNotes(turns, [note('b4', { text: '' })])).rows.filter((r: any) => r.role === 'note').length, 0);
});

function rig(o: { allowed?: boolean; run?: () => Promise<unknown> } = {}) {
  const m = momoRig(o);
  m.tasksPanel.on = true;
  if (o.run) m.briefRun.run = o.run;
  return { ...m, p: m.r.phone('p1') };
}

test('Try again from a phone writes the brief on the Mac; a refusal says why in words; with the brief off the Mac answers unavailable', async () => {
  const t = rig();
  assert.deepEqual(ok(await askSlow(t.p, 'momo.brief.runNow')), { ran: true });
  const skipped = rig({ run: () => Promise.reject(new RunSkipped('nothing-to-say')) });
  fail(await askSlow(skipped.p, 'momo.brief.runNow'), 'failed', /Nothing to tell you today/);
  t.tasksPanel.on = false;
  fail(await askSlow(t.p, 'momo.brief.runNow'), 'failed', /brief is off/);
});

test('the method is listed for an invited phone and refused for others, in the schema and the methods', async () => {
  const t = rig();
  assert.equal(ok(await t.p.ask('machine.hello')).capabilities.methods.includes('momo.brief.runNow'), true);
  assert.ok(MOMO_METHODS.includes('momo.brief.runNow'));
  assert.equal(typeof methods['momo.brief.runNow'], 'function');
  assert.deepEqual(PARSERS['momo.brief.runNow']({}), {});
  const off = rig({ allowed: false });
  fail(await off.p.ask('momo.brief.runNow'), 'forbidden', UNINVITED);
  t.r.service.momo = () => null;
  fail(await t.p.ask('momo.brief.runNow'), 'failed', /not ready/);
});
