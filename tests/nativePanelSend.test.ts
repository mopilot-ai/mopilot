// The native send fixture exercises the actual panel's busy-send gate and DOM expression before dispatching another draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { panelPage } from './support/side-panel-page.ts';
import { tick } from './support/extension-background/fixture.ts';
import { deferred } from './support/async-scenarios.ts';
import { startSidePanel } from '../electron/chrome-extension/src/sidePanel.mjs';
import { CHAT_GONE } from '../electron/chrome-extension/src/panelErrors.mjs';
import { submitNativePanel } from './e2e/fixtures/nativePanelSend.mjs';

async function fixture() {
  const p = panelPage();
  p.g.location = { search: '?tabId=1' };
  await startSidePanel(p.g).ready;
  await tick();
  const style = { visibility: 'visible' };
  const get = p.g.document.getElementById;
  p.g.document.getElementById = (id: string) => {
    const el = get(id);
    el.getClientRects ??= () => (el.hidden ? [] : [{}]);
    el.dispatchEvent ??= (e: Event) => el.listeners[e.type]?.(e);
    el.requestSubmit ??= () => el.listeners.submit({ preventDefault() {} });
    return el;
  };
  const inPanel = async (expression: string) =>
    runInNewContext(expression, {
      document: p.g.document,
      chrome: p.chrome,
      Event,
      getComputedStyle: () => style,
    });
  return { p, inPanel, style };
}

test('a terminal event before send acknowledgement cannot make a disabled second submission disappear', async (t) => {
  const f = await fixture();
  await submitNativePanel(f, 'Earlier');
  await tick();
  const sends: any[] = [];
  const replies: ReturnType<typeof deferred<any>>[] = [];
  const base = f.p.chrome.runtime.sendMessage;
  let refused = false;
  f.p.chrome.runtime.sendMessage = (m: any) => {
    if (m.method === 'send') {
      sends.push(m);
      const reply = deferred<any>();
      replies.push(reply);
      return reply.promise;
    }
    if (m.method === 'read' && refused)
      return Promise.resolve({
        status: 'connected',
        result: {
          state: 'idle',
          rows: [
            { role: 'user', text: 'Earlier' },
            { role: 'user', text: 'REFUSE again' },
            { role: 'note', text: 'refused', refusal: true, id: 'r' },
          ],
        },
      });
    return base(m);
  };
  const retry = deferred<void>();
  t.after(async () => {
    retry.resolve();
    for (const reply of replies) reply.resolve({ status: 'connected', result: {} });
    await tick();
  });
  await submitNativePanel(f, 'REFUSE again');
  await tick();
  refused = true;
  f.p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'turn', chatId: 'chat-9', state: 'idle' } });
  await tick();
  assert.equal(f.p.els['progress-text'].textContent, 'Stopped by a safety check');
  let dispatched = false;
  const next = submitNativePanel({ inPanel: f.inPanel, delay: () => retry.promise } as any, 'Say hello').then(() => {
    dispatched = true;
  });
  await tick();
  assert.equal(f.p.els.send.disabled, true);
  assert.equal(dispatched, false, 'a terminal label is not a receipt for an enabled composer');
  assert.equal(sends.length, 1);
  assert.equal(f.p.els.text.value, 'Say hello');
  replies[0].resolve({ status: 'connected', result: {} });
  await tick();
  retry.resolve();
  await next;
  assert.equal(sends.length, 2);
  assert.equal(sends[1].params.text, 'Say hello');
  assert.equal(f.p.els.text.value, '');
  assert.equal(f.p.els.send.disabled, true, 'dispatch returns before its own acknowledgement, preserving queued-send coverage');
});

for (const mode of [
  'input disabled',
  'input hidden',
  'form hidden',
  'send hidden',
  'send disabled',
  'no layout',
  'invisible',
  'missing input',
  'missing form',
  'missing send',
])
  test(`an ordinary send waits for ${mode} to recover and submits exactly once`, async () => {
    const f = await fixture();
    const read = f.inPanel;
    const get = f.p.g.document.getElementById;
    let calls = 0;
    let waits = 0;
    const missing = mode.startsWith('missing')
      ? ({ 'missing input': 'text', 'missing form': 'composer', 'missing send': 'send' } as any)[mode]
      : null;
    await submitNativePanel(
      {
        inPanel: async (expression: string) => {
          if (++calls === 2) {
            if (mode === 'input disabled') f.p.els.text.disabled = true;
            if (mode === 'input hidden') f.p.els.text.hidden = true;
            if (mode === 'form hidden') f.p.els.composer.hidden = true;
            if (mode === 'send hidden') f.p.els.send.hidden = true;
            if (mode === 'send disabled') f.p.els.send.disabled = true;
            if (mode === 'no layout') f.p.els.text.getClientRects = () => [];
            if (mode === 'invisible') f.style.visibility = 'hidden';
            if (missing) f.p.g.document.getElementById = (id: string) => (id === missing ? null : get(id));
          }
          return read(expression);
        },
        delay: async () => {
          waits++;
          f.p.g.document.getElementById = get;
          f.p.els.text.disabled = false;
          for (const id of ['text', 'composer', 'send']) f.p.els[id].hidden = false;
          f.p.els.send.disabled = false;
          f.p.els.text.getClientRects = () => [{}];
          f.style.visibility = 'visible';
        },
      },
      'One message',
    );
    await tick();
    assert.equal(waits, 1);
    assert.equal(f.p.sent().filter((m: any) => m.method === 'start').length, 1);
  });

