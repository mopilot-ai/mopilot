// A brief, wake-up or family message main delivered shows as what it is (components/thread/SideSessionCard.tsx), never
// as the user's own words; the windows read linked sessions once and keep them current (src/lib/sideSessions.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, impl, native } from './support/store-harness.ts';
await import('./support/dom.ts');
(window as any).native = native;
const { act, createElement: h, createContext } = await import('react');
const { mount, click, mockTsx } = await import('./support/composer-kit.ts');
const { store: S, resetState } = await loadStore();
const stub = (path: string, exports: Record<string, any>) => mockTsx(new URL('../src/' + path, import.meta.url), exports);
const passthrough = ({ children }: any) => children;
stub('components/markdown/SkillLink.tsx', { SkillLink: passthrough });
stub('components/thread/view/sentSkill.ts', { useSentSkill: () => null });
stub('components/ui/ImageLightbox.tsx', { ZoomableImage: () => null });
stub('components/thread/QuestionReplyBubble.tsx', { QuestionReplyBubble: passthrough });
stub('components/composer/SelectionChip.tsx', { SelectionChip: () => null });
stub('components/ui/Popover.tsx', { Tooltip: passthrough });
stub('components/markdown/MessagePathLink.tsx', { FileMentionLink: ({ token }: any) => token });
stub('components/thread/PeerMessages.tsx', { PeerContext: createContext([]) });
stub('components/diff/DiffComments.tsx', { linesLabel: () => '' });
const { UserMessage } = await import('../src/components/thread/view/UserMessage.tsx');
const { sideSessionForItem, resetSideSessions } = await import('../src/lib/sideSessions.ts');
const { resetMessageOpen } = await import('../src/lib/sideMessageOpen.ts');
const { markWindowReady, resetWindowReady } = await import('../src/lib/windowReady.ts');

const view = {
  children: {
    kid: { parentId: 'top', name: 'fix-login', title: 'Fix login', harness: 'codex', useWorktree: true, createdAt: 1, lastReport: null },
  },
  deliveries: {
    brief1: { kind: 'brief', chatId: 'kid', from: 'top', title: 'Fix login', body: 'Fix the login bug', at: 1 },
    wake1: {
      kind: 'wake',
      chatId: 'top',
      at: 2,
      notes: [
        { childId: 'kid', body: 'The session "Fix login" finished a turn.' },
        { childId: 'ghost', body: 'x'.repeat(700) },
        { childId: 'ghost', body: 'x'.repeat(700) },
      ],
    },
    msg1: { kind: 'message', chatId: 'top', from: 'kid', body: 'Blocked on the schema', at: 3 },
    msg2: { kind: 'message', chatId: 'top', from: 'kid', body: 'y'.repeat(700), at: 4 },
    wake2: { kind: 'wake', chatId: 'top', at: 5, notes: [{ childId: 'kid', body: 'Done.' }] },
  },
};
let notify: (v: any) => void = () => {};
beforeEach(() => {
  resetState();
  resetAll();
  resetSideSessions();
  resetMessageOpen();
  // boot has told main this window is ready, as in a window that finished starting
  resetWindowReady();
  markWindowReady();
  impl['orchestration.onChanged'] = (cb: any) => ((notify = cb), () => {});
  impl['orchestration.snapshot'] = () => Promise.resolve(view);
  S.useStore.setState({ threads: { top: { id: 'top', name: 'Top chat' } } } as any);
});

const message = (threadId: string, item: any) =>
  h(UserMessage, {
    threadId,
    turnId: 'turn',
    userIndex: 0,
    canEdit: true,
    item: { type: 'userMessage', content: [{ type: 'text', text: 'raw envelope' }], ...item },
  } as any);
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

