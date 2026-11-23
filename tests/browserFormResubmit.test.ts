// Back onto a form result (ERR_CACHE_MISS) and Chromium's other network errors in words: the pane's notice and its
// Resubmit / Go back, the agent's Back that lands there, and the reload no agent may send (it resubmits the form).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { netErrorName, netErrorMessage, netErrorNote, isResubmitError } from '../shared/netErrors.mjs';
import {
  loadFailure,
  loadFailureNote,
  openFailureNote,
  isResubmitFailure,
  formReloadNote,
  noticeActions,
  NOTICE_ACTIONS,
} from '../shared/browserNotice.mjs';
import { setup, navTab, drive } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const { ChromeTabContents } = require('../electron/capabilities/browser/chromeTab.cjs');

test("net errors: named from Electron's description, CDP's errorText or the code alone; unknown ones have no name", () => {
  assert.equal(netErrorName(-400, 'ERR_CACHE_MISS'), 'ERR_CACHE_MISS');
  assert.equal(netErrorName(null, 'net::ERR_NAME_NOT_RESOLVED'), 'ERR_NAME_NOT_RESOLVED');
  assert.equal(netErrorName(-105), 'ERR_NAME_NOT_RESOLVED');
  assert.equal(netErrorName(-999, ''), '');
  assert.equal(netErrorName(null, null as unknown as string), '');
  assert.equal(isResubmitError('ERR_CACHE_MISS'), true);
  assert.equal(isResubmitError('ERR_TIMED_OUT'), false);
  assert.equal(netErrorMessage('ERR_NOPE'), null);
  // every line the user reads fits the pane's one-line notice (tests/copyLength.test.ts NOTICE)
  for (const code of [-3, -7, -20, -21, -100, -101, -102, -105, -106, -107, -109, -113, -118, -137, -310, -324, -400]) {
    const message = netErrorMessage(netErrorName(code));
    assert.ok(message && message.length <= 72 && !/ERR_/.test(message), `${code}: ${message}`);
  }
});

