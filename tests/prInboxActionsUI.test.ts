// src/components/thread/PrInboxRow.tsx's actions on PRs on their way: the merge robot's steps, a review on GitHub, and
// a fix the gate holds unverified, which asks its session to verify it (or opens the PR), and says when that request
// could not go and waits in the session's draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kit,
  sent,
  links,
  rows,
  prs,
  Inbox,
  url,
  open,
  child,
  facts,
  settle,
  show,
  tray,
  text,
  button,
  reset,
  h,
  render,
  click,
} from './support/prInboxUIKit.ts';

test("the merge robot's PRs show its four steps; a review opens the PR, an unverified fix asks its chat or opens it", async () => {
  reset();
  Object.assign(rows, { top: 'idle', r: 'idle', v: 'idle', t: 'idle' });
  const gated = (n: number, details: any) =>
    open({
      url: url(n),
      number: n,
      title: `PR ${n}`,
      details: { checks: 'passing', mergeable: 'MERGEABLE', mergeState: 'CLEAN', ...details },
    });
  Object.assign(prs, {
    [url(1)]: gated(1, { review: true }),
    [url(2)]: gated(2, { gate: { at: 'held', why: 'unverified', text: 'x' } }),
    [url(3)]: gated(3, { gate: { at: 'train', others: 2 } }),
  });
  const children = {
    r: child({ name: 'r', ...facts(1) }),
    v: child({ name: 'v', createdAt: 2, ...facts(2) }),
    t: child({ name: 't', createdAt: 3, ...facts(3) }),
  };
  await show(children);
  const v = await render(h(Inbox, { threadId: 'top' }));
  await show(children);
  await click(v.host.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement);
  const t = tray()!;
  const steps = [...t.querySelectorAll('[aria-label="In a train with 2 more"] [data-at]')].map((s) => [
    s.getAttribute('data-at'),
    s.textContent,
  ]);
  assert.deepEqual(steps, [
    ['done', 'Checks'],
    ['done', 'Gate'],
    ['now', 'In a train with 2 more'],
    ['next', 'Main'],
  ]);
  assert.match(text(t)!, /Your reviewGitHub asks for your review/);
  assert.match(text(t)!, /Verify fixIts fix isn't recorded as verified/);
  // a cut title or reason reads whole on hover
  assert.equal(t.querySelector('[title^="PR 2"]')?.getAttribute('title'), 'PR 2\nOpen #2 on GitHub');
  assert.ok(t.querySelector(`[title="Its fix isn't recorded as verified"]`));
  await click(button(t, 'Review')!);
  await click(button(t, 'Open PR')!);
  assert.deepEqual(links, [url(1), url(2)]);
  // the chat that owns the PR is asked to verify it, once: the tray says so and keeps Open PR
  await click(button(t, 'Ask to verify')!);
  await settle();
  assert.deepEqual(sent, [
    [
      'v',
      'The merge gate holds #2: its fix is not recorded as verified. Verify the fix against its original repro if that is not done yet, record the steps and the result under "Verified the fix", and let the merge gate check it again.',
    ],
  ]);
  assert.equal(button(t, 'Ask to verify'), undefined);
  assert.match(text(t)!, /Asked/);
  assert.ok(button(t, 'Open PR'));
  await v.unmount();
});

test('an ask to verify that could not go waits in its draft, and the tray says so', async () => {
  reset();
  Object.assign(rows, { top: 'idle', v: 'idle' });
  kit.sendAnswer = false;
  prs[url(2)] = open({
    url: url(2),
    number: 2,
    title: 'PR 2',
    details: { checks: 'passing', mergeable: 'MERGEABLE', mergeState: 'CLEAN', gate: { at: 'held', why: 'unverified', text: 'x' } },
  });
  const children = { v: child({ name: 'v', ...facts(2) }) };
  await show(children);
  const v = await render(h(Inbox, { threadId: 'top' }));
  await show(children);
  await click(v.host.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement);
  await click(button(tray()!, 'Ask to verify')!);
  await settle();
  assert.equal(sent.length, 1);
  assert.match(text(tray())!, /Not sent · in its draft/);
  await v.unmount();
});
