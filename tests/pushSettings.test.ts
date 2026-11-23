// shared/remote/pushSettings.mjs: the names and defaults the phone's Settings reads match what the Mac actually uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PUSH_SETTINGS, PUSH_TITLE_EVENT, PUSH_TITLE_AAD_PREFIX, PUSH_TITLE_MAX_UNITS } from '../shared/remote/pushSettings.mjs';
import { MOMO_DEFAULTS } from '../shared/momoPrefs.mjs';

const require = createRequire(import.meta.url);
const notify = require('../electron/platform/notify.cjs');
const titles = require('../electron/remote/pushTitles.cjs');

test("the notification modes and kinds are the Mac notifier's own", () => {
  assert.deepEqual([...PUSH_SETTINGS.mode.values], notify.MODES);
  assert.equal(PUSH_SETTINGS.mode.default, notify.MODES[0]);
  assert.deepEqual([...PUSH_SETTINGS.kinds.values], [...notify.KINDS, 'momo']);
});

test('MoMo quiet hours default to what the Mac uses, and chat titles in push default to off', () => {
  assert.deepEqual({ ...PUSH_SETTINGS.momoQuietHours.default }, { ...MOMO_DEFAULTS.routines.quietHours });
  assert.equal(PUSH_SETTINGS.titlesInPush.default, false);
});

test("the Mac's title key event and aad are the shared ones", () => {
  assert.equal(titles.TITLE_EVENT, PUSH_TITLE_EVENT);
  assert.equal(titles.AAD_PREFIX, PUSH_TITLE_AAD_PREFIX);
  assert.equal(PUSH_TITLE_MAX_UNITS, 120);
});
