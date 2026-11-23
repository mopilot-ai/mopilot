// Refs across a reload (#3571, f1-deal-review): electron/capabilities/browser/tab.cjs remembers what each minted ref
// named and hands it back with the next call that names it, so a page that replaced its document (a form post that
// redirects back) does not strand the model's refs. The page agent's side is in pageAgentShadow.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

const URL_A = 'http://crm.test/deals/1';

test('refs: a call naming a ref minted earlier carries what it named; other refs, places and calls carry nothing', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.ops.tree = () => ({ lines: [] });
  tab.wc.ops.formInput = () => ({ ok: true });
  tab.wc.mintedNext = {
    minted: [
      ['ref_5', 'textbox', 'Add note', 'textarea'],
      ['ref_6', 'button', 'Add note', 'button'],
    ],
    url: URL_A,
  };
  await drive(t, tab.agent('tree'));
  await drive(t, tab.agent('formInput', { ref: 'ref_5', value: 'x' }));
  await drive(t, tab.agent('formInput', { ref: 'ref_77', value: 'x' }));
  await drive(
    t,
    tab.agent('formInput', { ref: 'ref_5', value: 'x' }, 'F9').catch(() => null),
  );
  const calls = tab.wc.agentCalls.filter((c) => c.op === 'formInput');
  assert.deepEqual(calls[0].hints, { ref_5: ['textbox', 'Add note', 'textarea', URL_A] });
  assert.equal(calls[1].hints, undefined, 'a ref the tab never saw minted');
  assert.equal(calls.length, 2, 'a ref minted in the main frame is not offered to a frame that is gone');
  // a later call that mints the same ref again replaces what it named
  tab.wc.mintedNext = { minted: [['ref_5', 'textbox', 'Reply', 'textarea']], url: URL_A };
  await drive(t, tab.agent('tree'));
  await drive(t, tab.agent('formInput', { ref: 'ref_5', value: 'x' }));
  assert.deepEqual(tab.wc.agentCalls.filter((c) => c.op === 'formInput')[2].hints, { ref_5: ['textbox', 'Reply', 'textarea', URL_A] });
});

test('refs: a frame element in a shared process keeps its own place, and what a tab remembers is bounded', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.ops.tree = () => ({ lines: [] });
  const place = { sessionId: '', frameId: 'frame-1' };
  tab.world = 1;
  tab.wc.mintedNext = { minted: [['ref_8', 'button', 'Pay', 'button']], url: URL_A };
  await drive(t, tab.agentAt(place, 'tree'));
  await drive(t, tab.agentAt(place, 'tree', { ref: 'ref_8' }));
  await drive(t, tab.agent('tree', { ref: 'ref_8' }));
  const calls = tab.wc.agentCalls.filter((c) => c.op === 'tree');
  assert.deepEqual(calls[1].hints, { ref_8: ['button', 'Pay', 'button', URL_A] });
  assert.equal(calls[2].hints, undefined, 'the main frame did not mint it');
  tab.refHints.note({ minted: Array.from({ length: 20001 }, (_, i) => [`ref_${i + 100}`, 'button', 'B', 'button']), url: URL_A }, '');
  assert.equal(tab.refHints.meta.size, 20000);
  assert.equal(tab.refHints.meta.has('ref_8'), false, 'the oldest go first');
  tab.refHints.note({}, '');
  tab.refHints.note(undefined, '');
});
