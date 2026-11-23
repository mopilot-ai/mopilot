// The machine page and the Home card with the phone's own path (X3): the reach, "Use without your Mac" and its failures, the Host's waiting
// cards in each state while the Mac is away, the Mac's list joined with the enrolled machines, and the lane the paths ride on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { cardId, answeredState } from '../mobile/src/remote/hostCards';
import { withDirect, type DirectFacts, type Machine } from '../mobile/src/remote/machines';
import { toBase64 } from '../shared/remote/envelope.mjs';
import { createDirectHosts, hostLaneUrl } from '../mobile/src/remote/directHosts';
import { waitFor } from './support/waitFor.ts';
import { CARD, HOST_KEY, away, local, open, path, prim, studio, tapRow } from './support/phone/machine-page-kit';

test('through the Mac the page offers "Use without your Mac"; setting it up turns the reach to Direct', async () => {
  const p = path();
  const host = await open({ direct: p.direct, machines: [local, studio] });
  await tapRow(/^Studio/);
  assert.match(host.textContent!, /ReachThrough MacBook Pro/);
  assert.match(host.textContent!, /Change this machine on your Mac\./);
  await click('Use without your Mac');
  await waitFor(() => 'h1' in p.stored(), 'the enrollment to be kept');
  // no Host is on this relay: its own path reads as not reachable, never as the Direct its record would claim
  await waitFor(() => (document.body.textContent ?? '').includes('Not reachable directly'), 'the reach to say the Host does not answer');
  assert.doesNotMatch(host.textContent!, /Use without your Mac/);
  assert.equal(p.enrolls[0][0], 'h1');
  assert.ok('h1' in p.stored());
});

test('a refusal reads as Couldn’t set up with Try again, and an older Host as Update <machine>', async () => {
  const bad = path({ macFails: new Error('no') });
  const host = await open({ direct: bad.direct, machines: [local, studio] });
  await tapRow(/^Studio/);
  await click('Use without your Mac');
  await waitFor(() => (document.body.textContent ?? '').includes("Couldn't set up direct access to Studio."), 'the failure line');
  assert.match(host.textContent!, /Try again/);
  const old = path({ macFails: Object.assign(new Error('x'), { code: 'update_host' }) });
  const host2 = await open({ direct: old.direct, machines: [local, studio] });
  await tapRow(/^Studio/);
  await click('Use without your Mac');
  await waitFor(() => (document.body.textContent ?? '').includes('Update Studio.'), 'the update line');
  assert.match(host2.textContent!, /Update Studio\./);
});

