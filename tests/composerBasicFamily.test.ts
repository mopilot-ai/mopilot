// A basic harness's chat in the composer (src/components/composer/Composer.tsx, useSlashItems): it reads its own harness's
// capabilities, and never Codex's plugins, Fast billing account or Full access banner.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, click } from './support/composer-kit.ts';
import { fx, mountComposer, reset, settle, store } from './support/composer-setup.ts';

beforeEach(() => reset());
const shown = (selector: string) => $(selector) !== null;

test("a basic chat, or a new chat on a basic harness, asks for that harness's caps and lists no Codex plugins", async () => {
  store.set({ basicOf: { t1: 'kimi' }, newBasic: 'kimi' });
  let listed = 0;
  fx.plugins = async () => (listed++, { marketplaces: [] });
  for (const threadId of ['t1', null]) {
    fx.capHints.length = 0;
    fx.fastNoteFor.length = 0;
    const m = await mountComposer({ threadId });
    try {
      assert.deepEqual(
        [...new Set(fx.capHints)].filter((k) => k !== undefined),
        ['acp:kimi'],
      );
      // the / menu is the harness's own commands: no Codex account is read for a Fast note it never shows
      assert.deepEqual(fx.fastNoteFor, []);
      await click($('[aria-label="Add files and more"]'));
      await settle();
      assert.equal(listed, 0);
    } finally {
      await m.unmount();
    }
  }
});

test('a first-tier chat still hints its own harness and reads its Fast note', async () => {
  store.set({ harnessOf: { c1: 'claude' } });
  const m = await mountComposer({ threadId: 'c1' });
  try {
    assert.deepEqual(
      [...new Set(fx.capHints)].filter((k) => k !== undefined),
      ['claude'],
    );
    assert.deepEqual([...new Set(fx.fastNoteFor)], ['claude']);
  } finally {
    await m.unmount();
  }
});

test('Full access is a first-tier permission: a basic chat shows no banner naming Codex', async () => {
  store.set((s: any) => ({ basicOf: { t1: 'kimi' }, prefs: { ...s.prefs, permission: 'full-access' } }));
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.equal(shown('.fa-banner'), false);
  } finally {
    await m.unmount();
  }
  const m2 = await mountComposer({ threadId: 't2' });
  try {
    assert.equal(shown('.fa-banner'), true);
  } finally {
    await m2.unmount();
  }
});

test("a basic chat whose harness id hasn't resolved hints no kind, never 'acp:null', then its own once it resolves (#2862)", async () => {
  // the chat is on the basic tier, but its basic harness id hasn't loaded yet
  store.set({ harnessOf: { t3: 'acp' } });
  fx.capHints.length = 0;
  const m = await mountComposer({ threadId: 't3' });
  try {
    assert.ok(fx.capHints.length > 0);
    assert.deepEqual([...new Set(fx.capHints)], [undefined]);
    fx.capHints.length = 0;
    store.set({ basicOf: { t3: 'kimi' } });
    await settle();
    assert.deepEqual(
      [...new Set(fx.capHints)].filter((k) => k !== undefined),
      ['acp:kimi'],
    );
  } finally {
    await m.unmount();
  }
});
