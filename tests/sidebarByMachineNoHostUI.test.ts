// A saved "By machine" needs Host: without it the sidebar is by project (its own file: whether Host exists is read once per window).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { native } from '../src/lib/native.ts';
import { fakeNative } from './support/ports/native.ts';
import { byText, flush, mountSidebar, reset } from './support/shell-sidebar-kit.ts';

test('a saved By machine falls back to By project without Host', async (t) => {
  const previous = native.host;
  native.host = fakeNative({ host: { access: async () => false, onAccess: () => () => undefined } }).host;
  t.after(() => {
    native.host = previous;
  });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    assert.equal(view.$$('.machine-group').length, 0);
    assert.equal(byText(view.host, '.side-label', 'Projects').textContent?.trim(), 'Projects');
  } finally {
    await view.unmount();
  }
});
