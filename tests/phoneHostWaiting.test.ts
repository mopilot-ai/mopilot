// A Host's waiting cards on the home (#4593): why a machine "Needs attention", the chats a Host waits on, and the hook that keeps them current.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot } from './support/phone/component-kit';
import { attentionReason, GENERIC_ATTENTION } from '../mobile/src/remote/machines.ts';

const hookPath = '../mobile/src/remote/useHostWaiting';
const { useHostWaiting, withHostWaiting, withStarted, viaHost, carriesCards, homeTaps, HOME_WATCH_MS } = await import(hookPath);

const agent = (state: string) => ({ id: 'a', label: 'A', state, via: null });

test('the reason is read only where the Mac said no more than "Needs attention": no agent on the machine is ready', () => {
  const m = (line: string, tone: string, agents: any[]) => ({ line, tone, agents }) as any;
  assert.equal(GENERIC_ATTENTION, 'Needs attention');
  assert.equal(attentionReason(m('Needs attention', 'warn', [])), 'No agent is ready');
  assert.equal(attentionReason(m('Needs attention', 'warn', [agent('signin'), agent('missing')])), 'No agent is ready');
  assert.equal(attentionReason(m('Needs attention', 'warn', [agent('ready')])), null);
  assert.equal(attentionReason(m('Claude needs sign-in', 'warn', [])), null, 'a line that says more is left alone');
  assert.equal(attentionReason(m('Needs attention', 'ok', [])), null);
});

test('a chat a Host waits on is drawn as waiting, with its machine; chats already waiting and chats nothing waits on are left as they are', () => {
  const chats = [
    { id: 'c1', state: 'idle' },
    { id: 'c2', state: 'waiting', hostId: 'other' },
    { id: 'c3', state: 'idle' },
  ];
  const waiting = new Map([
    ['c1', 'h1'],
    ['c2', 'h1'],
  ]);
  assert.deepEqual(withHostWaiting(chats, waiting), [
    { id: 'c1', state: 'waiting', hostId: 'h1', hostCard: true },
    { id: 'c2', state: 'waiting', hostId: 'other' },
    { id: 'c3', state: 'idle' },
  ]);
  assert.equal(withHostWaiting(chats, new Map()), chats);
  assert.equal(withHostWaiting(null, waiting), null);
  assert.deepEqual(withHostWaiting([{ id: 'c1', state: 'idle', hostId: 'mine' }], waiting), [
    { id: 'c1', state: 'waiting', hostId: 'mine', hostCard: true },
  ]);
});

