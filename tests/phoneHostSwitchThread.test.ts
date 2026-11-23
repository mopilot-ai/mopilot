// The open thread of a machine chat follows its agent (#4859): after a move is chosen the pill names the agent it goes to, and once the Host has settled it with the next message the pill and the Agent sheet name the agent the chat runs on, without leaving the chat.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useState } from 'react';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { createCardStore } from '../mobile/src/remote/hostCards.ts';
import { createHostChatKit } from '../mobile/src/remote/hostChat.ts';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const controlsPath = '../mobile/src/remote/useChatControls';
const { Thread } = await import(threadPath);
const { notesIn } = await import(controlsPath);

afterEach(() => document.body.replaceChildren());

const AGENTS = [
  { id: 'claude', label: 'Claude Code', state: 'ready', via: 'own' },
  { id: 'codex', label: 'Codex', state: 'ready', via: 'own' },
];
const ev = (turnId: string, event: object) => ({ t: 'event', family: 'acp', event: { turnId, ...event } });

const reads = { n: 0 };
/** What the Host's journal holds for the chat: a re-read of the chat finds all of it, as a real Host's snapshot does. */
const journal: any[] = [];

async function mount() {
  journal.length = 0;
  journal.push(ev('t1', { kind: 'turnStart', user: { id: 'u1', content: [{ type: 'text', text: 'hi' }] } }));
  const cards = createCardStore();
  let n = 0;
  const session: any = {
    subscribe: async (p: any) => {
      kit.chats.onEvent('h1', {
        event: 'frame',
        chatId: p.chatId,
        frame: {
          t: 'hello',
          seq: 0,
          rev: journal.length,
          epoch: 4,
          generation: 'g1',
          snapshot: { rev: journal.length, items: journal },
          inFlightEphemeral: [],
        },
      });
      return {};
    },
    // the reply as the Host's connection hands it over: the envelope around the effect's result
    switchTo: async (p: any) => ({ replayed: false, result: { pending: { harness: p.harness } } }),
    permit: async (p: any) => ({ replayed: false, result: { permission: p.value } }),
    start: async (p: any) => ({ chatId: p.chatId }),
  };
  const phones: any = {
    refresh: async () => true,
    session: async () => session,
    hostKeyOf: () => 'k',
    enrolled: (m: string) => m === 'h1',
    reachable: () => true,
    records: () => [{ machineId: 'h1', name: 'Studio' }],
    // each read of the controls asks the Host's agents once
    agents: () => (reads.n++, AGENTS),
  };
  const listeners = new Set<() => void>();
  const kit = createHostChatKit({
    enabled: () => true,
    phones: () => phones,
    cards,
    newId: () => `id${++n}`,
    changed: () => listeners.forEach((fn) => fn()),
  });
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1, outbox: [] }),
    subscribe: () => () => undefined,
    onEvent: () => () => undefined,
    request: async () => {
      throw Object.assign(new Error('Your Mac is away.'), { code: 'unreachable' });
    },
    direct: { chat: kit, phones, cards, subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)) },
  };
  withOutbox(runtime);
  const begun = kit.begin('claude');
  await kit.start('h1', begun, { text: 'hi' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Screen() {
    const [drafts] = useState(() => fakeDraft(''));
    return createElement(Thread, {
      runtime,
      chatId: begun.chatId,
      hostId: 'h1',
      offline: true,
      back: () => {},
      drafts,
    });
  }
  await act(async () => root.render(createElement(Screen)));
  await flush();
  await flush();
  return { host, kit, chatId: begun.chatId, phones };
}
/** The texts of the buttons on the page: the composer's pill is one of them, and the sheets are closed. */
const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')].map((b) => b.textContent);

test('the pill follows the chosen agent at once, and the settled switch without leaving the chat', async () => {
  const t = await mount();
  assert.match(t.host.textContent!, /Claude Code/);
  await click('Claude Code');
  await click('Agent');
  await click('Codex');
  await flush();
  await flush();
  assert.ok(buttons(t.host).includes('Codex'), 'a move held for the next message is shown by the pill');
  assert.ok(!buttons(t.host).includes('Claude Code'), 'and the pill no longer names the agent it runs on');
  // the Host settles it with the next message: its journal says so, and the turn ends
  const before = reads.n;
  const frame = (rev: number, item: object) => (
    journal.push(item), { event: 'frame', chatId: t.chatId, frame: { t: 'durable', seq: rev, rev, item } }
  );
  await act(async () => {
    t.kit.chats.onEvent('h1', frame(2, { t: 'switch', from: 'claude', to: 'codex', text: 'Claude Code → Codex ›', at: 1, turnId: 't2' }));
    t.kit.chats.onEvent('h1', frame(3, ev('t2', { kind: 'turnEnd', stopReason: 'end_turn' })));
    t.kit.chats.onEvent('h1', frame(4, ev('t1', { kind: 'turnEnd', stopReason: 'end_turn' })));
  });
  // the thread reads the chat again shortly after a turn ends (the feed's re-read)
  await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
  await flush();
  assert.ok(reads.n > before, 'the controls are read again once the chat shows the switch as a note');
  assert.ok(buttons(t.host).includes('Codex'));
  assert.equal(t.kit.chats.agentOf(t.chatId), 'codex');
});

test('the notes of a chat’s saved rows are counted, none for a chat not read yet', () => {
  assert.equal(notesIn(null), 0);
  assert.equal(notesIn({ history: [{ role: 'user' }, { role: 'note' }, { role: 'assistant' }, { role: 'note' }] }), 2);
});

test('a move held and the permission mode set outlive the screen that set them: the kit keeps them, not the runtime made for one screen', () => {
  let n = 0;
  const kit = createHostChatKit({
    phones: () => ({}) as never,
    cards: createCardStore(),
    newId: () => `i${++n}`,
    changed: () => undefined,
  });
  kit.held.moving.set('c', 'codex');
  kit.held.permits.set('c', 'default');
  assert.deepEqual([kit.held.moving.get('c'), kit.held.permits.get('c')], ['codex', 'default']);
});