test('a changed draft is preserved and cannot be replaced or submitted by the waiting operation', async () => {
  const f = await fixture();
  let calls = 0;
  await assert.rejects(
    submitNativePanel(
      {
        inPanel: async (expression: string) => {
          if (++calls === 2) f.p.els.text.value = 'Independent draft';
          return f.inPanel(expression);
        },
      },
      'Earlier draft',
    ),
    /draft changed/,
  );
  assert.equal(f.p.els.text.value, 'Independent draft');
  assert.equal(
    f.p.sent().some((m: any) => m.method === 'start'),
    false,
  );
});

test('a missing initial composer or a failed read is reported without any dispatch', async () => {
  const f = await fixture();
  const get = f.p.g.document.getElementById;
  f.p.g.document.getElementById = (id: string) => (id === 'text' ? null : get(id));
  await assert.rejects(submitNativePanel(f, 'Missing'), /composer is unavailable/);
  await assert.rejects(
    submitNativePanel(
      {
        inPanel: async () => {
          throw new Error('Panel closed');
        },
      },
      'Closed',
    ),
    /Panel closed/,
  );
  assert.equal(
    f.p.sent().some((m: any) => m.method === 'start'),
    false,
  );
});

test('an ambiguous error after dispatch propagates without sending a duplicate', async () => {
  const f = await fixture();
  await assert.rejects(
    submitNativePanel(
      {
        inPanel: async (expression: string) => {
          const result = await f.inPanel(expression);
          if (expression.includes('requestSubmit')) throw new Error('CDP acknowledgement lost');
          return result;
        },
      },
      'One message',
    ),
    /acknowledgement lost/,
  );
  await tick();
  assert.equal(f.p.sent().filter((m: any) => m.method === 'start').length, 1);
});

test('a composer that never becomes ready exits its bounded wait without submitting', async () => {
  const f = await fixture();
  let calls = 0;
  let waits = 0;
  const get = f.p.g.document.getElementById;
  await assert.rejects(
    submitNativePanel(
      {
        inPanel: (expression: string) => {
          if (++calls > 1) f.p.g.document.getElementById = (id: string) => (id === 'composer' ? null : get(id));
          return f.inPanel(expression);
        },
        delay: async () => {
          waits++;
        },
      },
      'Waiting',
    ),
    /did not become ready/,
  );
  assert.equal(waits, 300);
  assert.equal(
    f.p.sent().some((m: any) => m.method === 'start'),
    false,
  );
});

test('the default polling delay admits a later enabled control without awaiting its request acknowledgement', async () => {
  const f = await fixture();
  let calls = 0;
  await submitNativePanel(
    {
      inPanel: (expression: string) => {
        calls++;
        if (calls > 1) f.p.els.send.disabled = calls === 2;
        return f.inPanel(expression);
      },
    },
    'Eventually ready',
  );
  await tick();
  assert.equal(calls, 3);
  assert.equal(f.p.sent().filter((m: any) => m.method === 'start').length, 1);
});

test('a chat retired while the previous acknowledgement waits cannot receive the waiting draft in a new chat', async (t) => {
  const f = await fixture();
  await submitNativePanel(f, 'Earlier');
  await tick();
  const ack = deferred<any>();
  const poll = deferred<void>();
  const base = f.p.chrome.runtime.sendMessage;
  let gone = false;
  f.p.chrome.runtime.sendMessage = (m: any) => {
    if (m.method === 'send') return ack.promise;
    if (m.method === 'read' && gone) return Promise.resolve({ status: 'connected', error: 'The chat is gone.', code: CHAT_GONE });
    return base(m);
  };
  t.after(async () => {
    ack.resolve({ status: 'connected', result: {} });
    poll.resolve();
    await tick();
  });
  await submitNativePanel(f, 'Still sending');
  let ended = false;
  const next = submitNativePanel({ inPanel: f.inPanel, delay: () => poll.promise }, 'Keep this draft').finally(() => {
    ended = true;
  });
  const rejected = assert.rejects(next, /composer changed/);
  await tick();
  assert.equal(ended, false);
  gone = true;
  f.p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'changed', chatId: 'chat-9' } });
  await tick();
  assert.equal(f.p.els.title.textContent, 'New chat');
  assert.equal(f.p.els.text.value, 'Keep this draft');
  ack.resolve({ status: 'connected', result: {} });
  await tick();
  poll.resolve();
  await rejected;
  assert.equal(f.p.els.text.value, 'Keep this draft');
  assert.equal(f.p.sent().filter((m: any) => m.method === 'start').length, 1, 'no replacement chat is started');
});

for (const replacement of ['document', 'input', 'form', 'binding ABA'])
  test(`a ${replacement} replacement retires the original same-text submission`, async () => {
    const f = await fixture();
    let read = f.inPanel;
    let calls = 0;
    await assert.rejects(
      submitNativePanel(
        {
          inPanel: async (expression: string) => {
            if (++calls === 2) {
              if (replacement === 'document') read = (await fixture()).inPanel;
              else if (replacement === 'binding ABA') {
                for (const id of ['other', 'original'])
                  await f.p.chrome.runtime.sendMessage({ type: 'panelBind', tabId: 1, chat: { id, title: 'Same title' } });
              } else {
                const id = replacement === 'input' ? 'text' : 'composer';
                f.p.els[id] = { ...f.p.els[id] };
              }
            }
            return read(expression);
          },
        },
        'Same draft',
      ),
      /composer changed/,
    );
    assert.equal(f.p.els.text.value, 'Same draft');
    assert.equal(f.p.sent().filter((m: any) => m.method === 'start').length, 0);
  });
