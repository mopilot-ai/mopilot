// MoMo's open loops' shape (#2139 P4, electron/momo/openLoopsShape.cjs): a loop's quote must be the user's own words and nothing else the chat holds (a tool result, MoMo's reply, a nudge, text the user pasted), and a due date is read in the zone the user said it in, across daylight-saving and time-zone changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isLoop,
  norm,
  quotedByUser,
  zoneOffset,
  zonedEpoch,
  dueOf,
  localLabel,
  checkLoops,
} = require('../electron/momo/openLoopsShape.cjs');

const SAID = Date.UTC(2030, 2, 4, 15, 0); // Mon 2030-03-04 10:00 in New York
const said = (user: string[], other: string[] = []) => ({
  user: user.map((text, i) => ({ text, at: SAID + i, turnId: `t${i}` })),
  other,
});

test('a quote counts only when it is in the user’s own words and in nothing else the chat holds', () => {
  const s = said(['I’ll call the landlord by Wednesday, promise.'], ['MoMo: Sounds good.']);
  assert.equal(quotedByUser('"I\'ll call the landlord by Wednesday"', s)?.turnId, 't0', 'quotes and case are ignored');
  assert.equal(quotedByUser('call  the LANDLORD', s)?.turnId, 't0');
  assert.equal(quotedByUser('Sounds good', s), null, 'MoMo’s reply is not the user’s');
  assert.equal(quotedByUser('abc', s), null, 'too short to tie to anything');
  assert.equal(quotedByUser('nobody said this', s), null, 'in no message at all');
  // the words appear only in a tool result (a calendar answer shown in the chat)
  const tool = said(['What is on tomorrow?'], ['{"type":"toolResult","text":"Dentist appointment, pay the invoice by Friday"}']);
  assert.equal(quotedByUser('pay the invoice by Friday', tool), null);
  // the user pasted the tool's text: it is in their message, but also in the tool result, so it is not theirs
  const pasted = said(['look: pay the invoice by Friday'], ['pay the invoice by Friday']);
  assert.equal(quotedByUser('pay the invoice by Friday', pasted), null);
  assert.equal(norm('“Hi,  there!”'), 'hi there');
});

test('a due date is an absolute time in the user’s zone: a date alone is that day’s end, a time as said', () => {
  const ny = 'America/New_York';
  assert.equal(dueOf('2030-03-06', ny, SAID), Date.UTC(2030, 2, 7, 4, 59), 'Wed 23:59 EST');
  assert.equal(dueOf('2030-03-06T15:00', ny, SAID), Date.UTC(2030, 2, 6, 20, 0));
  assert.equal(dueOf(' 2030-03-06 15:00 ', ny, SAID), Date.UTC(2030, 2, 6, 20, 0));
  for (const bad of ['2030-02-30', '2030-13-01', 'next week', 42, '2030-03-06T24:00', '2030-03-06T10:60'])
    assert.equal(dueOf(bad, ny, SAID), null, String(bad));
  assert.equal(dueOf('2030-03-01', ny, SAID), null, 'before the day it was said');
  assert.equal(dueOf('2033-03-01', ny, SAID), null, 'more than two years on');
});

test('due dates across a daylight-saving change keep their wall-clock time', () => {
  const ny = 'America/New_York';
  // US clocks spring forward on 2030-03-10: 15:00 that Monday is EDT (UTC-4), 15:00 the Friday before EST (UTC-5)
  assert.equal(dueOf('2030-03-08T15:00', ny, SAID), Date.UTC(2030, 2, 8, 20, 0));
  assert.equal(dueOf('2030-03-11T15:00', ny, SAID), Date.UTC(2030, 2, 11, 19, 0));
  // a time the change skips (02:30) lands just after it
  assert.equal(zonedEpoch({ y: 2030, mo: 3, d: 10, h: 2, mi: 30 }, ny), Date.UTC(2030, 2, 10, 7, 30));
  // fall back: 01:30 happens twice; one of the two is taken
  const fall = zonedEpoch({ y: 2030, mo: 11, d: 3, h: 1, mi: 30 }, ny);
  assert.ok([Date.UTC(2030, 10, 3, 5, 30), Date.UTC(2030, 10, 3, 6, 30)].includes(fall));
  assert.equal(zoneOffset(Date.UTC(2030, 0, 1), ny), -5 * 3600_000);
  assert.equal(zoneOffset(Date.UTC(2030, 6, 1), ny), -4 * 3600_000);
});