test('net errors: the agent reads the cause, the raw error and what to do; a form result is never resubmitted by it', () => {
  assert.equal(
    netErrorNote('ERR_NAME_NOT_RESOLVED', 'net::ERR_NAME_NOT_RESOLVED'),
    "Couldn't load this page: the site's address wasn't found (net::ERR_NAME_NOT_RESOLVED). Check the address for a typo; retrying it as it is won't help.",
  );
  assert.equal(
    netErrorNote('ERR_CONNECTION_RESET', 'ERR_CONNECTION_RESET'),
    "Couldn't load this page: the connection was reset (ERR_CONNECTION_RESET). Try once more; if it fails again, tell the user.",
  );
  assert.equal(
    netErrorNote('', 'ERR_WHATEVER'),
    "Couldn't load this page (ERR_WHATEVER). Try once more; if it fails again, tell the user.",
  );
  const form = netErrorNote('ERR_CACHE_MISS', 'ERR_CACHE_MISS');
  assert.match(form, /result of a form submission/);
  assert.match(form, /Don't resubmit it yourself: it may repeat a submission or payment/);
  assert.match(form, /ask the user, who can resubmit from the browser pane/);
  assert.match(loadFailureNote('ERR_CACHE_MISS'), /^Couldn't show this page \(ERR_CACHE_MISS\): it was the result of a form/);
  assert.match(loadFailureNote('ERR_TOO_MANY_REDIRECTS'), /redirected too many times \(ERR_TOO_MANY_REDIRECTS\)\. Retrying won't help/);
  assert.equal(
    openFailureNote('https://nope.test/', 'net::ERR_NAME_NOT_RESOLVED'),
    "Couldn't open https://nope.test/: the site's address wasn't found (net::ERR_NAME_NOT_RESOLVED). Check the address for a typo; retrying it as it is won't help.",
  );
  assert.match(openFailureNote('https://x.test/', ''), /^Couldn't open https:\/\/x\.test\/ \(unknown error\)\. Try once more/);
  assert.equal(isResubmitFailure('ERR_CACHE_MISS'), true);
  assert.equal(isResubmitFailure('ERR_TIMED_OUT'), false);
  assert.match(formReloadNote('tab_1'), /^Didn't reload tab_1: its page is the result of a form submission/);
});

test('pane: a form result says so and offers Resubmit and Go back; other errors are in words, their code the detail', () => {
  assert.deepEqual(loadFailure(-400, 'ERR_CACHE_MISS'), {
    reason: 'resubmit',
    message: 'This page came from a form. Resubmit to see it again.',
    detail: 'ERR_CACHE_MISS',
  });
  assert.deepEqual(loadFailure(-105, 'ERR_NAME_NOT_RESOLVED'), {
    reason: 'load',
    message: "This site can't be reached: its address wasn't found.",
    detail: 'ERR_NAME_NOT_RESOLVED',
  });
  assert.deepEqual(loadFailure(-102), { reason: 'load', message: 'This site refused to connect.', detail: 'ERR_CONNECTION_REFUSED' });
  // an error not in the table keeps its raw words, as before
  assert.deepEqual(loadFailure(-999, 'ERR_ODD'), { reason: 'load', message: "Couldn't load this page (ERR_ODD).", detail: 'ERR_ODD' });
  assert.equal(loadFailure(-202, 'ERR_CERT_DATE_INVALID').detail, 'ERR_CERT_DATE_INVALID');
  // Retry would reload, which Electron cancels for a form result: the notice offers what works instead
  assert.deepEqual(noticeActions({ kind: 'failed', reason: 'resubmit' }, { chat: true, url: 'https://a.test/' }), ['resubmit', 'back']);
  // a form result opened in a new tab has no page to go back to
  assert.deepEqual(noticeActions({ kind: 'failed', reason: 'resubmit' }, { back: false }), ['resubmit']);
  assert.equal(NOTICE_ACTIONS.resubmit, 'Resubmit');
  assert.equal(NOTICE_ACTIONS.back, 'Go back');
});

test("agent: Back onto a form result says what happened and what to do, not a plain success; a Back that loads doesn't", async (t) => {
  const h = setup(t);
  const tab = navTab(t, h);
  tab.wc.url = 'https://query.test/results';
  tab.failure = 'stale';
  tab.wc.navigationHistory.goBack = () => {
    tab.wc.emit('did-start-loading');
    tab.wc.emit('did-fail-load', {}, -400, 'ERR_CACHE_MISS', 'https://query.test/results', true);
    tab.wc.emit('did-stop-loading');
  };
  const r = await drive(t, h.tabs.history(tab, 'back'));
  assert.equal(r.url, 'https://query.test/results');
  assert.match(r.note, /^Couldn't show this page \(ERR_CACHE_MISS\): it was the result of a form submission/);
  // a failure from the page it left is no failure of this Back
  tab.failure = 'stale';
  tab.wc.navigationHistory.goForward = () => tab.wc.emit('did-stop-loading');
  assert.equal((await drive(t, h.tabs.history(tab, 'forward'))).note, undefined);
});

test('agent: a reload that would resubmit a form is refused before it is sent; any other reload goes on', async (t) => {
  const h = setup(t);
  const tab = navTab(t, h);
  const reload = () => {
    tab.wc.navs = [];
    tab.wc.reload = () => {
      tab.wc.navs.push('reload');
      tab.wc.emit('did-stop-loading');
    };
    return drive(t, h.tabs.history(tab, 'reload'));
  };
  // the page failed as a form result: reloading it is resubmitting
  tab.failure = 'ERR_CACHE_MISS';
  await assert.rejects(
    reload(),
    (e: any) => e.code === 'denied' && /^Didn't reload tab_aaaaaa: its page is the result of a form/.test(e.message),
  );
  assert.deepEqual(tab.wc.navs, []);
  // the page loaded from a form: the same
  tab.failure = null;
  tab.wc.handlers['Page.getNavigationHistory'] = () => ({
    currentIndex: 1,
    entries: [{ transitionType: 'typed' }, { transitionType: 'form_submit' }],
  });
  await assert.rejects(reload(), { code: 'denied' });
  assert.deepEqual(tab.wc.navs, []);
  // a page opened by its address reloads
  tab.wc.handlers['Page.getNavigationHistory'] = () => ({ currentIndex: 0, entries: [{ transitionType: 'typed' }] });
  await reload();
  assert.deepEqual(tab.wc.navs, ['reload']);
  // a history it can't read is no form: the reload goes on
  tab.wc.handlers['Page.getNavigationHistory'] = () => {
    throw new Error('detached');
  };
  await reload();
  assert.deepEqual(tab.wc.navs, ['reload']);
});

test("Your Chrome: Chrome's error page is a failed load named by the document's own error, as a pane page's", () => {
  const wc = new ChromeTabContents({ relay: {}, chatId: 'c', tab: { id: 5, url: 'https://query.test/' } });
  const fails: any[] = [];
  wc.on('did-fail-load', (_e: unknown, ...args: unknown[]) => fails.push(args));
  wc.event({}, 'Page.frameNavigated', { frame: { id: 'F', url: 'https://query.test/' } });
  wc.event({}, 'Page.frameStartedLoading', { frameId: 'F' });
  // a canceled load, a subresource or an embedded page's document is not the page's failure
  wc.event({}, 'Network.requestWillBeSent', { type: 'Document', frameId: 'F', requestId: 'R1' });
  wc.event({}, 'Network.requestWillBeSent', { type: 'Document', frameId: 'SUB', requestId: 'R2' });
  wc.event({}, 'Network.requestWillBeSent', { type: 'Image', frameId: 'F', requestId: 'R3' });
  wc.event({}, 'Network.loadingFailed', { requestId: 'R1', canceled: true, errorText: 'net::ERR_ABORTED' });
  wc.event({}, 'Network.loadingFailed', { requestId: 'R2', errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
  wc.event({}, 'Network.loadingFailed', { requestId: 'R3', errorText: 'net::ERR_FAILED' });
  wc.event({}, 'Network.loadingFailed', { requestId: 'R1', errorText: 'net::ERR_CACHE_MISS' });
  wc.event({}, 'Page.frameNavigated', {
    frame: { id: 'F', url: 'chrome-error://chromewebdata/', unreachableUrl: 'https://query.test/results' },
  });
  assert.deepEqual(fails, [[0, 'net::ERR_CACHE_MISS', 'https://query.test/results', true]]);
  // the next load starts clean; an error page with no document error still says it failed
  wc.event({}, 'Page.frameStoppedLoading', { frameId: 'F' });
  wc.event({}, 'Page.frameStartedLoading', { frameId: 'F' });
  wc.event({}, 'Page.frameNavigated', { frame: { id: 'F', url: 'chrome-error://chromewebdata/', unreachableUrl: 'https://x.test/' } });
  assert.deepEqual(fails[1], [0, 'ERR_FAILED', 'https://x.test/', true]);
  // a page that loaded is no failure
  wc.event({}, 'Page.frameNavigated', { frame: { id: 'F', url: 'https://x.test/' } });
  assert.equal(fails.length, 2);
});

test("the pane's Resubmit has the form the page posted: kept per page and address, as sent, never a file's or a blob's", () => {
  const { installFormPosts, formPost, record, contentTypeOf, KEEP, MAX_BYTES } = require('../electron/capabilities/browser/formPosts.cjs');
  const { EventEmitter } = require('node:events');
  const listeners: any[] = [];
  const ses = { webRequest: { onBeforeRequest: (filter: any, fn: any) => listeners.push([filter, fn]) } };
  const page = new EventEmitter();
  const pages = { fromId: (id: number) => (id === 7 ? page : null) };
  installFormPosts(ses, pages);
  installFormPosts(ses, pages);
  installFormPosts(null, pages);
  installFormPosts({}, pages);
  // once per session, and only top-level navigations: the page's own requests pay nothing
  assert.equal(listeners.length, 1);
  assert.deepEqual(listeners[0][0], { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] });
  const post = (url: string, uploadData: any, extra: any = {}) => {
    let answered: unknown;
    listeners[0][1]({ method: 'POST', url, webContentsId: 7, uploadData, ...extra }, (r: unknown) => (answered = r));
    assert.deepEqual(answered, {}, 'the request goes on unchanged');
  };
  post('https://q.test/r', [{ bytes: Buffer.from('case=TW-1') }]);
  assert.equal(String(formPost(7, 'https://q.test/r').postData[0].bytes), 'case=TW-1');
  assert.equal(formPost(7, 'https://q.test/r').contentType, 'application/x-www-form-urlencoded');
  // Back trying the cache posts no data: the form's own stays; a GET or another page's request changes nothing
  post('https://q.test/r', []);
  post('https://q.test/r', undefined);
  post('https://q.test/r', [{ bytes: Buffer.from('x') }], { method: 'GET' });
  post('https://q.test/r', [{ bytes: Buffer.from('x') }], { webContentsId: 8 });
  post('https://q.test/r', [{ bytes: Buffer.from('x') }], { webContentsId: 0 });
  assert.equal(String(formPost(7, 'https://q.test/r').postData[0].bytes), 'case=TW-1');
  assert.equal(formPost(8, 'https://q.test/r'), null);
  // a form with a file in it can't be sent again as it was
  post('https://q.test/r', [{ bytes: Buffer.from('a') }, { file: '/tmp/x' }]);
  assert.equal(formPost(7, 'https://q.test/r'), null);
  // nor is one too large to hold for the page's lifetime
  post('https://q.test/big', [{ bytes: Buffer.alloc(MAX_BYTES + 1) }]);
  assert.equal(formPost(7, 'https://q.test/big'), null);
  // a multipart body names its boundary
  const mp = '------B1\r\nContent-Disposition: form-data; name="q"\r\n\r\nabc\r\n------B1--\r\n';
  assert.equal(contentTypeOf(Buffer.from(mp)), 'multipart/form-data; boundary=----B1');
  // the latest forms of a page are kept, and go with it
  for (let i = 0; i <= KEEP; i++)
    record({ method: 'POST', url: `https://q.test/${i}`, webContentsId: 7, uploadData: [{ bytes: Buffer.from('n') }] }, () => page);
  assert.equal(formPost(7, 'https://q.test/0'), null);
  assert.ok(formPost(7, `https://q.test/${KEEP}`));
  page.emit('destroyed');
  assert.equal(formPost(7, `https://q.test/${KEEP}`), null);
});
