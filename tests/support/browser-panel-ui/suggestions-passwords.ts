// Browser-panel suggestions-passwords unit cases with a shared recording fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window, act, fixture, root, container, setup, change, submit, rerender, input } from './fixture';

export function registerSuggestionsPasswordsCases() {
  const key = (name: string, extra: any = {}) =>
    act(
      async () =>
        void input().dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }) as any),
    );
  const row = (kind: string, url: string) => ({ kind, url, title: url });

  test('suggestions: typing asks for them, a pick, Enter or a click loads the page, and the toolbar has the bookmark star and menu', async () => {
    await setup({ tab: { agentChat: undefined, url: 'https://example.com/path', title: 'Example' }, props: { threadId: null } });
    // the star bookmarks this page; the menu opens a bookmark in this tab
    assert.deepEqual([fixture.star.url, fixture.star.title], ['https://example.com/path', 'Example']);
    await act(async () => fixture.bookmarksMenu.onOpen('https://bm.test/'));
    assert.deepEqual(
      fixture.calls.findLast((c: any) => c[0] === 'loadURL'),
      ['loadURL', 'https://bm.test/'],
    );
    // suggestions are for what the user typed while the address bar has focus, not for the page's own address
    assert.deepEqual(fixture.suggestArgs.at(-1)[1], false);
    await act(async () => void input().dispatchEvent(new (window as any).FocusEvent('focusin', { bubbles: true })));
    assert.equal(fixture.suggestArgs.at(-1)[1], false);
    await change('.browser-addr input', 'bm');
    assert.deepEqual(fixture.suggestArgs.at(-1), ['bm', true]);
    // the list under the bar: a click picks a row and ends the suggestions
    fixture.suggest.items = [row('bookmark', 'https://bm.test/'), row('history', 'https://seen.test/a')];
    await rerender({});
    assert.equal(container.querySelectorAll('.browser-suggest [role=option]').length, 2);
    await act(
      async () =>
        void container
          .querySelectorAll('.browser-suggest [role=option]')[1]
          .dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any),
    );
    assert.deepEqual(
      fixture.calls.findLast((c: any) => c[0] === 'loadURL'),
      ['loadURL', 'https://seen.test/a'],
    );
    assert.equal(fixture.suggestArgs.at(-1)[1], false);
    // hovering a row highlights it
    await act(
      async () =>
        void container
          .querySelectorAll('.browser-suggest [role=option]')[0]
          .dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }) as any),
    );
    assert.ok(fixture.calls.some((c: any) => c[0] === 'hover' && c[1] === 0));
    // submitting and leaving the bar also end them
    await change('.browser-addr input', 'x.test');
    assert.equal(fixture.suggestArgs.at(-1)[1], true);
    await submit();
    assert.equal(fixture.suggestArgs.at(-1)[1], false);
    await change('.browser-addr input', 'y.test');
    await act(async () => void input().dispatchEvent(new (window as any).FocusEvent('focusout', { bubbles: true })));
    assert.equal(fixture.suggestArgs.at(-1)[1], false);
  });

  test('suggestions: arrows move the highlight, Enter picks it, Shift+Delete forgets a visited page, Escape closes the list', async () => {
    await setup({ tab: { agentChat: undefined }, props: { threadId: null } });
    fixture.suggest.items = [row('bookmark', 'https://bm.test/'), row('history', 'https://seen.test/a')];
    const moves = () => fixture.calls.filter((c: any) => c[0] === 'move' || c[0] === 'drop' || c[0] === 'removeHistory');
    await act(async () => void input().dispatchEvent(new (window as any).FocusEvent('focusin', { bubbles: true })));
    await change('.browser-addr input', 'x');
    await key('ArrowDown');
    await key('ArrowUp');
    assert.deepEqual(moves(), [
      ['move', 1],
      ['move', -1],
    ]);
    // with nothing highlighted Enter is the form's own submit, and other keys do nothing
    await key('Enter');
    await key('a');
    await key('Delete', { shiftKey: true });
    assert.deepEqual(moves().length, 2);
    assert.equal(
      fixture.calls.some((c: any) => c[0] === 'loadURL'),
      false,
    );
    // a highlighted bookmark: Enter loads it, Shift+Delete leaves it alone, Delete without Shift does too
    fixture.suggest.index = 0;
    await key('Delete', { shiftKey: true });
    await key('Delete');
    assert.equal(moves().length, 2);
    await key('Enter');
    assert.deepEqual(
      fixture.calls.findLast((c: any) => c[0] === 'loadURL'),
      ['loadURL', 'https://bm.test/'],
    );
    // a highlighted visited page: Shift+Delete forgets it; a failing request is only noted
    await change('.browser-addr input', 'y');
    fixture.suggest.index = 1;
    await key('Delete', { shiftKey: true });
    assert.deepEqual(moves().slice(2), [
      ['removeHistory', 'https://seen.test/a'],
      ['drop', 'https://seen.test/a'],
    ]);
    fixture.nativeHandlers.removeHistory = async () => {
      throw new Error('main is busy');
    };
    await key('Delete', { shiftKey: true });
    // Escape closes the list even with no rows
    await key('Escape');
    assert.equal(fixture.suggestArgs.at(-1)[1], false);
    fixture.suggest.items = [];
    await change('.browser-addr input', 'z');
    await key('ArrowDown');
    await key('Escape');
    assert.equal(fixture.calls.filter((c: any) => c[0] === 'move').length, 2);
  });

  test('an agent tab has no first-run import card, and a user tab has', async () => {
    await setup({ tab: { agentChat: 'agent-chat' } });
    assert.equal(container.querySelector('.import-card-stub'), null);
    await act(async () => root.unmount());
    container.remove();
    await setup({ tab: { agentChat: undefined }, props: { threadId: null } });
    assert.ok(container.querySelector('.import-card-stub'));
  });

  test('the key button and the save-password bar get the page address, the page id (none while unattached) and the Chrome handoff only with a chat', async () => {
    await setup({ tab: { agentChat: undefined, url: 'https://task.test/login' }, props: { threadId: null } });
    assert.equal(fixture.loginKey.url, 'https://task.test/login');
    assert.equal(fixture.loginKey.pageId(), 10);
    assert.equal(fixture.loginKey.onChrome, undefined);
    assert.equal(fixture.loginOffer.pageId, fixture.loginKey.pageId, 'the save-password bar asks for the same page');
    assert.ok(container.querySelector('.login-offer-stub'));
    await act(async () => root.unmount());
    container.remove();
    await setup({ tab: { agentChat: undefined }, guestError: true });
    assert.equal(fixture.loginKey.pageId(), null, 'a guest that is not attached has no id');
    assert.equal(typeof fixture.loginKey.onChrome, 'function');
  });

  test('a blank tab has no page id for the key button', async () => {
    await setup({ tab: { agentChat: undefined, url: '' }, props: { threadId: null } });
    assert.equal(fixture.loginKey.pageId(), null);
  });
}
