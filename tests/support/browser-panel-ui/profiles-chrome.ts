// Browser-panel profiles-chrome unit cases with a shared recording fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, fixture, root, container, event, setup, emit, notice, click, submit, noticeClick } from './fixture';
import { window } from '../dom.ts';

export function registerProfilesChromeCases() {
  test("storage: with This chat only, a page opens in its chat's own partition and keeps it until it restarts", async () => {
    const { browserPartition, SHARED_PARTITION } = await import('../../../shared/browserStorage.mjs');
    // the agent's chat id is resolved to the MoPilot chat (main clears the partition by that id)
    await setup({ prefs: { browserStorage: 'session' }, chatOf: (id: string) => (id === 'agent-chat' ? 'chat-1' : id) });
    const mine = browserPartition('session', 'chat-1');
    assert.equal(fixture.guest.getAttribute('partition'), mine);
    assert.match(container.querySelector('.browser-context')!.textContent!, /This chat's own storage, cleared when the chat ends/);
    // switching the setting doesn't move a page that is open
    await act(async () => fixture.update({ prefs: { ...fixture.state.prefs, browserStorage: 'shared' } }));
    assert.equal(fixture.guest.getAttribute('partition'), mine);
    // a restart (after a crash) is a new page: it takes the current choice
    await emit('dom-ready');
    await notice(event('crashed'));
    await noticeClick('Reload');
    assert.equal(fixture.guest.getAttribute('partition'), SHARED_PARTITION);
    assert.match(container.querySelector('.browser-context')!.textContent!, /Sign-in is separate from Chrome/);
  });

  test('storage: the default is the shared profile, and a tab of no chat always shares', async () => {
    const { SHARED_PARTITION } = await import('../../../shared/browserStorage.mjs');
    await setup();
    assert.equal(fixture.guest.getAttribute('partition'), SHARED_PARTITION);
    await act(async () => root.unmount());
    container.remove();
    await setup({ prefs: { browserStorage: 'session' }, tab: { agentChat: undefined }, props: { threadId: null } });
    assert.equal(fixture.guest.getAttribute('partition'), SHARED_PARTITION);
  });

  test('when agents already use Your Chrome, the button and notice only offer to open the site there', async () => {
    await setup({ handlers: { chromeState: async () => ({ active: 'chrome', hasToken: false }) } });
    const btn = container.querySelector<HTMLButtonElement>('.browser-chrome-btn')!;
    assert.equal(btn.textContent, 'Open in Chrome');
    assert.equal(btn.title, 'Open this page in your real Chrome, where agents already work');
    // this chat's agent drives this very built-in tab: "Agents use Your Chrome" would be wrong here (#1834)
    assert.doesNotMatch(container.textContent!, /Agents use Your Chrome/);
    assert.match(container.querySelector('.browser-context')!.textContent!, /Sign-in is separate from Chrome/);
    await act(async () => btn.click());
    // nothing to confirm (the saved Preferred browser doesn't change): one click opens the page and continues there
    assert.deepEqual(
      fixture.calls.find((c: any) => c[0] === 'continueInChrome'),
      ['continueInChrome', { webContentsId: 10, chatId: 'agent-chat', url: 'https://task.test/start' }],
    );
    assert.match(fixture.calls.at(-1)[2], /fresh snapshot[\s\S]*\nContinue in Chrome · task\.test$/);
    assert.equal(container.querySelector('.browser-handoff'), null);
  });

  test('on Your Chrome, a built-in tab no agent uses says agents work in Chrome and this tab signs in on its own', async () => {
    await setup({
      handlers: { chromeState: async () => ({ active: 'chrome', hasToken: false }) },
      tab: { agentChat: undefined },
      props: { threadId: null },
    });
    assert.match(container.querySelector('.browser-context')!.textContent!, /^Agents use Your Chrome\. This tab has its own sign-in\.$/);
  });

  test("a chat on a vendor's Chrome controller opens the site in the user's Chrome for it: the channel stays and the agent is told its tool", async () => {
    let finish: any;
    await setup({
      handlers: { handoffRoute: async () => 'codex-browser-plugin', continueInChrome: () => new Promise((r) => (finish = r)) },
    });
    await click('Continue in Chrome');
    assert.deepEqual(
      fixture.calls.find((c: any) => c[0] === 'handoffRoute'),
      ['handoffRoute', 'agent-chat'],
    );
    const notice = () => container.querySelector('.browser-handoff')!.textContent!;
    // the first click is already the hand-off: no address to confirm on a page that has one
    assert.ok(fixture.calls.some((c: any) => c[0] === 'continueInChrome'));
    assert.match(notice(), /^Opening in Chrome…/);
    // no Playwright Extension approval to wait for on this route
    assert.doesNotMatch(notice(), /approve/i);
    await act(async () => finish({ ok: true, url: 'https://task.test/start', route: 'codex-browser-plugin' }));
    assert.notEqual(fixture.state.prefs.browserChannel, 'chrome', 'the browser channel stays');
    const sent = fixture.calls.at(-1);
    assert.equal(sent[0], 'sendMessage');
    // the routing note is hidden; the user's bubble says only where it continues
    assert.match(
      sent[2],
      /^<sage-browser-handoff>\nThe user opened this site in their Chrome at https:\/\/task\.test\/start\. .*browser\.user\.claimTab/,
    );
    assert.match(sent[2], /\n<\/sage-browser-handoff>\nContinue in Chrome · task\.test$/);
    assert.deepEqual(sent[4], { human: true, chromeHandoff: { url: 'https://task.test/start', token: 'current' } });
    assert.equal(container.querySelector('.browser-handoff'), null);
  });

  test('a sign-in hand-off opens the page in Chrome and waits for the user to sign in there before continuing', async () => {
    await setup({ handlers: { handoffRoute: async () => 'claude-in-chrome' } });
    fixture.nativeHandlers.continueInChrome = async () => ({ ok: true, url: 'https://task.test/start', route: 'claude-in-chrome' });
    await act(async () => fixture.loginKey.onChrome());
    const notice = () => container.querySelector('.browser-handoff')!.textContent!;
    assert.match(notice(), /Opened in your Chrome\. Sign in there, then continue with Claude in Chrome\./);
    assert.equal(
      fixture.calls.some((c: any) => c[0] === 'sendMessage'),
      false,
      'nothing goes on before the user signed in',
    );
    await click('Continue task in Chrome');
    const sent = fixture.calls.at(-1);
    assert.deepEqual(
      fixture.calls.findLast((c: any) => c[0] === 'handoffContinuation'),
      ['handoffContinuation', { chatId: 'agent-chat', url: 'https://task.test/start', signedIn: true }],
    );
    assert.match(
      sent[2],
      /^<sage-browser-handoff>\nThe user signed in in their Chrome at https:\/\/task\.test\/start\. .*tabs_context_mcp/,
    );
    assert.match(sent[2], /\nSigned in\. Continue in Chrome · task\.test$/);
    assert.equal(container.querySelector('.browser-handoff'), null);
  });

  test('a sign-in hand-off to Your Chrome waits for the sign-in; a page with no address to restart at asks for one first', async () => {
    // Chrome already the saved Preferred browser: nothing to confirm, the sign-in page opens in the chat's Chrome
    await setup({ prefs: { browserChannel: 'chrome' } });
    await act(async () => fixture.loginKey.onChrome());
    assert.match(container.querySelector('.browser-handoff')!.textContent!, /^Opened in Your Chrome\. Sign in there, then continue\./);
    await act(async () => root.unmount());
    container.remove();
    // a vendor's controller, but the page has no address to restart at: the notice asks for the site
    await setup({ handlers: { handoffRoute: async () => 'claude-in-chrome', pageState: async () => ({ pages: [], restartUrl: null }) } });
    await click('Continue in Chrome');
    assert.match(
      container.querySelector('.browser-handoff')!.textContent!,
      /Open this site in your Chrome and continue with Claude in Chrome\./,
    );
    assert.equal(
      fixture.calls.some((c: any) => c[0] === 'continueInChrome'),
      false,
    );
    await act(async () => root.unmount());
    container.remove();
    // agents already in Your Chrome, and no address: the same question, worded for Your Chrome
    await setup({
      handlers: {
        chromeState: async () => ({ active: 'chrome', hasToken: true }),
        pageState: async () => ({ pages: [], restartUrl: null }),
      },
    });
    await click('Open in Chrome');
    assert.match(container.querySelector('.browser-handoff')!.textContent!, /Open this site in Chrome, where agents already work\./);
  });

  test("MoPilot's extension missing: Add to Chrome, then the hand-off goes on by itself once it is there", async () => {
    let route = 'setup-extension';
    await setup({ handlers: { handoffRoute: async () => route } });
    fixture.nativeHandlers.continueInChrome = async ({ url }: any) => ({ ok: true, url, route: 'extension' });
    await click('Continue in Chrome');
    const notice = container.querySelector('.browser-handoff')!;
    assert.match(notice.textContent!, /Add MoPilot's extension to Chrome to continue there\./);
    assert.deepEqual(
      [...notice.querySelectorAll('.browser-notice-actions button')].map((b) => b.textContent),
      ['Add to Chrome', 'Browser settings'],
    );
    await click('Add to Chrome');
    assert.deepEqual(fixture.calls.at(-1), ['chromeInstall']);
    // still missing: a change in availability, or coming back to the window, keeps waiting
    await act(async () => fixture.callbacks.get('availability')());
    assert.equal(
      fixture.calls.some((c: any) => c[0] === 'continueInChrome'),
      false,
    );
    // a store listing this build lacks sends the user to Browser settings instead
    fixture.nativeHandlers.chromeInstall = async () => 'unavailable';
    await click('Add to Chrome');
    assert.deepEqual(fixture.calls.at(-1), ['navigate', { name: 'settings', section: 'browser' }]);
    fixture.nativeHandlers.chromeInstall = async () => {
      throw new Error('no store');
    };
    await click('Add to Chrome');
    assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't open the Chrome Web Store: no store", 'error']);
    route = 'extension';
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      fixture.callbacks.get('availability')();
      await new Promise((r) => setImmediate(r));
    });
    assert.equal(fixture.calls.filter((c: any) => c[0] === 'continueInChrome').length, 1, 'one go ahead for both signals');
    assert.match(fixture.calls.at(-1)[2], /call chrome_tabs_context_mcp[\s\S]*\nContinue in Chrome · task\.test$/);
    assert.equal(container.querySelector('.browser-handoff'), null);
  });

  test('a chat no agent can reach Chrome from offers Browser settings, never a hand-off that can only fail', async () => {
    await setup({ handlers: { handoffRoute: async () => 'none' } });
    await click('Continue in Chrome');
    const notice = container.querySelector('.browser-handoff')!;
    assert.match(notice.textContent!, /This chat can't use your Chrome\. Turn it on, or sign in another way\./);
    assert.equal(notice.querySelector('input'), null);
    assert.deepEqual(
      [...notice.querySelectorAll('.browser-notice-actions button')].map((b) => b.textContent),
      ['Browser settings'],
    );
    assert.equal(notice.querySelector('.browser-notice-close')!.getAttribute('aria-label'), 'Cancel');
    await click('Browser settings');
    assert.deepEqual(fixture.calls.at(-1), ['navigate', { name: 'settings', section: 'browser' }]);
    // what Settings turns on later is no answer to this notice: nothing goes ahead by itself
    assert.equal(fixture.callbacks.has('availability'), false);
    await click('Cancel');
    assert.equal(container.querySelector('.browser-handoff'), null);
    assert.equal(
      fixture.calls.some((c: any) => c[0] === 'continueInChrome'),
      false,
    );
  });

  test("the route can't be read: the notice offers settings without promising Your Chrome", async () => {
    await setup({
      handlers: {
        handoffRoute: async () => {
          throw new Error('main gone');
        },
      },
    });
    await click('Continue in Chrome');
    assert.match(
      container.querySelector('.browser-handoff')!.textContent!,
      /This chat can't use your Chrome\. Turn it on, or sign in another way\./,
    );
  });

  test('Cancel while connecting stops the handoff in main and ignores its late result', async () => {
    for (const late of ['result', 'error']) {
      await setup();
      await click('Continue in Chrome');
      let finish: any;
      fixture.nativeHandlers.continueInChrome = () =>
        new Promise((resolve, reject) => {
          finish = () => (late === 'error' ? reject(new Error('stopped')) : resolve({ ok: false, cancelled: true, message: 'Cancelled.' }));
        });
      fixture.nativeHandlers.cancelChromeHandoff = async () => true;
      await submit('.browser-handoff form');
      await click('Cancel');
      assert.deepEqual(
        fixture.calls.find((c: any) => c[0] === 'cancelChromeHandoff'),
        ['cancelChromeHandoff', { webContentsId: 10, chatId: 'agent-chat' }],
      );
      assert.equal(container.querySelector('.browser-handoff'), null);
      await act(async () => finish());
      assert.equal(container.querySelector('.browser-handoff'), null, late);
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test('Cancel after Chrome answered (or a failed cancel) keeps waiting for the handoff result', async () => {
    for (const answer of ['answered', 'rejected']) {
      await setup();
      await click('Continue in Chrome');
      let finish: any;
      fixture.nativeHandlers.continueInChrome = () =>
        new Promise((r) => {
          finish = () => r({ ok: true, url: 'https://task.test/' });
        });
      fixture.nativeHandlers.cancelChromeHandoff =
        answer === 'answered'
          ? async () => false
          : async () => {
              throw new Error('gone');
            };
      await submit('.browser-handoff form');
      await click('Cancel');
      assert.match(container.querySelector('.browser-handoff')!.textContent!, /Connecting to Chrome/);
      await act(async () => finish());
      // the hand-off finished: the task goes on there, as with no Cancel at all
      assert.equal(fixture.calls.at(-1)[0], 'sendMessage', answer);
      assert.equal(container.querySelector('.browser-handoff'), null, answer);
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
