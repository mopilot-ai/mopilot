// shared/acpMode.mjs: a basic harness's mode from session modes or a mode config option, and select values with groups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acpCurrentMode, acpModeControl, selectValues } from '../shared/acpMode.mjs';

test('selectValues: groups flattened; no options, or entries that are not objects, give none', () => {
  assert.deepEqual(
    selectValues({ options: [{ value: 1, name: 'a' }, { group: 'g', name: 'G', options: [{ value: 2, name: 'b' }] }, null] }),
    [
      { value: 1, name: 'a' },
      { value: 2, name: 'b' },
    ],
  );
  assert.deepEqual(selectValues(null), []);
  assert.deepEqual(selectValues({ options: 'x' }), []);
});

test('acpModeControl: session modes first, with names and descriptions defaulted', () => {
  const c = acpModeControl({ modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask', description: 'd' }, { id: 7 }] } });
  assert.deepEqual(c, {
    via: 'mode',
    configId: null,
    current: 'ask',
    options: [
      { id: 'ask', name: 'Ask', description: 'd' },
      { id: '7', name: '7', description: null },
    ],
  });
  assert.equal(acpModeControl({ modes: { currentModeId: 3, availableModes: [{ id: 'a', name: 'A' }] } })!.current, null);
});

test('acpModeControl: else a select config option of category "mode", its string values only', () => {
  const opt = {
    id: 'mode',
    category: 'mode',
    type: 'select',
    currentValue: 'plan',
    options: [{ value: 'build', name: 'build', description: 'B' }, { value: 'plan' }, { value: 3 }],
  };
  assert.deepEqual(acpModeControl({ modes: { currentModeId: 'x', availableModes: [] }, configOptions: [opt] }), {
    via: 'config',
    configId: 'mode',
    current: 'plan',
    options: [
      { id: 'build', name: 'build', description: 'B' },
      { id: 'plan', name: 'plan', description: null },
    ],
  });
  assert.equal(acpModeControl({ configOptions: [{ ...opt, currentValue: true }] })!.current, null);
  // not a select, no string values, no mode option, nothing declared
  assert.equal(acpModeControl({ configOptions: [{ ...opt, type: 'boolean' }] }), null);
  assert.equal(acpModeControl({ configOptions: [{ ...opt, options: [{ value: 1 }] }] }), null);
  assert.equal(acpModeControl({ configOptions: [{ id: 'model', category: 'model', type: 'select', options: [{ value: 'a' }] }] }), null);
  assert.equal(acpModeControl({ configOptions: 'x' }), null);
  assert.equal(acpModeControl(null), null);
});

test('acpCurrentMode: the modes current id, else the mode option, else none', () => {
  assert.equal(acpCurrentMode({ modes: { currentModeId: 'm' } }), 'm');
  assert.equal(
    acpCurrentMode({
      configOptions: [{ id: 'mode', category: 'mode', type: 'select', currentValue: 'plan', options: [{ value: 'plan' }] }],
    }),
    'plan',
  );
  assert.equal(acpCurrentMode({}), null);
  assert.equal(acpCurrentMode(undefined), null);
});
