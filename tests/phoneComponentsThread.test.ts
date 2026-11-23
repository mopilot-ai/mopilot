// Focused mobile component scenarios with native boundaries replaced by test controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const phoneModulePath = '../mobile/src/screens/Thread';
const { Thread } = await import(phoneModulePath);
/** Real time passing under the screen: the quiet re-read waits 300 ms after the first reason for it. */
const wait = (ms: number) => act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const follows = (calls: any[]) => calls.filter(([m]) => m === 'chat.follow').length;

test('thread follows, streams, answers, stops and refreshes historical events', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let listener: (e: any) => void = () => {};
  const calls: any[] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listener = f), () => {}),
    request: async (method: string, p: any) => {
      calls.push([method, p]);
      if (method === 'chat.follow')
        return {
          rev: 1,
          feedSeq: 0,
          historyStale: true,
          liveUnavailable: true,
          session: { turn: 'running', cards: [{ id: 'a', rev: 1, title: 'Approval', choices: [{ key: 'allow', label: 'Allow' }] }] },
          itemsShape: 'items',
          history: [{ role: 'user', text: 'Old' }],
          liveTurn: { id: 'one', status: 'inProgress' },
          items: [{ id: 'reply', type: 'agentMessage', text: 'Reply' }],
        };
      return {};
    },
  };
  withOutbox(runtime);
  let draft = '';
  let cleared = '';
  const render = () =>
    createElement(Thread, {
      runtime,
      chatId: 'c',
      back: () => {},
      drafts: fakeDraft(draft, {
        set: (value: string) => {
          draft = value;
        },
        clear: (value: string) => {
          cleared = value;
        },
      }),
    });
  await act(async () => root.render(render()));
  await flush();
  // a snapshot that says the history changed is the cure itself: no notice, no button
  assert.doesNotMatch(host.textContent!, /Earlier activity changed|Refresh chat/);
  assert.match(host.textContent!, /Reply/);
  await click('Allow');
  await click('Stop');
  assert.ok(calls.some(([m]) => m === 'chat.stop'));
  assert.ok(calls.some(([m, p]) => m === 'card.answer' && p.key === 'allow'));
  await act(async () =>
    listener({ kind: 'event', chatId: 'c', ev: 'items.delta', feedSeq: 1, live: true, itemId: 'reply', field: 'text', text: ' more' }),
  );
  // the live reply keeps its row: the block still being written waits until it is whole
  assert.match(host.textContent!, /Reply/);
  assert.doesNotMatch(host.textContent!, /Reply more/);
  await act(async () =>
    listener({ kind: 'event', chatId: 'c', ev: 'items.delta', feedSeq: 2, live: false, itemId: 'old', field: 'text', text: 'old' }),
  );
  // an event outside the live turn: the chat reads itself again, quietly, and keeps the rows, the draft and the send
  assert.doesNotMatch(host.textContent!, /Earlier activity changed|Refresh chat/);
  assert.match(host.textContent!, /Reply/);
  draft = 'Hello';
  await act(async () => root.render(render()));
  await click('Send');
  assert.equal(cleared, 'Hello');
  await wait(400);
  assert.equal(follows(calls), 2);
  assert.match(host.textContent!, /Reply/);
  assert.doesNotMatch(host.textContent!, /Refresh chat/);
  await act(async () => root.unmount());
  host.remove();
});

test('thread follow failure offers retry and retired follow cannot render', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let attempts = 0;
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string) => {
      if (method === 'chat.follow') {
        attempts++;
        if (attempts === 1) throw Error('offline');
        return { rev: 1, feedSeq: 0, session: {}, itemsShape: 'rows', items: [] };
      }
      return {};
    },
  };
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  assert.match(host.textContent!, /offline/);
  await click('Retry');
  assert.match(host.textContent!, /No messages yet/);
  await act(async () => root.unmount());
  host.remove();
});

test('a chat the Mac says is not in either app name has nothing to retry and nothing to send to; other failures keep Retry and the composer', async () => {
  const mount = async (failure: string) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const runtime: any = {
      snapshot: () => ({ selectedPair: 'p', generation: 1 }),
      onEvent: () => () => {},
      request: async (method: string) => {
        if (method === 'chat.follow') throw new Error(failure);
        return {};
      },
    };
    await act(async () => root.render(createElement(Thread, { runtime, chatId: 'gone', back: () => {}, drafts: fakeDraft('') })));
    await flush();
    const text = host.textContent!;
    const has = (name: string) =>
      [...document.querySelectorAll('button, textarea, input, [aria-label]')].some(
        (e) => e.getAttribute('aria-label') === name || e.textContent === name || e.getAttribute('placeholder') === name,
      );
    const out = { text, retry: has('Retry'), composer: has('Message this chat') };
    await act(async () => root.unmount());
    host.remove();
    return out;
  };
  for (const brand of ['MoPilot', 'MoPilot Code']) {
    const message = `That chat isn't in ${brand}.`;
    const gone = await mount(message);
    assert.ok(gone.text.includes(message));
    assert.equal(gone.retry, false, `${brand}: nothing to retry`);
    assert.equal(gone.composer, false, `${brand}: nothing to send to`);
    assert.doesNotMatch(gone.text, /Could not load this chat/);
  }
  const other = await mount('offline');
  assert.equal(other.retry, true);
  assert.equal(other.composer, true);
});

