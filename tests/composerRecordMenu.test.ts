// The composer's + panel entry for Record a skill (src/components/composer/ComposerMenus.tsx): offered from the chat's computerHistory capability, which a recording is delivered through, never its harness; it opens the dialog.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click } from './support/composer-kit.ts';
import { fx, mountComposer, reset } from './support/composer-setup.ts';

const item = (title: string) => $$('.add-panel-item').find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;
beforeEach(() => reset());

test('+ panel: Record a skill follows the chat capability and opens its dialog', async () => {
  fx.chatCaps = { ...fx.chatCaps, computerHistory: { state: 'absent', via: 'none' } };
  const off = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Add files and more"]'));
    assert.equal(item('Record a skill').getAttribute('aria-disabled'), 'true');
    assert.equal(item('Record a skill').title, "This chat can't take a recording");
    await click(item('Record a skill'));
    assert.equal(document.body.textContent?.includes('Start recording'), false, 'a chat that cannot take it opens nothing');
  } finally {
    await off.unmount();
  }
  fx.chatCaps = { ...fx.chatCaps, computerHistory: { state: 'native', via: 'config' } };
  const m = await mountComposer({ threadId: 'c1' });
  try {
    await click($('[aria-label="Add files and more"]'));
    assert.equal(item('Record a skill').getAttribute('aria-disabled'), 'false');
    await click(item('Record a skill'));
    assert.match(document.body.textContent ?? '', /Start recording/);
    const cancel = $$('button').find((b) => b.textContent === 'Cancel')!;
    await click(cancel);
    assert.equal(document.body.textContent?.includes('Start recording'), false);
  } finally {
    await m.unmount();
  }
});
