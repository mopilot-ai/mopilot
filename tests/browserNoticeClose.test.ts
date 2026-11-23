// Every browser pane notice closes (#1523 §2): what a page notice's close does (shared/browserNotice.mjs noticeCloseAction), that it never asks main to put away a notice main keeps, and that Dismiss is that close, never a pill of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISMISSABLE, NOTICE_ACTIONS, noticeActions, noticeCloseAction } from '../shared/browserNotice.mjs';
import { act, setup, fixture, container, event, notice } from './support/browser-panel-ui/fixture.ts';

const KINDS = [
  { kind: 'failed', reason: 'load' },
  { kind: 'failed', reason: 'certificate' },
  { kind: 'failed', reason: 'input' },
  { kind: 'slow' },
  { kind: 'crashed' },
  { kind: 'blocked', reason: 'app-link' },
  { kind: 'blocked', reason: 'address' },
  { kind: 'unresponsive' },
];

test("a notice's close dismisses only what main can put away (windows.cjs DISMISSABLE); a hung page's is Wait; a crashed or slow page's only hides it here", () => {
  const closes = KINDS.map((n) => [n.kind, noticeCloseAction(n)]);
  assert.deepEqual(closes, [
    ['failed', 'dismiss'],
    ['failed', 'dismiss'],
    ['failed', 'dismiss'],
    ['slow', 'hide'],
    ['crashed', 'hide'],
    ['blocked', 'dismiss'],
    ['blocked', 'dismiss'],
    ['unresponsive', 'wait'],
  ]);
  for (const n of KINDS) assert.equal(noticeCloseAction(n) === 'dismiss', DISMISSABLE.includes(n.kind), n.kind);
  assert.equal('hide' in NOTICE_ACTIONS, false, 'a close only, never an action button');
});

test('Dismiss is never a pill of its own: the close does them, whatever the context', () => {
  for (const n of KINDS)
    for (const ctx of [{}, { loading: true, chat: true, url: 'https://task.test/' }, { popup: true, url: 'https://idp.test/' }]) {
      const actions: string[] = noticeActions(n, ctx);
      assert.equal(actions.includes('dismiss'), false, `${n.kind}/${n.reason}`);
    }
});

test("closing a crashed page's notice hides it in the pane without asking main to dismiss it; main saying it again shows it", async () => {
  await setup();
  await notice(event('crashed'));
  const close = () => container.querySelector<HTMLButtonElement>('.browser-notice[role="alert"] .browser-notice-close');
  assert.equal(close()!.getAttribute('aria-label'), 'Close');
  await act(async () => close()!.click());
  assert.equal(close(), null);
  assert.equal(fixture.calls.filter((c: any[]) => c[0] === 'dismissNotice').length, 0);
  await notice(event('crashed'));
  assert.ok(close(), 'a new crash notice shows again');
});
