// Status-first chat rows: a glyph, a title and one grey line (project · status · +N −M), the agent as a letter, a pinned chat placed by its state, pull to refresh, and the list kept as the last one read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLayout } from './support/phone/home-layout';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
const partsPath = '../mobile/src/presentation/chatRowParts';
const pagesPath = '../mobile/src/chatPages';
const appPath = '../mobile/src/MobileApp';
const rowPath = '../mobile/src/components/ChatRow';
const listPath = '../mobile/src/screens/ChatList';
const { ageLabel, changesOf } = await import(partsPath);
const { chatPage } = await import(pagesPath);
const { MobileApp } = await import(appPath);
const { ChatRow } = await import(rowPath);
const { ChatList } = await import(listPath);
const { useHomeFolds } = await import('../mobile/src/useHomeFolds');
const StateList = withLayout(ChatList, useHomeFolds, 'state');

test('a chat is "now", minutes, hours, days, weeks, months or years old as the Mac says it, and nothing where the computer sent no time', () => {
  const now = 1_800_000_000_000;
  assert.equal(ageLabel(now - 30_000, now), 'now');
  assert.equal(ageLabel(now + 5 * 60_000, now), 'now', 'a time ahead of this clock is now');
  assert.equal(ageLabel(now - 60_000, now), '1m');
  assert.equal(ageLabel(now - 59 * 60_000, now), '59m');
  assert.equal(ageLabel(now - 60 * 60_000, now), '1h');
  assert.equal(ageLabel(now - 23 * 3_600_000, now), '23h');
  assert.equal(ageLabel(now - 49 * 3_600_000, now), '2d');
  const day = 86_400_000;
  assert.equal(ageLabel(now - 6 * day, now), '6d');
  assert.equal(ageLabel(now - 7 * day, now), '1w', 'a week, where the phone said 7d');
  assert.equal(ageLabel(now - 29 * day, now), '4w');
  assert.equal(ageLabel(now - 30 * day, now), '1mo');
  assert.equal(ageLabel(now - 364 * day, now), '12mo');
  assert.equal(ageLabel(now - 365 * day, now), '1y');
  for (const none of [undefined, null, '5', Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(ageLabel(none, now), null);
});

test('the changes line is two whole numbers with something changed; anything else is no line', () => {
  assert.deepEqual(changesOf({ added: 4, removed: 2 }), { added: 4, removed: 2 });
  assert.deepEqual(changesOf({ added: 0, removed: 1, extra: 'x' }), { added: 0, removed: 1 });
  for (const none of [
    null,
    undefined,
    3,
    {},
    { added: 0, removed: 0 },
    { added: -1, removed: 2 },
    { added: 1.5, removed: 2 },
    { added: '4', removed: 2 },
  ])
    assert.equal(changesOf(none), null);
});

test("a page of chats reads each chat's time on this phone's clock when the Mac says what time it is", () => {
  const rows = (result: object, receivedAt: number) =>
    chatPage({ chats: [{ id: 'a', at: 1_000_000 }, { id: 'b' }], ...result }, receivedAt).chats;
  // this phone is ten minutes ahead of the Mac: the chat is as old as it was on the Mac
  assert.equal(rows({ now: 1_100_000 }, 1_700_000)[0].at, 1_600_000);
  assert.equal('at' in rows({ now: 1_100_000 }, 1_700_000)[1], false, 'a chat with no time stays without one');
  // an older Mac says nothing of its clock, and a nonsense clock is no clock
  assert.equal(rows({}, 1_700_000)[0].at, 1_000_000);
  assert.equal(rows({ now: 'x' }, 1_700_000)[0].at, 1_000_000);
  assert.equal(rows({ now: Number.NaN }, 1_700_000)[0].at, 1_000_000);
});

test('a page of chats keeps only usable changes and leaves the rest of each chat as the computer sent it', () => {
  const page = chatPage({
    chats: [
      { id: 'a', title: 'A', changes: { added: 3, removed: 1, junk: true } },
      { id: 'b', title: 'B', changes: { added: -3, removed: 1 } },
      { id: 'c', title: 'C' },
    ],
    more: true,
  });
  assert.deepEqual(page.chats[0].changes, { added: 3, removed: 1 });
  assert.equal('changes' in page.chats[1], false);
  assert.equal('changes' in page.chats[2], false);
  assert.equal(page.chats[1].title, 'B');
  assert.equal(page.more, true);
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
const NOW = 1_800_000_000_000;
const row = (chat: any, props: any = {}) => createElement(ChatRow, { chat, now: NOW, open: () => {}, ...props });

test('a row reads status · age · login, then +N −M and where it runs, as Claude’s list does', async () => {
  const chat = {
    id: 'a',
    title: 'Release notes',
    state: 'idle',
    unread: true,
    harness: 'claude',
    at: NOW - 3_600_000,
    changes: { added: 4, removed: 2 },
  };
  const { host } = await mount(row(chat, { subtitle: 'shop' }));
  assert.match(host.textContent!, /Release notesshop · Done · 1h\+4 −2/);
  assert.ok(host.querySelector('[data-symbol="circle.fill"]'), 'a finished turn nobody has opened is a blue dot');
  assert.equal(host.querySelector('[data-symbol="circle"]'), null, 'and no longer the idle ring');
  assert.ok(host.querySelector('[data-symbol="laptopcomputer"]'), 'the row ends with where it runs: the Mac');
  assert.equal(host.querySelector('button')!.getAttribute('aria-valuetext'), 'Done, Claude Code, 4 added, 2 removed');
  // the numbers are green and red, and the line has no middle dot before them when it has nothing else
  const bare = await mount(row({ id: 'b', title: 'Plain', state: 'idle', changes: { added: 1, removed: 0 } }));
  assert.match(bare.host.textContent!, /Plain\+1 −0/);
  // an idle chat with nothing changed has no second line at all, and no age or letter when the computer sent none
  const idle = await mount(row({ id: 'c', title: 'Quiet', state: 'idle' }));
  assert.equal(idle.host.textContent, '○Quiet▭');
  assert.equal(idle.host.querySelector('button')!.getAttribute('aria-valuetext'), 'Idle');
  // a chat the computer cannot read an age for still shows its state in words
  const waits = await mount(row({ id: 'd', title: 'Asks', state: 'waiting', account: 'dana@example.com' }));
  assert.match(waits.host.textContent!, /AsksWaiting for you · dana@example\.com/);
  assert.ok(waits.host.querySelector('[data-symbol="hand.raised"]'), 'the amber hand');
  // a chat on a host shows the host's mark instead of the laptop
  const hosted = await mount(row({ id: 'h', title: 'Hosted', state: 'idle', hostId: 'h1' }));
  assert.ok(hosted.host.querySelector('[data-symbol="server.rack"]'));
  assert.equal(hosted.host.querySelector('button')!.getAttribute('aria-valuetext'), 'Idle, Runs on a host');
});

test('a running chat spins its ring and says Working, one that has gone quiet a still ring, and a pinned one says so to a screen reader', async () => {
  const running = await mount(row({ id: 'r', title: 'Busy', state: 'running', at: NOW - 60_000 }));
  assert.match(running.host.textContent!, /BusyWorking · 1m/);
  assert.ok(running.host.querySelector('[data-symbol="circle.dotted"]'));
  const quiet = await mount(row({ id: 'q', title: 'Silent', state: 'running', at: NOW - 6 * 60_000 }));
  assert.match(quiet.host.textContent!, /SilentNo recent update/);
  assert.ok(quiet.host.querySelector('[data-symbol="circle"]'), 'a quiet chat no longer spins');
  const pinned = await mount(row({ id: 'p', title: 'Kept', state: 'idle', pinned: true }));
  assert.equal(pinned.host.querySelector('button')!.getAttribute('aria-valuetext'), 'Idle, Pinned');
});

test('a row of the last list read claims no state', async () => {
  const chat = { id: 'a', title: 'Was running', state: 'running', at: NOW - 60_000, harness: 'codex' };
  const { host } = await mount(row(chat, { offline: true }));
  assert.match(host.textContent!, /Was running1m/, 'only its age');
  assert.doesNotMatch(host.textContent!, /Running|Working/);
  assert.equal(host.querySelector('button')!.getAttribute('aria-valuetext'), 'Offline, Codex');
});

const list = (chats: any[] | null, props: any = {}) =>
  createElement(StateList, { chats, failed: false, busy: false, scheduled: () => {}, open: () => {}, ...props });
const labels = (host: HTMLElement) =>
  [...host.querySelectorAll('button[aria-label^="Open chat"]')].map((b) => b.getAttribute('aria-label'));

test('a pinned or waiting chat is listed once, by its state, in the computer’s order, with its project on its row', async () => {
  const chats = [
    { id: 'w', title: 'Waits', state: 'waiting', pinned: true, project: 'App' },
    { id: 'p', title: 'Kept', state: 'idle', pinned: true, project: 'App' },
    { id: 'n', title: 'Normal', state: 'idle', project: 'App' },
  ];
  const { host } = await mount(list(chats));
  assert.match(host.textContent!, /Needs input.*WaitsApp · Waiting for you.*KeptApp.*NormalApp.*Computer/);
  assert.deepEqual(labels(host), ['Open chat Waits', 'Open chat Kept', 'Open chat Normal'], 'the idle ones are in the list, none folded');
  assert.doesNotMatch(host.textContent!, /Pinned|Needs you|Quiet/);
});

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [
    { pairId: 'p', macId: 'm', name: 'Mac' },
    { pairId: 'q', macId: 'm2', name: 'Other Mac' },
  ],
  selectedPair: 'p',
  safetyNumber: null,
  pendingPair: false,
  presence: {},
  reconnect: null,
  outbox: [],
  error: null,
};

async function app(answer: (pair: string | null) => any) {
  const listeners = new Set<() => void>();
  const state: any = { snap: online };
  const runtime: any = {
    snapshot: () => state.snap,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    onEvent: () => () => {},
    request: async (method: string) => (method === 'chats.recent' ? answer(state.snap.selectedPair) : {}),
  };
  withOutbox(runtime, { notify: () => listeners.forEach((f) => f()) });
  const { host } = await mount(createElement(MobileApp, { runtime }));
  const change = async (patch: object) => {
    state.snap = { ...state.snap, ...patch };
    await act(async () => listeners.forEach((f) => f()));
    await flush();
  };
  return { host, state, change };
}
const mac = (id: string) => ({ chats: [{ id, title: `Chat of ${id}`, state: 'waiting', changes: { added: 2, removed: 1 } }], more: false });

test('pull to refresh reads the list again and shows it is refreshing; it is offered only online', async () => {
  let reads = 0;
  let release: (v: unknown) => void = () => {};
  const a = await app(() => (reads++ ? new Promise((resolve) => (release = resolve)) : mac('p')));
  assert.equal(reads, 1);
  await click('Pull to refresh');
  assert.equal(reads, 2);
  assert.ok(a.host.querySelector('button[aria-label="Refreshing"]'));
  assert.equal(reads, 2);
  release(mac('p'));
  await flush();
  assert.ok(a.host.querySelector('button[aria-label="Pull to refresh"]'));
  await a.change({
    phase: 'offline',
    generation: 2,
    selectedPair: null,
    reconnect: { pairId: 'p', attempt: 1, nextAt: Date.now() + 5000 },
  });
  assert.equal(a.host.querySelector('button[aria-label="Pull to refresh"]'), null, 'offline: nothing to pull');
});

test('the list is kept as the last one read while the computer is away: no state claimed, no new chat, no more pages, a chat opens only when it is waited for', async () => {
  const a = await app(() => mac('p'));
  assert.match(a.host.textContent!, /Chat of pWaiting for you/);
  // away and not being waited for: the rows show, claim no state, grey their laptop, and open nothing
  await a.change({ phase: 'offline', generation: 2, selectedPair: null, reconnect: null });
  assert.match(a.host.textContent!, /Chat of p\+2 −1/);
  assert.ok(a.host.querySelector('[data-symbol="laptopcomputer.slash"]'), 'the laptop says the Mac is away');
  assert.match(a.host.textContent!, /MacOffline/, 'the Mac’s card says Offline');
  assert.doesNotMatch(a.host.textContent!, /Needs input|Running|Quiet|need input/, 'no state is claimed: no headers, no fold, no count');
  assert.doesNotMatch(a.host.textContent!, /Waiting for you/);
  const rowButton = () => a.host.querySelector('button[aria-label="Open chat Chat of p"]') as HTMLButtonElement;
  assert.equal(rowButton().disabled, true, 'a row that opens nothing says so');
  assert.equal(rowButton().getAttribute('aria-disabled'), 'true');
  await act(async () => rowButton().click());
  assert.equal(a.host.querySelector('button[aria-label="Send message"]'), null);
  assert.match(a.host.textContent!, /Chat of p\+2 −1/, 'still the list');
  // waited for: the chat opens as itself, its laptop saying the Mac is away and its composer ready to queue
  await a.change({ reconnect: { pairId: 'p', attempt: 1, nextAt: Date.now() + 5000 } });
  assert.equal(rowButton().disabled, false);
  await click('Open chat Chat of p');
  assert.ok(a.host.querySelector('button[aria-label^="Runs on"][aria-label$=", Offline"]'));
  assert.ok(a.host.querySelector('[aria-label="Message this chat"]'));
  await a.change({ reconnect: null });
});

test('back online the same computer shows its list at once while it is read again; another computer or account never sees it', async () => {
  let release: (v: unknown) => void = () => {};
  let second = false;
  const a = await app((pair) => (second ? new Promise((resolve) => (release = resolve)) : mac(pair ?? 'p')));
  await a.change({ phase: 'offline', generation: 2, selectedPair: null });
  second = true;
  await a.change({ phase: 'online', generation: 3, selectedPair: 'p' });
  // the list is there while the read is on its way, as the last one read: no state is claimed until it lands
  assert.match(a.host.textContent!, /Chat of p\+2 −1/);
  assert.doesNotMatch(a.host.textContent!, /Waiting for you/);
  release({ chats: [{ id: 'fresh', title: 'Fresh chat', state: 'idle' }], more: false });
  await flush();
  assert.match(a.host.textContent!, /Fresh chat/);
  assert.doesNotMatch(a.host.textContent!, /Chat of p/, 'read: its own words again');
  // another computer: nothing of the first one's list is shown while its own is read
  await a.change({ phase: 'offline', generation: 4, selectedPair: null });
  await a.change({ phase: 'online', generation: 5, selectedPair: 'q' });
  assert.doesNotMatch(a.host.textContent!, /Fresh chat/);
  release(mac('q'));
  await flush();
  assert.match(a.host.textContent!, /Chat of q/);
  // signed out: the list goes
  await a.change({ phase: 'signedOut', user: null, generation: 6, selectedPair: null });
  assert.doesNotMatch(a.host.textContent!, /Chat of q/);
  await a.change({ phase: 'offline', user: { id: 'u' }, generation: 7, selectedPair: null });
  assert.doesNotMatch(a.host.textContent!, /Chat of q/, 'and does not come back with the account');
});

const computer = (id: string, name: string) => ({ id, name, status: 'online', line: 'Ready', tone: 'ok', keepRunning: null, agents: [] });
const both = [computer('local', 'Studio Mac'), computer('h1', 'build-box')];

test('with more than one computer a row says which one its chat is on, after its state and age; with one it says nothing', async () => {
  const onMac = await mount(row({ id: 'm', title: 'Local', state: 'waiting', at: NOW - 3 * 3_600_000 }, { machines: both }));
  assert.match(onMac.host.textContent!, /LocalWaiting for you · 3h · Studio Mac/, 'a chat of the Mac names the Mac');
  const onHost = await mount(row({ id: 'h', title: 'Hosted', state: 'running', at: NOW - 60_000, hostId: 'h1' }, { machines: both }));
  assert.match(onHost.host.textContent!, /HostedWorking · 1m · build-box/, 'a chat of a Host names the Host');
  const withProject = await mount(
    row({ id: 'p', title: 'Shop', state: 'idle', at: NOW - 3_600_000 }, { machines: both, subtitle: 'checkout' }),
  );
  assert.match(withProject.host.textContent!, /Shopcheckout · 1h · Studio Mac/, 'after the project and the age');
  for (const alone of [null, [computer('local', 'Studio Mac')]]) {
    const one = await mount(row({ id: 'o', title: 'Solo', state: 'waiting', at: NOW - 3_600_000 }, { machines: alone }));
    assert.doesNotMatch(one.host.textContent!, /Studio Mac/, 'one computer is not named on every row');
  }
  const unknown = await mount(row({ id: 'u', title: 'Gone', state: 'idle', at: NOW - 3_600_000, hostId: 'h9' }, { machines: both }));
  assert.doesNotMatch(unknown.host.textContent!, /build-box|Studio Mac/, 'a chat whose machine is not in the list names none');
  const card = await mount(row({ id: 'k', title: 'Asks', state: 'running', hostId: 'h1', hostCard: true }, { machines: both }));
  assert.equal(card.host.textContent!.split('build-box').length - 1, 1, 'a line that already names the Host does not name it twice');
});
