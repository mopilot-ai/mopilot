// Computer access (#1364), this Mac's side over a real loopback connection: calls only from a paired device that is still
// paired, only fresh and only to the tools its scopes allow, run as a remote owner through the registry; cards go to
// the device and come back answered; Esc, revoke and the switch off end everything at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, until, tick, ClientConnection, newKeyPair, parseOffer, RemoteOwners } from './support/computer-access-kit.ts';

test('calls: only the scopes the person gave, run as a remote owner (never above Ask) through the registry, logged without values', async () => {
  const records: any[] = [];
  const w = await world({ ledger: () => ({ record: (r: any) => records.push(r) }) });
  try {
    const { c, device } = await w.pair({ browser: true });
    assert.deepEqual(
      (await c.tools()).map((t: any) => t.name),
      ['browser_navigate'],
    );
    const res = await c.call({
      chat: 'chat-1',
      turn: 't1',
      harness: 'claude',
      model: 'claude-sonnet-5-5',
      anchor: 'full',
      human: true,
      tool: 'browser_navigate',
      args: { url: 'https://shop.example' },
    });
    assert.deepEqual(res, { ok: true, content: [{ type: 'text', text: 'went to https://shop.example' }], error: null });
    const id = RemoteOwners.idOf(device.id, 'chat-1');
    assert.equal(w.calls[0].ctx.chatId, id);
    const owner = w.owners.get(id);
    assert.equal(owner.anchor, 'ask');
    assert.equal(owner.harness, 'claude');
    assert.equal(w.sessions.get(id).turn, 'running');
    assert.deepEqual(w.sessions.get(id).activeTurn, { id: 't1', human: true });
    for (const tool of ['desktop_screenshot', 'browser_javascript_exec', 'send_message_to_chat', 'nope']) {
      const r = await c.call({ chat: 'chat-1', turn: 't1', tool });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'not_allowed');
    }
    const bad = await c.call({ chat: '', turn: 't1', tool: 'browser_navigate' });
    assert.equal(bad.error.code, 'malformed');
    const call = w.log.recent().find((l: any) => l.event === 'call');
    assert.deepEqual([call.tool, call.outcome, call.argKeys, call.chat], ['browser_navigate', 'ok', ['url'], 'chat-1']);
    assert.equal(JSON.stringify(w.log.recent()).includes('shop.example'), false);
    assert.deepEqual(records[0], {
      kind: 'computerAccess',
      harness: 'claude',
      chat: 'chat-1',
      device: device.id,
      tool: 'browser_navigate',
      outcome: 'ok',
      code: undefined,
    });
    assert.equal(w.written.length, w.log.recent().length);
  } finally {
    await w.close();
  }
});

test('calls: a replayed or stale call is refused, a failing ledger does not fail the call, and a new turn ends the last one', async () => {
  const w = await world({
    ledger: () => ({
      record: () => {
        throw new Error('disk full');
      },
    }),
  });
  try {
    const { c, device } = await w.pair();
    // a frame re-sent by hand with the same call id: the second is refused as replayed
    const send = (m: any) => c.send(m);
    const results: any[] = [];
    const orig = c.calls;
    const wait = (callId: string) => new Promise((resolve) => orig.set(callId, { resolve, reject: resolve, timer: undefined }));
    const m = { t: 'call', callId: 'call-replay-1', issuedAt: Date.now(), chat: 'c', turn: 't', tool: 'browser_navigate', args: {} };
    const first = wait('call-replay-1');
    send(m);
    results.push(await first);
    const second = wait('call-replay-1');
    send(m);
    results.push(await second);
    const stale = wait('call-stale-01');
    send({ ...m, callId: 'call-stale-01', issuedAt: Date.now() - 120_000 });
    results.push(await stale);
    assert.deepEqual(
      results.map((r: any) => r.ok || r.error.code),
      [true, 'replayed', 'stale'],
    );
    const id = RemoteOwners.idOf(device.id, 'c');
    const ended: string[] = [];
    w.host.o.sessions = () => ({
      get: (x: string) => w.sessions.get(x),
      has: (x: string) => w.sessions.has(x),
      patch: (x: string, p: any) => (p.turn && ended.push(p.turn), w.sessions.patch(x, p)),
    });
    await c.call({ chat: 'c', turn: 't2', tool: 'browser_navigate', unattended: true });
    assert.deepEqual(ended, ['idle', 'running']);
    assert.deepEqual(w.sessions.get(id).scheduled, { unattended: true, computer: true, onApproval: 'wait' });
    assert.equal(w.sessions.get(id).activeTurn.human, false);
    // the device says its turn ended: the turn ends here, the owner (and its grants) stays
    c.turnEnded('c');
    await until(() => w.sessions.get(id).turn === 'idle');
    assert.ok(w.owners.get(id));
    // a turn end for a chat that never called here changes nothing
    c.turnEnded('other');
    await tick(20);
  } finally {
    await w.close();
  }
});

