// The Needs-you quick review's list side: a Needs-you row opens the review, several waiting chats are cleared one after another, and the list is read again when it ends (the card and sheet themselves: phoneReview.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, flush, click } from './support/phone/component-kit';
import { mount, buttons, runtimeFor, sheet, CARD } from './support/phone/review-kit';
import { fakeDraft } from './support/phone/drafts';

const appPath = '../mobile/src/MobileApp';
const threadPath = '../mobile/src/screens/Thread';
const outboxKitPath = './support/phone/outbox-kit';
const { MobileApp } = await import(appPath);
const { Thread } = await import(threadPath);
const { withOutbox } = await import(outboxKitPath);

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
  selectedPair: 'p',
  safetyNumber: null,
  pendingPair: false,
  presence: {},
  reconnect: null,
  outbox: [],
  error: null,
};
const WAITERS = [
  { id: 'w1', title: 'Clean up generated files', state: 'waiting', harness: 'claude', project: 'shop' },
  { id: 'w2', title: 'Fix the rounding bug', state: 'waiting', harness: 'codex', project: 'shop' },
  { id: 'i1', title: 'Just chatting', state: 'idle', project: 'shop' },
];

async function app(chats: any[] = WAITERS, cardFor?: (chatId: string) => any) {
  const calls: Array<[string, any]> = [];
  const listeners = new Set<() => void>();
  const state: any = { snap: online, chats };
  const runtime: any = {
    snapshot: () => state.snap,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    onEvent: () => () => {},
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      if (method === 'chats.recent') return { chats: state.chats, more: false };
      if (method === 'chat.follow')
        return {
          rev: 1,
          feedSeq: 0,
          session: {
            turn: 'awaitingUser',
            cards: [cardFor?.(params.chatId) ?? { ...CARD, id: `card-${params.chatId}`, title: `Run it in ${params.chatId}?` }],
          },
          itemsShape: 'rows',
          items: [],
        };
      return {};
    },
  };
  withOutbox(runtime, { notify: () => listeners.forEach((f) => f()) });
  const { host } = await mount(createElement(MobileApp, { runtime }));
  const change = async (patch: object) => {
    state.snap = { ...state.snap, ...patch };
    await act(async () => listeners.forEach((f) => f()));
    await flush();
  };
  return { host, calls, state, change };
}
const asked = (calls: Array<[string, any]>, method: string) => calls.filter(([m]) => m === method);

test('a Needs-you row opens the quick review, a row of any other kind still opens its chat', async () => {
  const a = await app();
  await click('Open chat Clean up generated files');
  assert.match(a.host.textContent!, /Clean up generated files.*1 of 2 · Claude Code · shop/);
  assert.match(a.host.textContent!, /Run it in w1\?/);
  assert.equal(a.host.querySelector('button[aria-label="Back to chats"]'), null, 'not the chat');
  assert.deepEqual(
    asked(a.calls, 'chat.follow').map(([, p]) => p.chatId),
    ['w1'],
  );
  // the sheet pulled down
  assert.equal(a.host.querySelector('[data-screen="answer"]')?.getAttribute('data-presentation'), 'modal');
  await click('Swipe back');
  assert.equal(a.host.querySelector('[data-screen="answer"]'), null);
  assert.deepEqual(
    asked(a.calls, 'chat.unfollow').map(([, p]) => p.chatId),
    ['w1'],
  );
  await click('Open chat Just chatting');
  assert.ok(a.host.querySelector('button[aria-label="Back to chats"]'), 'a chat that does not wait opens as a chat');
});

