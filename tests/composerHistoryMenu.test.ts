// The composer's + panel entry for Computer History (#1363, src/components/composer/ComposerMenus.tsx and Composer.tsx): offered from the chat's computerHistory capability, never its harness, and a share attaches to the message, replacing an earlier one. The share dialog itself has its own test (computerHistoryShareUI.test.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click } from './support/composer-kit.ts';
import { fx, mountComposer, reset } from './support/composer-setup.ts';

const item = (title: string) => $$('.add-panel-item').find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;
beforeEach(() => reset());

test('+ panel: Computer History follows the chat capability, and sharing again replaces the earlier memories', async () => {
  const block = '<sage-computer-history>\nx\n</sage-computer-history>';
  fx.chatCaps = { ...fx.chatCaps, computerHistory: { state: 'absent', via: 'none' } };
  const off = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Add files and more"]'));
    assert.equal(item('Computer History').getAttribute('aria-disabled'), 'true');
    assert.equal(item('Computer History').title, "This chat can't take shared memories");
    await click(item('Computer History'));
    assert.equal($('.stub-share'), null, 'a chat that cannot take them opens nothing');
  } finally {
    await off.unmount();
  }
  fx.chatCaps = { ...fx.chatCaps, computerHistory: { state: 'sage', via: 'polyfill' } };
  const m = await mountComposer({ threadId: null });
  try {
    for (const name of ['Computer History · Today · 2 memories', 'Computer History · Yesterday · 1 memory']) {
      fx.shareAttachment = { kind: 'computerHistory', path: 'computer-history:x', name, text: block };
      await click($('[aria-label="Add files and more"]'));
      assert.equal(item('Computer History').getAttribute('aria-disabled'), 'false');
      await click(item('Computer History'));
      await click($('.stub-share'));
    }
    assert.deepEqual(
      $$('.attachment-name').map((x) => x.textContent),
      ['Computer History · Yesterday · 1 memory'],
      'one share per message: the newer one replaces the earlier',
    );
  } finally {
    await m.unmount();
  }
});
