// Files without words are a message: the phone's chat sends them (as Claude for iOS and the app's composer do), the Mac accepts an empty text that carries attachments, and words are still required with none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted, fakeMedia } from './support/phone/m3';
import { mount as mountNewChat, button, attach } from './support/phone/newchat-kit';
import { composed, PARSERS } from '../shared/remote/schema.mjs';
import { PARSERS as HOST_PARSERS } from '../shared/host/schema.mjs';
import { deferred } from './support/async-scenarios';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const queuePath = '../mobile/src/components/QueuedMessages';
const outboxPath = '../mobile/src/outbox';
const { Thread } = await import(threadPath);
const { QueuedMessages } = await import(queuePath);
const { createOutbox } = await import(outboxPath);

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
const turn = (state: string) => ({ rev: 1, feedSeq: 0, session: { turn: state, cards: [] }, itemsShape: 'rows', items: [] });
const chat = (state: string, sent: any[]) => {
  const s = scripted((m) => (m === 'chat.follow' ? turn(state) : undefined));
  s.runtime.send = (chatId: string, text: string, attachments: string[]) => (sent.push([chatId, text, attachments]), 'send-1');
  return createElement(Thread, {
    runtime: s.runtime,
    chatId: 'c',
    back: () => {},
    drafts: fakeDraft(''),
    media: fakeMedia().media,
  });
};
const sendButton = () => document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null;

test('before chat.follow answers, the composer can send a ready photo without words and survives the reply', async () => {
  const following = deferred<unknown>();
  const s = scripted((method) => {
    if (method === 'chat.follow') return following.promise;
    if (method === 'chat.send') return { sent: true };
    return undefined;
  });
  const v = await mount(
    createElement(Thread, {
      runtime: s.runtime,
      chatId: 'c',
      back: () => {},
      drafts: fakeDraft(''),
      media: fakeMedia().media,
    }),
  );
  try {
    assert.ok(v.host.querySelector('[aria-label="Message this chat"]'));
    assert.equal(sendButton()?.disabled, true);
    await click('Add to session');
    await click('Photos');
    assert.equal(sendButton()?.disabled, false, 'the uploaded photo can be sent before the history arrives');
    await click('Send message');
    assert.deepEqual(
      s.calls.filter(([method]) => method === 'chat.send').map(([, params]) => [params.chatId, params.text, params.attachments]),
      [['c', '', ['0123456789abcdef']]],
    );
    await act(async () => following.resolve(turn('idle')));
    await flush();
    assert.ok(v.host.querySelector('[aria-label="Message this chat"]'));
    assert.equal(sendButton()?.disabled, true, 'the sent attachment was cleared');
  } finally {
    following.resolve(turn('idle'));
    await v.done();
  }
});

test('a chat with a photo attached and no words enables Send and sends the photo alone; with nothing at all it stays off', async () => {
  const sent: any[] = [];
  const v = await mount(chat('idle', sent));
  assert.equal(sendButton()?.disabled ?? true, true, 'nothing typed, nothing attached');
  await click('Add to session');
  await click('Photos');
  assert.equal(sendButton()?.disabled, false, 'the photo is ready');
  await click('Send message');
  assert.deepEqual(sent, [['c', '', ['0123456789abcdef']]]);
  await click('Send message');
  assert.equal(sent.length, 1, 'the attachments left with the message, so a second press has nothing to send');
  // A native press already dispatched before disabling must also find no content to enqueue.
  const button = sendButton()!;
  const propsKey = Object.keys(button).find((key) => key.startsWith('__reactProps'))!;
  await act(async () => (button as any)[propsKey].onClick());
  assert.equal(sent.length, 1, 'the send handler independently refuses an empty message');
  await v.done();
});

test('while a turn runs, a photo alone shows Send beside Stop instead of only Stop', async () => {
  const sent: any[] = [];
  const v = await mount(chat('running', sent));
  assert.equal(
    document.querySelector('button[aria-label="Stop"]') !== null || document.querySelector('[aria-label^="Stop"]') !== null,
    true,
  );
  await click('Add to session');
  await click('Photos');
  assert.ok(sendButton(), 'Send is shown once a file is attached');
  await click('Send message');
  assert.equal(sent.length, 1);
  await v.done();
});

