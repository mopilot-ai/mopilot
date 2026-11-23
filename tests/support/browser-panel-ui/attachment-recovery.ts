// Browser-panel attachment-recovery unit cases with a shared recording fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  fixture,
  root,
  container,
  event,
  setup,
  emit,
  notice,
  button,
  click,
  change,
  submit,
  rerender,
  clearRoot,
  noticeClick,
} from './fixture';

export function registerAttachmentRecoveryCases() {
  test('late guest attachment and channel notifications recover without remounting the page', async () => {
    await setup({
      guestError: true,
      handlers: {
        chromeState: async () => {
          throw new Error('not ready');
        },
        attach: async () => {
          throw new Error('old chat');
        },
        pageState: async () => {
          throw new Error('old guest');
        },
      },
    });
    // an attach event whose guest still can't be read waits for the next one
    await emit('did-attach');
    fixture.guestError = false;
    await emit('did-start-loading');
    await emit('did-attach');
    await act(async () => fixture.callbacks.get('channel')({ active: 'chrome' }));
    // the late channel reached the pane: its Chrome button now says agents work there (an agent tab names no "Agents use" note, #1834)
    assert.match(container.querySelector<HTMLButtonElement>('.browser-chrome-btn')!.title, /where agents already work/);
    await act(async () => fixture.update({ paneTabs: [{ ...fixture.state.paneTabs[0], agentChat: 'new-chat' }] }));
    assert.ok(fixture.calls.some((c: any) => c[0] === 'attach' && c[1] === 'new-chat'));
  });

  test("a page's listeners are set up once per page: renders, layers and the page's own updates leave them; another agent tab key attaches again", async () => {
    await setup({ tab: { agentTab: 'key-1' } });
    const guest = fixture.guest;
    await emit('did-attach');
    const pageReads = () => fixture.calls.filter((c: any) => c[0] === 'pageState').length;
    const attaches = () => fixture.calls.filter((c: any) => c[0] === 'attach').map((c: any) => c.slice(1));
    const before = pageReads();
    assert.deepEqual(attaches().at(-1), ['agent-chat', 10, 'key-1']);
    // the page's own title and address, a new layer and another thread are not a new page
    fixture.title = 'Renamed';
    await emit('page-title-updated');
    await rerender({ layer: 'back', threadId: 'other-thread' });
    assert.equal(pageReads(), before);
    assert.equal(fixture.guest, guest);
    // the agent's tab changes: the same page attaches to it, and its listeners still answer
    const attached = attaches().length;
    await act(async () => fixture.update({ paneTabs: [{ ...fixture.state.paneTabs[0], agentTab: 'key-2' }] }));
    assert.deepEqual(attaches().slice(attached), [['agent-chat', 10, 'key-2']]);
    assert.equal(fixture.guest, guest);
    await emit('did-attach');
    assert.deepEqual(attaches().at(-1), ['agent-chat', 10, 'key-2']);
    fixture.title = 'After';
    await emit('page-title-updated');
    assert.equal(fixture.state.paneTabs[0].title, 'After');
  });

  test('blank tab tools retain main routing and convert side chats in place', async () => {
    await setup({ tab: { url: '', agentChat: undefined }, props: { threadId: null } });
    assert.equal(document.activeElement, container.querySelector('input'));
    assert.equal(button('Side chat').disabled, true);
    await click('Changes');
    await click('Terminal');
    await click('Files');
    assert.ok(fixture.calls.some((c: any) => c[0] === 'changes'));
    await rerender({ threadId: 'main-thread' });
    await click('Side chat');
    assert.deepEqual(fixture.calls.at(-1), ['side', 'main-thread', undefined, 'tab']);
    await change('.browser-addr input', 'localhost:5199');
    await submit();
    assert.equal(fixture.guest.getAttribute('src'), 'http://localhost:5199/');
    assert.equal(fixture.guest.getAttribute('partition'), 'persist:browser');
  });

  test('missing tab and thread still render usable blank tools', async () => {
    await setup({ tab: { url: undefined, agentChat: undefined }, props: { threadId: null } });
    assert.equal(container.querySelector('webview'), null);
    assert.equal(button('Continue in Chrome').disabled, true);
    button('Continue in Chrome').disabled = false;
    await click('Continue in Chrome');
    assert.equal(container.querySelector('.browser-handoff'), null);
    await act(async () => fixture.update({ paneTabs: [] }));
    await rerender();
  });

  test('a converted blank tab mounts its destination and preserves full-address preference', async () => {
    await setup({ tab: { url: '', agentChat: undefined } });
    await act(async () =>
      fixture.update({ paneTabs: [{ ...fixture.state.paneTabs[0], url: 'https://task.test/converted' }], prefs: { browserFullUrl: true } }),
    );
    assert.equal(fixture.guest.getAttribute('src'), 'https://task.test/converted');
    await act(async () => container.querySelector<HTMLInputElement>('input')!.blur());
    fixture.guestUrl = 'https://task.test/full?x=1';
    await emit('did-navigate');
    assert.equal(container.querySelector<HTMLInputElement>('input')!.value, fixture.guestUrl);
  });

  test('failed retry navigates the attempted destination and reports a rejected retry', async () => {
    await setup();
    await act(async () => container.querySelector<HTMLInputElement>('input')!.focus());
    await change('input', 'still editing');
    await emit('did-fail-load', { isMainFrame: true, errorCode: -105, validatedURL: 'https://missing.test/' });
    assert.equal(container.querySelector<HTMLInputElement>('input')!.value, 'still editing');
    fixture.guestUrl = 'about:blank';
    fixture.loadURL = async () => {
      throw new Error('still offline');
    };
    await click('Retry');
    assert.deepEqual(
      fixture.calls.findLast((c: any) => c[0] === 'loadURL'),
      ['loadURL', 'https://missing.test/'],
    );
    assert.match(container.textContent!, /Couldn't reload/);
  });

  test('Chrome connection shows busy state and ignores a second submit until it finishes', async () => {
    await setup();
    await click('Continue in Chrome');
    let resolve: any;
    fixture.nativeHandlers.continueInChrome = () =>
      new Promise((r) => {
        resolve = r;
      });
    await submit('.browser-handoff form');
    assert.match(container.textContent!, /Connecting to Chrome/);
    // no saved token: Chrome waits for the user to approve the connection, so say where
    assert.match(container.textContent!, /click "Allow & select" on the Playwright Extension page/);
    assert.equal(button('Cancel').disabled, false);
    await submit('.browser-handoff form');
    assert.equal(fixture.calls.filter((c: any) => c[0] === 'continueInChrome').length, 1);
    await act(async () => resolve({ ok: true }));
  });

  test('Chrome connection with a saved token connects without the approval hint', async () => {
    await setup({ handlers: { chromeState: async () => ({ active: 'builtin', hasToken: true }) } });
    await click('Continue in Chrome');
    assert.match(container.textContent!, /Restart on this site in Chrome\. Agents in every chat will use your Chrome\./);
    let resolve: any;
    fixture.nativeHandlers.continueInChrome = () =>
      new Promise((r) => {
        resolve = r;
      });
    await submit('.browser-handoff form');
    assert.match(container.textContent!, /Connecting to Chrome/);
    assert.doesNotMatch(container.textContent!, /Allow & select/);
    await act(async () => resolve({ ok: true }));
  });

  test('Chrome already the saved Preferred browser (its tools not loaded): the hand-off notice promises no change (#1523)', async () => {
    await setup({ prefs: { browserChannel: 'chrome' }, handlers: { chromeState: async () => ({ active: 'builtin', hasToken: true }) } });
    await click('Continue in Chrome');
    // nothing to confirm: going ahead changes no saved setting, so the page opens there and the task goes on
    assert.ok(fixture.calls.some((c: any) => c[0] === 'continueInChrome'));
    assert.equal(fixture.calls.at(-1)[0], 'sendMessage');
    assert.equal(container.querySelector('.browser-handoff'), null);
    // a page with no address to restart at asks for the site, and still promises no change
    fixture.nativeHandlers.pageState = async () => ({ pages: [], restartUrl: null });
    await click('Continue in Chrome');
    assert.match(container.textContent!, /Restart on this site in Chrome\./);
    assert.doesNotMatch(container.textContent!, /every chat/);
  });

  test('late page/channel-state responses cannot resurrect an unmounted browser', async () => {
    let pageResolve: any;
    let stateResolve: any;
    await setup({
      handlers: {
        chromeState: () =>
          new Promise((r) => {
            stateResolve = r;
          }),
        pageState: () =>
          new Promise((r) => {
            pageResolve = r;
          }),
      },
    });
    await act(async () => root.unmount());
    await act(async () => {
      pageResolve({ pages: [] });
      stateResolve({ active: 'chrome' });
    });
    clearRoot();
    assert.equal(fixture.callbacks.size, 0);
  });

  test('guest ID fallback cannot connect a tab that has not attached or changed while preparing', async () => {
    await setup({ guestError: true });
    fixture.guestError = false;
    await click('Continue in Chrome');
    assert.equal(container.querySelector('.browser-handoff'), null);
    await emit('did-attach');
    let resolve: any;
    fixture.nativeHandlers.pageState = () =>
      new Promise((r) => {
        resolve = r;
      });
    await click('Continue in Chrome');
    await act(async () => fixture.update({ paneTabs: [{ ...fixture.state.paneTabs[0], agentChat: 'different-chat' }] }));
    await act(async () => resolve({ pages: [], restartUrl: 'https://task.test/' }));
  });

  test('updates preserve other tabs, and a removed tab recovers its original source after a crash', async () => {
    await setup();
    await act(async () =>
      fixture.update({ paneTabs: [...fixture.state.paneTabs, { id: 'other', url: 'https://other.test/', title: 'Other' }] }),
    );
    await emit('did-navigate');
    assert.equal(fixture.state.paneTabs[1].url, 'https://other.test/');
    await act(async () => fixture.update({ paneTabs: [] }));
    await notice(event('crashed'));
    await noticeClick('Reload');
    assert.equal(fixture.guest.getAttribute('src'), 'https://task.test/start');
  });

  test('a stale Chrome button callback cannot start a handoff after its chat disappears', async () => {
    await setup({ tab: { agentChat: undefined }, props: { threadId: null } });
    const btn = button('Continue in Chrome') as any;
    const key = Object.keys(btn).find((key) => key.startsWith('__reactProps$'))!;
    await act(async () => btn[key].onClick());
    assert.equal(
      fixture.calls.some((c: any) => c[0] === 'continueInChrome'),
      false,
    );
  });
}
