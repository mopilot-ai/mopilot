// Links to a MoPilot chat in a reply on the phone: `mopilot:chat/<id>` opens that chat over the one it is in (Back returns there); other links go to iOS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
const appPath = '../mobile/src/MobileApp';
const linksPath = '../mobile/src/chatLinks';
const markdownPath = '../mobile/src/components/Markdown';
const { MobileApp } = await import(appPath);
const { chatIdOfLink, ChatLinkContext } = await import(linksPath);
const { Markdown } = await import(markdownPath);

const CHATS = [
  {
    id: 'claude:parent-1',
    title: 'Fix phone',
    state: 'idle',
    harness: 'claude',
  },
  {
    id: 'claude:side-2',
    title: 'Side work',
    state: 'running',
    harness: 'claude',
  },
];
const REPLY: Record<string, string> = {
  'claude:parent-1': 'Started [Side work](mopilot:chat/claude:side-2) and [this chat](mopilot:chat/claude:parent-1).',
  'claude:side-2': 'In the side chat. [Parent](mopilot:chat/claude:parent-1)',
};

const linkNamed = (host: Element, name: string) =>
  [...host.querySelectorAll('[role="link"]')].find((el) => el.textContent === name) as HTMLElement;

async function app(review = false) {
  const snap = {
    phase: 'online',
    generation: 1,
    user: { id: 'u' },
    pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
    selectedPair: 'p',
    safetyNumber: null,
    pendingPair: false,
    presence: {},
    reconnect: null,
    error: null,
  };
  const runtime: any = {
    snapshot: () => snap,
    subscribe: () => () => {},
    start: async () => {},
    connect: async () => {},
    onEvent: () => () => {},
    request: async (method: string, p: any) => {
      if (method === 'chats.recent') return { chats: review ? [{ ...CHATS[0], state: 'waiting' }, CHATS[1]] : CHATS };
      if (method === 'chat.follow')
        return {
          rev: 1,
          feedSeq: 0,
          session: {
            turn: 'idle',
            cards:
              review && p.chatId === CHATS[0].id
                ? [
                    {
                      id: 'plan',
                      rev: 1,
                      kind: 'plan',
                      title: 'Review plan',
                      plan: { text: REPLY[p.chatId] },
                      choices: [{ key: 'ok', label: 'Approve' }],
                    },
                  ]
                : [],
          },
          itemsShape: 'rows',
          items: [{ role: 'assistant', text: REPLY[p.chatId] }],
        };
      return {};
    },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  return {
    host,
    root,
    stack: () => host.querySelector('[data-stack]')!.getAttribute('data-stack'),
  };
}

test('chatIdOfLink names the chat of a MoPilot chat link and nothing else', () => {
  assert.equal(chatIdOfLink('mopilot:chat/claude:c34fdae5'), 'claude:c34fdae5');
  assert.equal(chatIdOfLink('mopilot://chat/acp%3Ahost-claude%3Aab'), 'acp:host-claude:ab');
  assert.equal(chatIdOfLink('mopilot:chat/codex:1?from=reply#top'), 'codex:1');
  assert.equal(chatIdOfLink('mopilot:chat/'), null, 'no id');
  assert.equal(chatIdOfLink('mopilot:chat/%E0%A4%A'), null, 'a malformed escape');
  assert.equal(chatIdOfLink('https://github.com/mopilot-ai/mopilot-internal/issues/4193'), null);
  assert.equal(chatIdOfLink('mopilot://pair?code=x'), null);
  assert.equal(chatIdOfLink(undefined), null);
});

test('a chat link in a reply opens that chat over this one, Back returns to it, and a link to the open chat stays put', async () => {
  const a = await app();
  await click('Open chat Fix phone');
  assert.equal(a.stack(), 'home chat:claude:parent-1');
  (globalThis as any).__openedUrls = [];

  await act(async () => linkNamed(a.host, 'this chat').click());
  await flush();
  assert.equal(a.stack(), 'home chat:claude:parent-1', 'the open chat is not opened again');

  await act(async () => linkNamed(a.host, 'Side work').click());
  await flush();
  assert.match(a.host.textContent!, /In the side chat/);
  assert.match(a.stack()!, /chat:claude:side-2$/);
  assert.deepEqual((globalThis as any).__openedUrls, [], 'never handed to iOS');

  await click('Back to Fix phone');
  assert.equal(a.stack(), 'home chat:claude:parent-1', 'Back returns to the chat the link was in');
  await act(async () => a.root.unmount());
  a.host.remove();
});

test('other links go to iOS; a chat link where no chat can open does nothing', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const opened: string[] = [];
  (globalThis as any).__openedUrls = [];
  const text = '[issue](https://github.com/mopilot-ai/mopilot-internal/issues/4193) and [chat](mopilot:chat/claude:x)';
  await act(async () =>
    root.render(createElement(ChatLinkContext.Provider, { value: (id: string) => opened.push(id) }, createElement(Markdown, { text }))),
  );
  await act(async () => linkNamed(host, 'issue').click());
  await act(async () => linkNamed(host, 'chat').click());
  assert.deepEqual((globalThis as any).__openedUrls, ['https://github.com/mopilot-ai/mopilot-internal/issues/4193']);
  assert.deepEqual(opened, ['claude:x']);

  // outside the app's provider (a card's plan text before the app is up): the tap is ignored, not sent to iOS
  await act(async () => root.render(createElement(Markdown, { text })));
  await act(async () => linkNamed(host, 'chat').click());
  assert.deepEqual((globalThis as any).__openedUrls, ['https://github.com/mopilot-ai/mopilot-internal/issues/4193']);
  (globalThis as any).__linkFails = true;
  await act(async () => linkNamed(host, 'issue').click());
  (globalThis as any).__linkFails = false;
  await act(async () => root.unmount());
  host.remove();
});

test('cyclic links and same-tick repeated taps keep native chat routes unique', async () => {
  const a = await app();
  await click('Open chat Fix phone');
  await act(async () => {
    const link = linkNamed(a.host, 'Side work');
    link.click();
    link.click();
  });
  await flush();
  assert.equal(a.stack(), 'home chat:claude:parent-1 chat:claude:side-2');
  await act(async () => linkNamed(a.host, 'Parent').click());
  await flush();
  assert.equal(a.stack(), 'home chat:claude:parent-1');
  await click('Back to chats');
  assert.equal(a.stack(), 'home');
  await act(async () => a.root.unmount());
  a.host.remove();
});

test('a chat link in a quick-review plan dismisses the sheet and returns to the source chat', async () => {
  const a = await app(true);
  await click('Open chat Fix phone');
  assert.ok(a.host.querySelector('[data-screen="answer"]'));
  await act(async () => linkNamed(a.host, 'Side work').click());
  await flush();
  assert.equal(a.stack(), 'home chat:claude:parent-1 chat:claude:side-2');
  assert.equal(a.host.querySelector('[data-screen="answer"]'), null);
  await click('Back to Fix phone');
  assert.equal(a.stack(), 'home chat:claude:parent-1');
  await act(async () => a.root.unmount());
  a.host.remove();
});