test('cards: a remote owner’s card goes to its device, a person answers there, and it is withdrawn when it goes away', async () => {
  const w = await world();
  try {
    const { c, device } = await w.pair();
    await c.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
    const id = RemoteOwners.idOf(device.id, 'c');
    const got = new Promise((resolve) => c.once('approval', resolve));
    const card = { id: 'sage-browserOrigin-1', method: 'sage/browserOrigin', params: { origin: 'https://shop.example' } };
    w.sessions.patch(id, { approvals: [card] });
    w.host.onSessionPatch({ chatId: id, patch: { approvals: [card] } });
    const msg: any = await got;
    assert.deepEqual([msg.chat, msg.approval.id, msg.hostOnly], ['c', card.id, false]);
    // the same card again is not sent twice
    w.host.onSessionPatch({ chatId: id, patch: { approvals: [card] } });
    const answered = new Promise((resolve) => c.once('answered', resolve));
    c.answer(card.id, { decision: 'allow', scope: 'once', level: 'write' });
    assert.deepEqual(await answered, { t: 'answered', id: card.id, ok: true });
    assert.deepEqual(w.answers, [{ id: card.id, result: { decision: 'allow', scope: 'once', level: 'write' } }]);
    // a card that is not this device's, and an answer that is no card at all
    const unknown = new Promise((resolve) => c.once('answered', resolve));
    c.answer('sage-other-9', null);
    assert.equal(((await unknown) as any).code, 'unknown');
    const malformed = new Promise((resolve) => c.once('answered', resolve));
    c.send({ t: 'answer', id: 7 });
    assert.equal(((await malformed) as any).code, 'malformed');
    const withdrawn = new Promise((resolve) => c.once('withdraw', resolve));
    w.host.onSessionPatch({ chatId: id, patch: { approvals: [] } });
    assert.deepEqual(await withdrawn, { t: 'withdraw', chat: 'c', id: card.id });
    // patches of a chat here, or without cards, are not a device's business
    w.host.onSessionPatch({ chatId: 'local', patch: { approvals: [card] } });
    w.host.onSessionPatch({ chatId: id, patch: { turn: 'idle' } });
    w.host.onSessionPatch(null as any);
    w.host.onSessionPatch({ chatId: id, patch: { approvals: null } });
  } finally {
    await w.close();
  }
});

test('cards: with "only this Mac can approve", the device sees the card but its answer is refused', async () => {
  const w = await world();
  try {
    const { c, device } = await w.pair();
    w.store.setDevice(device.id, { hostOnlyApprovals: true });
    await c.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
    const id = RemoteOwners.idOf(device.id, 'c');
    assert.equal(w.owners.get(id).hostOnlyApprovals, true);
    const got = new Promise((resolve) => c.once('approval', resolve));
    w.host.onSessionPatch({ chatId: id, patch: { approvals: [{ id: 'sage-computerConfirm-1' }] } });
    assert.equal(((await got) as any).hostOnly, true);
    const answered = new Promise((resolve) => c.once('answered', resolve));
    c.answer('sage-computerConfirm-1', { decision: 'allow' });
    assert.equal(((await answered) as any).code, 'host_only');
    assert.deepEqual(w.answers, []);
  } finally {
    await w.close();
  }
});

test('stop: Esc or the tray on this Mac tells the device to stop its chat, and the owner goes away here', async () => {
  const w = await world();
  try {
    const { c, device } = await w.pair();
    await c.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
    const id = RemoteOwners.idOf(device.id, 'c');
    const stopped = new Promise((resolve) => c.once('stop', resolve));
    await w.owners.stop(id);
    assert.deepEqual(await stopped, { t: 'stop', chat: 'c' });
    assert.equal(w.owners.get(id), null);
    assert.equal(w.sessions.get(id).turn, 'idle');
    assert.ok(w.log.recent().some((l: any) => l.event === 'stop'));
  } finally {
    await w.close();
  }
});

test('revoke: the device is cut off at once, its owners go, and it cannot come back; a lost connection ends its owners too', async () => {
  const w = await world();
  try {
    const a = await w.pair();
    await a.c.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
    const closed = new Promise((resolve) => a.c.once('close', (code: number) => resolve(code)));
    assert.equal(w.host.revoke(a.device.id), true);
    assert.equal(await closed, 4410);
    assert.equal(w.owners.list().length, 0);
    assert.equal(w.host.revoke(a.device.id), false);
    await assert.rejects(w.connect(a.identity, a.hostKey), /not paired/);
    // a device whose connection drops: its chats' owners end here
    const b = await w.pair();
    await b.c.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
    assert.equal(w.owners.list().length, 1);
    b.c.close();
    await until(() => w.owners.list().length === 0);
    // it reconnects with its pinned key and is known again
    const again = await w.connect(b.identity, b.hostKey);
    assert.equal((await again.call({ chat: 'c', turn: 't2', tool: 'browser_navigate' })).ok, true);
    // revoked in the store behind the connection's back: its next request is refused and the connection ends
    w.store.revokeDevice(b.device.id);
    const refused = new Promise((resolve) => again.once('refused', resolve));
    const gone = new Promise((resolve) => again.once('close', (code: number) => resolve(code)));
    await assert.rejects(again.call({ chat: 'c', turn: 't2', tool: 'browser_navigate' }), /removed on that computer/);
    assert.equal(await gone, 4410);
    assert.equal(((await refused) as any).code, 'revoked');
  } finally {
    await w.close();
  }
});

