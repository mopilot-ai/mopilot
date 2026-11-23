// External attachment actions retain their originating browser edits when machine admission refuses them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { f, mount, marks, click, page, attachToComposer } from './support/browser-annotate-fixture.ts';
test('external attachment actions refuse machine chats and machine drafts before dispatch or persistence', () => {
  const state = f.state;
  f.state = { drafts: {} };
  let events = 0;
  const count = () => events++;
  window.addEventListener('composer-add-selection', count);
  try {
    f.remote = true;
    attachToComposer('machine-chat', { kind: 'file', name: 'local', path: '/local' });
    assert.equal(events, 0);
    assert.deepEqual(f.state.drafts, {});
    assert.match(f.toasts.at(-1)[0], /Only images.*from here.*machine/);
    f.remote = false;
    f.draftMachine = { id: 'box' };
    attachToComposer(null, { kind: 'skill', name: 'local', path: '/local/SKILL.md' });
    assert.equal(events, 0);
    assert.deepEqual(f.state.drafts, {});
  } finally {
    f.state = state;
    f.remote = false;
    f.draftMachine = null;
    window.removeEventListener('composer-add-selection', count);
  }
});

test('a browser screenshot remains usable on a machine through the existing image attachment channel', async () => {
  await mount({ guest: { collect: page(1) } });
  f.remote = true;
  try {
    await marks(1);
    await click('Add to chat');
    assert.equal(f.state.drafts['chat-1'].attachments[0].kind, 'image');
    assert.equal(f.exits, 1);
    assert.equal(
      f.toasts.some((t: unknown[]) => String(t[0]).startsWith('Added ')),
      true,
    );
  } finally {
    f.remote = false;
  }
});