test('several waiting chats are cleared one after another, and the list is read again when the review ends', async () => {
  const a = await app();
  await click('Open chat Clean up generated files');
  await click('Allow once');
  assert.deepEqual(
    asked(a.calls, 'card.answer').map(([, p]) => [p.chatId, p.key]),
    [['w1', 'once']],
  );
  assert.match(a.host.textContent!, /Allow once · answered on this (iPhone|phone)/);
  await click('Next chat');
  assert.match(a.host.textContent!, /Fix the rounding bug.*2 of 2/);
  assert.match(a.host.textContent!, /Run it in w2\?/);
  assert.ok(!a.host.textContent!.includes('Run it in w1?'), 'the first chat is done with');
  const reads = asked(a.calls, 'chats.recent').length;
  // the answers moved w1 and w2 out of Needs you on the Mac
  a.state.chats = [{ ...WAITERS[0], state: 'running' }, { ...WAITERS[1], state: 'running' }, WAITERS[2]];
  await click('Deny');
  assert.ok(buttons(a.host).includes('Done'), 'the last one ends with Done');
  await click('Done');
  assert.equal(asked(a.calls, 'chats.recent').length, reads + 1);
  assert.ok(!a.host.textContent!.includes('Run it in'), 'the sheet is gone');
  assert.doesNotMatch(a.host.textContent!, /Needs you ·/);
});

test('Open chat in the review goes to the chat; the sheet leaves with a lost connection and does not come back by itself', async () => {
  const a = await app();
  await click('Open chat Clean up generated files');
  await click('Open chat');
  assert.ok(a.host.querySelector('button[aria-label="Back to chats"]'));
  await click('Back to chats');
  await click('Open chat Fix the rounding bug');
  assert.match(a.host.textContent!, /Run it in w2\?/);
  await a.change({ phase: 'offline', generation: 2, selectedPair: null });
  assert.ok(!a.host.textContent!.includes('Run it in w2?'));
  await a.change({ phase: 'online', generation: 3, selectedPair: 'p' });
  assert.ok(!a.host.textContent!.includes('Run it in w2?'), 'back online the review is not reopened');
});

test('the list shown as the last one read cannot be reviewed: its rows are not Needs-you rows', async () => {
  const a = await app();
  await a.change({
    phase: 'offline',
    generation: 2,
    selectedPair: null,
    reconnect: { pairId: 'p', attempt: 1, nextAt: Date.now() + 5000 },
  });
  assert.match(a.host.textContent!, /MacOffline/, 'the Mac’s card says it is away');
  assert.doesNotMatch(a.host.textContent!, /Waiting for you/, 'no row claims to wait');
});

test('a card this phone answered in the chat keeps a receipt after the Mac takes it down; the next message ends it', async () => {
  let listener: (e: any) => void = () => {};
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listener = f), () => {}),
    request: async (method: string) => {
      if (method === 'chat.follow')
        return { rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards: [CARD] }, itemsShape: 'rows', items: [] };
      return {};
    },
  };
  withOutbox(runtime);
  let draft = '';
  const render = () =>
    createElement(Thread, {
      runtime,
      chatId: 'c1',
      back: () => {},
      drafts: fakeDraft(draft, { set: (v: string) => (draft = v), clear: () => (draft = '') }),
    });
  const { host, root } = await mount(render());
  // the card's wider scopes wait under More options, with their own labels
  await click('More options');
  await click('Always in this chat');
  assert.match(host.textContent!, /Always in this chat · answered on this (iPhone|phone)/);
  assert.ok(![...host.querySelectorAll('button')].some((b) => b.textContent === 'Deny'));
  await act(async () => listener({ kind: 'event', chatId: 'c1', ev: 'session.patch', rev: 2, patch: { cards: [] } }));
  assert.match(host.textContent!, /answered on this iPhone.*rm -rf dist coverage/, 'the receipt stays when the card is taken down');
  draft = 'Go on';
  await act(async () => root.render(render()));
  await click('Send');
  assert.doesNotMatch(host.textContent!, /answered on this/);
});

