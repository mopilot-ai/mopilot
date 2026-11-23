// The composer's "/" menu leaves Fast out where the chat's account or harness can't have it (useSlashItems in
// src/components/composer/ComposerSlash.tsx, fastHidden from src/session/harness/select.ts), the harness's own /fast included.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $$ } from './support/composer-kit.ts';
import { fx, mountComposer, reset, store } from './support/composer-setup.ts';

beforeEach(() => reset());
const titles = () => $$('.slash-panel .add-panel-title').map((x) => x.textContent);
const BLOCKED = 'Fast mode is billed to extra usage, which is turned off for this account';

test("Fast an account can't have has no / entry, and the harness's own /fast stays out too", async () => {
  fx.provider = { label: 'Claude Code' };
  fx.registry = () => ({ menu: [{ name: 'fast', dispatch: 'passthrough', source: 'harness' }], hidden: [] });
  store.set({ harnessOf: { t1: 'claude' } });
  fx.sel = { ...fx.sel, fastUnavailable: BLOCKED, fastHidden: true };
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/f');
    assert.ok(titles().includes('Feedback'));
    assert.deepEqual(
      titles().filter((t) => /fast|speed/i.test(t ?? '')),
      [],
    );
    // a reason the user can act on keeps the entry, which says why when picked
    fx.sel = { ...fx.sel, fastHidden: false };
    await m.type('/fa');
    assert.ok(titles().includes('Fast'));
  } finally {
    await m.unmount();
  }
});
