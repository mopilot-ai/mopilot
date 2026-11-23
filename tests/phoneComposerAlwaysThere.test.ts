// A chat has its message box from the moment it opens: before the Mac answers chat.follow (cached rows, a slow computer) a message can be typed and sent, it goes to the outbox, and it is delivered while the live load is still pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';
const cachePath = '../mobile/src/presentation/threadCache';
const { rememberRows, forgetRows } = await import(cachePath);

const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const chat = (runtime: any, draft: string) => createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft(draft) });

test('with chat.follow still pending the message box and Send are there and a typed message is sent; Stop and the model pill wait for the live chat', async () => {
  const { runtime, calls } = scripted((m) => (m === 'chat.follow' ? new Promise(() => {}) : undefined));
  const v = await mount(chat(runtime, 'hello'));
  assert.ok(v.host.querySelector('textarea, input'), 'the field is drawn before the chat is followed');
  const send = v.host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
  assert.ok(send);
  assert.equal(send.disabled, false);
  assert.equal(v.host.querySelector('button[aria-label="Stop"]'), null, 'nothing runs yet');
  await click('Send message');
  assert.ok(calls.some((c) => c[0] === 'chat.send' && c[1].text === 'hello' && c[1].chatId === 'c'));
  assert.equal(calls.findIndex((c) => c[0] === 'chat.follow') >= 0, true, 'the chat is being followed meanwhile');
  await v.done();
});

test('an empty box with the chat still loading keeps Send off', async () => {
  const { runtime } = scripted((m) => (m === 'chat.follow' ? new Promise(() => {}) : undefined));
  const v = await mount(chat(runtime, ''));
  const send = v.host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
  assert.equal(send.disabled, true);
  await v.done();
});

test('once the Mac names the chat’s model the pill appears in the composer bar and opens Select model', async () => {
  const { runtime } = scripted((m) => {
    if (m === 'chat.follow') return new Promise(() => {});
    if (m === 'machine.hello')
      return { capabilities: { methods: ['options.get', 'options.set', 'chat.switch', 'chats.pin'], permissionCeiling: 'auto-review' } };
    if (m === 'options.get')
      return {
        models: [{ id: 'm1', label: 'M1', efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low' }],
        model: 'm1',
        effort: 'low',
        harness: 'Claude Code',
        harnessId: 'claude',
        switching: false,
        permission: { value: 'default', rows: [{ id: 'default', label: 'Ask', detail: 'Ask first' }] },
      };
    return undefined;
  });
  const v = await mount(chat(runtime, ''));
  await flush();
  assert.ok(v.host.querySelector('button[aria-label="Model, M1 Low"]'), 'the pill needs only the chat’s controls, not the followed chat');
  await click('Model, M1 Low');
  assert.match(v.host.textContent!, /Select model/);
  await v.done();
});

test('cached rows stay visible while follow waits; two sends use the real outbox in order across the delayed reply', async () => {
  const key = JSON.stringify(['u', 'p', 'c']);
  rememberRows(key, [{ key: 'cached', role: 'assistant', text: 'Saved reply before reopening' }]);
  let finishFollow!: (value: unknown) => void;
  let acceptFirst!: (value: unknown) => void;
  const s = scripted((method, params) => {
    if (method === 'chat.follow') return new Promise((resolve) => (finishFollow = resolve));
    if (method === 'chat.send' && params.text === 'first') return new Promise((resolve) => (acceptFirst = resolve));
    return undefined;
  });
  let renderDraft!: (value: string) => void;
  const React = await import('react');
  function Screen() {
    const [drafts] = React.useState(() => fakeDraft('first'));
    renderDraft = drafts.set;
    return createElement(Thread, {
      runtime: s.runtime,
      chatId: 'c',
      historyKey: key,
      back: () => {},
      drafts,
    });
  }
  const v = await mount(createElement(Screen));
  try {
    assert.match(v.host.textContent!, /Saved reply before reopening/);
    assert.ok(v.host.querySelector('[aria-label="Message this chat"]'));
    await click('Send message');
    await act(async () => renderDraft('second'));
    await click('Send message');
    assert.deepEqual(
      s.calls.filter(([m]) => m === 'chat.send').map(([, p]) => p.text),
      ['first'],
    );
    assert.deepEqual(
      s.runtime.snapshot().outbox.map((item: any) => item.text),
      ['first', 'second'],
    );
    await act(async () => finishFollow({ rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] }));
    await flush();
    assert.ok(v.host.querySelector('[aria-label="Message this chat"]'), 'the same composer survives the live reply');
    await act(async () => acceptFirst({ warning: null }));
    await flush();
    assert.deepEqual(
      s.calls.filter(([m]) => m === 'chat.send').map(([, p]) => p.text),
      ['first', 'second'],
    );
    assert.deepEqual(s.runtime.snapshot().outbox, []);
  } finally {
    await v.done();
    forgetRows();
  }
});