test('the same words read in another zone are another absolute time; an unknown zone reads as UTC', () => {
  const tokyo = dueOf('2030-03-06T09:00', 'Asia/Tokyo', SAID);
  const berlin = dueOf('2030-03-06T09:00', 'Europe/Berlin', SAID);
  assert.equal(tokyo, Date.UTC(2030, 2, 6, 0, 0));
  assert.equal(berlin, Date.UTC(2030, 2, 6, 8, 0));
  assert.equal(dueOf('2030-03-06T09:00', 'Not/AZone', SAID), Date.UTC(2030, 2, 6, 9, 0));
  assert.equal(localLabel(SAID, 'America/New_York'), 'Mon 2030-03-04 10:00');
  assert.equal(localLabel(SAID, 'Asia/Tokyo'), 'Tue 2030-03-05 00:00');
});

test('checkLoops keeps adds in the user’s words, reads their due date against when they were said, and says why the rest went', () => {
  const s = said(
    ['I promise to send Ana the slides by Wednesday', 'the dentist thing is done, finally'],
    ['MoMo: I’ll remind you to renew the lease'],
  );
  const r = checkLoops(
    [
      {
        op: 'add',
        kind: 'promise',
        text: 'Send Ana the slides',
        quote: 'send Ana the slides by Wednesday',
        due: '2030-03-06',
        confidence: 'sure',
        event: 'Team sync',
      },
      { kind: 'todo', text: 'Renew the lease', quote: 'renew the lease' },
      { op: 'add', kind: 'todo', text: 'Key sk-abcdefgh12', quote: 'send Ana the slides' },
      { op: 'add', kind: 'chore', text: 'x', quote: 'send Ana' },
      { op: 'add', kind: 'todo', text: 'Slides', quote: 'send Ana the slides', due: 'soonish' },
      { op: 'mention', id: 'L1' },
      { op: 'done', id: 'L2', quote: 'the dentist thing is done' },
      { op: 'done', id: 'L1', quote: 'renew the lease' },
      { op: 'mention', id: 'gone' },
      { op: 'rename', text: 'x', quote: 'send Ana', kind: 'todo' },
    ],
    { said: s, tz: 'America/New_York', open: new Set(['L1', 'L2']), looksSecret: (t: string) => /sk-[a-z0-9]{8,}/.test(t) },
  );
  assert.equal(r.add.length, 2);
  assert.deepEqual(
    { ...r.add[0], line: r.add[0].line.turnId },
    {
      kind: 'promise',
      text: 'Send Ana the slides',
      quote: 'send Ana the slides by Wednesday',
      line: 't0',
      tz: 'America/New_York',
      confidence: 'sure',
      dueAt: Date.UTC(2030, 2, 7, 4, 59),
      dueDay: '2030-03-06',
      event: 'Team sync',
    },
  );
  assert.equal(r.add[1].confidence, 'likely', 'unsaid confidence is likely');
  assert.equal('dueAt' in r.add[1], false, 'a due date that can’t be read leaves the loop undated');
  assert.deepEqual(r.mention, ['L1']);
  assert.deepEqual(r.done, ['L2']);
  assert.deepEqual(r.dropped, [
    { op: 'add', reason: 'not in the user’s words' },
    { op: 'add', reason: 'looks like a secret' },
    { op: 'add', reason: 'not a loop' },
    { op: 'done', reason: 'not in the user’s words' },
    { op: 'mention', reason: 'not an open loop' },
    { op: 'rename', reason: 'not a loop' },
  ]);
});

test('isLoop takes only a whole loop', () => {
  const ok = {
    id: 'L1',
    kind: 'todo',
    text: 'Renew the lease',
    quote: 'renew the lease',
    source: { chatId: 'momo-main', harness: 'codex', turnId: 't1' },
    saidAt: 1,
    tz: 'UTC',
    confidence: 'sure',
    lastMentionedAt: 1,
    state: 'open',
    nudged: [{ at: 2, trigger: 'due', key: 'due:L1' }],
  };
  assert.equal(isLoop(ok), true);
  assert.equal(isLoop({ ...ok, dueAt: 5, dueDay: '2030-01-02', event: 'Lease', closedAt: 3, snoozedUntil: 4, askedClose: 6 }), true);
  for (const bad of [
    null,
    { ...ok, id: '' },
    { ...ok, kind: 'x' },
    { ...ok, text: ' ' },
    { ...ok, quote: 'q'.repeat(301) },
    { ...ok, source: { chatId: 'c', harness: 'h' } },
    { ...ok, saidAt: Number.NaN },
    { ...ok, tz: 1 },
    { ...ok, confidence: 'maybe' },
    { ...ok, dueAt: 'soon' },
    { ...ok, dueDay: 'Wed' },
    { ...ok, event: '' },
    { ...ok, state: 'gone' },
    { ...ok, closedAt: 'x' },
    { ...ok, snoozedUntil: 'x' },
    { ...ok, askedClose: 'x' },
    { ...ok, nudged: [{ at: 1 }] },
    { ...ok, nudged: 'x' },
  ])
    assert.equal(isLoop(bad), false, JSON.stringify(bad));
});
