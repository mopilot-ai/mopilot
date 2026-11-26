// A chat action that fails on the phone: the caller's handler may claim the error (no text, busy cleared), otherwise the message shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);

async function mount(failure: (method: string) => Error | null) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const releases: Array<() => void> = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string) => {
      if (method === 'chat.follow') {
        return {
          rev: 1,
          feedSeq: 0,
          session: {
            turn: 'running',
            turnStatus: 'running',
            cards: [{ id: 'a', rev: 1, title: 'Run it?', choices: [{ key: 'yes', label: 'Yes' }] }],
          },
          itemsShape: 'rows',
          items: [],
        };
      }
      if (method === 'chat.unfollow') return {};
      // a failing action settles only when the test lets it, so the busy flag is seen while it waits
      await new Promise<void>((resolve) => releases.push(resolve));
      const err = failure(method);
      if (err) throw err;
      return {};
    },
  };
  withOutbox(runtime);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  const stop = () =>
    [...host.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Stop')) as HTMLButtonElement;
  const settle = () => act(async () => releases.splice(0).forEach((release) => release()));
  return { host, root, stop, settle };
}

test('an error the card handler claims shows no text and frees the busy composer', async () => {
  const s = await mount(() => new Error('That request was already answered.'));
  await click('Yes');
  assert.equal(s.stop().disabled, true, 'busy while the answer is in flight');
  await s.settle();
  await flush();
  assert.doesNotMatch(s.host.textContent!, /already answered/);
  assert.match(s.host.textContent!, /Answered on your Mac/);
  assert.equal(s.stop().disabled, false, 'busy is cleared');
  await act(async () => s.root.unmount());
  s.host.remove();
});

test('an error with no handler (Stop) shows what it means, clears busy and is replaced by the next try', async () => {
  let fail = true;
  const s = await mount(() => (fail ? new Error('Computer is offline.') : null));
  await click('Stop');
  assert.equal(s.stop().disabled, true);
  await s.settle();
  await flush();
  // the runtime's words are worded for the person, as the other screens word them
  assert.match(s.host.textContent!, /Your computer is offline or asleep\. Wake it and try again\./);
  assert.equal(s.stop().disabled, false);
  fail = false;
  await click('Stop');
  assert.doesNotMatch(s.host.textContent!, /computer is offline/, 'a new action clears the old error');
  await s.settle();
  await flush();
  assert.doesNotMatch(s.host.textContent!, /computer is offline/);
  await act(async () => s.root.unmount());
  s.host.remove();
});

test('a non-Error refusal shows as text, and an action that fails after the screen closed changes nothing', async () => {
  const s = await mount(() => 'Refused' as unknown as Error);
  await click('Stop');
  await s.settle();
  await flush();
  assert.match(s.host.textContent!, /Refused/);
  await click('Stop');
  await act(async () => s.root.unmount());
  await s.settle();
  await flush();
  s.host.remove();
});

test('Stop says Stopping… from the tap, stays so until the turn ends, and goes back to Stop if the Mac refused it', async () => {
  const label = (s: any) => s.stop().getAttribute('aria-label');
  const ok = await mount(() => null);
  assert.equal(label(ok), 'Stop this chat’s turn');
  await click('Stop');
  assert.equal(label(ok), 'Stopping…', 'at once, before the Mac has answered');
  assert.equal(ok.stop().disabled, true);
  await ok.settle();
  await flush();
  assert.equal(label(ok), 'Stopping…', 'and after it answered, until the turn is seen to end');
  await act(async () => ok.root.unmount());
  ok.host.remove();
  const refused = await mount(() => new Error('Computer is offline.'));
  await click('Stop');
  assert.equal(label(refused), 'Stopping…');
  await refused.settle();
  await flush();
  assert.equal(label(refused), 'Stop this chat’s turn', 'a refused Stop can be tapped again');
  await act(async () => refused.root.unmount());
  refused.host.remove();
});
