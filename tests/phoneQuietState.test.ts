// "No recent update": a running chat the computer has not heard from for a while is no longer called Running, in the list and in the chat.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { withLayout } from './support/phone/home-layout';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { chatChips, QUIET_AFTER_MS } from '../mobile/src/presentation/chatChips';
import { snapshot } from '../mobile/src/presentation/thread';
import { fakeDraft } from './support/phone/drafts';
const rowPath = '../mobile/src/components/ChatRow';
const listPath = '../mobile/src/screens/ChatList';
const threadPath = '../mobile/src/screens/Thread';
const momoPath = '../mobile/src/screens/MomoChat';
const { ChatRow } = await import(rowPath);
const { ChatList } = await import(listPath);
const { useHomeFolds } = await import('../mobile/src/useHomeFolds');
const StateList = withLayout(ChatList, useHomeFolds, 'state');
const { Thread } = await import(threadPath);
const { MomoTranscript } = await import(momoPath);
const quietPath = '../mobile/src/remote/useQuiet';
const { useProgressLine } = await import(quietPath);
const turnLinePath = '../mobile/src/components/TurnLine';
const { TurnLine } = await import(turnLinePath);

const NOW = 1_800_000_000_000;

test('only a running chat silent for more than five minutes is "No recent update"', () => {
  assert.equal(QUIET_AFTER_MS, 5 * 60 * 1000);
  const running = (at?: number) => chatChips({ state: 'running', at }, NOW);
  assert.deepEqual(running(NOW - QUIET_AFTER_MS - 1), { state: 'quiet', stateLabel: 'No recent update', harness: null });
  assert.equal(running(NOW - QUIET_AFTER_MS).state, 'running', 'exactly five minutes is not yet');
  assert.equal(running(NOW - 1000).state, 'running');
  assert.equal(running(NOW + 60_000).state, 'running', 'a clock ahead of the computer is not silence');
  assert.equal(running(undefined).state, 'running', 'an older Mac sends no time: nothing is claimed about it');
  // the others keep their words, however old
  const old = NOW - 3_600_000;
  assert.equal(chatChips({ state: 'waiting', at: old }, NOW).state, 'needsYou');
  assert.equal(chatChips({ state: 'idle', unread: true, at: old }, NOW).state, 'done');
  assert.equal(chatChips({ state: 'idle', at: old }, NOW).state, 'idle');
  // by default the time is now
  assert.equal(chatChips({ state: 'running', at: Date.now() - 3_600_000 }).state, 'quiet');
});

const mounted: any[] = [];
async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return { host, root };
}

test('a row says "No recent update" with a ring and a chip, and a row redraws when the clock moves', async () => {
  const chat = { id: 'a', title: 'Write docs', state: 'running', harness: 'codex', at: NOW - 6 * 60_000 };
  const { host, root } = await mount(createElement(ChatRow, { chat, now: NOW, open: () => {} }));
  assert.match(host.textContent!, /No recent update/);
  assert.equal(host.querySelector('button')!.getAttribute('aria-valuetext'), 'No recent update, Codex');
  // a fresh one is Working; the same chat later in time is quiet, though the chat itself did not change
  const fresh = { ...chat, at: NOW - 60_000 };
  await act(async () => root.render(createElement(ChatRow, { chat: fresh, now: NOW, open: () => {} })));
  assert.match(host.textContent!, /Working/);
  await act(async () => root.render(createElement(ChatRow, { chat: fresh, now: NOW + 5 * 60_000, open: () => {} })));
  assert.match(host.textContent!, /No recent update/);
  assert.doesNotMatch(host.textContent!, /Working/);
});

test('the list moves a running chat to "No recent update" as the minutes pass, still among the active chats', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW });
  try {
    const chats = [{ id: 'a', title: 'Write docs', state: 'running', at: NOW - 4 * 60_000 }];
    const { host } = await mount(
      createElement(StateList, { chats, failed: false, busy: false, scheduled: () => {}, refresh: () => {}, open: () => {} }),
    );
    assert.match(host.textContent!, /Working/);
    assert.doesNotMatch(host.textContent!, /Running/, 'no Running header');
    await act(async () => mock.timers.tick(60_000));
    assert.match(host.textContent!, /Working/, 'four minutes and a minute is exactly five');
    await act(async () => mock.timers.tick(60_000));
    // it stays in the list: "No recent update" is a word on its row (the home has no fold of idle chats)
    assert.match(host.textContent!, /No recent update/);
    assert.doesNotMatch(host.textContent!, /Working/);
    assert.equal(host.querySelector('button[aria-label^="Quiet,"]'), null);
    assert.ok(host.querySelector('button[aria-label="Open chat Write docs"]'));
  } finally {
    mock.timers.reset();
  }
});