test('kill switch: turning access off ends every connection and owner, and stops listening', async () => {
  const w = await world();
  try {
    const { c, device } = await w.pair();
    await c.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
    const closed = new Promise((resolve) => c.once('close', (code: number) => resolve(code)));
    await w.host.setEnabled(false);
    assert.equal(await closed, 4503);
    assert.equal(w.host.listening, null);
    assert.equal(w.owners.list().length, 0);
    assert.equal(w.sessions.get(RemoteOwners.idOf(device.id, 'c')).turn, 'idle');
    assert.ok(w.log.recent().some((l: any) => l.event === 'off'));
    // stopping again with nothing running logs nothing new
    const n = w.log.recent().length;
    await w.host.stop('off');
    assert.equal(w.log.recent().length, n);
  } finally {
    await w.close();
  }
});

test('edge: a device revoked as it connects, a card for an owner with no connection, and an answer without a result', async () => {
  const w = await world();
  try {
    const a = await w.pair();
    a.c.close();
    // the device is found by the handshake, then gone by the time the connection opens
    const real = w.store.deviceByKey.bind(w.store);
    let n = 0;
    // the handshake asks twice (hello, confirmation); the connection opening asks a third time
    w.store.deviceByKey = (k: string) => (++n > 2 ? null : real(k));
    const c = new ClientConnection({ url: w.url(), identity: a.identity, hostKey: a.hostKey });
    await c.connect();
    const code = await new Promise((resolve) => c.once('close', (x: number) => resolve(x)));
    assert.equal(code, 4403);
    w.store.deviceByKey = real;
    // an owner whose device isn't connected: its cards wait here
    const owner = w.owners.enter({ deviceId: 'gone', deviceName: 'x', clientChat: 'c', hostAnchor: 'ask' });
    w.host.onSessionPatch({ chatId: owner.id, patch: { approvals: [{ id: 'sage-1' }] } });
    assert.deepEqual([...w.host.sent.get(owner.id)], ['sage-1']);
    // a waiting pairing shows in Settings with its code
    const offer = parseOffer(w.host.startPairing().text);
    const p = new ClientConnection({
      url: w.url(),
      identity: newKeyPair(),
      pair: { name: 'Pad', secret: offer.secret, fingerprint: offer.fingerprint },
    });
    const r = await p.connect();
    await until(() => w.host.request);
    assert.deepEqual(w.host.state().request, { name: 'Pad', code: r.code });
    const paired = p.paired();
    w.host.answerPairing(true);
    await paired;
    await p.call({ chat: 'q', turn: 't', tool: 'browser_navigate' });
    const id = RemoteOwners.idOf(w.host.state().devices.at(-1).id, 'q');
    w.sessions.patch(id, { approvals: [{ id: 'sage-2' }] });
    const answered = new Promise((resolve) => p.once('answered', resolve));
    p.send({ t: 'answer', id: 'sage-2' });
    assert.equal(((await answered) as any).ok, true);
    assert.deepEqual(w.answers.at(-1), { id: 'sage-2', result: null });
  } finally {
    await w.close();
  }
});

test('a request that throws closes the connection; a call returns its error code', async () => {
  const registry = {
    list: () => [{ name: 'browser_navigate' }],
    invoke: async (_o: string, _s: string, _t: string, args: any) => {
      if (args.boom) throw new Error('boom');
      return { ok: false, content: [], error: { code: 'denied', message: 'The user did not allow this action' } };
    },
  };
  const records: any[] = [];
  const w = await world({ registry, ledger: () => ({ record: (x: any) => records.push(x) }) });
  try {
    const { c } = await w.pair();
    const r = await c.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
    assert.deepEqual(r.error, { code: 'denied', message: 'The user did not allow this action' });
    assert.deepEqual([records[0].outcome, records[0].code], ['error', 'denied']);
    assert.equal(w.log.recent().find((l: any) => l.event === 'call').code, 'denied');
    const closed = new Promise((resolve) => c.once('close', (code: number) => resolve(code)));
    c.call({ chat: 'c', turn: 't', tool: 'browser_navigate', args: { boom: true } }).catch(() => {});
    assert.equal(await closed, 4400);
    // a malformed turn-end ends the connection too
    const { c: d } = await w.pair();
    const closedD = new Promise((resolve) => d.once('close', (code: number) => resolve(code)));
    d.send({ t: 'turnEnded', chat: 5 });
    assert.equal(await closedD, 4400);
  } finally {
    await w.close();
  }
});