test('a tapped notification for the chat under review closes the review, so its close cannot take the chat screen off the chat', async () => {
  let ui: any = { step: 'granted', busy: false, target: null, prefs: {} };
  const listeners = new Set<() => void>();
  const push: any = {
    ui: () => ui,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {},
    setOpenChat: () => {},
    signOut: async () => {},
  };
  const calls: Array<[string, any]> = [];
  const state: any = { snap: online };
  const subs = new Set<() => void>();
  const runtime: any = {
    snapshot: () => state.snap,
    subscribe: (f: () => void) => (subs.add(f), () => subs.delete(f)),
    start: async () => {},
    onEvent: () => () => {},
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      if (method === 'chats.recent') return { chats: WAITERS, more: false };
      if (method === 'chat.follow')
        return { rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards: [CARD] }, itemsShape: 'rows', items: [] };
      return {};
    },
  };
  withOutbox(runtime);
  const { host } = await mount(createElement(MobileApp, { runtime, push }));
  await click('Open chat Clean up generated files');
  assert.match(host.textContent!, /Run this command\?/);
  ui = { ...ui, target: { pairId: 'p', chatId: 'w1' } };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  assert.ok(host.querySelector('button[aria-label="Back to chats"]'), 'the chat is open');
  assert.equal(host.querySelector('[data-screen="answer"]'), null, 'and the review is gone');
});

test('a refused answer is shown without offering to read the chat again, and keeps the receipts of the cards answered before', async () => {
  let refuse = false;
  const two = [CARD, { ...CARD, id: 'k2', title: 'And this one?' }];
  const r = runtimeFor({
    cards: two,
    answer: (p) => {
      if (refuse && p.cardId === 'k2') throw new Error('Allow this from your Mac.');
      return {};
    },
  });
  const { host } = await mount(sheet(r.runtime));
  await click('Deny');
  refuse = true;
  const allows = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Allow once');
  await act(async () => allows[allows.length - 1].click());
  assert.match(host.textContent!, /Allow this from your Mac\./);
  assert.ok(!buttons(host).includes('Try again'), 'reading the chat again would not help');
  assert.match(host.textContent!, /Deny · answered on this/, 'the first answer keeps its receipt');
});

test('a waiting chat row says it opens a quick review', async () => {
  const a = await app();
  assert.equal(
    a.host.querySelector('button[aria-label="Open chat Clean up generated files"]')!.getAttribute('aria-description'),
    'Opens a quick review of what it asks',
  );
  assert.equal(a.host.querySelector('button[aria-label="Open chat Just chatting"]')!.getAttribute('aria-description'), null);
});

const hostPath = '../mobile/src/components/ReviewHost';
const { ReviewHost } = await import(hostPath);

test('the review host names a chat the list does not hold, one without a title, and says nothing of a position when it is the only one waiting', async () => {
  const r = runtimeFor({ cards: [CARD] });
  const host = (chats: any[], id: string) =>
    createElement(ReviewHost, { runtime: r.runtime, chats, id, go: () => {}, openChat: () => {}, done: () => {} });
  const lone = await mount(host([{ id: 'c1', state: 'waiting' }], 'c1'));
  assert.match(lone.host.textContent!, /Untitled chat/);
  assert.doesNotMatch(lone.host.textContent!, /1 of 1/);
  assert.ok(!buttons(lone.host).includes('Later'), 'nothing follows: Close, not Later');
  const unknown = await mount(host([{ id: 'other', title: 'Other', state: 'waiting' }], 'c1'));
  assert.match(unknown.host.textContent!, /Untitled chat/);
  assert.doesNotMatch(unknown.host.textContent!, /of 2|1 of/);
  const named = await mount(host([{ id: 'c1', title: 'Named', state: 'waiting', harness: 'codex', project: 'shop' }], 'c1'));
  assert.match(named.host.textContent!, /NamedCodex · shop/);
});

test('the sheet draws no second line when it has neither a project nor a position', async () => {
  const { host } = await mount(sheet(runtimeFor({ cards: [CARD] }).runtime, { subtitle: undefined }));
  assert.match(host.textContent!, /^Clean up generated filesLoading…|^Clean up generated files/);
  assert.doesNotMatch(host.textContent!, /Clean up generated files.*·/);
});

