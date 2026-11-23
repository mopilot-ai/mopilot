// The browser pane's page notice (src/components/panels/browserPanel/PageNotices.tsx PageNoticeBar), rendered: it offers
// exactly the actions shared/browserNotice.mjs noticeActions picks for the notice and its context, each button runs that
// action's own handler, and its close runs the close noticeCloseAction picks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { render, click } from './support/shell-chrome-kit.ts';
import { NOTICE_ACTIONS, noticeActions, noticeCloseAction, type NoticeAction } from '../shared/browserNotice.mjs';

const { PageNoticeBar } = await import('../src/components/panels/browserPanel/PageNotices.tsx');

const CASES = [
  { kind: 'failed', reason: 'load' },
  { kind: 'failed', reason: 'certificate' },
  { kind: 'failed', reason: 'input' },
  { kind: 'failed', reason: 'resubmit' },
  { kind: 'slow' },
  { kind: 'crashed' },
  { kind: 'blocked', reason: 'app-link' },
  { kind: 'blocked', reason: 'address' },
  { kind: 'unresponsive' },
];
const CONTEXTS = [
  { loading: false, back: false, chat: false },
  { loading: true, back: true, chat: true, url: 'https://task.test/' },
  { loading: false, back: false, chat: true, url: 'https://idp.test/', popup: true },
];

/** Every NoticeAction: tsc refuses this literal if it misses an action of the type or names one it lacks. */
const ACTIONS = Object.keys({
  retry: 1,
  resubmit: 1,
  back: 1,
  reload: 1,
  stop: 1,
  chrome: 1,
  openBrowser: 1,
  openApp: 1,
  dismiss: 1,
  wait: 1,
  restart: 1,
  closeTab: 1,
  closeWindow: 1,
} satisfies Record<NoticeAction, 1>) as NoticeAction[];

test('NoticeAction, the type every handlers record is keyed by (PageNoticeBar, BrowserPanel), names every action NOTICE_ACTIONS has', () => {
  assert.deepEqual(Object.keys(NOTICE_ACTIONS).sort(), [...ACTIONS].sort());
});

/** The notice rendered with a handler for every action that records which one ran. */
async function notice(n: { kind: string; reason?: string }, ctx: (typeof CONTEXTS)[number]) {
  const ran: string[] = [];
  const handlers = {} as Record<NoticeAction, () => void>;
  for (const a of ACTIONS) handlers[a] = () => ran.push(a);
  const view = await render(
    createElement(PageNoticeBar, { notice: { ...n, message: `${n.kind} notice`, detail: 'ERR_X' }, ...ctx, handlers }),
  );
  return { ran, view, bar: view.host.querySelector('.browser-notice[role="alert"]')! };
}

test('a page notice offers the actions noticeActions picks, and each button runs its own handler', async () => {
  for (const n of CASES)
    for (const ctx of CONTEXTS) {
      const what = `${n.kind}/${n.reason} ${JSON.stringify(ctx)}`;
      const expected = noticeActions(n, ctx);
      const { ran, view, bar } = await notice(n, ctx);
      assert.equal(bar.querySelector('span[title="ERR_X"]')?.textContent, `${n.kind} notice`, what);
      const buttons = [...bar.querySelectorAll<HTMLButtonElement>('.browser-notice-actions button')];
      assert.deepEqual(
        buttons.map((b) => b.textContent),
        expected.map((a) => NOTICE_ACTIONS[a]),
        what,
      );
      // no empty actions row when nothing can work
      assert.equal(!!bar.querySelector('.browser-notice-actions'), expected.length > 0, what);
      for (const b of buttons) await click(b);
      assert.deepEqual(ran, expected, what);
      await view.unmount();
    }
});

test("a page notice's close runs what noticeCloseAction picks: Dismiss, Wait, or a crashed or slow page's hide (Wait's handler)", async () => {
  for (const n of CASES) {
    const close = noticeCloseAction(n);
    const { ran, view, bar } = await notice(n, CONTEXTS[1]);
    const button = bar.querySelector<HTMLButtonElement>('.browser-notice-close')!;
    assert.equal(button.getAttribute('aria-label'), close === 'hide' ? 'Close' : NOTICE_ACTIONS[close], n.kind);
    await click(button);
    assert.deepEqual(ran, [close === 'hide' ? 'wait' : close], n.kind);
    await view.unmount();
  }
});
