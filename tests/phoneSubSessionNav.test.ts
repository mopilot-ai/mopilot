// Sub-sessions on the phone: a parent chat lists none at its end (the list nests them), a sub-session's header names its parent, and the chat trail pops back level by level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);

const CHATS = [
  { id: 'p1', title: 'Fix login', state: 'idle', harness: 'claude' },
  { id: 'k1', title: 'Write tests', state: 'running', parentId: 'p1', harness: 'codex' }, // a waiting child takes the parent's tap to its question (phoneLinkedSessions)
  { id: 'k2', title: '', state: 'running', parentId: 'p1' },
];

async function app() {
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
      if (method === 'chats.recent') return { chats: CHATS };
      if (method === 'chat.follow') {
        return {
          rev: 1,
          feedSeq: 0,
          session: { turn: 'idle', cards: [] },
          itemsShape: 'rows',
          items: [{ role: 'assistant', text: `In ${p.chatId}` }],
        };
      }
      return {};
    },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  return { host, root, stack: () => host.querySelector('[data-stack]')!.getAttribute('data-stack') };
}

test('a parent chat shows no sub-session card; its sub-sessions open from the list and Back returns to the list', async () => {
  const a = await app();
  await click('Open chat Fix login');
  assert.match(a.host.textContent!, /In p1/);
  assert.doesNotMatch(a.host.textContent!, /sub-session/i);
  assert.equal(a.stack(), 'home chat:p1');
  await click('Back to chats');
  assert.equal(a.stack(), 'home');
  await act(async () => a.root.unmount());
  a.host.remove();
});

test('two pops delivered together (a long press on Back) land two levels down, at the list', async () => {
  const trailPath = '../mobile/src/useChatTrail';
  const { useChatTrail } = await import(trailPath);
  let t: any;
  const Probe = () => {
    t = useChatTrail();
    return null;
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  await act(async () => t.push('orphan'));
  assert.deepEqual([t.chat, t.trail], ['orphan', []], 'nothing open: nothing to return to');
  await act(async () => t.show('p'));
  await act(async () => t.push('c'));
  await act(async () => t.push('g'));
  assert.deepEqual([t.chat, t.trail], ['g', ['p', 'c']]);
  await act(async () => {
    t.pop();
    t.pop();
  });
  assert.deepEqual([t.chat, t.trail], ['p', []]);
  await act(async () => t.clear());
  assert.deepEqual([t.chat, t.trail], [null, []]);
  await act(async () => root.unmount());
});

test('Back from a sub-session of an untitled chat is read as going back to the chat', async () => {
  const trailPath = '../mobile/src/useChatTrail';
  const { chatHeader } = await import(trailPath);
  const chats = [
    { id: 'p', title: '' },
    { id: 'c', title: 'Child', parentId: 'p', pinned: true },
  ];
  assert.deepEqual(chatHeader(chats, 'c', ['p']), {
    title: 'Child',
    subtitle: 'Sub-session of Untitled chat',
    pinned: true,
    backLabel: 'Back to the chat',
  });
  assert.deepEqual(chatHeader(chats, null, []), { title: undefined, subtitle: undefined, pinned: false, backLabel: undefined });
});

test('pinning reads the list again and archiving leaves the chat for the list, from the chat’s ⋯', async () => {
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
  const asked: string[] = [];
  const runtime: any = {
    snapshot: () => snap,
    subscribe: () => () => {},
    start: async () => {},
    connect: async () => {},
    onEvent: () => () => {},
    request: async (method: string) => {
      asked.push(method);
      if (method === 'machine.hello')
        return { capabilities: { methods: ['options.get', 'chats.pin', 'chats.archive'], archiveChats: true } };
      if (method === 'chats.recent') return { chats: [{ id: 'p1', title: 'Fix login', state: 'idle' }] };
      if (method === 'chat.follow') return { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] };
      if (method === 'options.get')
        return { harnessId: 'claude', models: [], permission: { value: 'default', rows: [{ id: 'default', label: 'Manual' }] } };
      if (method === 'chats.pin') return { pinned: true };
      if (method === 'chats.archive') return { archived: true };
      return {};
    },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  const stack = () => host.querySelector('[data-stack]')!.getAttribute('data-stack');
  await click('Open chat Fix login');
  const reads = () => asked.filter((m) => m === 'chats.recent').length;
  const before = reads();
  await click('Chat menu');
  await click('Pin');
  await flush();
  assert.ok(reads() > before, 'the list is read again after a pin');
  await click('Chat menu');
  await click('Archive');
  await flush();
  assert.equal(stack(), 'home', 'an archived chat closes');
  // the laptop says where the chat runs and opens the Mac's settings
  await click('Open chat Fix login');
  await click('Runs on Mac, Connected');
  assert.match(stack()!, /settings/);
  await act(async () => root.unmount());
  host.remove();
});

test('a chat opened to ask what should change in a plan says so, and only until the trail moves', async () => {
  const trailPath = '../mobile/src/useChatTrail';
  const { useChatTrail } = await import(trailPath);
  let t: any;
  const Probe = () => {
    t = useChatTrail();
    return null;
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  assert.equal(t.ask, null);
  await act(async () => t.show('c', 'plan-key'));
  assert.deepEqual([t.chat, t.ask], ['c', 'plan-key']);
  await act(async () => t.show('c'));
  assert.equal(t.ask, null, 'opened again as itself, it asks nothing');
  await act(async () => t.show('c', 'plan-key'));
  await act(async () => t.push('g'));
  assert.equal(t.ask, null, 'a linked chat is not that question');
  await act(async () => t.show('c', 'plan-key'));
  await act(async () => t.pop());
  assert.equal(t.ask, null);
  await act(async () => t.show('c', 'plan-key'));
  await act(async () => t.clear());
  assert.equal(t.ask, null);
  await act(async () => root.unmount());
});