test('the home reads the cards now and then and keeps the chats they wait on, only the waiting ones, until it is gone', async () => {
  const log: string[] = [];
  const shown = [
    { card: { chatId: 'c1' }, state: { kind: 'waiting' } },
    { card: { chatId: 'claude:11111111-2222-4333-8444-555555555555' }, state: { kind: 'waiting' } },
    { card: { chatId: 'c2' }, state: { kind: 'closed', line: 'x' } },
    { card: { chatId: 'c3' }, state: { kind: 'unreachable', optionId: 'a' } },
  ];
  const direct = {
    phones: {
      load: async () => undefined,
      records: () => [{ machineId: 'h1', name: 'Studio' }],
      hostKeyOf: () => 'k',
      reachable: () => true,
      enrolled: () => true,
      setupState: () => 'idle',
      watch: (ms: number) => (log.push(`watch ${ms}`), () => void log.push('stop')),
    },
    cards: { waiting: () => 1, list: () => shown },
    subscribe: () => () => undefined,
  };
  let latest: Map<string, string> | null = null;
  function Probe() {
    latest = useHostWaiting({ direct } as any);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  assert.deepEqual(
    [...latest!],
    [
      ['c1', 'h1'],
      ['acp:host-codex:c1', 'h1'],
      ['claude:11111111-2222-4333-8444-555555555555', 'h1'],
      ['acp:host-claude:11111111-2222-4333-8444-555555555555', 'h1'],
    ],
    'the chat is found by the Host’s name for it and by the one the Mac lists',
  );
  assert.deepEqual(log, [`watch ${HOME_WATCH_MS}`]);
  await act(async () => root.unmount());
  assert.deepEqual(log, [`watch ${HOME_WATCH_MS}`, 'stop']);
  // a phone with no paths of its own has none
  let none: Map<string, string> | null = null;
  function Bare() {
    none = useHostWaiting({} as any);
    return null;
  }
  await act(async () => createRoot(document.createElement('div')).render(createElement(Bare)));
  assert.equal(none!.size, 0);
});

test('a tap on a chat a Host waits on opens that machine; any other chat goes where it did', () => {
  const log: string[] = [];
  const tap = viaHost(
    new Map([['c1', 'h1']]),
    (machine: string) => log.push(`machine ${machine}`),
    (chat: string) => log.push(`chat ${chat}`),
  );
  tap('c1');
  tap('c2');
  assert.deepEqual(log, ['machine h1', 'chat c2']);
});

test('a chat the Mac itself lists as waiting is opened as before, whatever a Host also holds on it', () => {
  const log: string[] = [];
  const tap = viaHost(
    new Map([
      ['c1', 'h1'],
      ['c2', 'h1'],
    ]),
    (machine: string) => log.push(`machine ${machine}`),
    (chat: string) => log.push(`chat ${chat}`),
    [{ id: 'c1', state: 'waiting' }],
  );
  tap('c1');
  tap('c2');
  assert.deepEqual(log, ['chat c1', 'machine h1']);
});

test('the cards are read only while the list is on screen', async () => {
  const log: string[] = [];
  const direct = {
    phones: {
      load: async () => undefined,
      records: () => [],
      hostKeyOf: () => 'k',
      reachable: () => true,
      enrolled: () => true,
      setupState: () => 'idle',
      watch: (ms: number) => (log.push(`watch ${ms}`), () => void log.push('stop')),
    },
    cards: { waiting: () => 0, list: () => [] },
    subscribe: () => () => undefined,
  };
  function Probe({ home }: { home: boolean }) {
    useHostWaiting({ direct } as any, home);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe, { home: false })));
  assert.deepEqual(log, [], 'a thread open: no watch');
  await act(async () => root.render(createElement(Probe, { home: true })));
  assert.deepEqual(log, [`watch ${HOME_WATCH_MS}`]);
  await act(async () => root.render(createElement(Probe, { home: false })));
  assert.deepEqual(log, [`watch ${HOME_WATCH_MS}`, 'stop']);
  await act(async () => root.unmount());
});

test('a chat that goes through the machine itself opens as a chat, where its card is drawn and answered; the Mac’s page is for the rest', () => {
  const log: string[] = [];
  const waiting = new Map([['c1', 'h1']]);
  const open = (carries: boolean) =>
    viaHost(
      waiting,
      (m: string) => log.push(`machine ${m}`),
      (c: string) => log.push(`chat ${c}`),
      null,
      () => carries,
    );
  open(false)('c1');
  open(true)('c1');
  assert.deepEqual(log, ['machine h1', 'chat c1']);
});

const kitOf = (started: Record<string, string> = {}, queued: { pairId: string; chatId: string }[] = [], waits: string[] = []) => ({
  direct: {
    chat: {
      enabled: () => true,
      hostOf: (c: string) => started[c],
      items: () => queued,
      // the Host's cards: a Claude Code chat is named one way by the Host and another in the Mac's list
      cards: { list: () => waits.map((chatId) => ({ state: { kind: 'waiting' }, card: { chatId } })) },
    },
  },
});

