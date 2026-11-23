// The Sessions pane's three settings (prefs.momo.sessions, sessionsShow, sessionsAct; shared/momoPrefs.mjs, M6): the pane is off and MoMo's reading is off unless saved on, the list is shown unless saved off, each is a yes/no merged into the rest, and a paired phone cannot change any of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readMomoPrefs, setMomoPref, MOMO_DEFAULTS } from '../shared/momoPrefs.mjs';

const require = createRequire(import.meta.url);
const { PARSERS } = require('../shared/remote/schema.mjs');

const DEFAULT = { sessions: false, sessionsShow: true, sessionsAct: false } as const;

for (const key of ['sessions', 'sessionsShow', 'sessionsAct'] as const) {
  test(`${key}: its default, junk reads as the default, only a yes or no is saved`, () => {
    assert.equal(MOMO_DEFAULTS[key], DEFAULT[key]);
    assert.equal(readMomoPrefs({})[key], DEFAULT[key]);
    assert.equal(readMomoPrefs({ [key]: 'yes' })[key], DEFAULT[key]);
    assert.equal(readMomoPrefs({ [key]: !DEFAULT[key] })[key], !DEFAULT[key]);
    const set = setMomoPref({ paused: true }, key, !DEFAULT[key]) as any;
    assert.deepEqual([set.ok, set.momo], [true, { paused: true, [key]: !DEFAULT[key] }]);
    assert.equal((setMomoPref({}, key, 'yes') as any).ok, false);
  });

  test(`${key}: a paired phone cannot change it`, () => {
    assert.throws(() => PARSERS['momo.prefs.set']({ [key]: true }), /one of MoMo’s settings/);
  });
}