test('a brief shows who started the chat, the task title and body, and opens the parent', async () => {
  const m = await mount(message('kid', { id: 'native-item', clientId: 'brief1' }));
  await settle();
  const card = m.host.querySelector('.side-session-card') as HTMLElement;
  assert.equal(card.dataset.kind, 'brief');
  assert.match(card.textContent ?? '', /Started by Codex fromTop chat/);
  assert.match(card.textContent ?? '', /Fix loginFix the login bug/);
  assert.equal(m.host.querySelector('.user-message'), null);
  assert.ok(!(m.host.textContent ?? '').includes('raw envelope'));
  await click(card.querySelector('.peer-chat-link'));
  assert.deepEqual(S.useStore.getState().route, { name: 'thread', id: 'top' });
  // ⌥-click opens it in split view beside the chat on screen instead (src/session/openChat.ts)
  S.useStore.setState({ route: { name: 'thread', id: 'kid' } });
  await act(
    async () => void card.querySelector('.peer-chat-link')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, altKey: true })),
  );
  assert.deepEqual(
    S.useStore.getState().split.panes.map((p) => p.chatId),
    ['top'],
  );
  assert.deepEqual(S.useStore.getState().route, { name: 'thread', id: 'kid' });
  await m.unmount();
});

test('a wake-up reads as the messages it brought, each from its session, behind Show message', async () => {
  const m = await mount(message('top', { id: 'wake1' }));
  await settle();
  const card = m.host.querySelector('.side-session-card') as HTMLElement;
  assert.equal(card.dataset.kind, 'wake');
  assert.equal(card.querySelector('.side-session-wake-head')?.textContent, 'The app asked Codex to report back · Received 3 messages');
  const notes = [...card.querySelectorAll('.side-session-note')];
  assert.equal(notes.length, 3, 'identical notes each keep their row');
  assert.equal(notes[0].querySelector('.side-session-note-head span')?.textContent, 'Received message from fix-login');
  assert.equal(notes[1].querySelector('.peer-chat-link')?.textContent, 'another session');
  const toggle = notes[0].querySelector('.side-session-toggle') as HTMLButtonElement;
  assert.equal(toggle.textContent, 'Show message from fix-login');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(notes[0].querySelector('.side-session-text'), null);
  await click(toggle);
  assert.equal(notes[0].querySelector('.side-session-text')?.textContent, 'The session "Fix login" finished a turn.');
  assert.equal(toggle.textContent, 'Hide message from fix-login');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  // the identical notes beside it stay closed
  assert.equal((notes[1].querySelector('.side-session-toggle') as HTMLElement).textContent, 'Show message from another session');
  assert.equal(notes[1].querySelector('.side-session-text'), null);
  assert.equal(notes[2].querySelector('.side-session-text'), null);
  await click(toggle);
  assert.equal(notes[0].querySelector('.side-session-text'), null);
  await m.unmount();
  const one = await mount(message('top', { id: 'wake2' }));
  await settle();
  assert.equal(one.host.querySelector('.side-session-wake-head')?.textContent, 'The app asked Codex to report back');
  await one.unmount();
});

test('a family message is a closed Received message row; its toggle shows the whole message, long or short', async () => {
  const m = await mount(message('top', { clientId: 'msg2' }));
  await settle();
  const card = m.host.querySelector('.side-session-card') as HTMLElement;
  assert.equal(card.dataset.kind, 'message');
  assert.equal(card.querySelector('.side-session-note-head span')?.textContent, 'Received message from fix-login');
  assert.equal(card.querySelector('.side-session-text'), null);
  assert.equal(card.querySelector('.side-session-more'), null, 'no fold: the toggle is the disclosure');
  const toggle = card.querySelector('.side-session-toggle') as HTMLButtonElement;
  assert.equal(toggle.textContent, 'Show message from fix-login');
  await click(toggle);
  assert.equal(card.querySelector('.side-session-text')?.textContent, 'y'.repeat(700));
  assert.equal(card.querySelector('.side-session-text')?.className, 'side-session-text');
  assert.equal(toggle.textContent, 'Hide message from fix-login');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  await click(toggle);
  assert.equal(card.querySelector('.side-session-text'), null);
  await m.unmount();
});

test('the sender name opens that session, and an unknown sender reads as another session', async () => {
  const m = await mount(message('top', { clientId: 'msg1' }));
  await settle();
  await click(m.host.querySelector('.peer-chat-link'));
  assert.deepEqual(S.useStore.getState().route, { name: 'thread', id: 'kid' });
  await m.unmount();
  await act(async () => notify({ children: {}, deliveries: { msg1: view.deliveries.msg1 } }));
  const unknown = await mount(message('top', { clientId: 'msg1' }));
  await settle();
  assert.equal(unknown.host.querySelector('.side-session-note-head span')?.textContent, 'Received message from another session');
  assert.equal(unknown.host.querySelector('.side-session-toggle')?.textContent, 'Show message from another session');
  await unknown.unmount();
});

