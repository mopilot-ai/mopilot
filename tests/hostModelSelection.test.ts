// Machine model catalogs and choices stay scoped to the machine and harness, including absent and obsolete lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineModels, hostModelSelection } from '../shared/host/models.mjs';

test('only the machine models count; optional defaults, invalid rows and duplicate ids are handled', () => {
  assert.deepEqual(machineModels(null), []);
  assert.deepEqual(
    machineModels([
      null,
      {},
      { id: 3 },
      { id: 'm', name: 'Remote', efforts: ['low', null, 'high'], default: true, defaultEffort: 'high' },
      { id: 'm' },
    ]),
    [{ id: 'm', name: 'Remote', efforts: ['low', 'high'], default: true, defaultEffort: 'high' }],
  );
  assert.deepEqual(machineModels([{ id: 'x', efforts: 'bad', defaultEffort: 'absent' }]), [
    { id: 'x', name: 'x', efforts: [], default: false, defaultEffort: null },
  ]);
});

test("the agent's own line about a model rides along, cut short; an empty or missing one does not", () => {
  const [a, b, c] = machineModels([
    { id: 'a', description: 'Opus 5.5 · Best' },
    { id: 'b', description: '' },
    { id: 'c', description: 'x'.repeat(500) },
  ]);
  assert.equal(a.description, 'Opus 5.5 · Best');
  assert.equal('description' in b, false);
  assert.equal(c.description!.length, 400);
});

test('draft and chat picks keep their own machine/harness and never substitute a removed model', () => {
  const models = machineModels([{ id: 'm', default: true, efforts: ['low', 'high'], defaultEffort: 'low' }]);
  assert.deepEqual(hostModelSelection(models, null, 'box', 'claude'), { model: models[0], effort: 'low', unavailable: false });
  const pick = { hostId: 'box', harness: 'claude', model: 'm', effort: 'high' };
  assert.equal(hostModelSelection(models, pick, 'box', 'claude').effort, 'high');
  assert.equal(hostModelSelection(models, pick, 'other', 'claude').effort, 'low');
  assert.equal(hostModelSelection(models, pick, 'box', 'codex').effort, 'low');
  assert.equal(hostModelSelection(models, { ...pick, effort: 'gone' }, 'box', 'claude').unavailable, true);
  assert.deepEqual(hostModelSelection(models, { ...pick, model: 'gone' }, 'box', 'claude'), {
    model: null,
    effort: null,
    unavailable: true,
  });
  assert.deepEqual(hostModelSelection([], null, 'box', 'claude'), { model: null, effort: null, unavailable: false });
  assert.equal(hostModelSelection(machineModels([{ id: 'first' }]), null, 'box', 'custom').model?.id, 'first');
});