test('chats go through the machine with the Mac away and the phone following machine chats, and with the Mac there only a chat the machine holds', () => {
  const on = kitOf({ mine: 'h1' }, [{ pairId: 'h1', chatId: 'queued' }], ['theirs', 'claude:11111111-1111-4111-8111-111111111111']);
  assert.equal(carriesCards(false, on, 'h1', 'c1'), true, 'the Mac is away: the machine carries every chat');
  assert.equal(carriesCards(true, on, 'h1', 'c1'), false, 'the Mac is there and lists it: its page shows the card');
  assert.equal(carriesCards(true, on, 'h1', 'mine'), true, 'a chat this phone started on the machine goes there whatever the Mac does');
  assert.equal(carriesCards(true, on, 'h1', 'queued'), true, 'so does one with a message of this phone waiting for the machine');
  assert.equal(carriesCards(true, on, 'h1', 'theirs'), true, 'and one the machine holds a waiting card on, whoever started it');
  assert.equal(
    carriesCards(true, on, 'h1', 'acp:host-claude:11111111-1111-4111-8111-111111111111'),
    true,
    'the card’s chat is named the Host’s way, the row the Mac’s',
  );
  assert.equal(carriesCards(true, on, 'h2', 'mine'), false, 'a chat another machine started is not this one’s');
  assert.equal(carriesCards(true, on, undefined, 'mine'), false, 'a chat no machine waits on has no machine to go to');
  assert.equal(carriesCards(true, on, 'h1'), false);
  const off = { direct: { chat: { enabled: () => false, hostOf: () => 'h1', items: () => [], cards: { list: () => [] } } } };
  assert.equal(carriesCards(false, off, 'h1', 'mine'), false, 'the switch is off');
  assert.equal(carriesCards(true, off, 'h1', 'mine'), false);
  assert.equal(carriesCards(false, { direct: null }), false);
  assert.equal(carriesCards(false, {}), false);
});

test('every Home row kind × the Mac awake or away × held by the Mac or by the machine opens where its card can be answered', () => {
  // each row: what the Mac lists (state, or not listed), whether this phone started it on the machine, whether the machine holds a card on it
  const kinds = [
    // held by the Mac
    { id: 'macWaiting', listed: 'waiting', card: false, started: false },
    { id: 'macWaitingCard', listed: 'waiting', card: true, started: false },
    { id: 'macRunningCard', listed: 'running', card: true, started: false },
    { id: 'macRunning', listed: 'running', card: false, started: false },
    { id: 'macIdle', listed: 'idle', card: false, started: false },
    // held by the machine
    { id: 'startedCard', listed: null, card: true, started: true },
    { id: 'startedIdle', listed: null, card: false, started: true },
    { id: 'hostCardOnly', listed: null, card: true, started: false },
  ];
  const waiting = new Map(kinds.filter((k) => k.card).map((k) => [k.id, 'h1']));
  const listed = kinds.filter((k) => k.listed).map((k) => ({ id: k.id, state: k.listed as string }));
  const started = Object.fromEntries(kinds.filter((k) => k.started).map((k) => [k.id, 'h1']));
  const runtime = kitOf(
    started,
    [],
    kinds.filter((k) => k.card).map((k) => k.id),
  );
  const tapsOf = (macOnline: boolean, rt: any) => {
    const log: string[] = [];
    const taps = homeTaps(
      waiting,
      macOnline,
      rt,
      listed,
      (m: string) => log.push(`machine ${m}`),
      (c: string) => log.push(`chat ${c}`),
      (c: string) => log.push(`review ${c}`),
    );
    return { taps, log };
  };
  const row = (macOnline: boolean, rt: any = runtime) => {
    const { taps, log } = tapsOf(macOnline, rt);
    const out: Record<string, string[]> = {};
    for (const { id } of kinds) {
      log.length = 0;
      taps.open(id);
      taps.review(id);
      out[id] = [...log];
    }
    return out;
  };
  // the Mac awake: its own request keeps its review, anything the machine holds opens as a chat, the rest as before
  assert.deepEqual(row(true), {
    macWaiting: ['chat macWaiting', 'review macWaiting'],
    macWaitingCard: ['chat macWaitingCard', 'review macWaitingCard'],
    macRunningCard: ['chat macRunningCard', 'chat macRunningCard'],
    macRunning: ['chat macRunning', 'review macRunning'],
    macIdle: ['chat macIdle', 'review macIdle'],
    startedCard: ['chat startedCard', 'chat startedCard'],
    startedIdle: ['chat startedIdle', 'review startedIdle'],
    hostCardOnly: ['chat hostCardOnly', 'chat hostCardOnly'],
  });
  // the Mac away: every chat goes through the machine, a row never opens the machine's page
  const away = row(false);
  for (const { id } of kinds)
    assert.deepEqual(
      away[id].filter((l) => l.startsWith('machine')),
      [],
      id,
    );
  assert.deepEqual(away.macWaitingCard, ['chat macWaitingCard', 'chat macWaitingCard']);
  assert.deepEqual(away.macRunningCard, ['chat macRunningCard', 'chat macRunningCard']);
  // the switch off: no chat goes through the machine, so a card the Mac does not list is answered on the machine's page
  const switchedOff = { direct: { chat: { enabled: () => false, hostOf: () => undefined, items: () => [], cards: { list: () => [] } } } };
  assert.deepEqual(row(true, switchedOff).macRunningCard, ['machine h1', 'machine h1']);
  assert.deepEqual(row(true, switchedOff).macWaitingCard, ['chat macWaitingCard', 'review macWaitingCard']);
  assert.deepEqual(row(true, switchedOff).hostCardOnly, ['machine h1', 'machine h1']);
});

