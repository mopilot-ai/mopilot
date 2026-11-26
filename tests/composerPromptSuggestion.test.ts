// The desktop composer uses a harness prediction as an editable draft only after Tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import './support/dom.ts';
import { all, mountComposer, reset, setSessionState } from './support/composer-setup.ts';

reset();

test('a harness prediction stays in the placeholder until Tab copies it into an editable draft', async (t) => {
  setSessionState('t1', { promptSuggestion: 'Add a regression test.' });
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.equal(m.editor().dataset.placeholder, 'Add a regression test.');
    assert.equal(m.text, '');
    assert.equal(await m.key('Tab', { shiftKey: true }), false);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await act(async () => setSessionState('t1', { runningElsewhere: true }));
    assert.equal(await m.key('Tab'), false, 'busy composers leave Tab to focus navigation');
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(m.editor().getAttribute('aria-disabled'), 'false');
    assert.equal(await m.key('Tab'), false, 'an editor accepting edits still hides the offer while the external turn runs');
    await act(async () => setSessionState('t1', { runningElsewhere: false }));
    t.mock.timers.reset();
    await act(async () => setSessionState('t1', { turn: 'running' }));
    assert.equal(await m.key('Tab'), false);
    await act(async () => setSessionState('t1', { turn: 'idle' }));
    assert.equal(await m.key('Tab'), true);
    assert.equal(m.text, 'Add a regression test.');
    assert.equal(all('send').length, 0);
    await m.type('Add two regression tests.');
    await act(async () => setSessionState('t1', { promptSuggestion: 'This update must leave the draft alone.' }));
    assert.equal(m.text, 'Add two regression tests.');
    assert.equal(m.editor().dataset.placeholder, '');
    assert.equal(await m.key('Tab'), false);
  } finally {
    await m.unmount();
  }
});
