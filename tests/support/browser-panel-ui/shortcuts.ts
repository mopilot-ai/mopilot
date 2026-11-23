// Browser shortcuts act on one visible page, preserve browser focus semantics and retire removed listeners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, fixture, setup, container, input, window as domWindow, rerender, root, clearRoot } from './fixture.ts';
const window = domWindow as unknown as Window & typeof globalThis;
export function registerBrowserShortcutCases() {
  test('optional native modifier metadata cannot replace a browser notice while its page id is unavailable', async () => {
    await setup();
    const deliveries: any[] = [];
    const listen = (e: Event) => deliveries.push((e as CustomEvent).detail);
    window.addEventListener('browser-shortcut-modifiers', listen);
    const deliver = (rootId: number, combo: string) =>
      act(async () => fixture.callbacks.get('shortcut')({ rootId, combo, modifiers: true }));
    try {
      fixture.guestError = true;
      await deliver(-1, '⌘');
      assert.doesNotMatch(container.textContent!, /not ready/);
      assert.deepEqual(deliveries, []);
      fixture.guestError = false;
      await deliver(10, '⌘');
      fixture.guestError = true;
      await deliver(10, '');
      assert.deepEqual(deliveries, [
        { combo: '⌘', paneId: 'tab' },
        { combo: '', paneId: 'tab' },
      ]);
      assert.doesNotMatch(container.textContent!, /not ready/);
    } finally {
      fixture.guestError = false;
      await act(async () => root.unmount());
      clearRoot();
      window.removeEventListener('browser-shortcut-modifiers', listen);
    }
  });
  test('native modifier hints keep their live page owner across subscription renewal and retire on hide or close', async () => {
    await setup();
    const deliveries: any[] = [];
    const listen = (e: Event) => deliveries.push((e as CustomEvent).detail);
    window.addEventListener('browser-shortcut-modifiers', listen);
    const deliver = (rootId: number, combo: string) =>
      act(async () => fixture.callbacks.get('shortcut')({ rootId, combo, modifiers: true }));
    try {
      await deliver(-1, '⌘');
      assert.deepEqual(deliveries, []);
      await deliver(10, '⌘');
      assert.deepEqual(deliveries, [{ combo: '⌘', paneId: 'tab' }]);
      await rerender({ cwd: '/another' });
      assert.equal(deliveries.length, 1, 'ordinary rendering does not release a held modifier');
      await deliver(-1, '');
      assert.equal(deliveries.length, 1, 'a retired root cannot release the current root');
      await deliver(10, '');
      assert.deepEqual(deliveries.at(-1), { combo: '', paneId: 'tab' });
      await deliver(10, '⌘');
      await rerender({ layer: 'hidden' });
      assert.deepEqual(deliveries.at(-1), { combo: '', paneId: 'tab' });
      const hiddenCount = deliveries.length;
      await deliver(10, '⌘');
      assert.equal(deliveries.length, hiddenCount);
      await rerender({ layer: 'front' });
      await deliver(10, '⌘');
      await act(async () => root.unmount());
      clearRoot();
      assert.deepEqual(deliveries.at(-1), { combo: '', paneId: 'tab' });
      assert.equal(fixture.callbacks.has('shortcut'), false);
    } finally {
      window.removeEventListener('browser-shortcut-modifiers', listen);
    }
  });
  test('browser toolbar and native page keys target the visible page and report an unavailable page', async () => {
    await setup();
    const workspace = async (id: string, paneId = 'tab') => {
      await act(async () => {
        window.dispatchEvent(new window.CustomEvent('workspace-shortcut', { detail: { id, paneId } }));
      });
    };
    await workspace('browser-address');
    assert.equal(document.activeElement, input());
    await workspace('browser-back');
    await workspace('browser-forward');
    await workspace('browser-reload');
    await workspace('browser-reload-cache');
    assert.ok(fixture.calls.some((c: any[]) => c[0] === 'reloadIgnoringCache'));
    fixture.back = false;
    fixture.forward = false;
    await workspace('browser-back');
    await workspace('browser-forward');
    await workspace('unknown');
    await workspace('browser-reload', 'other');
    await workspace('browser-copy-url');
    fixture.guestUrl = '';
    await workspace('browser-copy-url');
    await workspace('browser-annotate');
    assert.equal(container.querySelector('[aria-label="Annotate"]')?.getAttribute('aria-pressed'), 'true');
    await workspace('browser-annotate');
    // ⌘F on the page opens the find bar between the toolbar and the page; typing finds in the page, Esc closes it
    await workspace('browser-find');
    const findField = container.querySelector('.browser-find input') as HTMLInputElement;
    assert.equal(document.activeElement, findField);
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(findField), 'value')!.set!.call(findField, 'task');
      findField.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await workspace('browser-find-next');
    await workspace('browser-find-previous');
    assert.deepEqual(
      fixture.calls.filter((c: any[]) => c[0] === 'find'),
      [
        ['find', 'task', { forward: true, findNext: true }],
        ['find', 'task', { forward: true, findNext: false }],
        ['find', 'task', { forward: false, findNext: false }],
      ],
    );
    await act(async () => {
      findField.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.equal(container.querySelector('.browser-find'), null);
    assert.ok(fixture.calls.some((c: any[]) => c[0] === 'stopFind'));
    const deliveries: any[] = [];
    const listen = (e: Event) => deliveries.push((e as CustomEvent).detail);
    window.addEventListener('browser-shortcut', listen);
    await act(async () => {
      fixture.callbacks.get('shortcut')({ rootId: -1, combo: '⌘R' });
      fixture.callbacks.get('shortcut')({ rootId: 10, combo: '⌘R' });
    });
    assert.equal(deliveries.length, 1);
    fixture.guestError = true;
    await act(async () => {
      fixture.callbacks.get('shortcut')({ rootId: 10, combo: '⌘R' });
    });
    assert.match(container.textContent!, /not ready/);
    fixture.guestError = false;
    await rerender({ layer: 'hidden' });
    await workspace('browser-reload');
    await act(async () => {
      fixture.callbacks.get('shortcut')({ rootId: 10, combo: '⌘R' });
    });
    assert.equal(deliveries.length, 1);
    await rerender({ layer: 'front' });
    fixture.reloadError = true;
    await workspace('browser-reload-cache');
    await act(async () => root.unmount());
    clearRoot();
    await workspace('browser-reload');
    assert.equal(fixture.callbacks.has('shortcut'), false);
    window.removeEventListener('browser-shortcut', listen);
  });
}
