// The chat's one error line and the Mac's queue rows (#4807, found by the iOS audit of #4805): a Retry the Host refused again shows the Host's reason on the row and nowhere else; a line a failed Retry, Cancel or pick set goes when the next one works or the row it was about changes; another control's line is never taken away by a call that has nothing to do with it; and a send that goes clears a send's failure.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const lineHookPath = '../mobile/src/presentation/queueLine';
const { Thread } = await import(threadPath);
const { useQueueLine } = await import(lineHookPath);

const mounted: any[] = [];
async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    rerender: async (next: any) => {
      await act(async () => root.render(next));
      await flush();
    },
  };
}
after(async () => {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
});
const item = (id: string, text: string, over: object = {}) => ({ id, text, mine: true, attached: 0, ...over });
const count = (text: string, part: string) => text.split(part).length - 1;

function chat(queue: object[], answers: (m: string, p: any) => unknown = () => undefined, turn = 'idle') {
  return scripted((m, p) =>
    m === 'chat.follow'
      ? { rev: 1, feedSeq: 0, session: { turn, cards: [], queue }, itemsShape: 'rows', items: [] }
      : (answers(m, p) as any),
  );
}
const view = (s: any) =>
  createElement(Thread, {
    runtime: s.runtime,
    chatId: 'c',
    back: () => {},
    drafts: fakeDraft('a new message'),
  });

const REASON = 'The host is offline right now';

test('A: a Retry the Host refused again shows its reason on the row once, and no second line at the top', async () => {
  const s = chat([item('q1', 'words', { refused: REASON })], (m) =>
    m === 'chat.queue.retry' ? { retried: true, status: 'queued', error: REASON } : undefined,
  );
  const { host } = await mount(view(s));
  assert.equal(count(host.textContent!, REASON), 1);
  await click('Retry sending');
  await flush();
  assert.equal(count(host.textContent!, REASON), 1, 'told once, on the row');
});

test('A: a line a failed Retry set goes when the next Retry works, and when its Cancel works', async () => {
  let fails = true;
  const s = chat([item('q1', 'words', { refused: 'No.' })], (m) => {
    if (m === 'chat.queue.retry') {
      if (fails) throw new Error('The Mac is busy.');
      return { retried: true, status: 'sent' };
    }
    return m === 'chat.queue.cancel' ? { removed: true } : undefined;
  });
  const { host } = await mount(view(s));
  await click('Retry sending');
  await flush();
  assert.match(host.textContent!, /The Mac is busy\./);
  fails = false;
  await click('Retry sending');
  await flush();
  assert.doesNotMatch(host.textContent!, /The Mac is busy\./, 'the next Retry that works takes it back');
  fails = true;
  await click('Retry sending');
  await flush();
  assert.match(host.textContent!, /The Mac is busy\./);
  await click('Cancel this message');
  await flush();
  assert.doesNotMatch(host.textContent!, /The Mac is busy\./, 'a Cancel that works takes it back too');
});

test('A: a line about a row goes when the row changes state or is gone, and another control’s line stays', async () => {
  const { useState } = await import('react');
  let line: string | null = null;
  let api: { fail: (m: string) => void; settle: () => void } | null = null;
  let setLine: ((text: string | null) => void) | null = null;
  const row = (over: object = {}) => ({ id: 'q1', text: 'words', attached: 0, ...over });
  const Probe = ({ held }: { held: any[] }) => {
    const [now, set] = useState<string | null>(null);
    line = now;
    setLine = set as any;
    api = useQueueLine(held, set);
    return null;
  };
  const { rerender } = await mount(createElement(Probe, { held: [row({ refused: 'No.' })] }));
  await act(async () => api!.fail('The Mac is busy.'));
  assert.equal(line, 'The Mac is busy.');
  // the same rows: the line stays
  await rerender(createElement(Probe, { held: [row({ refused: 'No.' })] }));
  assert.equal(line, 'The Mac is busy.');
  // the Host's reason changed: the row is something else now, and the line about the old one goes
  await rerender(createElement(Probe, { held: [row({ refused: 'A different reason.' })] }));
  assert.equal(line, null);
  // a line another control set is never taken by the list: its own settle (a call of the list starting) leaves it
  await act(async () => api!.fail('The list failed.'));
  await act(async () => setLine!('The Stop did not reach the Mac.'));
  await act(async () => api!.settle());
  assert.equal(line, 'The Stop did not reach the Mac.');
  // and a row that is gone is a change too
  await act(async () => api!.fail('Another failure.'));
  await rerender(createElement(Probe, { held: [] }));
  assert.equal(line, null);
  // settle with nothing said is nothing
  await act(async () => api!.settle());
  assert.equal(line, null);
});

test('A: a send that goes takes back the line of a send that failed', async () => {
  let fails = true;
  const s = chat([]);
  const send = s.runtime.send;
  s.runtime.send = (...a: any[]) => {
    if (fails) throw new Error('This chat is not open on the Mac.');
    return send.apply(s.runtime, a);
  };
  const { host } = await mount(view(s));
  await click('Send message');
  await flush();
  assert.match(host.textContent!, /This chat is not open on the Mac\./);
  fails = false;
  await click('Send message');
  await flush();
  assert.doesNotMatch(host.textContent!, /This chat is not open on the Mac\./);
});

test('A: Try again sends the last message once more, shows it as sent, and takes back the page’s line; a refused one puts its words there', async () => {
  const retryPath = '../mobile/src/presentation/retryTurn';
  const { retryTurn } = await import(retryPath);
  const calls: any[] = [];
  let line: string | null = 'An old failure.';
  let sent: any[] = [];
  const setError = (v: any) => (line = typeof v === 'function' ? v(line) : v);
  const setSent = (v: any) => (sent = typeof v === 'function' ? v(sent) : v);
  const base = {
    chatId: 'c',
    text: 'try that again',
    setSent,
    rows: () => [],
    held: [{ id: 'h1' }],
    pin: () => calls.push('pin'),
    setError,
  };
  retryTurn({ ...base, runtime: { send: (...a: any[]) => (calls.push(a), 'send-9') } })();
  assert.deepEqual(calls, [['c', 'try that again', [], []], 'pin']);
  assert.equal(line, null, 'a send that goes takes back the line');
  assert.equal(sent.length, 1);
  const refuse = (thrown: unknown) =>
    retryTurn({
      ...base,
      runtime: {
        send: () => {
          throw thrown;
        },
      },
    })();
  refuse(new Error('This chat is not open on the Mac.'));
  assert.equal(line, 'This chat is not open on the Mac.');
  refuse('plain words');
  assert.equal(line, 'plain words');
});
