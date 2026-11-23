// IPC for routines (#3571, G4; electron/app/ipc/routines.cjs): the list as Settings shows it (steps as lines, parameters
// by name, never their values), keeping a chat's last turn (its offer taken back), a rename at the revision shown, a
// delete, and why not: routines not up yet, nothing to save, a revision that changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { routineKit, recordSearchTurn, SEARCH, GO, ADD } from './support/routine-kit.ts';

const { register } = createRequire(import.meta.url)('../electron/app/ipc/routines.cjs');

function ipc(live: any) {
  const handlers = new Map<string, (...a: any[]) => any>();
  register({ handle: (ch: string, fn: any) => handlers.set(ch, fn) }, { live });
  return (ch: string, ...args: any[]) => handlers.get(ch)!({}, ...args);
}

test('not up yet: every call says so', () => {
  const call = ipc({});
  for (const ch of ['routines:list', 'routines:saveLast', 'routines:edit', 'routines:remove'])
    assert.deepEqual(call(ch), { ok: false, error: "Routines aren't ready yet" });
});

test('save the last turn, list it without its values, rename it at its revision, delete it', async () => {
  const k = routineKit({ controls: [SEARCH, GO, ADD] });
  const patches: any[] = [];
  const live = {
    routines: { store: k.store, recorder: k.recorder, skillsProblem: () => null },
    sessions: { patch: (...a: any[]) => patches.push(a) },
  };
  const call = ipc(live);
  assert.deepEqual(call('routines:saveLast', 'chat1', 'Buy'), {
    ok: false,
    error: "Nothing to save: this chat's last turn had no browser or app steps that finished, or it was stopped or failed.",
  });
  await recordSearchTurn(k);
  const saved = call('routines:saveLast', 'chat1', 'Buy');
  assert.equal(saved.ok, true);
  assert.deepEqual(patches, [['chat1', { routineOffer: null }]]);
  const { routines, skillsProblem } = call('routines:list');
  assert.equal(skillsProblem, null);
  assert.equal(routines.length, 1);
  const [r] = routines;
  assert.deepEqual(
    { ...r, id: 'x', updatedAt: 0 },
    {
      id: 'x',
      rev: 1,
      kind: 'browser',
      name: 'Buy',
      description: '',
      steps: ['navigate https://shop.test/', 'left_click "Search"', 'type "{{search}}"', 'left_click "Go"', 'left_click "Add to cart"'],
      params: ['search'],
      runs: 0,
      updatedAt: 0,
    },
  );
  assert.ok(!JSON.stringify(routines).includes('blue mug'), 'a recorded value never reaches the window');
  const renamed = call('routines:edit', r.id, 1, { name: 'Mug run', description: 'Buys a mug.' });
  assert.equal(renamed.routine.name, 'Mug run');
  assert.equal(renamed.routine.rev, 2);
  assert.deepEqual(call('routines:edit', r.id, 1, { name: 'Again' }), {
    ok: false,
    error: 'This routine changed meanwhile. Open it again.',
  });
  assert.equal(call('routines:edit', r.id, 2, null).ok, true, 'an empty edit changes nothing');
  assert.deepEqual(call('routines:remove', r.id), { ok: true, removed: true });
  assert.deepEqual(call('routines:remove', r.id), { ok: true, removed: false });
});

test("a harness's own browser or computer control: nothing to save, said by name", () => {
  const k = routineKit();
  const call = ipc({ routines: { store: k.store, recorder: k.recorder, unrecorded: () => 'the Codex Browser plugin' } });
  assert.deepEqual(call('routines:saveLast', 'chat1', 'X'), {
    ok: false,
    error: "Nothing to save: this chat's steps ran through the Codex Browser plugin, which MoPilot can't record.",
  });
});
