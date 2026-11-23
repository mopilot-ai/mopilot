// The tab strip's menu reaches a BrowserPanel's own page through the live-page registry (src/session/browserTabPage.ts),
// in front or behind, and a muted tab's new page is muted too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, fixture, setup, emit, rerender, tabState } from './fixture.ts';

const { browserTabPage } = await import('../../../src/session/browserTabPage.ts');

export function registerTabMenuCases() {
  test("the tab menu reloads and mutes this panel's page even behind another tab, and main's answer marks the tab", async () => {
    await setup({ handlers: { setAudioMuted: async (_id: number, muted: boolean) => muted } });
    await emit('dom-ready');
    await rerender({ layer: 'back' });
    const page = browserTabPage('tab')!;
    await act(async () => page.reload());
    assert.ok(fixture.calls.some((c: any[]) => c[0] === 'reload'));
    await act(async () => page.setMuted(true));
    assert.deepEqual(
      fixture.calls.filter((c: any[]) => c[0] === 'setAudioMuted'),
      [['setAudioMuted', 10, true]],
    );
    assert.equal(tabState().muted, true);
  });

  test("a muted tab's page is muted again when it binds; navigations of the same page do not ask again", async () => {
    await setup({ tab: { muted: true }, handlers: { setAudioMuted: async () => true } });
    await emit('dom-ready');
    await emit('dom-ready');
    await act(async () => {});
    assert.deepEqual(
      fixture.calls.filter((c: any[]) => c[0] === 'setAudioMuted'),
      [['setAudioMuted', 10, true]],
    );
    assert.equal(tabState().muted, true);
  });
}
