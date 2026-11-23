// Computer access (#1364), a chat on another MoPilot using this Mac, end to end over 127.0.0.1: the client pairs (same
// code on both sides), offers computer_access_* through its registry (every harness's channel), runs this Mac's tools
// as a remote owner, shows this Mac's card in its own chat and sends the person's answer back, is stopped by Esc here,
// ends its turn here when its own turn ends, and says plainly when the computer can't be reached or refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world, until, fakeSafe, AccessStore, RemoteOwners } from './support/computer-access-kit.ts';

const require = createRequire(import.meta.url);
const { ComputerAccessClient, TOOL_NAMES } = require('../electron/computerAccess/client.cjs');
const { Registry, ToolError } = require('../electron/capabilities/contract/registry.cjs');
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

/** A broker over a session store, as main's: a card is an approval in the chat's state. */
function brokerOver(sessions: any) {
  const controller = {
    addApproval: (chatId: string, a: any) => sessions.patch(chatId, { approvals: [...sessions.get(chatId).approvals, a] }),
    resolveApproval: (id: string) => {
      for (const chatId of sessions.all()) {
        const list = sessions.get(chatId).approvals;
        if (list.some((a: any) => a.id === id)) {
          sessions.patch(chatId, { approvals: list.filter((a: any) => a.id !== id) });
          return true;
        }
      }
      return false;
    },
  };
  return new ApprovalBroker({ controller });
}

