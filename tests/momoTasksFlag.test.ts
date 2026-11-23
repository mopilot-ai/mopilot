// The four-tab Tasks panel's flag, `momo.tasksPanel` (prefs.momo.tasksPanel, shared/momoPrefs.mjs): off unless saved on, a yes/no setting merged into the rest, a phone cannot change it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readMomoPrefs, setMomoPref, MOMO_DEFAULTS } from '../shared/momoPrefs.mjs';

const require = createRequire(import.meta.url);
const { PARSERS } = require('../shared/remote/schema.mjs');

test('the flag is off unless saved on, and only a yes or no is saved', () => {
  assert.equal(MOMO_DEFAULTS.tasksPanel, false);
  assert.equal(readMomoPrefs({}).tasksPanel, false);
  assert.equal(readMomoPrefs({ tasksPanel: true }).tasksPanel, true);
  assert.equal(readMomoPrefs({ tasksPanel: 'yes' }).tasksPanel, false);
  const on = setMomoPref({ paused: true }, 'tasksPanel', true) as any;
  assert.deepEqual([on.ok, on.momo], [true, { paused: true, tasksPanel: true }]);
  assert.equal((setMomoPref({}, 'tasksPanel', 'yes') as any).ok, false);
});

test('a paired phone cannot turn the panel on: the flag is not among the settings its method takes', () => {
  assert.throws(() => PARSERS['momo.prefs.set']({ tasksPanel: true }), /one of MoMo’s settings/);
});
