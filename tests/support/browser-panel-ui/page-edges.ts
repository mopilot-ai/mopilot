// Browser-panel page edge-state cases: a page's own dialogs, certificate failures, app links and hung pages, each
// notice offering only actions that can work (shared/browserNotice.mjs), with the shared recording fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_ACTIONS, PANE_NOTICE_KINDS, noticeActions } from '../../../shared/browserNotice.mjs';
import { act, fixture, container, event, setup, emit, notice, click, change, submit, noticeClick } from './fixture';

export function registerPageEdgesCases() {
  // pane tabs as main-owned views (shared.browser.viewTabs), as main-owned-views.ts sets them up
  const viewState = () => ({
    url: 'https://task.test/start',
    title: 'Task',
    canGoBack: true,
    canGoForward: false,
    loading: false,
    zoom: 1,
  });
  async function viewSetup(options: any = {}) {
    fixture.flags = { 'shared.browser.viewTabs': true };
    try {
      await setup({
        ...options,
        handlers: {
          'view.bind': async () => ({ id: 10, state: viewState() }),
          'view.bounds': async () => true,
          'view.nav': async () => {},
          ...options.handlers,
        },
      });
    } finally {
      fixture.flags = {};
    }
    await act(async () => {});
  }
  const viewCalls = (name: string) => fixture.calls.filter((c: any[]) => c[0] === `view.${name}`).map((c: any[]) => c.slice(1));

  const noticeButtons = () =>
    [...container.querySelectorAll('.browser-notice[role="alert"] .browser-notice-actions button')].map((b) => b.textContent);
  /** The page notice's close button: what closing it does (Dismiss, or Wait for a page that stopped responding). */
  const noticeClose = () => container.querySelector('.browser-notice[role="alert"] .browser-notice-close')?.getAttribute('aria-label');

  test("a page's own dialog shows in the pane and the user's answer goes to main; an answered or failed one says so", async () => {
    await setup();
    const asked: any[] = [];
    fixture.nativeHandlers.answerDialog = async (...a: any[]) => (asked.push(a), true);
    await notice(event('ready', 10, { dialog: { id: 1, type: 'prompt', message: 'Type the draft name', defaultPrompt: 'x' } }));
    const bar = container.querySelector('.browser-dialog')!;
    assert.equal(bar.getAttribute('aria-label'), 'task.test says');
    assert.match(bar.textContent!, /task\.test says Type the draft name/);
    assert.equal(container.querySelector<HTMLInputElement>('.browser-dialog input')!.value, 'x');
    await change('.browser-dialog input', 'Q3 plan');
    await submit('.browser-dialog form');
    assert.deepEqual(asked.at(-1), [10, 1, true, 'Q3 plan']);
    // a confirm from a popup: OK and Cancel, no field; a page with no origin yet
    await notice(event('ready', 10, { dialog: null }));
    await notice(event('opened', 20, { origin: 'null', dialog: { id: 2, type: 'confirm', message: 'Delete?', defaultPrompt: '' } }));
    assert.equal(container.querySelector('.browser-dialog input'), null);
    assert.match(container.querySelector('.browser-dialog')!.textContent!, /This page says Delete\?/);
    await click('Cancel');
    assert.deepEqual(asked.at(-1), [20, 2, false, null]);
    // an alert has OK only; the agent answered first, so the pane says so
    fixture.nativeHandlers.answerDialog = async (...a: any[]) => (asked.push(a), false);
    await notice(event('opened', 20, { origin: '', dialog: { id: 3, type: 'alert', message: 'Saved', defaultPrompt: '' } }));
    assert.deepEqual(
      [...container.querySelectorAll('.browser-dialog .browser-notice-actions button')].map((b) => b.textContent),
      ['OK'],
    );
    // its close is the browser's Esc: OK for an alert, which has nothing to cancel
    assert.equal(container.querySelector('.browser-dialog .browser-notice-close')!.getAttribute('aria-label'), 'OK');
    await act(async () => container.querySelector<HTMLButtonElement>('.browser-dialog .browser-notice-close')!.click());
    assert.deepEqual(asked.at(-1), [20, 3, true, null]);
    await submit('.browser-dialog form');
    assert.deepEqual(fixture.calls.at(-1), ['toast', "The page's dialog was already answered", 'info']);
    fixture.nativeHandlers.answerDialog = async () => {
      throw new Error('gone');
    };
    await submit('.browser-dialog form');
    assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't answer the page's dialog: gone", 'error']);
  });

  test('a load the pane starts that fails on a certificate says so instead of a Retry', async () => {
    await setup();
    fixture.loadURL = async () => {
      throw new Error("ERR_CERT_DATE_INVALID (-201) loading 'https://expired.test/'");
    };
    await change('.browser-addr input', 'https://expired.test/');
    await submit();
    assert.match(container.textContent!, /certificate isn't trusted \(ERR_CERT_DATE_INVALID\)/);
    // Dismiss is the notice's close button, never a pill of its own
    assert.deepEqual(noticeButtons(), ['Open in your browser']);
    assert.equal(noticeClose(), 'Dismiss');
    // an address that isn't one: only its close (Retry would do nothing)
    await change('.browser-addr input', 'javascript:alert(1)');
    await submit();
    assert.match(container.textContent!, /Enter a web address/);
    assert.deepEqual(noticeButtons(), []);
    assert.equal(container.querySelector('.browser-notice[role="alert"] .browser-notice-actions'), null, 'no empty actions row');
    await click('Dismiss');
    assert.equal(noticeClose(), undefined);
  });

  test('a link to an app offers "Open in app" (main opens it) and Dismiss; a failure says so', async () => {
    await setup();
    fixture.nativeHandlers.openAppLink = async () => true;
    await notice(event('blocked', 10, { reason: 'app-link', link: 7, message: 'This page wants to open an app (a zoommtg: link).' }));
    assert.deepEqual(noticeButtons(), ['Open in app']);
    assert.equal(noticeClose(), 'Dismiss');
    await click('Open in app');
    assert.deepEqual(fixture.calls.at(-1), ['openAppLink', 10, 7]);
    fixture.nativeHandlers.openAppLink = async () => {
      throw new Error('no app');
    };
    await click('Open in app');
    assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't open the app: no app", 'error']);
    await notice(
      event('blocked', 10, { reason: 'address', message: "This page tried to open an address MoPilot Browser can't show (file:)." }),
    );
    assert.deepEqual(noticeButtons(), []);
    assert.equal(noticeClose(), 'Dismiss');
    // a popup's blocked link shows on the popup's notice
    await notice(event('blocked', 20, { reason: 'app-link', message: 'popup wants an app' }));
    assert.match(container.textContent!, /popup wants an app/);
  });

  test('a page that stopped responding offers Wait, Reload and Close tab; Reload and Close tab stop it first', async () => {
    await setup();
    fixture.nativeHandlers.stopPage = async () => true;
    const hung = () => notice(event('unresponsive', 10, { message: "This page isn't responding." }));
    await hung();
    assert.deepEqual(noticeButtons(), ['Wait', 'Reload', 'Close tab']);
    // closing it is Wait too: the page may still recover
    assert.equal(noticeClose(), 'Wait');
    await click('Wait');
    assert.deepEqual(noticeButtons(), []);
    // it stays quiet until main says it again; its close puts it away the same way
    await hung();
    assert.deepEqual(noticeButtons(), ['Wait', 'Reload', 'Close tab']);
    await act(async () => container.querySelector<HTMLButtonElement>('.browser-notice[role="alert"] .browser-notice-close')!.click());
    assert.equal(noticeClose(), undefined);
    await hung();
    const before = fixture.guest;
    await noticeClick('Reload');
    assert.ok(fixture.calls.some((c: any) => c[0] === 'stopPage' && c[1] === 10));
    assert.notEqual(fixture.guest, before, 'a new page replaces the stopped one');
    await hung();
    await click('Close tab');
    assert.deepEqual(fixture.calls.slice(-2), [
      ['stopPage', 10],
      ['close', 'tab'],
    ]);
    fixture.nativeHandlers.stopPage = async () => {
      throw new Error('gone');
    };
    await noticeClick('Reload');
    assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't stop this page: gone", 'error']);
  });

  test('view: a page that stopped responding reloads in place after it is stopped; a reload refused on a certificate says so', async () => {
    await viewSetup();
    fixture.nativeHandlers.stopPage = async () => true;
    await notice(event('unresponsive', 10, { message: "This page isn't responding." }));
    await noticeClick('Reload');
    assert.deepEqual(viewCalls('nav').at(-1), [10, 'load', 'https://task.test/start']);
    fixture.nativeHandlers['view.nav'] = async () => {
      throw new Error('ERR_CERT_REVOKED');
    };
    await notice(event('crashed'));
    await noticeClick('Reload');
    assert.match(container.textContent!, /certificate isn't trusted \(ERR_CERT_REVOKED\)/);
  });

  test('with Your Chrome but no Playwright Extension, "Continue in Chrome" leads to setting it up', async () => {
    await setup({ handlers: { handoffRoute: async () => 'setup' } });
    await click('Continue in Chrome');
    assert.match(container.querySelector('.browser-handoff')!.textContent!, /Set up the Playwright Extension/);
    assert.equal(container.textContent!.includes('Open in Chrome'), false);
    await click('Browser settings');
    assert.deepEqual(fixture.calls.at(-1), ['navigate', { name: 'settings', section: 'browser' }]);
  });

  // #3988: a blank tab's card sat under a second Continue in Chrome, and its orange button did nothing on an empty field
  test('a page with no address offers its one way to Chrome, and the card says when it cannot go on', async () => {
    await setup({
      tab: { url: 'about:blank' },
      handlers: { handoffRoute: async () => 'claude-in-chrome', pageState: async () => ({ pages: [], restartUrl: null }) },
    });
    await notice(event('crashed'));
    assert.deepEqual(noticeButtons(), ['Reload'], 'a page with no web address has nothing for its notice to hand off');
    const toolbar = container.querySelector<HTMLButtonElement>('.browser-chrome-btn')!;
    await act(async () => toolbar.click());
    assert.equal(toolbar.disabled, true, 'the card is open: its button would do nothing');
    const field = () => container.querySelector<HTMLInputElement>('.browser-handoff input')!;
    const open = () =>
      [...container.querySelectorAll<HTMLButtonElement>('.browser-handoff button')].find((b) => b.textContent === 'Open in Chrome')!;
    const form = () => container.querySelector<HTMLFormElement>('.browser-handoff form')!;
    assert.equal(field().placeholder, 'Site address', 'nothing that reads as an address already filled in');
    assert.equal(open().disabled, true);
    assert.equal(form().noValidate, true, "the field's failure is shown here, not left to a native bubble");
    await change('.browser-handoff input', 'javascript:alert(1)');
    assert.equal(open().disabled, false);
    await act(async () => open().click());
    assert.match(container.querySelector('.browser-handoff [role="alert"]')!.textContent!, /Enter a web address/);
    assert.equal(
      fixture.calls.some((c: any) => c[0] === 'continueInChrome'),
      false,
    );
    // an address as the address bar takes it
    await change('.browser-handoff input', 'github.com');
    await act(async () => open().click());
    assert.deepEqual(
      fixture.calls.find((c: any) => c[0] === 'continueInChrome'),
      ['continueInChrome', { webContentsId: 10, chatId: 'agent-chat', url: 'https://github.com/' }],
    );
  });

  test("a web page's notice drops its hand-off while the Chrome card is open, and has it again once closed", async () => {
    await setup({ handlers: { pageState: async () => ({ pages: [], restartUrl: null }) } });
    await notice(event('failed', 10, { reason: 'load', message: "Couldn't load this page (ERR_CONNECTION_REFUSED)." }));
    assert.deepEqual(noticeButtons(), ['Retry', 'Continue in Chrome']);
    await noticeClick('Continue in Chrome');
    assert.deepEqual(noticeButtons(), ['Retry']);
    assert.equal(container.querySelector<HTMLButtonElement>('.browser-chrome-btn')!.disabled, true);
    await act(async () => container.querySelector<HTMLButtonElement>('.browser-handoff .browser-notice-close')!.click());
    assert.deepEqual(noticeButtons(), ['Retry', 'Continue in Chrome']);
    assert.equal(container.querySelector<HTMLButtonElement>('.browser-chrome-btn')!.disabled, false);
  });

  test('a failed page offers Retry and, beside a chat, a hand-off to Chrome from its notice', async () => {
    await setup();
    await notice(event('failed', 10, { reason: 'load', message: "Couldn't load this page (ERR_CONNECTION_REFUSED)." }));
    assert.deepEqual(noticeButtons(), ['Retry', 'Continue in Chrome']);
    await noticeClick('Continue in Chrome');
    assert.ok(container.querySelector('.browser-handoff'));
  });

  test("main's notice of every kind the pane shows offers only the actions noticeActions picks, never a hand-written Retry", async () => {
    await setup();
    // a page event of another kind is page state, not a notice
    await notice(event('ready'));
    assert.equal(container.querySelector('.browser-notice[role="alert"]'), null);
    const cases = [
      { kind: 'failed', reason: 'load' },
      { kind: 'failed', reason: 'certificate' },
      { kind: 'failed', reason: 'resubmit' },
      { kind: 'slow' },
      { kind: 'crashed' },
      { kind: 'blocked', reason: 'app-link' },
      { kind: 'blocked', reason: 'address' },
      { kind: 'unresponsive' },
    ];
    assert.deepEqual([...new Set(cases.map((n) => n.kind))].sort(), [...PANE_NOTICE_KINDS].sort(), 'a case for every kind shown');
    for (const n of cases) {
      await notice(event(n.kind, 10, { reason: n.reason, message: `${n.kind}/${n.reason}` }));
      const offered = noticeActions(n, { loading: false, back: false, chat: true, url: 'https://task.test/start' });
      assert.match(container.querySelector('.browser-notice[role="alert"]')!.textContent!, new RegExp(`${n.kind}/${n.reason}`));
      assert.deepEqual(
        noticeButtons(),
        offered.map((a) => NOTICE_ACTIONS[a]),
        n.kind,
      );
      const retries = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Retry');
      assert.equal(retries.length, offered.includes('retry') ? 1 : 0, `${n.kind}/${n.reason}`);
    }
  });

  test("Dismiss puts away the pane's notice and main's of the same page, so the same words don't come back", async () => {
    await setup();
    fixture.nativeHandlers.dismissNotice = async () => true;
    await notice(event('failed', 10, { reason: 'certificate', message: "This site's security certificate isn't trusted (main)" }));
    await emit('did-fail-load', {
      isMainFrame: true,
      errorCode: -202,
      errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
      validatedURL: 'https://a.test/',
    });
    assert.match(container.textContent!, /ERR_CERT_AUTHORITY_INVALID/);
    await noticeClick('Dismiss');
    assert.deepEqual(fixture.calls.at(-1), ['dismissNotice', 10]);
  });

  test("an embedded page's dialog says which page asks", async () => {
    await setup();
    await notice(
      event('ready', 10, { dialog: { id: 4, type: 'alert', message: 'Paid', defaultPrompt: '', frame: 'https://pay.example' } }),
    );
    assert.match(container.querySelector('.browser-dialog')!.textContent!, /An embedded page at pay\.example says Paid/);
  });

  test('a popup window that stopped responding offers Wait, Reload and Close window; Reload and Close stop it first', async () => {
    await setup();
    fixture.nativeHandlers.stopPage = async () => true;
    fixture.nativeHandlers.reloadPage = async () => true;
    fixture.nativeHandlers.closePopup = async () => {};
    const hung = () => notice(event('unresponsive', 20, { message: "This window isn't responding." }));
    await hung();
    assert.deepEqual(noticeButtons(), ['Wait', 'Reload', 'Close window']);
    await noticeClick('Wait');
    assert.deepEqual(noticeButtons(), []);
    assert.match(container.textContent!, /This window isn't responding\./, 'the popup notice it had before');
    await hung();
    await noticeClick('Reload');
    assert.deepEqual(fixture.calls.slice(-2), [
      ['stopPage', 20],
      ['reloadPage', 20],
    ]);
    fixture.nativeHandlers.reloadPage = async () => {
      throw new Error('gone');
    };
    await noticeClick('Reload');
    assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't reload the window: gone", 'error']);
    await noticeClick('Close window');
    assert.deepEqual(fixture.calls.slice(-2), [
      ['stopPage', 20],
      ['closePopup', 20],
    ]);
  });
}

/**
 * The certificate notice's hand-off to the user's own browser (CM-M18, catalogued in docs/control-plane/matrix/M.md),
 * run by tests/controlMatrixPageHandoff.test.ts so the control-matrix guard finds it.
 */
export function registerCertificateHandoffCase() {
  const noticeButtons = () =>
    [...container.querySelectorAll('.browser-notice[role="alert"] .browser-notice-actions button')].map((b) => b.textContent);
  const noticeClose = () => container.querySelector('.browser-notice[role="alert"] .browser-notice-close')?.getAttribute('aria-label');
  test('CM-M18: "Open in your browser" on an untrusted certificate closes the notice once the site opened there and says so; a browser that does not open keeps it, and a newer notice stays', async () => {
    await setup();
    fixture.nativeHandlers.dismissNotice = async () => true;
    const fail = () =>
      emit('did-fail-load', {
        isMainFrame: true,
        errorCode: -202,
        errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
        validatedURL: 'https://localhost:8791/s/tls',
      });
    await fail();
    assert.match(container.textContent!, /certificate isn't trusted \(ERR_CERT_AUTHORITY_INVALID\)/);
    assert.deepEqual(noticeButtons(), ['Open in your browser']);
    // the site opens in the user's browser: the notice goes and says so (CM-M14, E-P5b's dead end)
    await click('Open in your browser');
    assert.deepEqual(fixture.calls.at(-2), ['external', 'https://localhost:8791/s/tls']);
    assert.deepEqual(fixture.calls.at(-1), ['toast', 'Opened this page in your browser', 'info']);
    assert.deepEqual(noticeButtons(), []);
    assert.equal(
      fixture.calls.some((c: any) => c[0] === 'dismissNotice'),
      false,
      "the pane's own notice: nothing in main to put away",
    );
    // a browser that doesn't open keeps the notice and says why
    await fail();
    fixture.nativeHandlers.external = async () => {
      throw new Error('no browser');
    };
    await click('Open in your browser');
    assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't open the link: no browser", 'error']);
    assert.deepEqual(noticeButtons(), ['Open in your browser']);
    await click('Dismiss');
    assert.equal(noticeClose(), undefined);
    // main's notice of the same failure is put away in main too once the browser opened
    fixture.nativeHandlers.external = async () => {};
    await emit('did-start-loading');
    await notice(event('failed', 10, { reason: 'certificate', message: "This site's security certificate isn't trusted" }));
    assert.deepEqual(noticeButtons(), ['Open in your browser']);
    await click('Open in your browser');
    assert.deepEqual(
      fixture.calls.slice(-3),
      [
        ['external', 'https://localhost:8791/s/tls'],
        ['dismissNotice', 10],
        ['toast', 'Opened this page in your browser', 'info'],
      ],
      'the tab is at the address that failed',
    );
    // a notice that came after the click (the page moved on while the browser opened) stays
    let opened!: () => void;
    fixture.nativeHandlers.external = () => new Promise<void>((r) => (opened = r));
    await notice(event('failed', 10, { reason: 'certificate', message: "This site's security certificate isn't trusted" }));
    await click('Open in your browser');
    await notice(event('failed', 10, { reason: 'certificate', message: 'A newer failure' }));
    const before = fixture.calls.length;
    await act(async () => opened());
    assert.deepEqual(fixture.calls.slice(before), [['toast', 'Opened this page in your browser', 'info']], 'nothing put away');
    assert.match(container.textContent!, /A newer failure/);
    fixture.nativeHandlers.dismissNotice = async () => {
      throw new Error('gone');
    };
    await click('Dismiss');
    assert.deepEqual(fixture.calls.at(-1), ['dismissNotice', 10]);
    // a failure to put main's notice away after the browser opened changes nothing for the user
    fixture.nativeHandlers.external = async () => {};
    await notice(event('failed', 10, { reason: 'certificate', message: "This site's security certificate isn't trusted" }));
    await click('Open in your browser');
    assert.deepEqual(fixture.calls.at(-1), ['toast', 'Opened this page in your browser', 'info']);
  });
}
