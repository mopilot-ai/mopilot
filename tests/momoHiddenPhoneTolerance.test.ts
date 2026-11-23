// A phone build already in testers' hands (phone-build-13: macSettings.ts and momo/contract.ts are identical on main) reads what a Mac now omits for an account MoMo is not allowed for: no hello momo or momoBrainSet, no momoQuietHours, no momo kind.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import '../tests/support/phone/register.ts';

const macPath = '../mobile/src/push/macSettings.ts';
const contractPath = '../mobile/src/momo/contract';
const { parseSettings, loadMacSettings } = await import(macPath);
const { momoAllowed, momoBrainSet } = await import(contractPath);
const require = createRequire(import.meta.url);
const { createPushSettingsOps } = require('../electron/remote/pushSettingsOps.cjs');

const uninvited = () =>
  createPushSettingsOps({
    prefs: () => ({ notifyKinds: { momo: false } }),
    patchPrefs: () => true,
    titles: () => null,
    momoOn: () => false,
  });

test('a hello without the MoMo fields leaves the phone with no MoMo tab and no brain setting', () => {
  const hello = { capabilities: { pushSettings: true, methods: [], permissionCeiling: 'auto-review' } };
  assert.equal(momoAllowed(hello), false);
  assert.equal(momoBrainSet(hello), false);
});

test('push settings without momoQuietHours and the momo kind still parse, with every other setting intact', async () => {
  const answer = uninvited().get();
  assert.ok(!('momoQuietHours' in answer) && !('momo' in answer.kinds));
  const parsed = parseSettings(answer);
  assert.equal(parsed.mode, 'unfocused');
  assert.equal(parsed.titlesInPush, false);
  assert.equal(parsed.kinds.turn, false);
  const request = async (method: string) => (method === 'machine.hello' ? { capabilities: { pushSettings: true } } : answer);
  assert.equal((await loadMacSettings(request as any)).mode, 'unfocused');
});
