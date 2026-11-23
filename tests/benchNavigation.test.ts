// Bench Settings recovery uses the visible label without its keyboard shortcut suffix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const { backButton, BACK_BUTTON, BACK_TO_APP } = await import('../bench/lib/navigation.mjs');
test('Settings exit works with shortcut text in both direct and serialized CDP calls', () => {
  let clicks = 0;
  const target = { innerText: 'Back to app\nEsc', click: () => clicks++ };
  const document = { querySelectorAll: () => [target] };
  assert.equal(backButton(document), target);
  assert.equal(vm.runInNewContext(BACK_BUTTON, { document }), target);
  vm.runInNewContext(BACK_TO_APP, { document });
  assert.equal(clicks, 1);
});
test('exact label remains supported; similar labels and missing text are not exits', () => {
  const target = { innerText: ' Back to app ', click() {} };
  const wrong = [{ innerText: 'Back to application', click() {} }, { click() {} }];
  assert.equal(backButton({ querySelectorAll: () => [...wrong, target] }), target);
  assert.equal(backButton({ querySelectorAll: () => wrong }), undefined);
  assert.equal(vm.runInNewContext(BACK_TO_APP, { document: { querySelectorAll: () => wrong } }), undefined);
});