async function followed(turn: string) {
  let listener: (e: any) => void = () => {};
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listener = f), () => {}),
    request: async (method: string) =>
      method === 'chat.follow' ? { rev: 1, feedSeq: 0, session: { turn, cards: [] }, itemsShape: 'rows', items: [] } : {},
  };
  withOutbox(runtime);
  const { host } = await mount(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') }));
  return { host, event: (e: any) => act(async () => listener({ kind: 'event', chatId: 'c', ...e })) };
}

test('in a chat "Thinking…" turns to "No recent update" after five silent minutes, and any event brings it back', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const t = await followed('running');
    assert.match(t.host.textContent!, /Thinking/);
    await act(async () => mock.timers.tick(QUIET_AFTER_MS - 1));
    assert.match(t.host.textContent!, /Thinking/);
    await act(async () => mock.timers.tick(1));
    assert.match(t.host.textContent!, /No recent update/);
    assert.doesNotMatch(t.host.textContent!, /Thinking/);
    await t.event({ ev: 'session.patch', rev: 2, patch: { cards: [] } });
    assert.match(t.host.textContent!, /Thinking/, 'the chat spoke: the silence is counted again, in the same render');
    await act(async () => mock.timers.tick(QUIET_AFTER_MS));
    assert.match(t.host.textContent!, /No recent update/);
    await t.event({ ev: 'session.patch', rev: 3, patch: { turn: 'idle' } });
    assert.doesNotMatch(t.host.textContent!, /Thinking|No recent update/, 'a turn that ended says neither');
    await act(async () => mock.timers.tick(QUIET_AFTER_MS * 2));
    assert.doesNotMatch(t.host.textContent!, /No recent update/);
  } finally {
    mock.timers.reset();
  }
});

test('a chat waiting for you is never "No recent update"', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const t = await followed('awaitingUser');
    await act(async () => mock.timers.tick(QUIET_AFTER_MS * 2));
    assert.match(t.host.textContent!, /Waiting for you/);
    assert.doesNotMatch(t.host.textContent!, /No recent update/);
  } finally {
    mock.timers.reset();
  }
});

test("MoMo's chat says it the same way", async () => {
  // the chat the last test left open is let go before the clock is faked: its feed clears its own timers when it goes
  await mount(createElement('div'));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const thread = snapshot({ rev: 1, feedSeq: 0, session: { turn: 'running', cards: [] }, itemsShape: 'items', history: [], items: [] });
    // the screen passes the transcript the chat's own progress line, as Momo.tsx does
    const Chat = ({ t }: { t: any }) =>
      createElement(MomoTranscript, {
        rows: [],
        cards: [],
        answeredOnMac: [],
        answer: async () => true,
        act: () => {},
        canAct: true,
        working: t?.session.turnStatus === 'running',
        progress: useProgressLine(t),
        empty: null,
        cardRef: () => {},
      });
    const { host } = await mount(createElement(Chat, { t: thread }));
    assert.match(host.textContent!, /Working…/);
    await act(async () => mock.timers.tick(QUIET_AFTER_MS));
    assert.match(host.textContent!, /No recent update/);
    // before the chat is read there is nothing to say
    const none = await mount(createElement(Chat, { t: null }));
    assert.doesNotMatch(none.host.textContent!, /No recent update|Working/);
  } finally {
    mock.timers.reset();
  }
});

test('the turn line stops its spark and says "No recent update" when quiet, and only while the turn works', async () => {
  const clock = { active: true, start: Date.now() - 400_000, took: null };
  const line = (props: object) => createElement(TurnLine, { clock, state: 'working', folded: false, ...props });
  const live = await mount(line({}));
  assert.equal(live.host.textContent, 'Thinking…', 'a line drawn now starts at the first thinking words');
  const quiet = await mount(line({ quiet: true }));
  assert.equal(quiet.host.textContent, 'No recent update');
  assert.equal(quiet.host.querySelector('div')!.getAttribute('aria-label'), 'No recent update');
  const waiting = await mount(line({ quiet: true, state: 'waiting' }));
  assert.match(waiting.host.textContent!, /Waiting for you$/);
  assert.equal(waiting.host.querySelector('div')!.getAttribute('aria-label'), 'Waiting for you');
});
