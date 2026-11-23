// Browser-panel navigation-notices unit cases with a shared recording fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, fixture, container, event, setup, emit, notice, click, change, submit, rerender, noticeClick } from './fixture';

export function registerNavigationNoticesCases() {
  test('navigation updates the address/history without reloading src or discarding a user edit', async () => {
    await setup();
    const guest = fixture.guest;
    await emit('dom-ready');
    assert.equal(guest.getAttribute('src'), 'https://task.test/start');
    fixture.guestUrl = 'https://task.test/redirect';
    fixture.title = 'Redirected';
    await emit('did-navigate');
    await emit('did-navigate-in-page');
    await emit('page-title-updated');
    assert.equal(guest.getAttribute('src'), 'https://task.test/start');
    assert.equal(fixture.state.paneTabs[0].url, 'https://task.test/redirect');
    await act(async () => container.querySelector<HTMLInputElement>('input')!.focus());
    await change('input', 'my typed search');
    fixture.guestUrl = 'https://task.test/new';
    await emit('did-navigate');
    assert.equal(container.querySelector<HTMLInputElement>('input')!.value, 'my typed search');
    await submit();
    assert.deepEqual(fixture.calls.filter((c: any) => c[0] === 'loadURL').at(-1), [
      'loadURL',
      'https://www.google.com/search?q=my%20typed%20search',
    ]);
    await act(async () => container.querySelector<HTMLInputElement>('input')!.blur());
    await click('Back');
    await click('Forward');
    await click('Reload');
    assert.ok(fixture.calls.some((c: any) => c[0] === 'back'));
    assert.ok(fixture.calls.some((c: any) => c[0] === 'forward'));
    // the toolbar's loading bar shows while the page loads, decorative for assistive tech
    const loadbar = () => container.querySelector<HTMLElement>('.browser-bar > .browser-loadbar')!;
    assert.equal(loadbar().dataset.on, 'false');
    assert.equal(loadbar().getAttribute('aria-hidden'), 'true');
    fixture.loading = true;
    await emit('did-start-loading');
    assert.equal(loadbar().dataset.on, 'true');
    await click('Stop');
    fixture.loading = false;
    await emit('did-stop-loading');
    assert.equal(loadbar().dataset.on, 'false');
    fixture.title = '';
    await emit('page-title-updated');
    assert.equal(fixture.state.paneTabs[0].title, fixture.guestUrl);
    fixture.syncError = true;
    await emit('did-navigate');
  });

  test('load failures keep the attempted address and expose retry, stop and renderer recovery', async () => {
    await setup();
    await emit('did-fail-load', { isMainFrame: false, errorCode: -105 });
    await emit('did-fail-load', { isMainFrame: true, errorCode: -3 });
    assert.equal(container.querySelector('[role=alert]'), null);
    await emit('did-fail-load', {
      isMainFrame: true,
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'https://missing.test/path',
    });
    fixture.guestUrl = 'about:blank';
    await emit('did-stop-loading');
    assert.equal(fixture.state.paneTabs[0].url, 'https://missing.test/path');
    // Chrome's words; the code is the tooltip
    assert.match(container.textContent!, /address wasn't found/);
    assert.ok(container.querySelector('span[title="ERR_NAME_NOT_RESOLVED"]'));
    await click('Retry');
    await emit('did-fail-load', { isMainFrame: true, errorCode: -102, validatedURL: 'bad' });
    // a failure reported by its code alone is named from it
    assert.ok(container.querySelector('span[title="ERR_CONNECTION_REFUSED"]'));
    fixture.reloadError = true;
    await click('Retry');
    assert.match(container.textContent!, /not ready/);
    fixture.reloadError = false;
    fixture.loading = true;
    await emit('did-start-loading');
    await notice(event('slow'));
    await click('Stop loading');
    const before = fixture.guest;
    await notice(event('crashed'));
    await noticeClick('Reload');
    assert.notEqual(fixture.guest, before);
    assert.equal(fixture.guest.getAttribute('src'), 'https://missing.test/path');
    await notice(event('crashed'));
    await change('.browser-addr input', 'https://task.test/recovery');
    await submit();
    assert.equal(fixture.guest.getAttribute('src'), 'https://task.test/recovery');
  });

  test('popup notices follow the latest window, cancel and focus it, with sign-in fallback', async () => {
    await setup();
    await notice({ ...event('opened', 20), rootId: 99 });
    assert.equal(container.textContent!.includes('Sign-in window open'), false);
    await notice(event('opened', 20, { origin: 'https://accounts.google.com' }));
    assert.match(container.textContent!, /Sign-in window open for accounts\.google\.com\. Finish there, then come back\./);
    assert.match(container.textContent!, /Chrome and iCloud passkeys don't work here/);
    await click('Show window');
    await click('Cancel window');
    assert.ok(fixture.calls.some((c: any) => c[0] === 'focusPopup' && c[1] === 20));
    await notice(event('slow', 20));
    assert.match(container.textContent!, /slow notice/);
    await notice(event('opened', 21, { origin: 'null' }));
    await notice(event('ready', 20));
    await click('Show window');
    assert.deepEqual(fixture.calls.at(-1), ['focusPopup', 21]);
    fixture.nativeHandlers.closePopup = async () => {
      throw new Error('closed');
    };
    await click('Cancel window');
    assert.equal(fixture.calls.at(-1)[0], 'toast');
    await notice(event('closed', 21));
    await notice(event('closed', 20));
    assert.equal(container.textContent!.includes('Sign-in window open'), false);
    await act(async () => fixture.update({ paneTabs: [{ ...fixture.state.paneTabs[0], url: 'https://accounts.google.com/' }] }));
    assert.match(container.textContent!, /Chrome and iCloud passkeys don't work here/);
  });

  test("a page at macOS's passkey sheet says to finish there, and can use a passkey saved here instead", async () => {
    await setup({ tab: { url: 'https://accounts.google.com/' } });
    assert.match(container.textContent!, /Chrome and iCloud passkeys don't work here/);
    // where the system sheet serves passkeys, the general note would be wrong
    await notice(event('ready', 10, { origin: 'https://accounts.google.com', systemPasskeys: true }));
    assert.equal(container.textContent!.includes("Chrome and iCloud passkeys don't work here"), false);
    const at = { origin: 'https://accounts.google.com', systemPasskeys: true, passkey: true, passkeySystem: true };
    await notice(event('ready', 10, at));
    assert.match(container.textContent!, /Finish in the passkey window to sign in to accounts\.google\.com\./);
    // no passkey an earlier build made can be offered
    assert.equal(container.textContent!.includes('Use a passkey saved here'), false);
    await notice(event('ready', 10, { ...at, legacyPasskeys: true }));
    await click('Use a passkey saved here');
    assert.deepEqual(fixture.calls.at(-1), ['cancelPasskey', 10, true]);
    await click('Use another method');
    assert.deepEqual(fixture.calls.at(-1), ['cancelPasskey', 10, undefined]);
    await notice(event('opened', 20, { ...at, origin: 'null' }));
    await notice(event('ready', 10, { origin: 'https://accounts.google.com', systemPasskeys: true }));
    assert.match(container.textContent!, /Finish in the passkey window to sign in\./);
  });

  test('a page waiting on a passkey says why it stalls and can end the request or go to Chrome', async () => {
    await setup({ tab: { url: 'https://accounts.google.com/v3/signin/challenge/pk' } });
    // a sign-in page with no pending request keeps the general passkey note
    assert.match(container.textContent!, /Chrome and iCloud passkeys don't work here\.Continue in Chrome/);
    assert.equal(container.textContent!.includes('wants a passkey'), false);
    await notice(event('ready', 10, { origin: 'https://accounts.google.com', passkey: true }));
    assert.match(container.textContent!, /accounts\.google\.com wants a passkey, which this browser can't provide\./);
    assert.equal(container.textContent!.includes("Chrome and iCloud passkeys don't work here"), false);
    await click('Use another method');
    assert.deepEqual(fixture.calls.at(-1), ['cancelPasskey', 10, undefined]);
    fixture.nativeHandlers.cancelPasskey = async () => {
      throw new Error('gone');
    };
    await click('Use another method');
    assert.equal(fixture.calls.at(-1)[0], 'toast');
    await notice(event('ready', 10, { origin: 'https://accounts.google.com', passkey: false }));
    assert.equal(container.textContent!.includes('wants a passkey'), false);
    // a popup's request, on a page with no origin yet
    await notice(event('opened', 20, { origin: 'null', passkey: true }));
    assert.match(container.textContent!, /This page wants a passkey/);
    await notice(event('ready', 20, { origin: '', passkey: true }));
    assert.match(container.textContent!, /This page wants a passkey/);
  });

  test('a passkey notice with no chat offers only the in-page fallback', async () => {
    await setup({ tab: { agentChat: undefined }, props: { threadId: undefined } });
    await notice(event('ready', 10, { passkey: true }));
    assert.match(container.textContent!, /task\.test wants a passkey/);
    const labels = [...container.querySelectorAll('.browser-notice-actions button')].map((b) => b.textContent);
    assert.deepEqual(labels, ['Use another method']);
    // its close puts the notice away; the page keeps waiting on its passkey
    await click('Close');
    assert.doesNotMatch(container.textContent!, /wants a passkey/);
    assert.equal(fixture.calls.filter((c: any) => c[0] === 'cancelPasskey').length, 0);
  });

  test('Chrome handoff stays bound to the original page/chat while preserving the IAB profile', async () => {
    await setup();
    await click('Continue in Chrome');
    assert.match(container.textContent!, /Restart on this site in Chrome\./);
    await click('Browser settings');
    assert.deepEqual(fixture.calls.at(-1), ['navigate', { name: 'settings', section: 'browser' }]);
    await change('.browser-handoff input', 'https://task.test/work');
    await rerender({ threadId: 'another-thread' });
    await submit('.browser-handoff form');
    assert.deepEqual(
      fixture.calls.find((c: any) => c[0] === 'continueInChrome'),
      ['continueInChrome', { webContentsId: 10, chatId: 'agent-chat', url: 'https://task.test/work' }],
    );
    assert.equal(fixture.state.prefs.browserChannel, 'chrome');
    // the toolbar's hand-off continues the task by itself once the page is open there: no second click
    assert.equal(fixture.calls.at(-1)[0], 'sendMessage');
    assert.equal(fixture.calls.at(-1)[1], 'agent-chat');
    assert.match(fixture.calls.at(-1)[2], /fresh snapshot/);
    assert.equal(container.querySelector('.browser-handoff'), null);
    assert.equal(fixture.guest.getAttribute('src'), 'https://task.test/start');
  });

  test('Chrome handoff handles errors, reconnect, cancel, dismiss and failed task continuation', async () => {
    await setup();
    fixture.nativeHandlers.pageState = async () => {
      throw new Error('page gone');
    };
    await click('Continue in Chrome');
    assert.match(container.textContent!, /no longer available/);
    fixture.nativeHandlers.pageState = async () => ({ pages: [], restartUrl: null });
    await click('Continue in Chrome');
    assert.equal(container.querySelector<HTMLInputElement>('.browser-handoff input')!.value, '');
    await click('Cancel');
    assert.equal(container.querySelector('.browser-handoff'), null);
    fixture.nativeHandlers.pageState = async () => ({ pages: [], restartUrl: 'https://task.test/' });
    await click('Continue in Chrome');
    fixture.nativeHandlers.continueInChrome = async () => ({ ok: false, message: 'missing extension' });
    await submit('.browser-handoff form');
    // main's words, as a sentence (userError)
    assert.match(container.textContent!, /Missing extension\./);
    fixture.nativeHandlers.continueInChrome = async () => ({ ok: false });
    await submit('.browser-handoff form');
    assert.match(container.textContent!, /Could not connect/);
    fixture.nativeHandlers.continueInChrome = async () => {
      throw new Error('offline');
    };
    await submit('.browser-handoff form');
    assert.match(container.textContent!, /Check Browser settings/);
    fixture.nativeHandlers.continueInChrome = async () => ({ ok: true });
    // main refused the send it made by itself (sendMessage said why): the notice stays, to try again
    fixture.nativeHandlers.sendMessage = async () => false;
    await submit('.browser-handoff form');
    assert.match(container.textContent!, /Opened in your Chrome\..*Could not resume/);
    // the error updates the hand-off, and nothing is sent again by itself
    assert.equal(fixture.calls.filter((c: any) => c[0] === 'sendMessage').length, 1);
    assert.ok(container.querySelector('.browser-handoff'));
    fixture.nativeHandlers.sendMessage = async () => {
      throw new Error('chat closed');
    };
    await click('Continue task in Chrome');
    assert.match(container.textContent!, /Could not resume/);
    // the notice's close (Cancel) puts the finished hand-off away
    await click('Cancel');
    assert.equal(container.querySelector('.browser-handoff'), null);
  });

  test('address navigation reports invalid protocols, rejected loads and unavailable guests', async () => {
    await setup();
    await change('.browser-addr input', 'file:///private/key');
    await submit();
    assert.match(container.textContent!, /Enter a web address or search term\./);
    fixture.loadURL = async () => {
      throw new Error('ERR_ABORTED');
    };
    await change('.browser-addr input', 'https://task.test/');
    await submit();
    assert.equal(container.querySelector('[role=alert]'), null);
    fixture.loadURL = async () => {
      throw new Error('ERR_FAILED');
    };
    await submit();
    assert.match(container.textContent!, /Couldn't open/);
    fixture.guestError = true;
    await submit();
    assert.match(container.textContent!, /not ready/);
    fixture.nativeHandlers.external = async () => {
      throw new Error('not installed');
    };
    await click('Open in default browser');
    // the toast says why the page didn't open, not only that it didn't
    assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't open the link: not installed", 'error']);
  });
}