test('with the Mac away the enrolled machine stays, with its waiting cards in the plan’s states', async () => {
  const p = path({ enrolled: true });
  await p.direct.phones.load();
  p.direct.cards.setPending(HOST_KEY, [CARD, { ...CARD, requestId: 'r2' }, { ...CARD, requestId: 'r3' }] as any);
  const watched: number[] = [];
  const watch = p.direct.phones.watch;
  p.direct.phones.watch = (ms: number) => (watched.push(ms), watch(ms));
  const host = await open({ direct: p.direct, machines: null, snap: away });
  assert.match(host.textContent!, /Studio3 waiting/, 'the line a Host with waiting cards has');
  assert.deepEqual(watched, [4000], 'the home reads them now and then, the list of computers adds nothing');
  await tapRow(/^Studio/);
  assert.deepEqual(watched, [4000, 1000], 'the machine page reads them every second while it is open');
  assert.match(host.textContent!, /Not reachable directly/, 'no Host answers here: the record alone does not make the path Direct');
  assert.match(host.textContent!, /Waiting/);
  assert.match(host.textContent!, /git push --force-with-lease/);
  p.direct.cards.close(cardId(HOST_KEY, 'c1', 'r2'), answeredState('allow', 'Work MacBook Pro'));
  p.direct.cards.close(cardId(HOST_KEY, 'c1', 'r3'), { kind: 'unreachable', optionId: 'a' });
  await flush();
  assert.match(host.textContent!, /Allowed on Work MacBook Pro/);
  assert.match(host.textContent!, /Couldn't reach Studio\./);
  assert.match(host.textContent!, /Try again/);
  // Try again repeats the tap that could not be delivered; no Host answers, so the card stays and says so
  await click('Try again');
  await waitFor(() => (document.body.textContent ?? '').includes("Couldn't reach Studio."), 'the unreachable line again');
  // a tap on Allow: no Host answers, so the card stays and says so
  await click('Allow');
  await waitFor(() => (document.body.textContent ?? '').includes("Couldn't reach Studio."), 'the unreachable line');
  p.direct.cards.close(cardId(HOST_KEY, 'c1', 'r1'), { kind: 'sending', optionId: 'a' });
  await flush();
  assert.match(host.textContent!, /…/);
});

test('the Mac’s list joined with the phone’s own paths: reach per machine, a machine only the phone knows, nothing when there is none', () => {
  const mac = [
    { id: 'local', name: 'M', status: 'online', line: 'Online', tone: 'ok', keepRunning: null, agents: [] },
    { id: 'h1', name: 'One', status: 'online', line: 'Online', tone: 'ok', keepRunning: null, agents: [] },
    { id: 'h2', name: 'Two', status: 'online', line: 'Online', tone: 'ok', keepRunning: null, agents: [] },
    { id: 'h3', name: 'Three', status: 'offline', line: 'Offline', tone: 'off', keepRunning: null, agents: [] },
  ] as Machine[];
  const facts = (waiting: Record<string, number>, up: boolean | null = true): DirectFacts => ({
    records: [
      { machineId: 'h1', name: 'One' },
      { machineId: 'h3', name: 'Three' },
      { machineId: 'h4', name: 'Four' },
    ],
    waiting: (id: string) => waiting[id] ?? 0,
    reachable: () => up,
    agents: (id: string) =>
      id === 'h1'
        ? [{ id: 'claude', label: 'Claude Code', state: 'ready', via: 'own' }]
        : id === 'h4'
          ? [{ id: 'codex', label: 'Codex', state: 'signin', via: null }]
          : null,
  });
  const joined = withDirect(mac, facts({ h1: 2 }))!;
  assert.deepEqual(
    joined.map((m) => [m.id, m.reach, m.line]),
    [
      ['local', undefined, 'Online'],
      ['h1', 'direct', '2 waiting'],
      ['h2', 'through', 'Online'],
      ['h3', 'direct', 'Offline'],
      ['h4', 'direct', 'Online'],
    ],
  );
  assert.equal(joined.find((m) => m.id === 'h1')!.tone, 'warn');
  // a machine the Mac lists keeps the Mac's agents (it knows what it lends); one only the phone knows has what its Host reported
  assert.deepEqual(
    joined.map((m) => [m.id, m.agents.map((a) => a.label)]),
    [
      ['local', []],
      ['h1', []],
      ['h2', []],
      ['h3', []],
      ['h4', ['Codex']],
    ],
  );
  const awayList = withDirect(null, facts({ h4: 1 }, false))!;
  assert.deepEqual(
    awayList.map((m) => [m.id, m.line, m.tone, m.status]),
    [
      ['h1', 'Offline', 'off', 'offline'],
      ['h3', 'Offline', 'off', 'offline'],
      ['h4', '1 waiting', 'warn', 'offline'],
    ],
  );
  assert.equal(withDirect(null, { records: [], waiting: () => 0, reachable: () => null, agents: () => null }), null);
  assert.equal(
    withDirect([mac[0]], { records: [], waiting: () => 0, reachable: () => null, agents: () => null }),
    null,
    'a list of only this Mac shows nothing',
  );
});

test('the Host lane: its address, the account token, requests and frames', async () => {
  assert.equal(hostLaneUrl('wss://r/v1/ws'), 'wss://r/v1/ws?as=hostlink');
  assert.equal(hostLaneUrl('wss://r/v1/ws?x=1'), 'wss://r/v1/ws?x=1&as=hostlink');
  const sockets: any[] = [];
  const stored: Record<string, any> = {};
  const direct = createDirectHosts({
    prim,
    vault: {
      getHosts: async () => stored,
      putHost: async (id: string, r: object) => void (stored[id] = r),
      removeHost: async () => true,
      getIdentity: async () => ({ ed: prim.edKeypair() }),
    } as any,
    relayUrl: 'wss://r/v1/ws',
    auth: { relayToken: async () => 'tok' },
    open: (url: string, token: string) => {
      const socket: any = {
        url,
        token,
        sent: [] as any[],
        send(t: string) {
          this.sent.push(JSON.parse(t));
        },
        close() {},
      };
      sockets.push(socket);
      return socket;
    },
    request: async (method: string, params: any) => ({
      hostPub: toBase64(prim.randomBytes(32)),
      hostEphPub: toBase64(prim.randomBytes(32)),
      hostKey: HOST_KEY,
      name: 'Studio',
      features: [],
      method,
      params,
    }),
    deviceName: () => 'Pocket iPhone',
  });
  let heard = 0;
  const off = direct.subscribe(() => void heard++);
  const setUp = direct.phones.setUp('h1');
  await waitFor(() => sockets.length === 1, 'the lane to open');
  assert.deepEqual([sockets[0].url, sockets[0].token], ['wss://r/v1/ws?as=hostlink', 'tok']);
  sockets[0].onmessage({ data: JSON.stringify({ t: 'hello' }) });
  await waitFor(() => sockets[0].sent.some((m: any) => m.t === 'host.register'), 'the credential to be registered');
  const register = sockets[0].sent.find((m: any) => m.t === 'host.register');
  assert.equal(register.hash.length, 64);
  sockets[0].onmessage({ data: JSON.stringify({ t: 'ok', rid: register.rid }) });
  await setUp;
  assert.equal(direct.phones.enrolled('h1'), true);
  assert.ok(heard > 0);
  // frames and presence on the lane reach the sessions; one for no pair is ignored
  sockets[0].onmessage({ data: JSON.stringify({ t: 'frame', pair: 'p_unknown000', dir: 'p2m', ctr: 1, nonce: '', box: '' }) });
  sockets[0].onmessage({ data: JSON.stringify({ t: 'event', ev: 'peer', pair: 'p_unknown000', online: false }) });
  // a Host session riding the lane sends its first frame, and the app going to the background closes the lane
  void direct.phones.refresh('h1');
  await waitFor(() => sockets[0].sent.some((m: any) => m.t === 'frame'), 'the session to open');
  sockets[0].onclose({ code: 1006 });
  direct.phones.background();
  // giving the path up opens the lane again to take the credential back
  const forgotten = direct.phones.forget('h1');
  await waitFor(() => sockets.length === 2, 'the lane to open again');
  sockets[1].onmessage({ data: JSON.stringify({ t: 'hello' }) });
  await waitFor(() => sockets[1].sent.some((m: any) => m.t === 'host.revoke'), 'the credential to be revoked');
  const revoke = sockets[1].sent.find((m: any) => m.t === 'host.revoke');
  assert.equal(revoke.host, register.host);
  sockets[1].onmessage({ data: JSON.stringify({ t: 'ok', rid: revoke.rid }) });
  await forgotten;
  assert.equal(direct.phones.enrolled('h1'), false);
  off();
});

test('a card a Host holds is on the home: a count on its row with the reason, the chat under Needs input, and a tap lands on the card', async () => {
  const p = path({ enrolled: true });
  await p.direct.phones.load();
  p.direct.cards.setPending(HOST_KEY, [CARD] as any);
  // the Mac lists the machine as one that needs attention with no agent ready, and has the chat the card is for (idle there)
  const needy = { ...studio, status: 'needs-setup', line: 'Needs attention', tone: 'warn', agents: [] };
  const chat = { id: 'c1', title: 'Fix the build', state: 'idle', updatedAt: Date.now(), hostId: 'h1', project: 'repo' };
  const host = await open({ direct: p.direct, machines: [local, needy], home: true, chats: [chat] });
  assert.match(host.textContent!, /Studio/);
  assert.match(host.textContent!, /Needs attention · No agent is ready · Direct/, 'the row says why');
  assert.match(host.textContent!, /1 need input/, "the Host's own card is counted");
  assert.match(host.textContent!, /Needs input/, 'the chat the card is for sits under Needs input');
  assert.match(host.textContent!, /Needs you on Studio/, 'and its row says where');
  assert.equal(document.querySelector('[data-screen="settings"]'), null);
  await click('Studio, Needs attention · No agent is ready · Direct, 1 need input');
  await flush();
  assert.ok(document.querySelector('[data-screen="settings"]'));
  assert.match(host.textContent!, /Waiting/, 'one tap lands on the machine page with the card');
  assert.match(host.textContent!, /git push --force-with-lease/);
  // the chat row under Needs input goes to the same card, not to a quick review the Mac knows nothing of
  // a page opened from the home goes back to the home, not to a Settings list the person never opened
  await click('Back');
  await flush();
  assert.equal(document.querySelector('[data-screen="settings"]'), null);
  const row = [...document.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') ?? '').includes('Fix the build'),
  ) as HTMLElement;
  assert.ok(row, 'the chat row');
  await act(async () => row.click());
  await flush();
  assert.ok(document.querySelector('[data-screen="settings"]'));
  assert.match(host.textContent!, /git push --force-with-lease/);
});

test('a chat the Mac itself lists as waiting still opens as a chat, though a Host holds a card on it too', async () => {
  const p = path({ enrolled: true });
  await p.direct.phones.load();
  p.direct.cards.setPending(HOST_KEY, [CARD] as any);
  const chat = { id: 'c1', title: 'Fix the build', state: 'waiting', updatedAt: Date.now(), hostId: 'h1', project: 'repo' };
  await open({ direct: p.direct, machines: [local, studio], home: true, chats: [chat] });
  const row = [...document.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') ?? '').includes('Fix the build'),
  ) as HTMLElement;
  assert.ok(row, 'the chat row');
  await act(async () => row.click());
  await flush();
  assert.equal(
    document.querySelector('[data-screen="settings"]'),
    null,
    'the Mac knows this request: the chat opens, not the machine page',
  );
});

test('a machine with no card waiting opens its own page from the home too', async () => {
  const p = path({ enrolled: true });
  await p.direct.phones.load();
  const host = await open({ direct: p.direct, machines: [local, studio], home: true });
  await click('Studio, Online · direct · Direct');
  await flush();
  assert.match(host.textContent!, /Reach/);
});

test('a machine page lists the chats on that machine, newest first, while the phone follows machine chats itself; one opens as a chat', async () => {
  const p = path({ enrolled: true });
  await p.direct.phones.load();
  let on = true;
  (p.direct as any).chat = {
    enabled: () => on,
    told: () => undefined,
    startedOn: () => [],
    hostOf: () => undefined,
    items: () => [],
    cards: p.direct.cards,
  };
  const chat = (id: string, title: string, hostId: string, at: number, extra: object = {}) => ({
    id,
    title,
    state: 'idle',
    hostId,
    at,
    ...extra,
  });
  const chats = [
    chat('c1', 'Fix the build', 'h1', 10, { project: 'repo' }),
    chat('c2', 'Ship the release', 'h1', 30, { state: 'waiting' }),
    chat('c3', 'On the Mac', 'local', 50),
    chat('c4', '   ', 'h1', 20),
  ];
  await open({ direct: p.direct, machines: [local, studio], chats });
  await tapRow(/^Studio/);
  const text = document.querySelector('[data-screen="settings"]')!.textContent!;
  assert.match(text, /ChatsShip the releaseNeeds input›Untitled chat›Fix the buildrepo›/, 'this machine’s chats only, newest first');
  assert.doesNotMatch(text, /On the Mac/);
  const row = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').startsWith('Fix the build')) as HTMLElement;
  await act(async () => row.click());
  await flush();
  assert.equal(document.querySelector('[data-screen="settings"]'), null, 'the page closes');
  assert.match(document.querySelector('[data-stack]')!.getAttribute('data-stack')!, /chat/, 'and the chat is open');
  // the switch off: the page is as it was; no chat of the machine listed
  on = false;
  await open({ direct: p.direct, machines: [local, studio], chats });
  await tapRow(/^Studio/);
  assert.doesNotMatch(document.querySelector('[data-screen="settings"]')!.textContent!, /Fix the build/);
});

test('no Chats on a machine page when the Mac lists none on that machine', async () => {
  const p = path({ enrolled: true });
  await p.direct.phones.load();
  (p.direct as any).chat = {
    enabled: () => true,
    told: () => undefined,
    startedOn: () => [],
    hostOf: () => undefined,
    items: () => [],
    cards: p.direct.cards,
  };
  await open({
    direct: p.direct,
    machines: [local, studio],
    chats: [{ id: 'c3', title: 'On the Mac', state: 'idle', hostId: 'local', at: 1 }],
  });
  await tapRow(/^Studio/);
  const page = () => document.querySelector('[data-screen="settings"]')!.textContent!;
  assert.doesNotMatch(page(), /Chats/);
});

test('a machine the phone has no path to is not followed: its page lists no chats', async () => {
  const none = path();
  (none.direct as any).chat = {
    enabled: () => true,
    told: () => undefined,
    startedOn: () => [],
    hostOf: () => undefined,
    items: () => [],
    cards: none.direct.cards,
  };
  await open({ direct: none.direct, machines: [local, studio], chats: [{ id: 'c1', title: 'Fix', state: 'idle', hostId: 'h1', at: 1 }] });
  await tapRow(/^Studio/);
  const page = () => document.querySelector('[data-screen="settings"]')!.textContent!;
  assert.doesNotMatch(page(), /Chats/, 'a machine the phone has no path to is not followed');
});

test('a closed card says how it ended for a few seconds and then leaves the Waiting list', async () => {
  const path2 = '../mobile/src/components/MachineApprovals';
  const { MachineApprovals, CLOSED_SHOWN_MS } = await import(path2);
  const mk = (id: string, state: any, closedAt?: number) => ({
    id,
    hostKey: 'k',
    card: { ...CARD, requestId: id },
    via: 'direct',
    state,
    ...(closedAt === undefined ? {} : { closedAt }),
  });
  const closed = { kind: 'closed', line: 'Already answered on Work Mac.' };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cards = [
    mk('live', { kind: 'waiting' }),
    mk('fresh', closed, Date.now()),
    mk('old', { kind: 'closed', line: 'Old outcome.' }, Date.now() - CLOSED_SHOWN_MS - 1),
  ];
  await act(async () => root.render(createElement(MachineApprovals, { cards, machine: 'Studio', answer: () => undefined })));
  assert.match(host.textContent!, /Already answered on Work Mac\./);
  assert.doesNotMatch(host.textContent!, /Old outcome/);
  await act(async () =>
    root.render(createElement(MachineApprovals, { cards: [mk('old', closed, 1)], machine: 'Studio', answer: () => undefined })),
  );
  assert.equal(host.textContent, '', 'a list with only old closed cards draws nothing');
  await act(async () => root.unmount());
  host.remove();
});
