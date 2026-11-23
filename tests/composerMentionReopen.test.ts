// The composer's @ list after a file is picked (useComposerPopup in src/components/composer/ComposerPopups.tsx, src/lib/composerSkills.ts): the
// caret moving after the inserted mention leaves the list closed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$ } from './support/composer-kit.ts';
import { fx, mountComposer, reset, settle } from './support/composer-setup.ts';
import { act } from 'react';

beforeEach(() => reset());
const W = window as any;

test('a picked file mention does not reopen the list when the caret moves after it; a new @ still opens it', async () => {
  // main-e2e on b135dda: after Enter picked a file, the caret move reopened the list on the inserted path, and its
  // popover layer made View → Search Files a no-op (shortcuts and menu commands wait while a popover is open)
  fx.files = [{ path: '/home/a.ts', file_name: 'a.ts', indices: null }];
  const m = await mountComposer({ threadId: null });
  const caretMoved = () =>
    act(async () => {
      const el = m.editor();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new W.Event('selectionchange'));
      el.dispatchEvent(new W.Event('select', { bubbles: true }));
    });
  try {
    await m.type('see @a');
    await settle(130);
    await m.key('Enter');
    await settle(5);
    assert.equal(m.text, 'see @/home/a.ts ');
    await caretMoved();
    await settle(130);
    assert.ok(!$('.composer-popup'), 'the picked mention reopened the list');
    // typing a new @ after it opens the list again
    await m.type('see @/home/a.ts and @a');
    await settle(130);
    assert.deepEqual(
      $$('.composer-popup .mention-name').map((x) => x.textContent),
      ['a.ts'],
    );
  } finally {
    await m.unmount();
  }
});
