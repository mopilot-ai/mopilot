// M3 entry points in the app and the thread: New chat, Changes, attachments and voice in the composer, hidden where media is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText } from './support/phone/component-kit';
import { scripted, fakeMedia, chunkReply } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';
const appModulePath = '../mobile/src/MobileApp';
const attachmentsModulePath = '../mobile/src/remote/useAttachments';
const clientModulePath = '../mobile/src/remote/client';
const threadModulePath = '../mobile/src/screens/Thread';
const { MobileApp } = await import(appModulePath);
const { Thread } = await import(threadModulePath);

const snap = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
  selectedPair: 'p',
  safetyNumber: null,
  pendingPair: false,
  error: null,
};
const follow = { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] };
const mounted: any[] = [];
async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return host;
}
const appRuntime = (extra: (m: string, p: any) => unknown = () => undefined) => {
  const s = scripted(
    (m, p) =>
      m === 'chats.recent'
        ? { chats: [{ id: 'c', title: 'Old chat' }] }
        : m === 'chat.follow'
          ? follow
          : m === 'chat.start'
            ? { chatId: 'c2' }
            : extra(m, p),
    snap,
  );
  s.runtime.start = async () => {};
  return s;
};

test('the app offers New chat, opens the started chat, and reaches Changes from a chat', async () => {
  const { runtime, calls } = appRuntime((m) => (m === 'diff.list' ? { files: [] } : undefined));
  const host = await mount(createElement(MobileApp, { runtime, media: fakeMedia().media }));
  await click('New chat');
  assert.ok(host.querySelector('input[placeholder="Describe a task or ask a question"]'));
  await click('Back');
  await click('New chat');
  await inputText('Describe a task or ask a question', 'hello');
  await click('Start chat');
  assert.ok(calls.some((c) => c[0] === 'chat.follow' && c[1].chatId === 'c2'));
  assert.ok(host.querySelector('[aria-label="Message this chat"]'), 'the chat is open');
  await click('Chat menu');
  await click('Changes');
  assert.match(host.textContent!, /No changes here yet/);
  await click('Back to chat');
  assert.ok(host.querySelector('[aria-label="Message this chat"]'), 'the chat is open');
  await click('Back to chats');
  assert.ok(host.querySelector('button[aria-label="Open menu"]'), 'back on Chats');
});

test('without media the app hides New chat and the thread hides attachments and voice', async () => {
  const { runtime } = appRuntime();
  const host = await mount(createElement(MobileApp, { runtime }));
  assert.doesNotMatch(host.textContent!, /New chat/);
  await click('Open chat');
  assert.doesNotMatch(host.textContent!, /Photo library|Record voice note/);
});

test('a thread message carries its attachments, waits for uploads, and takes a dictated draft', async () => {
  let attach: (v: unknown) => void = () => {};
  const { runtime, calls } = scripted((m, p) =>
    m === 'chat.follow'
      ? follow
      : m === 'chat.attach' && p.purpose === 'file'
        ? new Promise((r) => (attach = r))
        : m === 'chat.transcribe'
          ? { text: 'dictated' }
          : m === 'chat.send'
            ? {}
            : undefined,
  );
  let draft = 'typed';
  let cleared = '';
  const render = () =>
    createElement(Thread, {
      runtime,
      chatId: 'c',
      back: () => {},
      drafts: fakeDraft(draft, { set: (t: string) => (draft = t), clear: (t: string) => (cleared = t) }),
      media: fakeMedia().media,
    });
  const host = await mount(render());
  await click('Add to session');
  await click('Photos');
  const send = () => host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
  assert.equal(send().disabled, true);
  await act(async () => attach(chunkReply({ stream: 's', index: 0, total: 1, purpose: 'file', name: 'photo.jpg' })));
  await flush();
  assert.equal(send().disabled, false);
  await click('Record voice note');
  await click('Stop and transcribe');
  await click('Use text');
  assert.equal(draft, 'typed dictated');
  await click('Send');
  const sent = calls.find((c) => c[0] === 'chat.send')![1];
  // the dictated words are in the draft the send reads: the text typed and the words added to it
  assert.deepEqual([sent.text, sent.attachments], ['typed dictated', ['0123456789abcdef']]);
  assert.equal(cleared, 'typed dictated');
  assert.equal(host.querySelector('[aria-label^="photo.jpg"]'), null);
  await act(async () =>
    mounted[0].root.render(
      createElement(Thread, {
        runtime,
        chatId: 'c',
        back: () => {},
        drafts: fakeDraft(''),
        media: fakeMedia().media,
      }),
    ),
  );
  await flush();
});

test('a dictated note fills an empty thread draft', async () => {
  const { runtime } = scripted((m) => (m === 'chat.follow' ? follow : m === 'chat.transcribe' ? { text: 'only' } : undefined));
  let draft = '';
  await mount(
    createElement(Thread, {
      runtime,
      chatId: 'c',
      back: () => {},
      drafts: fakeDraft(draft, { set: (t: string) => (draft = t) }),
      media: fakeMedia().media,
    }),
  );
  await click('Record voice note');
  await click('Stop and transcribe');
  await click('Use text');
  assert.equal(draft, 'only');
});

