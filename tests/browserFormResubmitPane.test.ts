// The browser pane's notice for a form result (Back onto a POST, ERR_CACHE_MISS) and other failed loads: Chrome's
// words with the raw error in the tooltip, and Resubmit / Go back doing what they say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, setup, fixture, container, event, notice, noticeClick, emit, click } from './support/browser-panel-ui/fixture.ts';

const { browserLoadFailure } = await import('../src/lib/browserStop.ts');
const { shownNotice } = await import('../src/components/panels/browserPanel/PageNotices.tsx');

const bar = () => container.querySelector<HTMLElement>('.browser-notice[role="alert"]');
const actions = () => [...bar()!.querySelectorAll('.browser-notice-actions button')].map((b) => b.textContent);

test("main's notice of a form result offers Resubmit and Go back, not Retry; the raw error is the tooltip", async () => {
  await setup();
  fixture.nativeHandlers.resubmitPage = async () => true;
  // the page has one to go back to
  fixture.back = true;
  await emit('did-stop-loading');
  await notice(
    event('failed', 10, {
      reason: 'resubmit',
      message: 'This page came from a form. Resubmit to see it again.',
      detail: 'ERR_CACHE_MISS',
    }),
  );
  assert.deepEqual(actions(), ['Resubmit', 'Go back']);
  assert.equal(bar()!.querySelector('span[title]')!.getAttribute('title'), 'ERR_CACHE_MISS');
  await noticeClick('Resubmit');
  assert.deepEqual(fixture.calls.at(-1), ['resubmitPage', 10]);
  await noticeClick('Go back');
  assert.deepEqual(fixture.calls.at(-1), ['back']);
});

test("a Resubmit main couldn't do is a toast, and the page's own failure shows in words with its code as the tooltip", async () => {
  await setup();
  fixture.nativeHandlers.resubmitPage = async () => {
    throw new Error('This browser page is no longer available.');
  };
  await emit('did-fail-load', { isMainFrame: true, errorCode: -400, errorDescription: 'ERR_CACHE_MISS', validatedURL: 'https://q.test/r' });
  assert.match(bar()!.textContent!, /This page came from a form\. Resubmit to see it again\./);
  assert.equal(bar()!.querySelector('span[title]')!.getAttribute('title'), 'ERR_CACHE_MISS');
  // the toolbar's Reload (and Cmd+R) never loads the form result as a GET, nor reloads it: the notice stays, Resubmit is the way
  const calls = fixture.calls.length;
  await click('Reload');
  assert.deepEqual(fixture.calls.slice(calls), []);
  assert.match(bar()!.textContent!, /came from a form/);
  await noticeClick('Resubmit');
  await act(async () => {});
  assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't resubmit this page: This browser page is no longer available.", 'error']);
  // another error: its words, no raw code in the line
  await emit('did-start-loading');
  await emit('did-fail-load', {
    isMainFrame: true,
    errorCode: -105,
    errorDescription: 'ERR_NAME_NOT_RESOLVED',
    validatedURL: 'https://q.test/',
  });
  assert.match(bar()!.textContent!, /This site can't be reached: its address wasn't found\./);
  assert.doesNotMatch(bar()!.querySelector('span[title]')!.textContent!, /ERR_/);
});

test("a load the pane started is told in Chrome's words, a certificate keeps its recovery, an unknown one the fallback", () => {
  const fallback = "Couldn't open this page. Try again or continue in Chrome.";
  assert.deepEqual(browserLoadFailure(new Error("ERR_CONNECTION_REFUSED (-102) loading 'https://a.test/'"), fallback), {
    reason: 'load',
    message: 'This site refused to connect.',
    detail: 'ERR_CONNECTION_REFUSED',
  });
  assert.equal(browserLoadFailure(new Error('ERR_CERT_AUTHORITY_INVALID (-202)'), fallback).reason, 'certificate');
  assert.deepEqual(browserLoadFailure(new Error('ERR_ODD (-999)'), fallback), { message: fallback, reason: 'load', detail: 'ERR_ODD' });
  assert.deepEqual(browserLoadFailure(new Error('gone'), fallback), { message: fallback, reason: 'load', detail: undefined });
});

test("the notice shown is the pane's own, else main's with its detail, else none", () => {
  assert.deepEqual(shownNotice({ message: 'm', reason: 'resubmit', detail: 'ERR_CACHE_MISS' }, null), {
    kind: 'failed',
    message: 'm',
    reason: 'resubmit',
    detail: 'ERR_CACHE_MISS',
    pageId: null,
  });
  const root = { rootId: 1, pageId: 2, kind: 'failed', message: 'x', reason: 'load', detail: 'ERR_TIMED_OUT', origin: '' } as const;
  assert.deepEqual(shownNotice(null, root), { kind: 'failed', reason: 'load', message: 'x', detail: 'ERR_TIMED_OUT', pageId: 2 });
  assert.equal(shownNotice(null, undefined), null);
});