/** A host whose browser_click asks a site card (its own broker), and a client MoPilot paired with it. */
async function pairedWorld() {
  const hostRegistry = new Registry();
  let hostBroker: any = null;
  hostRegistry.register({ name: 'browser_navigate', policy: 'observe', handler: (a: any) => `went to ${a.url}` });
  hostRegistry.register({
    name: 'browser_click',
    policy: 'act',
    authorizesItself: true,
    handler: async (_a: any, ctx: any) => {
      const answer = await hostBroker.ask(ctx.chatId, 'browserOrigin', { origin: 'https://shop.example', level: 'write' });
      if (answer?.decision !== 'allow') throw new ToolError('The user did not allow https://shop.example.', 'denied');
      return 'clicked';
    },
  });
  hostRegistry.register({ name: 'desktop_screenshot', policy: 'observe', handler: () => 'shot' });
  const w = await world({ registry: hostRegistry, answer: (id: string, r: unknown) => hostBroker.answer(id, r) });
  hostBroker = brokerOver(w.sessions);
  // as computer use does in main: a card that left the session's approvals unanswered resolves as not allowed
  const toHost = w.host.onSessionPatch.bind(w.host);
  w.host.onSessionPatch = (p: any) => {
    toHost(p);
    if (p?.patch?.approvals) hostBroker.sweep(p.chatId, p.patch.approvals);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-access-client-'));
  const store = new AccessStore({ file: path.join(dir, 'store.json'), safeStorage: fakeSafe() });
  const sessions = new SessionStore();
  const broker = brokerOver(sessions);
  const stopped: string[] = [];
  const client = new ComputerAccessClient({
    store,
    broker: () => broker,
    facts: (chatId: string) => ({
      turn: sessions.get(chatId).activeTurn?.id ?? 'no-turn',
      human: true,
      unattended: false,
      harness: 'claude',
      model: 'claude-sonnet-5-5',
      anchor: 'ask',
    }),
    stopChat: (chatId: string) => stopped.push(chatId),
    deviceName: () => 'Laptop',
  });
  const registry = new Registry();
  client.sync(registry);
  const offer = w.host.startPairing().text;
  const { code, done } = await client.pair(offer);
  await until(() => w.host.request);
  assert.equal(w.host.state().request.code, code);
  w.host.answerPairing(true, { browser: true });
  const host = await done;
  const call = (chatId: string, tool: string, args: any, o: any = {}) => registry.invoke(chatId, 'seg', tool, args, o);
  const close = async () => {
    client.close();
    await w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { w, host, client, store, sessions, broker, registry, stopped, call, close };
}

test('a client chat lists the paired computer and its allowed tools, and runs one there as a remote owner', async () => {
  const t = await pairedWorld();
  try {
    assert.equal(t.host.name, 'Studio');
    assert.deepEqual(
      t.registry.list().map((x: any) => x.name),
      TOOL_NAMES,
    );
    // what Settings lists: the computer, connected, and no key
    const [listed] = t.client.hosts();
    assert.deepEqual([listed.name, listed.connected, 'key' in listed], ['Studio', true, false]);
    const hosts = await t.call('chat-A', 'remote_computers', {});
    assert.deepEqual(JSON.parse(hosts.content[0].text), { computers: [{ id: t.host.id, name: 'Studio', online: true }] });
    const tools = JSON.parse((await t.call('chat-A', 'remote_computer_tools', { host: 'studio' })).content[0].text).tools;
    assert.deepEqual(
      tools.map((x: any) => x.name),
      ['browser_navigate', 'browser_click'],
    );
    t.sessions.patch('chat-A', { turn: 'running', activeTurn: { id: 'turn-1', human: true } });
    const res = await t.call('chat-A', 'remote_computer_call', {
      host: t.host.id,
      tool: 'browser_navigate',
      args: { url: 'https://shop.example' },
    });
    assert.deepEqual(res.content, [{ type: 'text', text: 'went to https://shop.example' }]);
    const owner = t.w.owners.get(RemoteOwners.idOf(t.w.host.state().devices[0].id, 'chat-A'));
    assert.deepEqual([owner.harness, owner.model, owner.anchor, owner.human], ['claude', 'claude-sonnet-5-5', 'ask', true]);
    assert.equal(t.w.sessions.get(owner.id).activeTurn.id, 'turn-1');
    // a tool the device's scopes don't allow is refused there, and the chat is told why
    const refused = await t.call('chat-A', 'remote_computer_call', { tool: 'desktop_screenshot' });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'not_allowed');
    // the same computer paired again: one entry, one connection (the old one is closed with the old id)
    const again = await t.client.pair(t.w.host.startPairing().text);
    await until(() => t.w.host.request);
    t.w.host.answerPairing(true, { browser: true });
    const host2 = await again.done;
    assert.equal(t.store.hosts().length, 1);
    assert.notEqual(host2.id, t.host.id);
    await until(() => t.client.conns.size === 1);
    assert.ok(t.client.conns.get(host2.id).open);
    t.host = host2;
    // a chat that never used this computer ending its turn changes nothing there
    t.client.turnEnded('chat-never');
    // forgetting a computer that is connected ends its connection
    assert.equal(t.client.forget(t.host.id), true);
    assert.equal(t.client.conns.size, 0);
    assert.deepEqual(t.registry.list(), []);
  } finally {
    await t.close();
  }
});

test('a card this Mac raises shows in the client chat; the answer there runs the action, and a withdrawn card goes', async () => {
  const t = await pairedWorld();
  try {
    t.sessions.patch('chat-B', { turn: 'running', activeTurn: { id: 'turn-1', human: true } });
    const pending = t.call('chat-B', 'remote_computer_call', { tool: 'browser_click', args: {} });
    await until(() => t.sessions.get('chat-B').approvals.length === 1);
    const card = t.sessions.get('chat-B').approvals[0];
    assert.equal(card.method, 'sage/browserOrigin');
    assert.deepEqual(card.params.remote, { host: t.host.id, hostName: 'Studio' });
    assert.equal(card.params.origin, 'https://shop.example');
    t.broker.answer(card.id, { decision: 'allow', scope: 'once', level: 'write' });
    const res = await pending;
    assert.deepEqual(res.content, [{ type: 'text', text: 'clicked' }]);
    assert.equal(t.sessions.get('chat-B').approvals.length, 0);
    // a card the chat's turn ending here takes away: the computer ends the owner's turn, its card is withdrawn here too
    const second = t.call('chat-B', 'remote_computer_call', { tool: 'browser_click', args: {} });
    await until(() => t.sessions.get('chat-B').approvals.length === 1);
    t.client.onSessionPatch({ chatId: 'chat-B', patch: { turn: 'idle' } });
    const r2 = await second;
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'denied');
    await until(() => t.sessions.get('chat-B').approvals.length === 0);
    const owner = RemoteOwners.idOf(t.w.host.state().devices[0].id, 'chat-B');
    assert.equal(t.w.sessions.get(owner).turn, 'idle');
    // the computer turning access off while a card waits here: the card goes, the call fails
    t.sessions.patch('chat-B', { turn: 'running', activeTurn: { id: 'turn-2', human: true } });
    const third = t.call('chat-B', 'remote_computer_call', { tool: 'browser_click', args: {} });
    await until(() => t.sessions.get('chat-B').approvals.length === 1);
    await t.w.host.setEnabled(false);
    const r3 = await third;
    assert.equal(r3.ok, false);
    await until(() => t.sessions.get('chat-B').approvals.length === 0);
  } finally {
    await t.close();
  }
});