test('buffer overflow and malformed live events show retry while preserving readable rows', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let listener: (e: any) => void = () => {};
  let release: (v: any) => void = () => {};
  let first = true;
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listener = f), () => {}),
    request: async (method: string) => {
      if (method === 'chat.follow') {
        if (first) {
          first = false;
          return new Promise((r) => {
            release = r;
          });
        }
        return {
          rev: 0,
          feedSeq: 0,
          session: {},
          itemsShape: 'items',
          history: [{ role: 'assistant', text: 'Saved' }],
          items: [
            { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'New' }] },
            { id: 's', type: 'commandExecution', command: 'Command' },
          ],
        };
      }
      return {};
    },
  };
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  await act(async () => {
    for (let i = 0; i < 1001; i++) listener({ chatId: 'c', ev: 'items.delta', text: 'x' });
  });
  // too many events while the chat loads: no notice, it is read again from a newer snapshot once the first is back
  assert.doesNotMatch(host.textContent!, /changed too quickly|Refresh chat/);
  release({ rev: 0, feedSeq: 0, session: {}, itemsShape: 'rows', items: [] });
  await flush();
  await wait(400);
  // each row says who it is from to a screen reader
  assert.ok(host.querySelector('[aria-label^="You, live:"]'));
  assert.ok(host.querySelector('[aria-label^="Live activity:"]'));
  // a reply reads as its own text, not as one element labelled with its source (#4259)
  assert.ok([...host.querySelectorAll('span')].some((n) => n.textContent === 'Saved'));
  assert.equal(host.querySelector('[aria-label^="MoPilot:"]'), null);
  // an event this phone cannot read (no feed number): the rows are read again in place, nothing is shown
  await act(async () => listener({ chatId: 'c', ev: 'items.delta', itemId: 'u', field: 'text', text: 'bad' }));
  assert.doesNotMatch(host.textContent!, /newer version|Refresh chat/);
  await wait(400);
  assert.ok(host.querySelector('[aria-label^="You, live:"]'), 'the rows stay');
  await act(async () => root.unmount());
  host.remove();
});

test('thread ignores unrelated events, replays buffered events and retires in-flight action on unmount', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let listener: (e: any) => void = () => {};
  let finishFollow: (v: any) => void = () => {};
  let finishSend: (v: any) => void = () => {};
  let clear = '';
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listener = f), () => {}),
    request: async (method: string) => {
      if (method === 'chat.follow')
        return new Promise((resolve) => {
          finishFollow = resolve;
        });
      if (method === 'chat.send')
        return new Promise((resolve) => {
          finishSend = resolve;
        });
      throw 'unfollow failure';
    },
  };
  withOutbox(runtime);
  await act(async () =>
    root.render(
      createElement(Thread, {
        runtime,
        chatId: 'c',
        back: () => {},
        drafts: fakeDraft('draft', {
          clear: (v: string) => {
            clear = v;
          },
        }),
      }),
    ),
  );
  await flush();
  await act(async () => {
    listener({ chatId: 'else', ev: 'items.delta' });
    listener({ chatId: 'c', ev: 'items.append', feedSeq: 1, items: [{ id: 'x', type: 'agentMessage', text: 'live' }] });
    finishFollow({ rev: 0, feedSeq: 0, session: {}, itemsShape: 'rows', items: [] });
  });
  await flush();
  assert.match(host.textContent!, /live/);
  await click('Send');
  await act(async () => root.unmount());
  await act(async () => finishSend({}));
  await flush();
  assert.equal(clear, 'draft');
  host.remove();
});

test('synchronous oversized initial event exits pending follow safely', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => {
      f({ chatId: 'c', ev: 'items.delta', text: 'x'.repeat(1000001) });
      return () => {};
    },
    request: async (method: string) => (method === 'chat.follow' ? { rev: 0, feedSeq: 0, session: {}, itemsShape: 'rows', items: [] } : {}),
  };
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  assert.doesNotMatch(host.textContent!, /changed too quickly|Refresh chat/);
  await wait(400);
  assert.doesNotMatch(host.textContent!, /changed too quickly|Refresh chat/);
  await act(async () => root.unmount());
  host.remove();
});

test('retired follow and rejected sends do not publish errors into a replacement view', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let rejectFollow: (e: any) => void = () => {};
  let rejectSend: (e: any) => void = () => {};
  let ready = false;
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string) => {
      if (method === 'chat.follow')
        return ready
          ? { rev: 0, feedSeq: 0, session: {}, itemsShape: 'rows', items: [] }
          : new Promise((_r, j) => {
              rejectFollow = j;
            });
      if (method === 'chat.send')
        return new Promise((_r, j) => {
          rejectSend = j;
        });
      return {};
    },
  };
  const view = () => createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('go') });
  await act(async () => root.render(view()));
  await flush();
  await act(async () => root.unmount());
  await act(async () => rejectFollow('late'));
  await flush();
  const next = createRoot(host);
  ready = true;
  await act(async () => next.render(view()));
  await flush();
  await click('Send');
  await act(async () => next.unmount());
  await act(async () => rejectSend('late'));
  await flush();
  host.remove();
});

test('a queued send press cannot submit a draft cleared before dispatch', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let sends = 0;
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string) => {
      if (method === 'chat.follow') return { rev: 0, feedSeq: 0, session: {}, itemsShape: 'rows', items: [] };
      if (method === 'chat.send') sends++;
      return {};
    },
  };
  const view = (draft: string) => createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft(draft) });
  await act(async () => root.render(view('old')));
  await flush();
  const queued = (globalThis as any).__queuedPhoneSend;
  await act(async () => root.render(view('')));
  await act(async () => queued());
  assert.equal(sends, 0);
  await act(async () => root.unmount());
  host.remove();
});
