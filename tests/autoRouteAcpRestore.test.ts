// Auto on an ACP agent (electron/autoRoute/acpRestore.cjs): each value Auto picks is written down against the chat's own
// before the turn, the next message hands what it leaves alone back to the adapter, and a turn the agent took clears it,
// unless a later turn wrote a newer record; each agent's record is its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAcpRestore } = require('../electron/autoRoute/acpRestore.cjs');

function world(o: any = {}) {
  const record: any = { meta: { config: { autoRoute: 'harness', ...o.config } } };
  let kind = o.kind ?? 'acp:kimi';
  const values: any = o.noSettings ? null : { model: 'pro', effort: 'high', ...o.values };
  const changed: string[] = [];
  const restore = createAcpRestore({
    chats: {
      records: new Map([['chat', record]]),
      patchMeta: (_id: string, p: any) => ((record.meta = { ...record.meta, ...p }), true),
    },
    controller: { ref: () => ({ kind }) },
    settings: { settingsOf: () => values },
    changed: (id: string) => changed.push(id),
  });
  return { restore, record, values, changed, saved: () => record.meta.config.autoRouteRestore, move: (k: string) => (kind = k) };
}

const flash = { model: 'flash', effort: 'low' };

test('Auto’s pick is written down against the chat’s own, and the next message hands it back', () => {
  const w = world();
  assert.equal(w.restore.prepare('chat', { pick: flash }), null);
  assert.deepEqual(w.saved(), {
    'acp:kimi': { generation: 1, model: { own: 'pro', applied: 'flash' }, effort: { own: 'high', applied: 'low' } },
  });
  assert.deepEqual(w.changed, ['chat']);
  w.restore.afterTurn('chat', true);
  // the agent now runs Auto's pick; the next message, without Auto, hands both values back
  Object.assign(w.values, flash);
  const back = w.restore.prepare('chat', {});
  assert.deepEqual(back, { model: { own: 'pro', applied: 'flash' }, effort: { own: 'high', applied: 'low' } });
  assert.equal(w.saved()['acp:kimi'].generation, 2);
  w.restore.afterTurn('chat', true);
  assert.equal(w.saved(), null);
});

test('a later Auto pick keeps the chat’s own from the unsettled record, not the agent’s current value', () => {
  const w = world({
    values: flash,
    config: { autoRouteRestore: { 'acp:kimi': { generation: 3, model: { own: 'pro', applied: 'flash' } } } },
  });
  assert.equal(w.restore.prepare('chat', { pick: { model: 'ultra', effort: null } }), null);
  assert.deepEqual(w.saved()['acp:kimi'], { generation: 4, model: { own: 'pro', applied: 'ultra' } });
  // a pick equal to the chat's own puts the agent back: nothing is left to remember
  w.restore.prepare('chat', { pick: { model: 'pro', effort: null } });
  assert.equal(w.saved(), null);
});

test('a value this turn leaves alone is handed back; one someone else sets for the turn stays written down', () => {
  const w = world({
    config: {
      autoRouteRestore: { 'acp:kimi': { generation: 1, model: { own: 'pro', applied: 'flash' }, effort: { own: 'high', applied: 'low' } } },
    },
  });
  // Auto picks only a model; a scheduled run sets nothing
  assert.deepEqual(w.restore.prepare('chat', { pick: { model: 'ultra', effort: null } }), { effort: { own: 'high', applied: 'low' } });
  w.restore.afterTurn('chat', true);
  assert.deepEqual(w.saved()['acp:kimi'], { generation: 2, model: { own: 'pro', applied: 'ultra' } });
  // a scheduled run that names a model: the model's record waits, nothing is handed back
  assert.equal(w.restore.prepare('chat', { explicit: { model: 'k2' } }), null);
  w.restore.afterTurn('chat', true);
  assert.deepEqual(w.saved()['acp:kimi'].model, { own: 'pro', applied: 'ultra' });
});

test('a start the agent never took keeps what it was handed; a record a later turn wrote is not cleared by an earlier one', () => {
  const w = world({ config: { autoRouteRestore: { 'acp:kimi': { generation: 1, model: { own: 'pro', applied: 'flash' } } } } });
  w.restore.prepare('chat', {});
  w.restore.afterTurn('chat', false);
  assert.deepEqual(w.saved()['acp:kimi'].model, { own: 'pro', applied: 'flash' });
  // a turn hands the model back, and before it ends the record is written anew (a retried start, say)
  w.restore.prepare('chat', {});
  w.record.meta.config.autoRouteRestore = { 'acp:kimi': { generation: 9, model: { own: 'pro', applied: 'opus' } } };
  w.restore.afterTurn('chat', true);
  assert.deepEqual(w.saved()['acp:kimi'], { generation: 9, model: { own: 'pro', applied: 'opus' } });
  // a turn with nothing handed changes nothing
  w.restore.afterTurn('chat', true);
  assert.equal(w.saved()['acp:kimi'].generation, 9);
});

test('each agent’s record waits for the chat to be on that agent; an agent that reports no values has no own to write down', () => {
  const w = world({
    kind: 'acp:gemini',
    config: { autoRouteRestore: { 'acp:kimi': { generation: 1, model: { own: 'pro', applied: 'flash' } } } },
  });
  assert.equal(w.restore.prepare('chat', {}), null);
  assert.deepEqual(Object.keys(w.saved()), ['acp:kimi']);
  w.restore.prepare('chat', { pick: flash });
  assert.deepEqual(Object.keys(w.saved()).sort(), ['acp:gemini', 'acp:kimi']);
  w.move('acp:kimi');
  assert.deepEqual(w.restore.prepare('chat', {}), { model: { own: 'pro', applied: 'flash' } });
  const bare = world({ noSettings: true });
  assert.equal(bare.restore.prepare('chat', { pick: flash }), null);
  assert.equal(bare.saved(), undefined);
  const ghost = world();
  assert.equal(ghost.restore.prepare('nobody', {}), null);
});
