// The page shell's flag, `momo.shell` (prefs.momo.shell, shared/momoPrefs.mjs): off unless saved on, a yes/no setting merged into the rest, a phone cannot change it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readMomoPrefs, setMomoPref, MOMO_DEFAULTS } from '../shared/momoPrefs.mjs';

const require = createRequire(import.meta.url);
const { PARSERS } = require('../shared/remote/schema.mjs');

test('the flag is off unless saved on, and only a yes or no is saved', () => {
  assert.equal(MOMO_DEFAULTS.shell, false);
  assert.equal(readMomoPrefs({}).shell, false);
  assert.equal(readMomoPrefs({ shell: true }).shell, true);
  assert.equal(readMomoPrefs({ shell: 'yes' }).shell, false);
  const on = setMomoPref({ paused: true }, 'shell', true) as any;
  assert.deepEqual([on.ok, on.momo], [true, { paused: true, shell: true }]);
  assert.equal((setMomoPref({}, 'shell', 'yes') as any).ok, false);
});

test('a paired phone cannot turn the shell on: the flag is not among the settings its method takes', () => {
  assert.throws(() => PARSERS['momo.prefs.set']({ shell: true }), /one of MoMo’s settings/);
});
