// The Changes pane's findings strip: where the fixes stand, Previous and Next around the findings still shown, Re-run review and Dismiss.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, render, callsTo, moduleCalls, resetStore, settle } from './support/thread-kit.ts';

mockStore();
const { FindingsWalkBar, walkLabel } = await import('../src/components/panels/FindingsWalkBar.tsx');

const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? '';
const findings = [
  { file: 'a.ts', line: 1, summary: 'one' },
  { file: 'b.ts', line: 2, summary: 'two' },
  { file: 'c.ts', line: 3, summary: 'three' },
];
const review = { type: 'exitedReviewMode', id: 'r1', review: '-', findings, level: 'high' };
const fixed = { type: 'exitedReviewMode', id: 'r2', review: '-', findings: findings.map((f) => ({ ...f, outcome: 'fixed' })) };
const turn = (...items: object[]) => ({ id: 't1', status: 'completed', items });
const walk = (extra: object = {}) => ({ chatId: 'c1', reviewId: 'r1', current: 0, ...extra });
const button = (v: { $$: (s: string) => HTMLElement[] }, label: string) =>
  v.$$('button').find((b) => text(b) === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;

const open = (state: object = {}) =>
  resetStore({
    diffPanel: { open: true, scope: 'branch', walk: walk() },
    reviewMarks: {},
    runtime: { c1: { turns: [turn(review)] } },
    ...state,
  });
beforeEach(() => {
  moduleCalls.length = 0;
  open();
});

test('the label says fixes are running, done, or which finding is in focus', () => {
  assert.equal(walkLabel(['fixing', 'open'], [0, 1], 0), 'Applying fixes…');
  // fixed findings have left the walk (`shown`); the label still counts them
  assert.equal(walkLabel(['addressed', 'addressed'], [], null), 'Fixes applied');
  assert.equal(walkLabel(['addressed', 'open', 'open'], [1, 2], 1), '1 fixed · 2 open');
  assert.equal(walkLabel(['addressed', 'dismissed'], [], null), 'Fixes applied', 'a dismissed finding counts for neither');
  assert.equal(walkLabel(['open', 'open'], [0, 1], 1), 'Finding 2 of 2');
  assert.equal(walkLabel(['dismissed'], [], null), 'No findings to show');
});

test('fixes asked: the strip reads Applying fixes… and Previous / Next move the focus around the findings', async () => {
  open({ reviewMarks: { c1: { r1: { status: { 0: 'fixing', 1: 'fixing', 2: 'fixing' } } } } });
  const v = await render(h(FindingsWalkBar, { chatId: 'c1' }));
  assert.equal(text(v.$('.findings-walk-label')), 'Applying fixes…');
  assert.equal(v.$('[role="status"]'), v.$('.findings-walk-label'), 'only the label is live, not the buttons');
  await settle(() => button(v, 'Next finding')!.click());
  await settle(() => button(v, 'Previous finding')!.click());
  assert.deepEqual(callsTo('store:focusFinding'), [[1], [2]], 'Next from the first, Previous from the first wraps to the last');
  assert.equal(button(v, 'Re-run review'), undefined, 'not while fixes run');
});

test('findings dismissed in the diff leave the walk; a single one leaves nothing to step to', async () => {
  open({ reviewMarks: { c1: { r1: { status: { 1: 'dismissed', 2: 'dismissed' } } } } });
  const v = await render(h(FindingsWalkBar, { chatId: 'c1' }));
  assert.equal(text(v.$('.findings-walk-label')), 'Finding 1 of 1');
  assert.ok(button(v, 'Next finding')!.disabled);
  assert.ok(button(v, 'Previous finding')!.disabled);
});

test('every finding dismissed: nothing to show, and focus falls back to none', async () => {
  open({ reviewMarks: { c1: { r1: { status: { 0: 'dismissed', 1: 'dismissed', 2: 'dismissed' } } } } });
  const v = await render(h(FindingsWalkBar, { chatId: 'c1' }));
  assert.equal(text(v.$('.findings-walk-label')), 'No findings to show');
  assert.ok(button(v, 'Re-run review'), 'nothing is left to fix');
});

test('fixes reported: Fixes applied, Re-run review at the level the review ran at, and Dismiss closes the walk', async () => {
  open({ runtime: { c1: { turns: [turn(review, fixed)] } } });
  const v = await render(h(FindingsWalkBar, { chatId: 'c1' }));
  assert.equal(text(v.$('.findings-walk-label')), 'Fixes applied');
  await settle(() => button(v, 'Re-run review')!.click());
  assert.deepEqual(callsTo('store:rerunReview'), [['c1', 'high']]);
  await settle(() => button(v, 'Dismiss')!.click());
  assert.deepEqual(callsTo('store:closeFindingsWalk'), [['c1']]);
});

test('a fixed finding leaves the walk: Previous and Next step over it, and the label still counts it', async () => {
  const one = { type: 'exitedReviewMode', id: 'r2', review: '-', findings: [{ ...findings[1], outcome: 'fixed' }] };
  open({ runtime: { c1: { turns: [turn(review, one)] } }, diffPanel: { open: true, scope: 'branch', walk: walk({ current: 1 }) } });
  const v = await render(h(FindingsWalkBar, { chatId: 'c1' }));
  assert.equal(text(v.$('.findings-walk-label')), '1 fixed · 2 open');
  await settle(() => button(v, 'Next finding')!.click());
  await settle(() => button(v, 'Previous finding')!.click());
  assert.deepEqual(
    callsTo('store:focusFinding'),
    [[2], [2]],
    'the focus left the fixed one for the first open one, and Next / Previous skip it',
  );
});

test("no walk, another chat's walk, or a review the turns no longer hold: no strip", async () => {
  open({ diffPanel: { open: true, scope: 'branch' } });
  assert.equal((await render(h(FindingsWalkBar, { chatId: 'c1' }))).$('.findings-walk'), null);
  open({ diffPanel: { open: true, scope: 'branch', walk: walk({ chatId: 'other' }) } });
  assert.equal((await render(h(FindingsWalkBar, { chatId: 'c1' }))).$('.findings-walk'), null);
  assert.equal((await render(h(FindingsWalkBar, { chatId: null }))).$('.findings-walk'), null);
  open({ diffPanel: { open: true, scope: 'branch', walk: walk({ reviewId: 'gone' }) } });
  assert.equal((await render(h(FindingsWalkBar, { chatId: 'c1' }))).$('.findings-walk'), null);
});

test('a walk of a review a newer one superseded offers no Re-run review, as its card offers none', async () => {
  const newer = { type: 'exitedReviewMode', id: 'r3', review: '-', findings: [findings[0]], level: 'low' };
  open({ runtime: { c1: { turns: [turn(review, fixed), { id: 't2', status: 'completed', items: [newer] }] } } });
  const v = await render(h(FindingsWalkBar, { chatId: 'c1' }));
  assert.equal(text(v.$('.findings-walk-label')), 'Fixes applied');
  assert.equal(button(v, 'Re-run review'), undefined);
  assert.ok(button(v, 'Dismiss'));
});
