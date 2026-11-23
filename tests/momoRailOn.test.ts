// src/lib/momoRoute.ts momoRailOn (#4926): MoMo's rail is the page's one navigation column only on MoMo's page, with the shell on and setup done; App draws neither the sidebar nor MoMo's nav then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { momoRailOn } from '../src/lib/momoRoute.ts';

const momo = (shell: boolean, done: boolean) => ({ shell, onboarding: { done } });

test('the rail is the one column on MoMo’s page with the shell on and setup done, and nowhere else', () => {
  assert.equal(momoRailOn({ name: 'momo' }, momo(true, true)), true);
  assert.equal(momoRailOn({ name: 'momo' }, momo(true, false)), false, 'setup is the page alone, with its nav column');
  assert.equal(momoRailOn({ name: 'momo' }, momo(false, true)), false, 'shell off: today’s page');
  assert.equal(momoRailOn({ name: 'home' }, momo(true, true)), false);
});