test('Esc on this Mac stops the client chat; a chat that never used the computer is never stopped by it', async () => {
  const t = await pairedWorld();
  try {
    t.sessions.patch('chat-C', { turn: 'running', activeTurn: { id: 't', human: true } });
    await t.call('chat-C', 'remote_computer_call', { tool: 'browser_navigate', args: { url: 'https://a.example' } });
    const owner = RemoteOwners.idOf(t.w.host.state().devices[0].id, 'chat-C');
    // another chat's turn ending here is not this one's: chat-C keeps its turn there
    t.client.turnEnded('chat-other');
    assert.equal(t.w.sessions.get(owner).turn, 'running');
    await t.w.owners.stop(owner);
    await until(() => t.stopped.length === 1);
    assert.deepEqual(t.stopped, ['chat-C']);
    // a forged stop for a chat that never used this computer
    const conn = t.client.conns.get(t.host.id);
    conn.emit('stop', { t: 'stop', chat: 'chat-unrelated' });
    assert.deepEqual(t.stopped, ['chat-C']);
  } finally {
    await t.close();
  }
});

test('the client says plainly when it cannot use a computer: none paired, none named, offline, removed, or refused', async () => {
  const t = await pairedWorld();
  try {
    // a second computer: now a call must name one
    t.store.addHost({ name: 'Office', key: t.store.identity().x, address: '127.0.0.1', port: 9 });
    const unnamed = await t.call('chat-D', 'remote_computer_call', { tool: 'browser_navigate' });
    assert.equal(unnamed.error.code, 'bad_args');
    assert.match(unnamed.error.message, /Studio, Office/);
    // the list reaches each computer: one that isn't there is offline
    const listed = JSON.parse((await t.call('chat-D', 'remote_computers', {})).content[0].text).computers;
    assert.deepEqual(
      listed.map((c: any) => [c.name, c.online]),
      [
        ['Studio', true],
        ['Office', false],
      ],
    );
    const unknown = await t.call('chat-D', 'remote_computer_tools', { host: 'Garage' });
    assert.equal(unknown.error.code, 'unknown_host');
    // a computer that isn't there: offline, with its name
    const offline = await t.call('chat-D', 'remote_computer_tools', { host: 'Office' });
    assert.equal(offline.error.code, 'offline');
    assert.match(offline.error.message, /^Office can't be reached/);
    // a chat that used the computer before it went away: its turn ending here has nobody to tell, and that is fine
    assert.equal(
      (await t.call('chat-D2', 'remote_computer_call', { host: 'Studio', tool: 'browser_navigate', args: { url: 'https://a.example' } }))
        .ok,
      true,
    );
    // removed on the computer: the call is refused, the connection ends, and a new one is refused
    t.w.host.revoke(t.w.host.state().devices[0].id);
    await until(() => !t.client.conns.get(t.host.id));
    t.client.turnEnded('chat-D2');
    const removed = await t.call('chat-D', 'remote_computer_tools', { host: 'Studio' });
    assert.equal(removed.error.code, 'offline');
    assert.match(removed.error.message, /not paired with that computer/);
    // forgotten here: no longer offered; with none left the tools go away
    assert.equal(t.client.forget(t.host.id), true);
    assert.equal(t.client.forget(t.host.id), false);
    const office = t.store.hosts()[0];
    assert.equal(t.client.forget(office.id), true);
    assert.deepEqual(t.registry.list(), []);
    const none = new ComputerAccessClient({
      store: t.store,
      broker: () => null,
      facts: () => ({}),
      stopChat: () => {},
      deviceName: () => 'x',
    });
    const h = none.handlers();
    await assert.rejects(h.remote_computer_tools({}), { code: 'unknown_host' });
    await assert.rejects(none.pair('not an offer'), { code: 'bad_offer' });
    assert.equal(none.forget('nope'), false);
  } finally {
    await t.close();
  }
});

test('pairing that this Mac denies saves nothing; a stopped call ends the turn there; a card nobody may answer here is not shown', async () => {
  const t = await pairedWorld();
  try {
    const offer = t.w.host.startPairing().text;
    const { done } = await t.client.pair(offer);
    await until(() => t.w.host.request);
    t.w.host.answerPairing(false);
    await assert.rejects(done, /didn't accept/);
    assert.equal(t.store.hosts().length, 1);
    // Stop here while a call waits on this Mac's card: the turn there ends and the call is refused
    t.sessions.patch('chat-E', { turn: 'running', activeTurn: { id: 't', human: true } });
    const ac = new AbortController();
    const pending = t.call('chat-E', 'remote_computer_call', { tool: 'browser_click', args: {} }, { signal: ac.signal });
    await until(() => t.sessions.get('chat-E').approvals.length === 1);
    ac.abort();
    const r = await pending;
    assert.equal(r.ok, false);
    const owner = RemoteOwners.idOf(t.w.host.state().devices[0].id, 'chat-E');
    await until(() => t.w.sessions.get(owner).turn === 'idle');
    // only this Mac may approve: the client chat is not shown the card
    t.w.store.setDevice(t.w.host.state().devices[0].id, { hostOnlyApprovals: true });
    t.sessions.patch('chat-F', { turn: 'running', activeTurn: { id: 't2', human: true } });
    const waiting = t.call('chat-F', 'remote_computer_call', { tool: 'browser_click', args: {} });
    const ownerF = RemoteOwners.idOf(t.w.host.state().devices[0].id, 'chat-F');
    await until(() => t.w.sessions.get(ownerF).approvals.length === 1);
    assert.equal(t.sessions.get('chat-F').approvals.length, 0);
    // answered on this Mac instead
    t.w.host.o.answer(t.w.sessions.get(ownerF).approvals[0].id, { decision: 'allow', scope: 'once', level: 'write' });
    assert.deepEqual((await waiting).content, [{ type: 'text', text: 'clicked' }]);
    // a card of a kind this app doesn't show, or for a chat that never used the computer, is ignored
    const conn = t.client.conns.get(t.host.id);
    conn.emit('approval', { chat: 'chat-F', approval: { id: 'x', method: 'item/commandExecution/requestApproval' } });
    conn.emit('approval', { chat: 'chat-Z', approval: { id: 'y', method: 'sage/browserOrigin' } });
    conn.emit('approval', { chat: 'chat-F', approval: null });
    conn.emit('withdraw', { id: 'never-shown' });
    assert.equal(t.sessions.get('chat-F').approvals.length, 0);
  } finally {
    await t.close();
  }
});

test('the client tools stay visible on every harness: no other family claims their names (visibility, host servers)', async () => {
  const { isToolHidden } = require('../electron/capabilities/visibility.cjs');
  const { placement } = require('../electron/capabilities/contract/hostServers.cjs');
  const flags = [
    'browserParity',
    'browserParityOff',
    'computerParity',
    'drivesUserChrome',
    'nativeChrome',
    'nativeComputer',
    'chromeRelay',
  ];
  for (let mask = 0; mask < 1 << flags.length; mask++) {
    const facts: any = Object.fromEntries(flags.map((f, i) => [f, !!(mask & (1 << i))]));
    for (const unavailable of [null, 'no helper'])
      for (const name of TOOL_NAMES)
        assert.equal(
          isToolHidden(name, { ...facts, computerUnavailable: unavailable }),
          false,
          `${name} hidden with ${JSON.stringify(facts)}`,
        );
  }
  // on Claude Code they stay on the session's own server under their own names
  for (const name of TOOL_NAMES) assert.deepEqual(placement(name, 'sage_0123456789ab'), { server: 'sage_0123456789ab', name });
});
