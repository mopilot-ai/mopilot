// A chat that runs on a Host, opened while the Mac is away (#4603): the Thread reads it from the machine itself with its history, sends and stops there, instead of "Waiting for your computer…".
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useState } from 'react';
import { act, createElement, createRoot, flush, click, inputText } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { createCardStore } from '../mobile/src/remote/hostCards.ts';
import { createHostChatKit } from '../mobile/src/remote/hostChat.ts';

import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);

const ev = (turnId: string, event: object) => ({ t: 'event', family: 'acp', event: { turnId, ...event } });
const start = (t: string, text: string) =>
  ev(t, { kind: 'turnStart', user: { id: `u-${t}`, clientId: t, content: [{ type: 'text', text }] } });
const said = (t: string, text: string) =>
  ev(t, { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
const done = (t: string) => ev(t, { kind: 'turnEnd', stopReason: 'end_turn' });

// a test that failed before it unmounted must not leave its page for the next one to type into
afterEach(() => document.body.replaceChildren());

async function mount(o: {
  on: boolean;
  macRequests?: string[];
  send?: (p: any) => unknown;
  up?: () => boolean;
  start?: (p: any) => unknown;
  before?: (kit: any) => string;
  /** The Mac is away (the default) or up. */
  macAway?: boolean;
}) {
  const sent: any[] = [];
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
          rev: 3,
          epoch: 4,
          generation: 'g1',
          snapshot: { rev: 3, items: [start('t1', 'Fix the build'), said('t1', 'The build is fixed.'), done('t1')] },
          inFlightEphemeral: [],
        },
      });
      return {};
    },
    send: async (p: any) => {
      await o.send?.(p);
      return sent.push(p), {};
    },
    stop: async (p: any) => (sent.push(p), { stopped: true }),
    start: async (p: any) => {
      await o.start?.(p);
      return sent.push(p), { chatId: p.chatId };
    },
  };
  const phones: any = {
    refresh: async () => true,
    session: async () => session,
    hostKeyOf: () => 'k',
    enrolled: (m: string) => m === 'h1',
    reachable: () => o.up?.() ?? true,
    records: () => [{ machineId: 'h1', name: 'Studio' }],
  };
  const listeners = new Set<() => void>();
  const kit = createHostChatKit({
    enabled: () => o.on,
    phones: () => phones,
    cards,
    newId: () => `id${++n}`,
    changed: () => listeners.forEach((fn) => fn()),
  });
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1, outbox: [] }),
    subscribe: () => () => undefined,
    onEvent: () => () => undefined,
    // the Mac is away: nothing it is asked answers
    request: async (method: string) => {
      o.macRequests?.push(method);
      throw Object.assign(new Error('Your Mac is away.'), { code: 'unreachable' });
    },
    direct: { chat: kit, phones, cards, subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)) },
  };
  withOutbox(runtime);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const chatId = o.before?.(kit) ?? 'c1';
  const control: { setAway: (away: boolean) => void } = { setAway: () => undefined };
  function Screen() {
    const [drafts] = useState(() => fakeDraft(''));
    const [away, setAway] = useState(o.macAway ?? true);
    control.setAway = setAway;
    return createElement(Thread, {
      runtime,
      chatId,
      hostId: 'h1',
      offline: away,
      back: () => {},
      drafts,
    });
  }
  await act(async () => root.render(createElement(Screen)));
  await flush();
  return { host, root, sent, kit, runtime, setMacAway: (away: boolean) => act(async () => control.setAway(away)) };
}

test('a Host chat opened with the Mac away shows its history from the machine and sends there', async () => {
  const macRequests: string[] = [];
  const s = await mount({ on: true, macRequests });
  assert.match(s.host.textContent!, /Fix the build/);
  assert.match(s.host.textContent!, /The build is fixed\./);
  assert.doesNotMatch(s.host.textContent!, /Waiting for your computer/);
  assert.deepEqual(
    macRequests.filter((m) => m.startsWith('chat.follow')),
    [],
    'the Mac is not asked to follow the chat',
  );
  // a message typed here goes to the machine once, under one key, and not to the Mac
  await inputText('Message this chat', 'run the tests');
  await click('Send');
  await flush();
  const sends = s.sent.filter((p) => p.text === 'run the tests');
  assert.equal(sends.length, 1);
  assert.match(sends[0].key, /^phone-[0-9a-f]+$/, 'one key per message');
  assert.equal(macRequests.includes('chat.send'), false);
  await act(async () => s.root.unmount());
  s.host.remove();
});

