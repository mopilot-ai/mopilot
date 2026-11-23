// src/components/thread/SessionStack.tsx and items/sessionRuns.ts: sessions a turn started back to back join into one
// stack of live cards on any harness; past SHOWN + 1 the rest fold behind a line that counts them by state, and a card
// that needs the user is never folded away.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, click } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const store = fakeStore<any>({ runtime: {}, segments: {}, archived: [], claudeArchived: {}, agentTabs: {} });
let notify: (v: any) => void = () => {};
const empty = { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
stubStore({ useStore: store.useStore, openInSplit: () => {}, navigate: () => {}, toast: () => {}, chatKind: () => 'claude' });
installNativeStub({ orchestration: { snapshot: async () => empty, onChanged: (cb: any) => ((notify = cb), () => {}) } });
// each chat's row state (the sidebar dot's), set by hand per chat
const rows: Record<string, string> = {};
mock.module('../src/session/useChatRowState.ts', {
  namedExports: {
    useChatRowState: (id: string) => (rows[id] ? { state: rows[id] } : null),
    useChatTurn: () => 'idle',
    retryChatState: async () => {},
  },
});
const { sessionToolCall } = await import('../src/lib/sessionToolCall.ts');
const { SessionStack, foldLine, SHOWN } = await import('../src/components/thread/SessionStack.tsx');
const { joinSessionCards } = await import('../src/components/thread/items/sessionRuns.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const startItem = (chatId: string, title = chatId) => ({
  type: 'mcpToolCall',
  id: `call-${chatId}`,
  server: 'sage_ab12',
  tool: 'start_session',
  status: 'completed',
  arguments: {},
  result: {
    content: [
      { type: 'text', text: JSON.stringify({ status: 'started', chat_id: chatId, name: chatId, title, worktree: true, context: 'fresh' }) },
    ],
  },
  error: null,
});
const startedCall = (chatId: string) => sessionToolCall(startItem(chatId)) as any;
/** Stack rows for these chats, each keyed by its own call. */
const rowsOf = (ids: string[]) => ids.map((id, n) => ({ id: `call-${n}`, call: startedCall(id) }));
const show = (v: any = {}) => act(async () => notify({ ...empty, ...v }));
const titles = (v: any) => [...v.host.querySelectorAll('.session-stack .session-card-title')].map((e: any) => e.textContent);
const more = (v: any) => v.host.querySelector('.session-stack-more') as HTMLButtonElement | null;

test('adjacent session cards join into one block; a lone card, and cards with anything between them, stay apart', () => {
  const block = (item: any) => ({ kind: 'block' as const, item });
  const reply = block({ id: 'r', type: 'agentMessage', text: 'Started.' });
  const steps = { kind: 'steps' as const, items: [{ id: 'c', type: 'commandExecution' }] as any[] };
  const [a, b, c] = ['a', 'b', 'c'].map((id) => block(startItem(id)));
  const row = (blk: any) => ({ id: blk.item.id, call: sessionToolCall(blk.item) });
  assert.deepEqual(joinSessionCards([a]), [a]);
  assert.deepEqual(joinSessionCards([reply, a, b, c, steps]), [reply, { kind: 'sessions', rows: [row(a), row(b), row(c)] }, steps]);
  assert.deepEqual(joinSessionCards([a, reply, b, steps, c]), [a, reply, b, steps, c]);
  // a scheduled-task card or other block between them is not a session card
  assert.deepEqual(joinSessionCards([reply, reply]), [reply, reply]);
});

test('the fold line counts what it holds, by the states the window knows', () => {
  assert.equal(foldLine(['done', 'queued', 'done']), '3 more · 2 done, 1 queued');
  assert.equal(foldLine([undefined, 'working']), '2 more · 1 working');
  assert.equal(foldLine([undefined, undefined]), '2 more');
});

test('up to SHOWN + 1 cards all show; past that the rest fold, and a folded card that needs the user still shows', async () => {
  for (const k of Object.keys(rows)) delete rows[k];
  await show();
  const four = await render(h(SessionStack, { rows: rowsOf(['a', 'b', 'c', 'd']), threadId: 'top' }));
  assert.equal(SHOWN, 3);
  assert.deepEqual(titles(four), ['a', 'b', 'c', 'd'], 'a fold never hides just one');
  assert.equal(more(four), null);
  await four.unmount();

  Object.assign(rows, { a: 'working', b: 'working', c: 'working', d: 'done', e: 'idle', f: 'working' });
  const v = await render(h(SessionStack, { rows: rowsOf(['a', 'b', 'c', 'd', 'e', 'f']), threadId: 'top' }));
  assert.deepEqual(titles(v), ['a', 'b', 'c']);
  assert.equal(more(v)!.textContent, '3 more · 1 done, 1 idle, 1 working');
  assert.equal(more(v)!.getAttribute('aria-expanded'), 'false');
  // a folded card that needs input comes out of the fold, in its place, and the line stops counting it
  rows.e = 'approval';
  await show();
  assert.deepEqual(titles(v), ['a', 'b', 'c', 'e']);
  assert.equal(more(v)!.textContent, '2 more · 1 done, 1 working');
  assert.equal(v.host.querySelector('.session-card[data-state="needsInput"] .session-card-word')!.textContent, 'Needs input');
  // opening the fold shows every card, and the line goes
  await click(more(v)!);
  assert.deepEqual(titles(v), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(more(v), null);
  await v.unmount();

  // when everything past SHOWN needs the user, there is nothing left to fold
  Object.assign(rows, { d: 'failed', e: 'input' });
  const urgent = await render(h(SessionStack, { rows: rowsOf(['a', 'b', 'c', 'd', 'e']) }));
  assert.deepEqual(titles(urgent), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(more(urgent), null);
  await urgent.unmount();
});

test('a start that never reached its session is not folded away either', async () => {
  for (const k of Object.keys(rows)) delete rows[k];
  await show();
  const calls = ['a', 'b', 'c', 'd', 'f'].map(startedCall);
  const broken = sessionToolCall({
    ...startItem('e'),
    result: {
      content: [
        { type: 'text', text: JSON.stringify({ status: 'not_started', chat_id: 'e', name: 'e', title: 'e', error: 'login_required' }) },
      ],
    },
  }) as any;
  const v = await render(h(SessionStack, { rows: [...calls, broken].map((call, n) => ({ id: `call-${n}`, call })) }));
  assert.equal(v.host.querySelector('.session-stack .session-not-started-reason')!.textContent, 'login_required');
  assert.equal(more(v)!.textContent, '2 more · 2 starting…');
  await v.unmount();
});

test('a fold never holds just one: when cards that need the user leave it with one, every card shows', async () => {
  for (const k of Object.keys(rows)) delete rows[k];
  Object.assign(rows, { a: 'working', b: 'working', c: 'working', d: 'done', e: 'working' });
  await show();
  const v = await render(h(SessionStack, { rows: rowsOf(['a', 'b', 'c', 'd', 'e']) }));
  assert.equal(more(v)!.textContent, '2 more · 1 done, 1 working');
  rows.e = 'approval';
  await show();
  assert.deepEqual(titles(v), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(more(v), null);
  await v.unmount();
});

test('two calls that name one chat each keep their row', async () => {
  for (const k of Object.keys(rows)) delete rows[k];
  await show();
  const v = await render(h(SessionStack, { rows: rowsOf(['a', 'a']) }));
  assert.deepEqual(titles(v), ['a', 'a']);
  await v.unmount();
});