test('retry only restarts a failed or cancelled file, never a sending, done or unknown one', async () => {
  const { useAttachments } = await import(attachmentsModulePath);
  const { ownedRequest } = await import(clientModulePath);
  let mode = 'fail';
  const { runtime, calls } = scripted((m, p) =>
    m === 'chat.attach' ? (mode === 'fail' ? Promise.reject(new Error('no')) : chunkReply(p)) : undefined,
  );
  let api: any;
  const Probe = () => {
    api = useAttachments(ownedRequest(runtime));
    return null;
  };
  await mount(createElement(Probe));
  const file = { name: 'a.jpg', mime: 'image/jpeg', base64: 'QUJD' };
  await act(async () => api.add(file));
  await flush();
  assert.equal(api.items[0].state, 'failed');
  mode = 'ok';
  await act(async () => api.retry(99));
  assert.equal(calls.length, 1);
  await act(async () => api.retry(api.items[0].key));
  await flush();
  assert.equal(api.items[0].state, 'done');
  await act(async () => api.retry(api.items[0].key));
  assert.equal(calls.length, 2);
  assert.deepEqual(api.ids, ['0123456789abcdef']);
});

test('removing a file that is still sending aborts it and drops it', async () => {
  const { useAttachments } = await import(attachmentsModulePath);
  const { ownedRequest } = await import(clientModulePath);
  const { runtime } = scripted((m) => (m === 'chat.attach' ? new Promise(() => {}) : undefined));
  let api: any;
  const Probe = () => {
    api = useAttachments(ownedRequest(runtime));
    return null;
  };
  await mount(createElement(Probe));
  await act(async () => api.add({ name: 'a.jpg', mime: 'image/jpeg', base64: 'QUJD' }));
  assert.equal(api.items[0].state, 'sending');
  await act(async () => api.remove(api.items[0].key));
  await flush();
  assert.deepEqual(api.items, []);
});

test('a dropped connection keeps the new chat message, and it comes back with the screen', async () => {
  const s = appRuntime();
  const listeners = new Set<() => void>();
  s.runtime.subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
  const notify = async (snapshot: any) => {
    s.state.snap = snapshot;
    await act(async () => listeners.forEach((f) => f()));
    await flush();
  };
  const host = await mount(createElement(MobileApp, { runtime: s.runtime, media: fakeMedia().media }));
  await click('New chat');
  await inputText('Describe a task or ask a question', 'half written');
  await notify({ ...snap, phase: 'offline', generation: 2, selectedPair: null });
  assert.equal(host.querySelector('input[placeholder="Describe a task or ask a question"]'), null);
  await notify({ ...snap, generation: 3 });
  assert.ok(host.querySelector('input[placeholder="Describe a task or ask a question"]'));
  assert.equal(host.querySelector<HTMLInputElement>('input[placeholder="Describe a task or ask a question"]')!.value, 'half written');
  await inputText('Describe a task or ask a question', 'done');
  await click('Start chat');
  await click('Back to chats');
  await click('New chat');
  assert.equal(host.querySelector<HTMLInputElement>('input[placeholder="Describe a task or ask a question"]')!.value, '');
});

test('another account does not land in the previous account’s New chat', async () => {
  const s = appRuntime();
  const listeners = new Set<() => void>();
  s.runtime.subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
  const notify = async (snapshot: any) => {
    s.state.snap = snapshot;
    await act(async () => listeners.forEach((f) => f()));
    await flush();
  };
  const host = await mount(createElement(MobileApp, { runtime: s.runtime, media: fakeMedia().media }));
  await click('New chat');
  await notify({ ...snap, user: { id: 'other' }, generation: 2 });
  assert.equal(host.querySelector('input[placeholder="Describe a task or ask a question"]'), null);
  assert.ok(host.querySelector('button[aria-label="Open menu"]'), 'back on Chats');
});

test('retrying a multi-part upload resumes the same stream from the confirmed part', async () => {
  const { useAttachments, uploadRetry } = await import(attachmentsModulePath);
  const { ownedRequest } = await import(clientModulePath);
  // no waits: the part is refused at once and the person retries (an upload under way otherwise waits for the computer: phoneAttachmentMemory)
  const waits = uploadRetry.waits;
  uploadRetry.waits = [];
  let fail = true;
  const { runtime, calls } = scripted((m, p) => {
    if (m !== 'chat.attach') return undefined;
    if (p.index === 1 && fail) return Promise.reject(new Error('Computer is offline'));
    return chunkReply(p);
  });
  let api: any;
  const Probe = () => {
    api = useAttachments(ownedRequest(runtime));
    return null;
  };
  await mount(createElement(Probe));
  await act(async () => api.add({ name: 'big.jpg', mime: 'image/jpeg', base64: 'A'.repeat(160_000 + 8) }));
  await flush();
  assert.deepEqual([api.items[0].state, api.items[0].sent], ['failed', 1]);
  fail = false;
  await act(async () => api.retry(api.items[0].key));
  await flush();
  assert.equal(api.items[0].state, 'done');
  const attach = calls.filter((c) => c[0] === 'chat.attach').map((c) => [c[1].stream, c[1].index]);
  assert.equal(new Set(attach.map((a) => a[0])).size, 1);
  assert.deepEqual(
    attach.map((a) => a[1]),
    [0, 1, 1],
  );
  uploadRetry.waits = waits;
});

test('the app opens the terminal from a chat and returns to it', async () => {
  const s = appRuntime((m) => (m === 'pty.open' ? { resumed: false, at: 0, truncated: false } : undefined));
  const host = await mount(createElement(MobileApp, { runtime: s.runtime, media: fakeMedia().media }));
  await click('Open chat');
  await click('Chat menu');
  await click('Terminal');
  assert.match(host.textContent!, /A shell in this chat's folder/);
  await click('Back to chat');
  await click('Back to chats');
  assert.ok(host.querySelector('button[aria-label="Open menu"]'), 'back on Chats');
});
