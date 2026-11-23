// The store behind a pick that shows before the Mac answers, and what each pick changes in the controls (#4986 F3): a refusal brings back the pick it was shown on, an answer to an earlier pick settles nothing, and the agent a chat ran on before a row of picks is remembered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/register.ts';
const hookPath = '../mobile/src/remote/useChatControls';
const patchPath = '../mobile/src/remote/pickPatches';
const { optimistic } = await import(hookPath);
const { withModel, withEffort, withPermission, withAccount, withAgent } = await import(patchPath);

const MODELS = [
  { id: 'm1', label: 'M1', efforts: [], defaultEffort: null },
  { id: 'm2', label: 'M2', efforts: [], defaultEffort: null },
];
const ROWS = [
  { id: 'default', label: 'Ask', detail: 'Ask first' },
  { id: 'auto-review', label: 'Auto', detail: 'Reviewed' },
];
const AGENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

test('the pick patches: each changes only what it names, and an unknown row or login falls back to the id', () => {
  const controls: any = {
    options: {
      models: MODELS,
      model: 'm1',
      effort: 'low',
      permissions: ROWS,
      permission: 'default',
      permissionLabel: 'Ask',
      accounts: [{ id: 'work', label: 'Work' }],
      account: { id: null, pinned: false, serving: 'Home' },
    },
    harness: { id: 'claude', label: 'Claude Code' },
    switching: false,
    harnesses: AGENTS,
    methods: {},
  };
  assert.deepEqual([withModel('m2', 'medium')(controls).options.model, withModel('m2', null)(controls).options.effort], ['m2', null]);
  assert.equal(withEffort('high')(controls).options.effort, 'high');
  assert.deepEqual(
    [withPermission('auto-review')(controls).options.permission, withPermission('auto-review')(controls).options.permissionLabel],
    ['auto-review', 'Auto'],
  );
  assert.equal(withPermission('weird')(controls).options.permissionLabel, 'weird');
  assert.deepEqual(withAccount('work')(controls).options.account, {
    id: 'work',
    pinned: true,
    serving: 'Work',
  });
  assert.deepEqual(withAccount('gone')(controls).options.account, {
    id: 'gone',
    pinned: true,
    serving: 'gone',
  });
  assert.deepEqual(withAccount(null)(controls).options.account, {
    id: null,
    pinned: false,
    serving: null,
  });
  // an agent: not the one it runs on is a move that waits; with no own agent known, the one it is on now stands in; held and unknown stays a move
  const to = { id: 'codex', label: 'Codex' };
  assert.deepEqual([withAgent(to, 'claude')(controls).switching, withAgent(to, 'codex')(controls).switching], [true, false]);
  assert.equal(withAgent(to, undefined)(controls).switching, true);
  assert.equal(withAgent({ id: 'claude', label: 'Claude Code' }, undefined)(controls).switching, false);
  assert.equal(withAgent({ id: 'claude', label: 'Claude Code' }, undefined)({ ...controls, switching: true }).switching, true);
  assert.deepEqual(withAgent(to, 'claude')(controls).moved, { from: 'claude' });
  // two picks with the chat's own agent unknown: back to the agent it ran on is not a move
  const first = withAgent(to, undefined)(controls);
  assert.equal(withAgent({ id: 'claude', label: 'Claude Code' }, undefined)(first).switching, false);
});

test('the store: a refused pick is gone, a saved one waits for a read that began after it, a refused second pick leaves the first showing', () => {
  const apply = (c: any) => ({ ...c, options: { ...c.options, model: 'x' } });
  const t = optimistic.show('s', apply);
  optimistic.landed('s', 5);
  assert.equal(optimistic.get('s')?.settled, false, 'a read cannot settle a pick the Mac has not answered');
  optimistic.settle('s', t, true);
  optimistic.landed('s', 5);
  assert.ok(optimistic.get('s'), 'a read that began before the read-back was asked for is no answer');
  optimistic.after('s', 6);
  optimistic.landed('s', 5);
  assert.ok(optimistic.get('s'));
  optimistic.landed('s', 6);
  assert.equal(optimistic.get('s'), undefined);
  optimistic.settle('s', optimistic.show('s', apply), false);
  assert.equal(optimistic.get('s'), undefined);
  // a second pick on top of one that waits for its read-back shows both; refused, it leaves the first as it was
  const one = optimistic.show('s', (c: any) => ({ ...c, options: { ...c.options, model: 'a' } }));
  optimistic.settle('s', one, true);
  optimistic.after('s', 3);
  const two = optimistic.show('s', (c: any) => ({ ...c, options: { ...c.options, effort: 'b' } }));
  const both = optimistic.get('s').apply({ options: { model: 'old', effort: 'old' } });
  assert.deepEqual([both.options.model, both.options.effort], ['a', 'b']);
  optimistic.settle('s', two, false);
  const kept = optimistic.get('s');
  assert.deepEqual(
    [kept.settled, kept.from, kept.apply({ options: { model: 'old', effort: 'old' } }).options],
    [true, 3, { model: 'a', effort: 'old' }],
  );
  // an answer to a pick that was left behind settles nothing of a later one
  optimistic.drop('s');
  const old = optimistic.show('s', apply);
  optimistic.drop('s');
  const later = optimistic.show('s', apply);
  optimistic.settle('s', old, true);
  optimistic.settle('s', old, false);
  assert.equal(optimistic.get('s')?.settled, false);
  assert.equal(optimistic.get('s')?.token, later);
  optimistic.drop('s');
  assert.equal(optimistic.get('s'), undefined);
  // nothing to settle, land or drop on a chat with no pick
  optimistic.settle('none', 1, true);
  optimistic.after('none', 1);
  optimistic.landed('none', 1);
  optimistic.drop('none');
  assert.equal(optimistic.get('none'), undefined);
});