test('what was opened is remembered per item: a remounted row stays open, its neighbours and other items stay closed', async () => {
  const first = await mount(message('top', { clientId: 'msg1' }));
  await settle();
  await click(first.host.querySelector('.side-session-toggle'));
  assert.equal(first.host.querySelector('.side-session-text')?.textContent, 'Blocked on the schema');
  await first.unmount();
  const again = await mount(message('top', { clientId: 'msg1' }));
  await settle();
  assert.equal(again.host.querySelector('.side-session-text')?.textContent, 'Blocked on the schema');
  assert.equal(again.host.querySelector('.side-session-toggle')?.getAttribute('aria-expanded'), 'true');
  // two messages from one sender back to back are two rows with a choice each
  const other = await mount(message('top', { clientId: 'msg2' }));
  await settle();
  assert.equal(other.host.querySelector('.side-session-text'), null);
  // a wake-up's notes are remembered per note, and not under the same delivery key as a message
  const wake = await mount(message('top', { id: 'wake1' }));
  await settle();
  await click(wake.host.querySelectorAll('.side-session-toggle')[1]);
  await wake.unmount();
  const wakeAgain = await mount(message('top', { id: 'wake1' }));
  await settle();
  const texts = [...wakeAgain.host.querySelectorAll('.side-session-note')].map((n) => n.querySelector('.side-session-text') !== null);
  assert.deepEqual(texts, [false, true, false]);
  // closing it forgets it
  await click(again.host.querySelector('.side-session-toggle'));
  assert.equal(again.host.querySelector('.side-session-text'), null);
  await again.unmount();
  await other.unmount();
  await wakeAgain.unmount();
});

test('a card rendered without its delivery key keeps its choice in the row only', async () => {
  const { SideSessionCard } = await import('../src/components/thread/SideSessionCard.tsx');
  const delivery = { kind: 'message', chatId: 'top', from: 'kid', body: 'No key', at: 1 };
  const m = await mount(h(SideSessionCard, { delivery } as any));
  await settle();
  await click(m.host.querySelector('.side-session-toggle'));
  assert.equal(m.host.querySelector('.side-session-text')?.textContent, 'No key');
  await click(m.host.querySelector('.side-session-toggle'));
  assert.equal(m.host.querySelector('.side-session-text'), null);
  await m.unmount();
  const second = await mount(h(SideSessionCard, { delivery } as any));
  await settle();
  assert.equal(second.host.querySelector('.side-session-text'), null);
  await second.unmount();
});

test('a fork’s copy of a delivered item shows as it was; the user’s own stays a bubble', async () => {
  const fork = await mount(message('forked-child', { id: 'wake1' }));
  await settle();
  assert.equal((fork.host.querySelector('.side-session-card') as HTMLElement)?.dataset.kind, 'wake');
  await fork.unmount();
  const own = await mount(message('top', { id: 'typed-by-user' }));
  await settle();
  assert.equal(own.host.querySelector('.side-session-card'), null);
  assert.ok(own.host.querySelector('.user-message'));
  await own.unmount();
});

test('a change from main replaces the snapshot, and a snapshot that answers after a change is dropped', async () => {
  let answer!: (v: any) => void;
  impl['orchestration.snapshot'] = () => new Promise((r) => (answer = r));
  const m = await mount(message('top', { id: 'later' }));
  await settle();
  assert.equal(m.host.querySelector('.side-session-card'), null);
  await act(async () => notify({ children: {}, deliveries: { later: { kind: 'message', chatId: 'top', from: 'x', body: 'hi', at: 1 } } }));
  assert.ok(m.host.querySelector('.side-session-card'));
  await act(async () => answer({ children: {}, deliveries: {} }));
  assert.ok(m.host.querySelector('.side-session-card'), 'the older snapshot did not replace the change');
  await act(async () => notify(null));
  assert.equal(m.host.querySelector('.side-session-card'), null);
  await m.unmount();
});