test('the chats this phone started on a machine have a Home row of their own where the Mac lists none, and the Mac’s own row stands once it has one', () => {
  const mine = [
    { chatId: 'a', machineId: 'h1', title: 'First', at: 5 },
    { chatId: 'b', machineId: 'h1', title: 'Second', at: 9 },
  ];
  assert.equal(withStarted(null, []), null);
  const only = withStarted(null, mine)!;
  assert.deepEqual(
    only.map((r: any) => [r.id, r.title, r.state, r.hostId, r.at]),
    [
      ['a', 'First', 'idle', 'h1', 5],
      ['b', 'Second', 'idle', 'h1', 9],
    ],
    'with no list at all (the Mac away and nothing cached) they are the list',
  );
  const macList = [{ id: 'a', title: 'Named by the Mac', state: 'running' }];
  const merged = withStarted(macList, mine)!;
  assert.deepEqual(
    merged.map((r: any) => [r.id, r.title]),
    [
      ['a', 'Named by the Mac'],
      ['b', 'Second'],
    ],
  );
  assert.equal(withStarted(macList, [mine[0]]), macList, 'nothing missing: the list is the Mac’s own');
  // a started chat whose machine holds a waiting card sits under Needs input, with the machine named
  const shown = withHostWaiting(only, new Map([['a', 'h1']]))!;
  assert.deepEqual(
    shown.map((r: any) => [r.id, r.state, r.hostCard ?? false]),
    [
      ['a', 'waiting', true],
      ['b', 'idle', false],
    ],
  );
});

test('Home’s two taps agree: a chat that goes through its machine opens as a chat from the row and from its quick review, any other Host card opens the machine, a Mac request opens its review', () => {
  const waiting = new Map([
    ['held', 'h1'],
    ['other', 'h1'],
    ['mac', 'h1'],
  ]);
  const log: string[] = [];
  const taps = homeTaps(
    waiting,
    true,
    kitOf({ held: 'h1' }),
    [{ id: 'mac', state: 'waiting' }],
    (m: string) => log.push(`machine ${m}`),
    (c: string) => log.push(`chat ${c}`),
    (c: string) => log.push(`review ${c}`),
  );
  for (const id of ['held', 'other', 'mac', 'plain']) {
    taps.open(id);
    taps.review(id);
  }
  assert.deepEqual(log, ['chat held', 'chat held', 'machine h1', 'machine h1', 'chat mac', 'review mac', 'chat plain', 'review plain']);
});