test('a chat read after the sheet closed, a refusal that is not an Error, an unfollow that fails and an answer after closing change nothing', async () => {
  let readIt: (v: unknown) => void = () => {};
  let answerIt: (e: unknown) => void = () => {};
  let unfollowFails = true;
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: (method: string) => {
      if (method === 'chat.follow') return new Promise((resolve) => (readIt = resolve));
      if (method === 'chat.unfollow') return unfollowFails ? Promise.reject(new Error('gone')) : Promise.resolve({});
      if (method === 'card.answer') return new Promise((_, reject) => (answerIt = reject));
      return Promise.resolve({});
    },
  };
  const { root } = await mount(sheet(runtime));
  await act(async () => root.unmount());
  await act(async () => readIt({ rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards: [CARD] }, itemsShape: 'rows', items: [] }));
  // a follow refused with something that is not an Error is shown as text
  const plain: any = { ...runtime, request: (m: string) => (m === 'chat.follow' ? Promise.reject('plain failure') : Promise.resolve({})) };
  const shown = await mount(sheet(plain));
  assert.match(shown.host.textContent!, /plain failure/);
  // an answer that fails after the sheet was closed touches nothing
  const live: any = {
    ...runtime,
    request: (m: string) =>
      m === 'chat.follow'
        ? Promise.resolve({ rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards: [CARD] }, itemsShape: 'rows', items: [] })
        : m === 'card.answer'
          ? new Promise((_, reject) => (answerIt = reject))
          : Promise.resolve({}),
  };
  const open = await mount(sheet(live));
  await click('Deny');
  await act(async () => open.root.unmount());
  await act(async () => answerIt(new Error('late')));
  // a refusal that is not an Error is shown as text
  const odd: any = {
    ...live,
    request: (m: string) =>
      m === 'card.answer'
        ? Promise.reject('plain refusal')
        : Promise.resolve({ rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards: [CARD] }, itemsShape: 'rows', items: [] }),
  };
  const refused = await mount(sheet(odd));
  await click('Deny');
  assert.match(refused.host.textContent!, /plain refusal/);
  unfollowFails = false;
});

test("the review host's Ask for changes ends the review and opens its chat asking what should change, not the chat as it was", async () => {
  const plan = {
    id: 'p1',
    rev: 1,
    title: 'Approve this plan?',
    kind: 'plan',
    plan: { text: '1. Round once' },
    choices: [
      { key: 'once', label: 'Approve plan' },
      { key: 'deny', label: 'Deny', deny: true },
    ],
  };
  const r = runtimeFor({ cards: [plan] });
  const moves: string[] = [];
  const { host } = await mount(
    createElement(ReviewHost, {
      runtime: r.runtime,
      chats: [{ id: 'c1', title: 'Plan chat', state: 'waiting' }],
      id: 'c1',
      go: (id: string | null) => moves.push(`go ${id}`),
      openChat: (id: string) => moves.push(`open ${id}`),
      askChanges: (id: string, card: string) => moves.push(`ask ${id} ${card}`),
      done: () => {},
    }),
  );
  assert.match(host.textContent!, /Round once/);
  await click('Ask for changes');
  assert.deepEqual(moves, ['go null', 'ask c1 ["p1",1]']);
  assert.equal(r.calls.filter(([m]) => m === 'card.answer').length, 0);
});

test("a plan's Ask for changes in the quick review opens the chat asking what should change, answers nothing, and a chat opened later asks nothing", async () => {
  const plan = (id: string) => ({
    id: `plan-${id}`,
    rev: 1,
    title: 'Approve this plan?',
    kind: 'plan',
    plan: { text: '1. Round once' },
    choices: [
      { key: 'once', label: 'Approve plan' },
      { key: 'deny', label: 'Deny', deny: true },
    ],
  });
  const a = await app(WAITERS, plan);
  await click('Open chat Clean up generated files');
  assert.match(a.host.textContent!, /1 of 2/);
  await click('Ask for changes');
  assert.equal(a.host.querySelector('[data-screen="answer"]'), null, 'the review is over');
  assert.ok(a.host.querySelector('button[aria-label="Back to chats"]'), 'the chat is open');
  assert.equal((a.host.querySelector('input') as HTMLInputElement).placeholder, 'What should change in the plan?');
  assert.equal(asked(a.calls, 'card.answer').length, 0, 'nothing was sent: the refusal goes with the words');
  await click('Back to chats');
  await click('Open chat Just chatting');
  assert.equal((a.host.querySelector('input') as HTMLInputElement).placeholder, 'Message this chat', 'only the review asks');
});