test('a queued message of files shows how many, can be saved with no words, and the outbox keeps it when edited empty', async () => {
  const items = [
    { id: 'a', pairId: 'p', chatId: 'c', text: '', attachments: ['x'], at: 0, status: 'queued', error: null },
    { id: 'b', pairId: 'p', chatId: 'c', text: '   ', attachments: ['x', 'y'], at: 0, status: 'queued', error: null },
  ];
  const saved: string[] = [];
  const v = await mount(
    createElement(QueuedMessages, {
      items,
      cancel: () => {},
      retry: () => {},
      edit: (id: string, text: string) => (saved.push(`${id}:${text}`), true),
    }),
  );
  assert.match(v.host.textContent!, /1 attachment/);
  assert.match(v.host.textContent!, /2 attachments/);
  await act(async () => (v.host.querySelector('button[aria-label="Edit this message"]') as HTMLElement).click());
  const field = v.host.querySelector('input[aria-label="Edit this message"]') as HTMLInputElement;
  assert.ok(field);
  for (const value of ['Photo caption', '']) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  const save = v.host.querySelector('button[aria-label="Save this message"]') as HTMLButtonElement;
  assert.equal(save.disabled, false, 'words are not needed when files go with the message');
  await act(async () => save.click());
  assert.deepEqual(saved, ['a:']);
  await v.done();

  let n = 0;
  const box = createOutbox({
    online: () => false,
    send: async () => undefined,
    lost: () => false,
    idempotent: () => true,
    ready: async () => true,
    newId: () => `send-${++n}`,
    now: () => 1,
    onChange: () => {},
  });
  const withFiles = box.add({ pairId: 'p', chatId: 'c', text: 'hi', attachments: ['x'] });
  assert.equal(box.edit(withFiles, ''), true, 'a message of files may lose its words');
  const bare = box.add({ pairId: 'p', chatId: 'c', text: 'hi', attachments: [] });
  assert.equal(box.edit(bare, '  '), false, 'a message with nothing attached still needs words');
});

test('the Mac takes attachments without words, while a Host rejects unsupported files and accepts negotiated images', () => {
  assert.equal(composed({ text: '', attachments: ['0123456789abcdef'] }), '');
  assert.equal(composed({ attachments: ['0123456789abcdef'], tab: { url: 'https://a.example/x' } }), '[Chrome tab: https://a.example/x]');
  assert.equal(composed({ text: ' hi ', attachments: ['0123456789abcdef'] }), 'hi');
  assert.throws(() => composed({ text: ' ', attachments: [] }), /Type a message first/);
  assert.throws(() => composed({ text: '' }), /Type a message first/);
  const send = (PARSERS as any)['chat.send']({ chatId: 'th-1', text: '', attachments: ['0123456789abcdef'] });
  assert.equal(send.text, '');
  assert.deepEqual(send.attachments, ['0123456789abcdef']);
  assert.throws(() => (PARSERS as any)['chat.send']({ chatId: 'th-1', text: '' }), /Type a message first/);
  // Local attachment ids are not Host image references: refuse them before losing their content.
  for (const method of ['chat.send', 'chat.start']) {
    for (const attachments of [[], ['0123456789abcdef']]) {
      assert.throws(
        () =>
          (HOST_PARSERS as any)[method]({
            chatId: 'th-1',
            text: '',
            attachments,
            epoch: 1,
            key: 'key-12345678',
            harness: 'claude',
            cwd: '/project',
          }),
        attachments.length ? /Files other than images and local skills/ : /Type a message first/,
      );
    }
    const params = { chatId: 'th-1', epoch: 1, key: 'key-12345678', harness: 'claude', cwd: '/project' };
    assert.equal((HOST_PARSERS as any)[method]({ ...params, text: '', images: ['a'.repeat(64)] }).text, '');
    assert.throws(
      () => (HOST_PARSERS as any)[method]({ ...params, text: 'hello', attachments: ['local-file'] }),
      /Files other than images and local skills/,
    );
  }
});

test('New chat starts from a photo alone on this Mac: Start is grey with nothing, ready with a photo, and the start carries the photo with no words', async () => {
  const { runtime, calls } = scripted((m) => (m === 'chat.start' ? { chatId: 'claude:new' } : undefined));
  const { host } = await mountNewChat(runtime, fakeMedia().media);
  assert.equal(button(host, 'Start chat')!.disabled, true);
  await attach('Photo library');
  assert.equal(button(host, 'Start chat')!.disabled, false);
  await click('Start chat');
  const start = calls.find((c) => c[0] === 'chat.start')![1];
  assert.equal(start.text, '');
  assert.deepEqual(start.attachments, ['0123456789abcdef']);
});

test('a queued message of pictures without words says how many pictures, unless the pictures themselves are shown', async () => {
  const base = { pairId: 'p', chatId: 'c', text: '', attachments: [] as string[], at: 0, status: 'queued', error: null };
  const items = [
    { ...base, id: 'a', images: 1 },
    { ...base, id: 'b', images: 2 },
    { ...base, id: 'c', images: 2, attachments: ['x', 'y', 'z'] },
  ];
  const v = await mount(
    createElement(QueuedMessages, {
      items,
      cancel: () => {},
      retry: () => {},
      picturesFor: (id: string) => (id === 'c' ? ['data:image/png;base64,aGVsbG8='] : undefined),
    }),
  );
  assert.match(v.host.textContent!, /1 picture(?!s)/);
  assert.match(v.host.textContent!, /2 pictures/);
  assert.match(v.host.textContent!, /3 attachments/, 'shown pictures leave the files label for the rest');
  await v.done();
});
