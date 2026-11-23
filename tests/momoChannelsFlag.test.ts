// The channels' flag, `momo.channels` (prefs.momo.channels, shared/momoPrefs.mjs): off unless saved on, a yes/no setting merged into the rest, and a paired phone cannot change it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readMomoPrefs, setMomoPref, MOMO_DEFAULTS } from '../shared/momoPrefs.mjs';

const require = createRequire(import.meta.url);
const { PARSERS } = require('../shared/remote/schema.mjs');

test('the flag is off unless saved on, and only a yes or no is saved', () => {
  assert.equal(MOMO_DEFAULTS.channels, false);
  assert.equal(readMomoPrefs({}).channels, false);
  assert.equal(readMomoPrefs({ channels: true }).channels, true);
  assert.equal(readMomoPrefs({ channels: 'yes' }).channels, false);
  const on = setMomoPref({ paused: true }, 'channels', true) as any;
  assert.deepEqual([on.ok, on.momo], [true, { paused: true, channels: true }]);
  assert.equal((setMomoPref({}, 'channels', 'yes') as any).ok, false);
});

test('a paired phone cannot turn channels on: the flag is not among the settings its method takes', () => {
  assert.throws(() => PARSERS['momo.prefs.set']({ channels: true }), /one of MoMo’s settings/);
});
