// Older messages the reader paged back to survive a read again and a page that repeats rows (#5379): the safety net reads the chat again every few seconds and the computer caps a read, which threw the paged rows away and moved the view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
// the paths are variables, so the root typecheck does not take the whole phone app in with this file
const threadPath = '../mobile/src/screens/Thread';
const earlierPath = '../mobile/src/remote/earlier';
const useEarlierPath = '../mobile/src/remote/useEarlier';
const { Thread } = await import(threadPath);
const { keptAbove, newRows, earlierKey, earlierRow, rowIdentity } = await import(earlierPath);

const rows = (...ids: string[]) => ids.map((id) => ({ id, role: 'user', text: `text ${id}` }));
const snap = (shape: string, items: object[]) => ({ shape, items, history: [] });

test('a read again keeps the held rows that come before its first row, and nothing when it does not start at a held row', () => {
  const held = rows('r1', 'r2', 'r3', 'r4', 'r5');
  assert.deepEqual(
    keptAbove(held, snap('rows', rows('r4', 'r5', 'r6')) as any)?.map((r) => r.id),
    ['r1', 'r2', 'r3'],
  );
  assert.equal(
    keptAbove(held, snap('rows', rows('r1', 'r2')) as any),
    null,
    'the new snapshot reaches the oldest held row: nothing is above it',
  );
  assert.equal(keptAbove(held, snap('rows', rows('x9')) as any), null, 'a first row that was never held: the history changed');
  assert.equal(keptAbove(held, snap('rows', [{ role: 'user', text: 'no id' }]) as any), null);
  assert.equal(keptAbove(held, snap('rows', []) as any), null);
  assert.equal(keptAbove(held, snap('items', rows('r4')) as any), null, 'only a snapshot of rows can be placed among them');
  assert.equal(
    keptAbove([{ role: 'step', text: 'no id' }, ...rows('r2', 'r3')], snap('rows', rows('r3')) as any),
    null,
    'rows above that start at one with no id cannot be paged from',
  );
});

test('a read again with no snapshot before it, or one that is not of rows, forgets what was paged', async () => {
  const { useEarlier } = await import(useEarlierPath);
  let api: any;
  const Probe = () => ((api = useEarlier((async () => ({ rows: rows('r1'), more: true })) as any, 'c')), null);
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => api.load(snap('rows', rows('r5'))));
  assert.deepEqual(
    api.rows.map((r: any) => r.id),
    ['r1'],
  );
  await act(async () => api.reread(snap('items', rows('r5')), snap('rows', rows('r5'))));
  assert.deepEqual(api.rows, [], 'a snapshot that is not of rows cannot be placed among the held rows');
  await act(async () => api.load(snap('rows', rows('r5'))));
  await act(async () => api.reread(null, snap('rows', rows('r5'))));
  assert.deepEqual(api.rows, [], 'nothing before it');
  await act(async () => root.unmount());
});

test('a page adds only the rows that are not held, and a row with no id is always new', () => {
  const held = new Set(['r3', 'r4']);
  assert.deepEqual(
    newRows([...rows('r2', 'r3', 'r4'), { role: 'step', text: 'no id' }], held).map((r) => r.id ?? 'none'),
    ['r2', 'none'],
  );
});

test('a row above the snapshot has the key the snapshot gives it, so moving between them mounts nothing again', () => {
  assert.equal(earlierKey({ id: 'a' }), JSON.stringify(['item', 'a']));
  assert.equal(earlierKey({ id: 'a', phoneId: 'p' }), JSON.stringify(['item', 'p']));
  assert.equal(rowIdentity({ id: 'a', phoneId: 'p' }), 'p');
  assert.equal(earlierKey({ role: 'step' }), null);
  const a = { role: 'step', text: 'no id' };
  const b = { role: 'step', text: 'no id either' };
  assert.notEqual(earlierRow(a).key, earlierRow(b).key, 'two rows that name nothing never share a key');
  assert.equal(earlierRow(a), earlierRow(a), 'a row held is worked out once, and keeps its key');
  assert.equal(earlierRow({ id: 'a' }).key, JSON.stringify(['item', 'a']));
});

function rig(pages: any[]) {
  const listeners = { current: (_e: any) => {} };
  const follow = { items: rows('r10', 'r11') as object[] };
  const calls: any[] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listeners.current = f), () => {}),
    request: async (method: string, p: any) => {
      calls.push([method, p]);
      if (method === 'chat.follow')
        return { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: follow.items };
      if (method === 'chat.read') return pages.shift();
      return {};
    },
  };
  withOutbox(runtime);
  return { runtime, listeners, follow, calls };
}
const mounted: any[] = [];
const mount = async (runtime: any) => {
  for (const old of mounted.splice(0)) await act(async () => old.unmount());
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  return host;
};
const readAgain = async (listeners: any) => {
  await act(async () => listeners.current({ kind: 'event', chatId: 'c', ev: 'items.append', feedSeq: 1, live: false, items: [] }));
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 100)));
};
const order = (host: HTMLElement, ...ids: string[]) => ids.map((id) => host.textContent!.indexOf(`text ${id}`));
const inOrder = (at: number[]) => at.every((n, i) => n >= 0 && (i === 0 || at[i - 1]! < n));

