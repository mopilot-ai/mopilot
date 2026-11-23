// The phone's Remote Run flags ship on (host.phoneDirect, host.phoneChat): a phone enrolls with a Host itself and reaches a machine's chat with the Mac asleep, without anyone switching a flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAG_DEFS } from '../shared/flagDefs.mjs';

for (const key of ['host.phoneDirect', 'host.phoneChat']) {
  test(`${key} ships on and stays a toggle the owner can switch off`, () => {
    const def = FLAG_DEFS.find((d: { key: string }) => d.key === key);
    assert.equal(def?.default, true);
    assert.equal(def?.mode, 'toggle');
  });
}
