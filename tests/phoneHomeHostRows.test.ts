// Home's rows for chats a machine holds (#4717): a chat this phone started on a machine has a row of its own where the Mac lists none, a row that goes through its machine opens as a chat, and a machine page opened from Home goes back to Home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush } from './support/phone/component-kit';
import { CARD, HOST_KEY, local, open, path, studio } from './support/phone/machine-page-kit';
import { waitFor } from './support/waitFor.ts';

const rowOf = (title: string) =>
  [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').includes(title)) as HTMLElement | undefined;

/** A direct path whose chat kit knows chats this phone started on the machine. */
function started(chats: { chatId: string; title: string; at: number }[], on = true) {
  const p = path({ enrolled: true });
  (p.direct as any).chat = {
    enabled: () => on,
    told: () => undefined,
    startedOn: (machineId: string) => (machineId === 'h1' ? chats.map((c) => ({ ...c, machineId: 'h1' })) : []),
    hostOf: (chatId: string) => (chats.some((c) => c.chatId === chatId) ? 'h1' : undefined),
    items: () => [],
    titleOf: () => undefined,
    onFeed: () => () => undefined,
    onSent: () => () => undefined,
    cards: p.direct.cards,
  };
  return p;
}

test('a chat this phone started on a machine is a Home row with the Mac awake, though the Mac lists none; its card puts it under Needs input; a tap opens the chat', async () => {
  const p = started([{ chatId: 'chat-new', title: 'Started here', at: 50 }]);
  await p.direct.phones.load();
  await open({ direct: p.direct, machines: [local, studio], home: true, chats: [] });
  // an idle chat is in the list, as any other
  assert.match(document.body.textContent!, /Started here/, 'the chat has a Home row');
  assert.doesNotMatch(document.body.textContent!, /Quiet/);
  assert.doesNotMatch(document.body.textContent!, /Needs input/);
  // the machine holds a card on it: it waits, says where, and still opens as a chat (its card is drawn in the thread)
  await act(async () => p.direct.cards.setPending(HOST_KEY, [{ ...CARD, chatId: 'chat-new' }] as any));
  await flush();
  assert.match(document.body.textContent!, /Needs input/);
  assert.match(document.body.textContent!, /Needs you on Studio/);
  await act(async () => rowOf('Started here')!.click());
  await flush();
  assert.equal(document.querySelector('[data-screen="settings"]'), null, 'not the machine page');
  assert.match(document.querySelector('[data-stack]')!.getAttribute('data-stack')!, /chat/);
});

test('with the Mac listing the chat and the machine holding a card on it, the row opens the chat too, not the machine page', async () => {
  const p = started([]);
  await p.direct.phones.load();
  p.direct.cards.setPending(HOST_KEY, [CARD] as any);
  const chat = { id: 'c1', title: 'Started elsewhere', state: 'running', updatedAt: Date.now(), hostId: 'h1', project: 'repo' };
  await open({ direct: p.direct, machines: [local, studio], home: true, chats: [chat] });
  await act(async () => rowOf('Started elsewhere')!.click());
  await flush();
  assert.equal(document.querySelector('[data-screen="settings"]'), null, 'not the machine page');
  assert.match(document.querySelector('[data-stack]')!.getAttribute('data-stack')!, /chat/);
});

test('a machine page opened from a Home machine row goes back to Home, and so does Remove this machine', async () => {
  const p = path({ enrolled: true });
  await p.direct.phones.load();
  await open({ direct: p.direct, machines: [local, studio], home: true });
  const studioRow = () =>
    [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Studio')) as HTMLElement;
  await act(async () => studioRow().click());
  await flush();
  assert.ok(document.querySelector('[data-screen="settings"]'));
  await click('Back');
  await flush();
  assert.equal(document.querySelector('[data-screen="settings"]'), null, 'Back lands on Home');
  await act(async () => studioRow().click());
  await flush();
  await click('Remove this machine');
  await click('Remove');
  await waitFor(() => !('h1' in p.stored()), 'the record to go');
  await waitFor(() => document.querySelector('[data-screen="settings"]') === null, 'Home to be shown');
});
