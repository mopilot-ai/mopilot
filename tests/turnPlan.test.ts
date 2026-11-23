// src/store/turnPlan.ts: which plan the turn box shows (the latest turn's own, the agent's list, an earlier turn's
// own) and when, as Claude Desktop's turn box decides it: a plan from before the user's latest message shows still while
// a turn runs and goes once done; after a turn, only one cut short with steps left or one linked sessions still work on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxPlan, boxShows, steeredMessages } from '../src/store/turnPlan.ts';

const turn = (status: string, items: any[] = [], plan?: any) => ({ id: 't', status, items, plan }) as any;
const user = (id: string) => ({ type: 'userMessage', id });
const steps: any[] = [
  { step: 'Read', status: 'completed' },
  { step: 'Write', status: 'inProgress' },
];
const done = steps.map((s) => ({ ...s, status: 'completed' }));
const none = () => false;

test('the messages steered into a turn are its userMessage items after the opening one', () => {
  assert.equal(steeredMessages(turn('inProgress', [user('a'), { type: 'agentMessage' }, user('b'), user('c')])), 2);
  assert.equal(steeredMessages(turn('inProgress', [user('a')])), 0);
  assert.equal(steeredMessages(turn('inProgress')), 0);
});

test('the latest turn’s own plan wins; one a later message was steered in after is stale; one read from disk is not', () => {
  const agent = { items: [{ content: 'Mine', status: 'pending' as const }], stale: false };
  const own = turn('inProgress', [user('a')], { explanation: null, steps, steered: 0 });
  assert.deepEqual(boxPlan([own], agent, none), { steps, stale: false });
  const steered = turn('inProgress', [user('a'), user('b')], { explanation: null, steps, steered: 0 });
  assert.equal(boxPlan([steered], agent, none)!.stale, true);
  // the plan came before the opener joined its turn (the harness's events beat main's answer): it is still this turn's
  const early = turn('inProgress', [user('a')], { explanation: null, steps, steered: 0 });
  assert.equal(boxPlan([early], agent, none)!.stale, false);
  const fromDisk = turn('completed', [user('a'), user('b')], { explanation: null, steps });
  assert.equal(boxPlan([fromDisk], undefined, none)!.stale, false);
  // an empty plan of its own is none: the agent's list shows, as main marks it
  const empty = turn('inProgress', [], { explanation: null, steps: [] });
  assert.deepEqual(boxPlan([empty], { ...agent, stale: true }, none), { steps: [{ step: 'Mine', status: 'pending' }], stale: true });
});

test('with neither, an earlier turn’s own plan shows, stale once the user spoke after it (not for what main delivered)', () => {
  const earlier = turn('completed', [user('a')], { explanation: null, steps });
  assert.equal(boxPlan([], undefined, none), null);
  assert.equal(boxPlan([turn('inProgress')], { items: [], stale: false }, none), null);
  assert.deepEqual(boxPlan([earlier, turn('inProgress', [user('b')])], undefined, none), { steps, stale: true });
  // a wake-up's delivered item is not the user's message: the plan is still the one being worked on
  const wake = turn('inProgress', [user('wake')]);
  assert.equal(boxPlan([earlier, wake], undefined, (i) => i.id === 'wake')!.stale, false);
  // the nearest earlier plan is the one
  const older = turn('completed', [], { explanation: null, steps: done });
  assert.deepEqual(boxPlan([older, earlier, turn('inProgress')], undefined, none)!.steps, steps);
});

test('while a turn runs: a fresh plan spins while a step is open; a stale one is still, and goes once done', () => {
  assert.deepEqual(boxShows({ steps, stale: false }, 'inProgress', false), { spin: true });
  assert.deepEqual(boxShows({ steps: done, stale: false }, 'inProgress', false), { spin: false });
  assert.deepEqual(boxShows({ steps, stale: true }, 'inProgress', false), { spin: false });
  assert.equal(boxShows({ steps: done, stale: true }, 'inProgress', false), null);
});

test('after a turn: a fresh plan cut short with steps left shows frozen; a finished one only while linked sessions work', () => {
  assert.equal(boxShows({ steps, stale: false }, 'completed', false), null);
  assert.equal(boxShows({ steps, stale: false }, undefined, false), null);
  assert.deepEqual(boxShows({ steps, stale: false }, 'interrupted', false), { spin: false });
  assert.deepEqual(boxShows({ steps, stale: false }, 'failed', false), { spin: false });
  assert.equal(boxShows({ steps: done, stale: false }, 'interrupted', false), null);
  assert.deepEqual(boxShows({ steps: done, stale: false }, 'completed', true), { spin: false });
  assert.equal(boxShows({ steps, stale: true }, 'interrupted', true), null);
});

test('after a turn: steps left keep spinning while linked sessions or background tasks still work on them', () => {
  assert.deepEqual(boxShows({ steps, stale: false }, 'completed', true), { spin: true });
  assert.deepEqual(boxShows({ steps, stale: false }, 'completed', false, true), { spin: true });
  assert.deepEqual(boxShows({ steps, stale: false }, undefined, false, true), { spin: true });
  // a finished plan does not linger for a background task alone, nor a stale one
  assert.equal(boxShows({ steps: done, stale: false }, 'completed', false, true), null);
  assert.equal(boxShows({ steps, stale: true }, 'completed', true, true), null);
  // a turn the user stopped stays frozen though its tasks or sessions carry on
  assert.deepEqual(boxShows({ steps, stale: false }, 'interrupted', true, true), { spin: false });
  assert.deepEqual(boxShows({ steps, stale: false }, 'failed', false, true), { spin: false });
});

test('linked sessions waiting on input or queued retain the plan without claiming to execute', () => {
  assert.deepEqual(boxShows({ steps, stale: false }, 'completed', true, false, false), { spin: false });
  assert.deepEqual(boxShows({ steps, stale: false }, 'completed', true, true, false), { spin: true });
});
