// Superagent core (electron/superagent/core): ids, reasons, model helpers, ticket stage and the Policy port check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { key } = require('../electron/superagent/core/ids.cjs');
const { REASONS, said, reasonText } = require('../electron/superagent/core/reasons.cjs');
const m = require('../electron/superagent/core/model.cjs');
const { ticketStage, canRetry } = require('../electron/superagent/core/stage.cjs');
const { policyProblems } = require('../electron/superagent/core/ports.cjs');

const ticket = (o: any = {}) => ({ id: 't', assignments: [], inputs: [], undelivered: [], ...o });
const asg = (state: string, report?: string) => ({
  id: 'a',
  state,
  createdAt: '',
  ...(report ? { report: { state: report, summary: '', at: '2026-01-01T00:00:00.000Z' } } : {}),
});

test('key is stable, distinct per input and 32 hex chars', () => {
  assert.equal(key('a', 'b'), key('a', 'b'));
  assert.notEqual(key('a', 'b'), key('ab'));
  assert.match(key('x'), /^[0-9a-f]{32}$/);
});

test('reasonText fills templates, prefixes the trigger, falls back to the code and tolerates nothing', () => {
  assert.equal(reasonText(said('hi')), 'hi');
  assert.equal(reasonText({ code: 'observed', values: { text: 'rule' }, triggerId: 'tr1' }), 'tr1: Observe mode: would accept (rule)');
  assert.equal(reasonText({ code: 'observed' }), 'Observe mode: would accept ({text})');
  assert.equal(reasonText([{ code: 'noAdmissible' }, { code: 'custom_code' }]), `${REASONS.noAdmissible}; custom_code`);
  assert.equal(reasonText(undefined), '');
});

test('threadKey and isoTime', () => {
  assert.equal(m.threadKey({ source: 'github', id: 'o/r#1' }), 'github:o/r#1');
  assert.equal(m.isoTime('2026-11-07T10:00:00+02:00'), '2026-11-07T08:00:00.000Z');
  assert.equal(m.isoTime('not a time'), 'not a time');
});

test('ticket readers', () => {
  const open = ticket({ assignments: [asg('running'), asg('ended', 'ready')] });
  assert.equal(m.liveTicket(open), true);
  assert.equal(m.liveTicket({ ended: { outcome: 'merged' } }), false);
  assert.equal(m.ticketOutcome({ ended: { outcome: 'merged' } }), 'merged');
  assert.equal(m.ticketOutcome({}), undefined);
  assert.equal(m.runningAssignment(open).state, 'running');
  assert.equal(m.runningAssignment(ticket()), undefined);
  assert.equal(m.latestAssignment(open).state, 'ended');
  assert.equal(m.latestReport(open).state, 'ready');
  assert.equal(m.latestReport(ticket()), undefined);
});

test('waitsForPerson: only a blocked or failed report with no person since', () => {
  assert.equal(m.waitsForPerson(ticket()), false);
  assert.equal(m.waitsForPerson(ticket({ assignments: [asg('ended', 'ready')] })), false);
  const blocked = ticket({ assignments: [asg('ended', 'blocked')] });
  assert.equal(m.waitsForPerson(blocked), true);
  const later = { id: 'i', kind: 'trigger', triggerId: 'x', at: '2026-02-01T00:00:00.000Z' };
  assert.equal(m.waitsForPerson({ ...blocked, inputs: [{ ...later, human: true }] }), false);
  assert.equal(m.waitsForPerson({ ...blocked, inputs: [{ ...later, human: true, context: true }] }), true);
  assert.equal(m.waitsForPerson({ ...blocked, inputs: [later] }), true);
  assert.equal(m.waitsForPerson({ ...blocked, inputs: [{ id: 'n', kind: 'note', text: '', at: '2027' }] }), true);
  assert.equal(m.waitsForPerson({ ...blocked, inputs: [{ ...later, human: true, at: '2025-01-01T00:00:00.000Z' }] }), true);
});

test('ticketStage follows the first matching row', () => {
  assert.deepEqual(ticketStage(ticket({ ended: { outcome: 'merged' }, delivery: {} })), { stage: 'ended' });
  assert.deepEqual(ticketStage(ticket({ delivery: { error: 'x' } })), { stage: 'person', action: 'delivery' });
  assert.deepEqual(ticketStage(ticket({ attention: { id: 'q', question: '?' } })), { stage: 'person', action: 'answer' });
  assert.deepEqual(ticketStage(ticket({ assignments: [asg('running', 'ready')] })), { stage: 'person', action: 'review' });
  assert.deepEqual(ticketStage(ticket({ assignments: [asg('ended', 'failed')] })), { stage: 'person', action: 'failed' });
  assert.deepEqual(ticketStage(ticket()), { stage: 'working', action: 'queued' });
  assert.deepEqual(ticketStage(ticket({ assignments: [asg('pending')] })), { stage: 'working', action: 'queued' });
  assert.deepEqual(ticketStage(ticket({ assignments: [asg('running', 'waiting')] })), { stage: 'idle' });
  assert.deepEqual(ticketStage(ticket({ assignments: [asg('ended', 'progress')] })), { stage: 'idle' });
  assert.deepEqual(ticketStage(ticket({ assignments: [asg('running', 'progress')] })), { stage: 'working' });
  // a blocked report a person already answered falls through to the next rows
  const answered = ticket({
    assignments: [asg('running', 'blocked')],
    inputs: [{ id: 'i', kind: 'trigger', triggerId: 'x', human: true, at: '2027-01-01T00:00:00.000Z' }],
  });
  assert.deepEqual(ticketStage(answered), { stage: 'working' });
});

test('canRetry', () => {
  assert.equal(canRetry(ticket({ ended: {} })), false);
  assert.equal(canRetry(ticket()), false);
  assert.equal(canRetry(ticket({ delivery: { error: 'x' } })), true);
  assert.equal(canRetry(ticket({ assignments: [asg('ended', 'failed')] })), true);
});

test('policyProblems names every missing or mistyped member', () => {
  const ok = { version: '1', paused: false, gate() {}, revalidate() {}, admitsInferred() {}, evalTimeoutMs: 1 };
  assert.deepEqual(policyProblems(ok), []);
  assert.deepEqual(policyProblems({ ...ok, version: 1, gate: null }), ['version must be a string', 'gate must be a function']);
  assert.equal(policyProblems(null).length, 6);
  assert.equal(policyProblems('x').length, 6);
});