test('a snapshot that fails is only noted, and items then show as ordinary messages', async () => {
  impl['orchestration.snapshot'] = () => Promise.reject(new Error('main gone'));
  const m = await mount(message('top', { id: 'wake1' }));
  await settle();
  assert.equal(m.host.querySelector('.side-session-card'), null);
  await m.unmount();
  assert.equal(sideSessionForItem(view as any, {}), null);
  assert.equal(sideSessionForItem(view as any, { clientId: null, id: 'msg1' })?.kind, 'message');
});

test('a window still starting reads the linked sessions only once boot told main it is ready, then shows them', async () => {
  // main refuses a window it doesn't know yet, and nothing would read again until the journal next changed
  resetWindowReady();
  let reads = 0;
  impl['orchestration.snapshot'] = () => (reads++, Promise.resolve(view));
  const m = await mount(message('top', { id: 'wake1' }));
  await settle();
  assert.equal(reads, 0);
  assert.equal(m.host.querySelector('.side-session-card'), null);
  await act(async () => markWindowReady());
  await settle();
  assert.equal(reads, 1);
  assert.equal((m.host.querySelector('.side-session-card') as HTMLElement)?.dataset.kind, 'wake');
  await m.unmount();
});

test('structured session briefs expose distinct Task and Context steps, their own folding and parent harness', async () => {
  const { SideSessionCard } = await import('../src/components/thread/SideSessionCard.tsx');
  S.useStore.setState({ segments: { top: [{ nativeId: 'claude-parent', harness: 'claude', start: 0 }] } } as any);
  const task = 'a'.repeat(700);
  const context = 'line\n'.repeat(7);
  const delivery = { kind: 'brief', chatId: 'kid', from: 'top', title: 'Task title', body: 'legacy', task, context, at: 1 };
  const m = await mount(h(SideSessionCard, { delivery } as any));
  await settle();
  assert.match(m.host.querySelector('.side-session-brief-head')?.textContent ?? '', /Started by Claude Code fromTop chat/);
  assert.equal(m.host.querySelectorAll('.side-session-brief-step').length, 2);
  const steps = [...m.host.querySelectorAll('.side-session-brief-step')];
  assert.equal(steps[0].querySelector('.side-session-text')?.textContent, task);
  assert.equal(steps[1].querySelector('.side-session-text')?.textContent, context);
  assert.ok(steps.every((s) => s.querySelector('.side-session-text.folded')));
  await click(steps[0].querySelector('.side-session-more'));
  assert.equal(steps[0].querySelector('.side-session-text.folded'), null);
  assert.ok(steps[1].querySelector('.side-session-text.folded'), 'the other step retains its own disclosure');
  await click(steps[0].querySelector('.side-session-more'));
  assert.ok(steps[0].querySelector('.side-session-text.folded'));
  impl['clipboard.write'] = async () => {};
  await click(steps[0].querySelector('[aria-label="Task actions"]'));
  await click(steps[1].querySelector('[aria-label="Context actions"]'));
  const toggle = m.host.querySelector('[aria-label="Hide session brief"]');
  await click(toggle);
  assert.equal(m.host.querySelector('.side-session-brief-steps'), null);
  await click(toggle);
  assert.equal(m.host.querySelectorAll('.side-session-brief-step').length, 2);
  await m.unmount();
  const fork = await mount(h(SideSessionCard, { delivery: { ...delivery, fork: true, context: '', task: '' } } as any));
  assert.match(fork.host.querySelector('.side-session-brief-head')?.textContent ?? '', /Forked fromTop chat/);
  assert.equal(fork.host.querySelectorAll('.side-session-brief-step').length, 1);
  await fork.unmount();
  const recorded = await mount(h(SideSessionCard, { delivery: { ...delivery, harness: 'codex' } } as any));
  assert.match(recorded.host.querySelector('.side-session-brief-head')?.textContent ?? '', /Started by Codex from/);
  await recorded.unmount();
  const unknown = await mount(h(SideSessionCard, { delivery: { ...delivery, harness: 'acp:unknown' } } as any));
  assert.match(unknown.host.querySelector('.side-session-brief-head')?.textContent ?? '', /Started by Assistant from/);
  await unknown.unmount();
});