test('with the flag off the same chat waits for the Mac, as before', async () => {
  const s = await mount({ on: false });
  assert.doesNotMatch(s.host.textContent!, /The build is fixed\./);
  await act(async () => s.root.unmount());
  s.host.remove();
});

const typeAndSend = async (text: string) => {
  await inputText('Message this chat', text);
  await click('Send');
  await flush();
};

test('a message the machine refuses stays on the page as Not sent, with Retry and Delete, and Retry sends it once', async () => {
  let refuse = true;
  const s = await mount({
    on: true,
    send: () => {
      if (refuse) throw Object.assign(new Error('The Host could not take that.'), { code: 'invalid' });
    },
  });
  await typeAndSend('run the tests');
  assert.match(s.host.textContent!, /run the tests/, 'the bubble is there');
  assert.match(s.host.textContent!, /Not sent: The Host could not take that\./, 'with the reason');
  refuse = false;
  await click('Retry');
  await flush();
  assert.equal(s.sent.filter((p) => p.text === 'run the tests').length, 1, 'sent once');
  assert.doesNotMatch(s.host.textContent!, /Not sent/);
  await act(async () => s.root.unmount());
  s.host.remove();
});

test('a message for a machine that does not answer waits in view, and goes when it does', async () => {
  let up = false;
  const s = await mount({ on: true, up: () => up });
  await typeAndSend('later please');
  assert.match(s.host.textContent!, /later please/);
  assert.match(s.host.textContent!, /Will send when Studio is back/);
  assert.equal(s.sent.filter((p) => p.text === 'later please').length, 0);
  await act(async () => s.root.unmount());
  s.host.remove();
});

test('a chat just started on the machine opens at once with its first message sending, called what it was asked, and a refusal is Not sent with Retry', async () => {
  let refuse = true;
  const s = await mount({
    on: true,
    start: () => {
      if (refuse) throw Object.assign(new Error('Sign in to Codex on Studio.'), { code: 'harness_not_configured' });
    },
    before: (kit) => kit.launch('h1', kit.begin('codex'), { text: 'build it' }),
  });
  assert.match(s.host.textContent!, /build it/, 'the prompt is there at once');
  await flush();
  assert.match(s.host.textContent!, /Not sent: Sign in to Codex on Studio\./);
  refuse = false;
  await click('Retry');
  await flush();
  assert.doesNotMatch(s.host.textContent!, /Not sent/);
  assert.equal(s.sent.filter((p) => p.text === 'build it').length, 1);
  await act(async () => s.root.unmount());
  s.host.remove();
});

test('a chat this phone started on the machine follows the machine even with the Mac up; one it did not start follows the Mac', async () => {
  const macRequests: string[] = [];
  const started = await mount({
    on: true,
    macAway: false,
    macRequests,
    before: (kit) => kit.launch('h1', kit.begin('claude'), { text: 'reply with only the word OK' }),
  });
  assert.match(started.host.textContent!, /The build is fixed\./, 'read from the machine');
  assert.equal(
    macRequests.some((m) => m === 'chat.follow'),
    false,
    'the Mac is not asked to follow a chat it does not have',
  );
  await act(async () => started.root.unmount());
  started.host.remove();
  const listed: string[] = [];
  const other = await mount({ on: true, macAway: false, macRequests: listed });
  assert.ok(listed.includes('chat.follow'), 'a chat the phone did not start goes through the Mac while it is there');
  assert.doesNotMatch(other.host.textContent!, /The build is fixed\./);
  await act(async () => other.root.unmount());
  other.host.remove();
});

test('a message still waiting for the machine, or refused by it, keeps its chat on the machine when the Mac comes back', async () => {
  const refuse = true;
  const s = await mount({
    on: true,
    send: () => {
      if (refuse) throw Object.assign(new Error('The Host could not take that.'), { code: 'invalid' });
    },
  });
  await typeAndSend('run the tests');
  assert.match(s.host.textContent!, /Not sent: The Host could not take that\./);
  // the Mac is back: the same chat, drawn again with the Mac up, still holds the message and can still retry it
  await s.setMacAway(false);
  assert.match(s.host.textContent!, /Not sent: The Host could not take that\./, 'the refused message does not vanish');
  assert.match(s.host.textContent!, /The build is fixed\./, 'and the chat is still read from the machine');
  await act(async () => s.root.unmount());
  s.host.remove();
});
