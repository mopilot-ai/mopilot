// Every flag has an owner and a removal date (or is a permanent kill switch), and none outlives its date (shared/flagDefs.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAG_DEFS, flagDay, flagDefProblems, flagExpired } from '../shared/flagDefs.mjs';

test('I: every flag definition is sound today', () => {
  assert.ok(FLAG_DEFS.length > 0, 'the definitions were found');
  assert.deepEqual(flagDefProblems(FLAG_DEFS, flagDay()), []);
});

test('B1: a missing owner, a dated flag without a date, or a past date fails, naming the key and owner', () => {
  const ok = { key: 'x.ok', default: false, owner: 'momo', remove: '2026-12-01', mode: 'toggle', description: 'a feature' } as const;
  const today = '2026-11-03';
  assert.deepEqual(flagDefProblems([ok, { ...ok, key: 'x.today', remove: today }], today), [], 'a flag may live through its date');
  assert.deepEqual(
    flagDefProblems(
      [
        { ...ok, key: 'x.noOwner', owner: '' },
        { ...ok, key: 'x.noDate', remove: 'permanent' },
        { ...ok, key: 'x.badDate', remove: '2026-02-30' },
        { ...ok, key: 'x.badMonth', remove: '2026-13-01' },
        { ...ok, key: 'x.undated', remove: undefined },
        { ...ok, key: 'x.past', remove: '2026-11-02' },
        { ...ok, key: 'x.mode', mode: 'on' as never },
        { ...ok, key: 'x.default', default: 'yes' as never },
        { ...ok, key: 'x.desc', description: ' ' },
        { ...ok, key: 'x.ok' },
        ok,
      ],
      today,
    ),
    [
      'x.noOwner (owner missing): no owner',
      'x.noDate (owner momo): a toggle flag needs a removal date',
      'x.badDate (owner momo): removal date must be YYYY-MM-DD or permanent',
      'x.badMonth (owner momo): removal date must be YYYY-MM-DD or permanent',
      'x.undated (owner momo): removal date must be YYYY-MM-DD or permanent',
      'x.past (owner momo): past its removal date 2026-11-02; remove the flag',
      'x.mode (owner momo): remote mode must be kill or toggle',
      'x.default (owner momo): default is not a boolean',
      'x.desc (owner momo): no description',
      'x.ok (owner momo): defined twice',
    ],
  );
  assert.deepEqual(flagDefProblems([{ ...ok, mode: 'kill', remove: 'permanent' }], today), [], 'a permanent kill switch is allowed');
});

test('a removal date is a UTC day; permanent never expires', () => {
  assert.equal(flagDay(Date.UTC(2026, 10, 3, 23, 59)), '2026-11-03');
  assert.equal(flagExpired({ remove: '2026-11-02' }, '2026-11-03'), true);
  assert.equal(flagExpired({ remove: '2026-11-03' }, '2026-11-03'), false);
  assert.equal(flagExpired({ remove: 'permanent' }, '2999-01-01'), false);
});
