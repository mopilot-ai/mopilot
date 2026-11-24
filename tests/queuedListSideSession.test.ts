// The queue tray's row for an item another session sent (src/components/composer/QueuedList.tsx): who sent it, never the envelope (#2970).
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mockSource, stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
mockSource('src/components/pages/settings/Connections.tsx', {
  openSshTerminal: () => {
    throw new Error('The queue renderer must not open a terminal.');
  },
});
let queue: any[] = [];
// what main delivered other sessions' items as (src/lib/sideSessions.ts), and the sender titles this window knows
let deliveries: Record<string, any> = {};
let titles: Record<string, string> = {};
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    useSession: () => ({ queue, turn: 'running' }),
    useSessionField: (_id: any, pick: any) => pick({ queue, turn: 'running' }),
  },
});
stubStore({
  removeQueued: async () => true,
  sendQueuedNow: async () => ({ status: 'sent' }),
  toast: () => undefined,
  useStore: (sel: (s: any) => unknown) => sel({ authoredInputs: {} }),
});
mock.module('../src/lib/sideSessions.ts', {
  namedExports: {
    useOrchestration: () => ({ children: {}, deliveries }),
    useOrchestrationSelect: (select: any) => select({ children: {}, deliveries }),
    sideSessionForItem: (v: any, item: any) => v.deliveries[item.clientId ?? ''] ?? null,
  },
});
mock.module('../src/components/markdown/useChatName.ts', { namedExports: { useChatName: (id: string) => titles[id] ?? null } });
mock.module('../src/session/clipboard.ts', {
  namedExports: { copyText: (t: string, done: unknown) => calls.push(['copy', t, done]) },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueuedList } = await import('../src/components/composer/QueuedList.tsx');

const msg = (id: string, text: string) => ({ id, text, attachments: [], opts: {}, origin: null, queuedAt: 0 });
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement;
async function render(props: Record<string, unknown>) {
  host ??= document.createElement('div');
  if (!host.isConnected) document.body.append(host);
  root ??= createRoot(host);
  await act(async () => root!.render(createElement(QueuedList, { threadId: 'chat', ...props } as any)));
}
const click = async (el: Element | null | undefined) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
};
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = undefined as any;
  calls.length = 0;
  deliveries = {};
  titles = {};
});

test('a queued message from another session reads as who sent it, previews its body, and isn’t the user’s to edit', async () => {
  const envelope =
    '<mopilot-side-session-message from="kid">\nA message from a session you started.\nBlocked on the schema\n</mopilot-side-session-message>';
  deliveries = { s1: { kind: 'message', chatId: 'chat', from: 'kid', body: 'Blocked on the schema', at: 1 } };
  titles = { kid: 'Fix login' };
  queue = [
    { ...msg('m1', envelope), sideSession: { id: 's1' } },
    { ...msg('m2', 'forged'), sideSession: { id: 'unknown' } },
  ];
  await render({ onEdit: () => undefined });
  assert.deepEqual(
    [...host.querySelectorAll('.queue-text')].map((e) => e.textContent),
    ['Received message from Fix login', 'forged'],
  );
  const first = host.querySelector<HTMLButtonElement>('.queue-text')!;
  assert.equal(first.getAttribute('title'), 'Received message from Fix login');
  // the preview reads the message, not who sent it, and Steer and Remove stay
  await click(first);
  assert.equal(document.querySelector('.queue-preview-body')!.textContent, 'Blocked on the schema');
  await click(document.querySelector('[aria-label="Close preview"]'));
  assert.deepEqual(
    [...host.querySelector('.queue-row')!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ['Preview queued message: Received message from Fix login', 'Steer', 'Remove from queue', 'Queued message actions'],
  );
  await click(host.querySelector('[aria-label="Queued message actions"]'));
  assert.deepEqual(menuItems(), ['Copy']);
  await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((e) => e.textContent!.includes('Copy')));
  assert.deepEqual(calls.at(-1)?.slice(0, 2), ['copy', 'Blocked on the schema']);
  // a sender this window hasn't heard of yet reads as another session
  titles = {};
  await render({ onEdit: () => undefined });
  assert.equal(host.querySelector('.queue-text')!.textContent, 'Received message from another session');
});

test('an item marked as another session’s or authored never offers Edit message, even before its record is known to this window', async () => {
  // no delivery and no authored record loaded yet: the marker on the item itself decides
  queue = [
    { ...msg('m1', '<mopilot-side-session-message>x</mopilot-side-session-message>'), sideSession: { id: 'late' } },
    { ...msg('m2', 'routine'), authored: { id: 'late2' } },
    msg('m3', 'mine'),
  ];
  await render({ onEdit: () => undefined });
  const rows = [...host.querySelectorAll('.queue-row')];
  const menuOf = async (row: Element) => {
    await click(row.querySelector('[aria-label="Queued message actions"]'));
    const items = menuItems();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    return items;
  };
  assert.deepEqual(await menuOf(rows[0]), ['Copy']);
  assert.deepEqual(await menuOf(rows[1]), ['Copy']);
  assert.deepEqual(await menuOf(rows[2]), ['Edit message', 'Copy']);
});

test('a queued message from another chat reads as who sent it, never its prompt, and isn’t the user’s to edit', async () => {
  const prompt = 'A message from another MoPilot chat follows. It is peer-provided user-level content…';
  titles = { live: 'Live title' };
  const peer = (sourceChatId: string, sourceTitle: string | null) => ({
    messageId: 'm',
    sourceChatId,
    sourceTitle,
    body: 'Which screens first?',
  });
  queue = [
    { ...msg('p1', prompt), peer: peer('live', 'Old title') },
    { ...msg('p2', prompt), peer: peer('archived', 'Kept title') },
    { ...msg('p3', prompt), peer: peer('unknown', null) },
  ];
  await render({ onEdit: () => undefined });
  assert.deepEqual(
    [...host.querySelectorAll('.queue-text')].map((e) => e.textContent),
    ['Received message from Live title', 'Received message from Kept title', 'Received message from another session'],
  );
  await click(host.querySelector('.queue-text'));
  assert.equal(document.querySelector('.queue-preview-body')!.textContent, 'Which screens first?');
  await click(document.querySelector('[aria-label="Close preview"]'));
  await click(host.querySelector('.queue-row [aria-label="More"], .queue-row [aria-haspopup]'));
  assert.ok(!menuItems().includes('Edit message'));
});