test('a read again that covers fewer rows than were on screen keeps the rows above it, the paged ones and the snapshot rows it no longer reaches, in order (#5379)', async () => {
  const { runtime, listeners, follow, calls } = rig([{ chatId: 'c', rows: rows('r8', 'r9'), more: true }]);
  const host = await mount(runtime);
  await click('Load earlier messages');
  assert.ok(inOrder(order(host, 'r8', 'r9', 'r10', 'r11')));
  // the computer's cap: the read again starts at r11, one row after where the old snapshot started
  follow.items = rows('r11', 'r12');
  await readAgain(listeners);
  assert.ok(inOrder(order(host, 'r8', 'r9', 'r10', 'r11', 'r12')), 'nothing was thrown away and r10 stays between r9 and r11');
  assert.equal(host.textContent!.split('text r10').length - 1, 1, 'r10 once');
  assert.match(host.textContent!, /Load earlier messages/, 'the paged rows are still paged back from their own oldest row');
  await click('Load earlier messages');
  assert.deepEqual(calls.at(-1), ['chat.read', { chatId: 'c', before: 'r8', limit: 40 }]);
});

test('a read again with the same first row changes nothing above it, and one that starts at a row never held forgets what was paged', async () => {
  const { runtime, listeners, follow } = rig([{ chatId: 'c', rows: rows('r8', 'r9'), more: true }]);
  const host = await mount(runtime);
  await click('Load earlier messages');
  follow.items = rows('r10', 'r11', 'r12');
  await readAgain(listeners);
  assert.ok(inOrder(order(host, 'r8', 'r9', 'r10', 'r11', 'r12')));
  follow.items = rows('x1', 'x2');
  await readAgain(listeners);
  assert.equal(host.textContent!.includes('text r8'), false, 'the history changed under the reader');
  assert.ok(inOrder(order(host, 'x1', 'x2')));
});

test('a page that repeats rows already held adds them once; one that adds nothing though there is more is a failure to retry, not the end of the chat', async () => {
  const { runtime, calls } = rig([
    { chatId: 'c', rows: rows('r9', 'r10'), more: true },
    { chatId: 'c', rows: rows('r9', 'r10'), more: true },
    { chatId: 'c', rows: rows('r6', 'r7'), more: false },
  ]);
  const host = await mount(runtime);
  await click('Load earlier messages');
  assert.equal(host.textContent!.split('text r10').length - 1, 1, 'r10 is in the snapshot: not added again');
  assert.ok(inOrder(order(host, 'r9', 'r10', 'r11')));
  await click('Load earlier messages');
  assert.equal(host.textContent!.split('text r9').length - 1, 1);
  assert.match(host.textContent!, /Earlier messages did not load\. Try again\./, 'it says so, and the older history is not hidden');
  assert.match(host.textContent!, /Load earlier messages/, 'the row stays: the person can ask again');
  await click('Load earlier messages');
  assert.deepEqual(calls.at(-1), ['chat.read', { chatId: 'c', before: 'r9', limit: 40 }], 'asked again from the same row');
  assert.ok(inOrder(order(host, 'r6', 'r7', 'r9', 'r10', 'r11')), 'the page that came next is joined above');
  assert.doesNotMatch(host.textContent!, /did not load/);
  assert.doesNotMatch(host.textContent!, /Load earlier messages/, 'the chat starts there');
});

test('a read again that arrives before the screen drew a page that just landed keeps that page', async () => {
  const { useEarlier } = await import(useEarlierPath);
  let api: any;
  const Probe = () => ((api = useEarlier((async () => ({ chatId: 'c', rows: rows('r1'), more: true })) as any, 'c')), null);
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  // the page lands and the read again is handled in the same turn, before React renders the page
  await act(async () => {
    await api.load(snap('rows', rows('r5')));
    api.reread(snap('rows', rows('r5')), snap('rows', rows('r5')));
  });
  assert.deepEqual(
    api.rows.map((r: any) => r.id),
    ['r1'],
    'the page is above the snapshot still',
  );
  await act(async () => root.unmount());
});

test('the computer coming back after it was away follows the chat again: the rows paged to before are not left above a snapshot they were not read with', async () => {
  const { runtime, follow } = rig([{ chatId: 'c', rows: rows('r8', 'r9'), more: true }]);
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  const show = (offline: boolean) =>
    act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft(''), offline })));
  await show(false);
  await flush();
  await click('Load earlier messages');
  assert.ok(inOrder(order(host, 'r8', 'r9', 'r10', 'r11')));
  await show(true);
  follow.items = rows('r30', 'r31');
  await show(false);
  await flush();
  assert.ok(inOrder(order(host, 'r30', 'r31')));
  assert.equal(host.textContent!.includes('text r8'), false, 'no gap: nothing paged to before sits above the new snapshot');
  await act(async () => root.unmount());
});
