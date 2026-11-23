// The remote client service on fake operations: every method through a phone, forbidden and invalid paths, idempotency, follow and patches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, sansTook, settle } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { PANEL } = require('../electron/remote/service.cjs');
const { CHAT_GONE_TEXT } = require('../electron/chrome-extension/src/panelErrors.mjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false);
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};

test('machine.hello tells the phone what this Mac allows: methods, MoMo for the account, the permission ceiling', async () => {
  const r = rig({ momo: true, policy: { allow: (_pair: string, m: string) => m !== 'chat.start', permissionCeiling: () => 'default' } });
  const hello = ok(await r.phone('p1').ask('machine.hello'));
  assert.equal(hello.v, 1);
  assert.equal(hello.app, '1.2.3');
  assert.equal(hello.capabilities.momo, true);
  assert.equal(hello.capabilities.mirrors, false);
  assert.equal(hello.capabilities.permissionCeiling, 'default');
  assert.equal(hello.capabilities.sendId, true, 'phones are told chat.send answers a repeated send id once');
  assert.ok(hello.capabilities.methods.includes('chat.follow'));
  assert.ok(!hello.capabilities.methods.includes('chat.start'), 'a method the Mac does not allow is not offered');
  assert.ok(!hello.capabilities.methods.includes('panel.browserSettings'), 'the panel’s own methods are not a phone’s');
  const plain = rig();
  const h2 = ok(await plain.phone('p1').ask('machine.hello'));
  assert.ok(!('momo' in h2.capabilities || 'momoBrainSet' in h2.capabilities), 'no MoMo field, not even false');
  assert.equal(h2.capabilities.permissionCeiling, 'auto-review');
  assert.deepEqual(plain.service.methodsFor(PANEL).includes('chat.follow'), false);
  assert.equal(plain.service.methodsFor(PANEL).includes('chat.open'), true);
});

test('machine.hello names this computer for the phone: the host name by default, cleaned, and none when it is unusable', async () => {
  const named = ok(
    await rig({ machineName: () => 'Studio-Mac.local' })
      .phone('p1')
      .ask('machine.hello'),
  );
  assert.equal(named.name, 'Studio-Mac');
  assert.equal(
    ok(
      await rig({ machineName: () => '' })
        .phone('p1')
        .ask('machine.hello'),
    ).name,
    null,
  );
  const byDefault = ok(await rig().phone('p1').ask('machine.hello'));
  assert.ok(byDefault.name === null || (typeof byDefault.name === 'string' && !/\.local$/.test(byDefault.name)));
});

test('a phone reads and acts through the panel’s operations; results are the panel’s', async () => {
  const r = rig();
  const p = r.phone('p1');
  assert.deepEqual(ok(await p.ask('chats.recent', { limit: 5 })).chats, [
    { id: 'c1', title: 'One', harness: 'codex', at: 1, project: null, pinned: false, state: 'running' },
  ]);
  assert.deepEqual(r.calls[0], ['recent', 6, false, 0], 'one more than asked for, to learn whether there is another page');
  assert.deepEqual(ok(await p.ask('chats.pin', { chatId: 'c1', pinned: true })), { pinned: true });
  fail(await p.ask('chats.pin', { chatId: 'zzz' }), 'gone', /isn't in MoPilot/);
  assert.deepEqual(ok(await p.ask('projects.list')), { projects: [{ id: 'p1', name: 'P' }] });
  assert.deepEqual(ok(await p.ask('scheduled.list')), { tasks: [{ id: 't', name: 'T', next: null }] });
  assert.deepEqual(ok(await p.ask('harnesses.list')), { harnesses: [{ id: 'codex', label: 'Codex' }] });
  assert.deepEqual(ok(await p.ask('options.get', { chatId: 'c1' })), { models: [] });
  assert.deepEqual(ok(await p.ask('commands.list', { harness: 'codex' })), { commands: [] });
  assert.deepEqual(ok(await p.ask('dictation.engine')), { engine: 'local' });
  assert.deepEqual(ok(await p.ask('chat.read', { chatId: 'c1' })).rows, [{ role: 'user', text: 'hi' }]);
  assert.deepEqual(ok(await p.ask('chat.switch', { chatId: 'c1', harness: 'claude' })), { switched: true });
  assert.deepEqual(ok(await p.ask('chat.stop', { chatId: 'c1' })), { stopped: true });
  assert.deepEqual(ok(await p.ask('chat.attach', { dataUrl: 'data:x,y' })), { id: '0123456789abcdef', name: 'n', kind: 'file' });
  assert.deepEqual(ok(await p.ask('chat.transcribe', { mime: 'audio/wav', audio: 'aGk=' })), { text: 'hi' });
  assert.deepEqual(ok(await p.ask('card.choose', { chatId: 'c1', model: 'm' })), { chosen: true });
  assert.deepEqual(ok(await p.ask('card.permit', { chatId: 'c1', value: 'default' })), { permitted: true });
  assert.deepEqual(ok(await p.ask('options.set', { chatId: 'c1', model: 'm', effort: 'high' })), { chosen: true });
  assert.deepEqual(ok(await p.ask('options.set', { chatId: 'c1', value: 'read-only' })), { permitted: true });
  assert.deepEqual(r.calls.find((c) => c[0] === 'choose')![1], { chatId: 'c1', model: 'm', effort: null });
});

test('chat.send queues like the panel’s: one after another, warnings pass on, and a Stop retires the waiting', async () => {
  let release: () => void = () => undefined;
  const order: string[] = [];
  const r = rig({
    ops: {
      sendCheck: () => () => undefined,
      send: async (m: any) => {
        order.push(`start ${m.text}`);
        if (m.text === 'first') await new Promise<void>((res) => (release = res));
        order.push(`end ${m.text}`);
        return m.text === 'second' ? { warning: 'Your message is queued.' } : {};
      },
    },
  });
  const p = r.phone('p1');
  const first = p.ask('chat.send', { chatId: 'c1', text: 'first' }, 'a');
  await settle();
  const second = p.ask('chat.send', { chatId: 'c1', text: 'second' }, 'b');
  await settle();
  assert.deepEqual(order, ['start first'], 'the second waits for the first');
  release();
  await Promise.all([first, second]);
  await settle();
  const replyTo = (id: string) => p.inbox.find((m) => m.inReplyTo === id);
  assert.deepEqual(sansTook(ok(replyTo('a'))), { sent: true });
  assert.deepEqual(sansTook(ok(replyTo('b'))), { sent: true, warning: 'Your message is queued.' });
  assert.deepEqual(order, ['start first', 'end first', 'start second', 'end second']);
  // a Stop retires what is still waiting
  const q = rig({ ops: { send: async () => new Promise(() => undefined) } });
  const qp = q.phone('p1');
  void qp.ask('chat.send', { chatId: 'c1', text: 'one' }, 'x');
  void qp.ask('chat.send', { chatId: 'c1', text: 'two' }, 'y');
  await settle();
  await qp.ask('chat.stop', { chatId: 'c1' }, 'z');
  assert.equal(q.service.sendOwners.has('c1'), false);
  // an expired deadline is refused before the harness hears of it
  const late = rig();
  fail(await late.phone('p1').ask('chat.send', { chatId: 'c1', text: 'hi', deadline: 1 }), 'failed', /took too long/);
  // a Stop between accept and send ends it
  const stopped = rig({
    ops: {
      sendCheck: () => () => {
        throw new Error('stopped');
      },
    },
  });
  fail(await stopped.phone('p1').ask('chat.send', { chatId: 'c1', text: 'hi' }), 'failed', /stopped/);
});

test('chat.send under a send id goes to the harness once, however often the phone sends it again', async () => {
  let release: () => void = () => undefined;
  const reached: string[] = [];
  const r = rig({
    ops: {
      send: async (m: any) => {
        assert.equal('sendId' in m, false, 'the harness is not told the id');
        reached.push(m.text);
        if (m.text === 'slow') await new Promise<void>((res) => (release = res));
        if (m.text === 'broken') throw new Error('The harness did not accept the message.');
        return m.text === 'warned' ? { warning: 'Queued behind another message.' } : {};
      },
    },
  });
  const p = r.phone('p1');
  const sends = () => reached.filter((t) => t === 'slow').length;
  // the same message again while the first is still being worked on shares its outcome
  const first = p.ask('chat.send', { chatId: 'c1', text: 'slow', sendId: 'send-0001' }, 'a');
  await settle();
  const again = p.ask('chat.send', { chatId: 'c1', text: 'slow', sendId: 'send-0001', deadline: Date.now() + 30000 }, 'b');
  await settle();
  release();
  await Promise.all([first, again]);
  await settle();
  const replyTo = (id: string) => p.inbox.find((m) => m.inReplyTo === id);
  assert.deepEqual(sansTook(ok(replyTo('a'))), { sent: true });
  assert.deepEqual(sansTook(ok(replyTo('b'))), { sent: true });
  assert.equal(sends(), 1);
  // after it finished, a retry with a fresh request id (the phone lost the reply) is answered without sending again
  assert.deepEqual(sansTook(ok(await p.ask('chat.send', { chatId: 'c1', text: 'slow', sendId: 'send-0001' }, 'c'))), { sent: true });
  assert.equal(sends(), 1);
  // the id means that message: other text under it is refused, another chat's or another pair's id is its own
  fail(await p.ask('chat.send', { chatId: 'c1', text: 'other', sendId: 'send-0001' }, 'd'), 'send_conflict', /different message/);
  assert.equal(sends(), 1);
  await p.ask('chat.send', { chatId: 'c2', text: 'slow', sendId: 'send-0001' }, 'e').catch(() => undefined);
  const plain = ok(await r.phone('p2').ask('chat.send', { chatId: 'c1', text: 'plain', sendId: 'send-0001' }, 'f'));
  assert.deepEqual(sansTook(plain), { sent: true });
  // a send the harness refused may be sent again under the same id
  fail(await p.ask('chat.send', { chatId: 'c1', text: 'broken', sendId: 'send-0002' }, 'g'), 'failed', /did not accept/);
  fail(await p.ask('chat.send', { chatId: 'c1', text: 'broken', sendId: 'send-0002' }, 'h'), 'failed', /did not accept/);
  assert.equal(reached.filter((t) => t === 'broken').length, 2);
  // the reply a repeat gets is the first one, warning included
  const warned = { chatId: 'c1', text: 'warned', sendId: 'send-0003' };
  const firstAnswer = ok(await p.ask('chat.send', warned, 'w1'));
  assert.deepEqual(sansTook(firstAnswer), { sent: true, warning: 'Queued behind another message.' });
  assert.deepEqual(ok(await p.ask('chat.send', warned, 'w2')), firstAnswer, 'the repeat gets the first answer, tookMs too');
  assert.equal(reached.filter((t) => t === 'warned').length, 1);
  // a send without an id is as before, and a bad id is refused before anything happens
  await p.ask('chat.send', { chatId: 'c1', text: 'plain' }, 'i');
  await p.ask('chat.send', { chatId: 'c1', text: 'plain' }, 'j');
  assert.equal(reached.filter((t) => t === 'plain').length, 3, 'the other pair, and the two sends without an id');
  fail(await p.ask('chat.send', { chatId: 'c1', text: 'x', sendId: 'bad id!' }, 'k'), 'invalid', /send id/);
});

test('chat.start checks the harness, caps a permission, and returns the new chat', async () => {
  const r = rig({ policy: { permissionCeiling: () => 'default' } });
  const p = r.phone('p1');
  assert.deepEqual(ok(await p.ask('chat.start', { harness: 'codex', text: 'go' })), { chatId: 'new-chat' });
  assert.deepEqual(r.calls.find((c) => c[0] === 'start')![1], {
    harness: 'codex',
    text: 'go',
    projectId: null,
    model: null,
    effort: null,
    attachments: [],
    skills: [],
  });
  fail(await p.ask('chat.start', { harness: 'acp:off', text: 'go' }), 'failed', /can't start a chat now/);
  assert.deepEqual(ok(await p.ask('chat.start', { harness: 'codex', text: 'go', permission: 'read-only' })), { chatId: 'new-chat' });
  assert.equal(r.calls.filter((c) => c[0] === 'start').at(-1)![1].permission, 'read-only');
  fail(await p.ask('chat.start', { harness: 'codex', text: 'go', permission: 'full-access' }), 'forbidden', /Full access/);
  fail(await p.ask('chat.start', { harness: 'codex', text: 'go', permission: 'auto-review' }), 'forbidden', /above what this Mac allows/);
  // a result object passes through
  const obj = rig({ ops: { start: async () => ({ chatId: 'n2', warning: 'w' }) } });
  assert.deepEqual(ok(await obj.phone('p1').ask('chat.start', { harness: 'claude', text: 'go' })), { chatId: 'n2', warning: 'w' });
});

test('a phone never sets Full access and never above the Mac’s ceiling; the panel is as the app’s menu', async () => {
  const r = rig({ policy: { permissionCeiling: () => 'auto-review' } });
  const p = r.phone('p1');
  for (const method of ['card.permit', 'options.set']) {
    fail(await p.ask(method, { chatId: 'c1', value: 'full-access' }), 'forbidden', /Full access/);
    fail(await p.ask(method, { chatId: 'c1', value: 'bypassPermissions' }), 'forbidden', /Full access/);
    ok(await p.ask(method, { chatId: 'c1', value: 'auto-review' }));
    ok(await p.ask(method, { chatId: 'c1', value: 'plan' }));
  }
  const low = rig({ policy: { permissionCeiling: () => 'default' } });
  const lp = low.phone('p1');
  fail(await lp.ask('card.permit', { chatId: 'c1', value: 'auto-review' }), 'forbidden', /above/);
  ok(await lp.ask('card.permit', { chatId: 'c1', value: 'default' }));
  assert.deepEqual(await low.service.call(PANEL, 'card.permit', { chatId: 'c1', value: 'full-access' }), { permitted: true });
  assert.deepEqual(await low.service.call(PANEL, 'options.set', { chatId: 'c1', value: 'full-access' }), { permitted: true });
});

test('methods the Mac does not allow, the panel’s own, MoMo and unknown ones answer with a code', async () => {
  const r = rig({ policy: { allow: (_p: string, m: string) => m !== 'chats.recent' } });
  const p = r.phone('p1');
  fail(await p.ask('chats.recent'), 'forbidden', /doesn't allow/);
  fail(await p.ask('chat.open', { chatId: 'c1' }), 'forbidden');
  fail(await p.ask('panel.browserSettings', {}), 'forbidden');
  fail(await p.ask('chat.nope'), 'invalid', /^Unknown request: chat\.nope$/);
  fail(await p.ask('momo.chat', {}), 'invalid', /^Unknown request: momo\.chat$/);
  fail(await p.ask('chat.read', { chatId: 'not valid' }), 'invalid', /isn't in MoPilot/);
  assert.equal(r.calls.length, 0, 'nothing reached an operation');
  const momo = rig({ momo: true });
  fail(await momo.phone('p1').ask('momo.chat', {}), 'invalid', /Unknown request/);
  // the panel may not follow, and a phone that follows is not the panel
  await assert.rejects(r.service.call(PANEL, 'chat.follow', { chatId: 'c1' }), /doesn't allow/);
  await assert.rejects(r.service.call(PANEL, 'device.unpair', {}), /doesn't allow/);
  assert.deepEqual(await r.service.call(PANEL, 'chat.open', { chatId: 'c1', page: 'scheduled' }), { opened: true });
  assert.deepEqual(await r.service.call(PANEL, 'panel.browserSettings', { a: 1 }), { ok: true });
});

test('a phone that leaves is forgotten by the Mac', async () => {
  const seen: string[] = [];
  const r = rig({ policy: { onUnpair: (pair: string) => (seen.push(pair), true) } });
  assert.deepEqual(ok(await r.phone('p2').ask('device.unpair')), { unpaired: true });
  assert.deepEqual(seen, ['p2']);
  const failed = rig({ policy: { onUnpair: () => false } });
  fail(await failed.phone('p1').ask('device.unpair'), 'failed');
  const none = rig();
  fail(await none.phone('p1').ask('device.unpair'), 'forbidden');
  assert.equal(none.service.methodsFor(none.service.phones.get('p1').client).includes('device.unpair'), false);
});

test('a retried request id replays the reply instead of acting twice, in flight or after', async () => {
  let gate: () => void = () => undefined;
  const r = rig({ ops: { stop: async () => new Promise<void>((res) => (gate = res)) } });
  const p = r.phone('p1');
  const a = p.ask('chat.stop', { chatId: 'c1' }, 'same');
  await settle();
  void p.ask('chat.stop', { chatId: 'c1' }, 'same');
  await settle();
  gate();
  await a;
  await settle();
  const replies = p.inbox.filter((m) => m.inReplyTo === 'same');
  assert.equal(replies.length, 2, 'both asks are answered');
  assert.deepEqual(replies[0], replies[1], 'with the same reply');
  assert.deepEqual(replies[0].result, { stopped: true });
  // after it finished, a retry is replayed too (an error reply as well)
  const q = rig();
  const qp = q.phone('p1');
  await qp.ask('chat.send', { chatId: 'c1', text: 'once' }, 'k');
  await qp.ask('chat.send', { chatId: 'c1', text: 'once' }, 'k');
  assert.equal(q.calls.filter((c) => c[0] === 'send').length, 1);
  await qp.ask('chat.read', { chatId: 'bad id' }, 'e');
  const again = await qp.ask('chat.read', { chatId: 'bad id' }, 'e');
  assert.equal(again.error.code, 'invalid');
  // another pair's ids are its own
  const other = q.phone('p2');
  await other.ask('chat.send', { chatId: 'c1', text: 'once' }, 'k');
  assert.equal(q.calls.filter((c) => c[0] === 'send').length, 2);
});

test('only the last 1000 replies per pair are kept', async () => {
  const r = rig();
  const p = r.phone('p1');
  for (let i = 0; i < 1001; i++) await p.send({ id: `m${i}`, t: 1, kind: 'request', method: 'projects.list', params: {} });
  await settle();
  const before = r.calls.filter((c) => c[0] === 'projects').length;
  assert.equal(before, 1001);
  await p.send({ id: 'm1000', t: 1, kind: 'request', method: 'projects.list', params: {} });
  await settle();
  assert.equal(r.calls.filter((c) => c[0] === 'projects').length, 1001, 'the newest is still replayed');
  await p.send({ id: 'm0', t: 1, kind: 'request', method: 'projects.list', params: {} });
  await settle();
  assert.equal(r.calls.filter((c) => c[0] === 'projects').length, 1002, 'the oldest was forgotten, so it acts again');
});

test('frames that are not requests, ids that are missing and pairs that are unknown are ignored', async () => {
  const r = rig();
  const p = r.phone('p1');
  await p.send({ id: 'x1', t: 1, kind: 'ack' });
  await p.send({ id: '', t: 1, kind: 'request', method: 'projects.list' });
  await p.send({ t: 1, kind: 'request', method: 'projects.list' } as any);
  r.link.addPair('p3');
  r.service.phones.delete('p3');
  await r.link.phone('p3').send({ id: 'y', t: 1, kind: 'request', method: 'projects.list' });
  await settle();
  assert.equal(r.calls.length, 0);
  assert.equal(p.inbox.length, 0);
});

test('a reply that cannot be sent is noted, not thrown, and a pair that unpairs loses its state', async () => {
  const r = rig();
  const p = r.phone('p1');
  const send = r.link.mac.send;
  r.link.mac.send = async () => {
    throw new Error('offline');
  };
  await p.send({ id: 'q', t: 1, kind: 'request', method: 'projects.list', params: {} });
  await settle();
  r.link.mac.send = send;
  r.link.removePair('p2');
  assert.equal(r.service.phones.has('p2'), false);
  assert.equal(r.service.phones.has('p1'), true);
  r.service.detach();
  assert.equal(r.service.attached, false);
  assert.equal(r.service.phones.size, 0);
  // attaching again replaces the earlier transport
  r.service.attach(r.link.mac);
  r.service.attach(r.link.mac);
  assert.equal(r.service.attached, true);
});

test('chat.follow sends a snapshot, then session patches by rev; what a window shows only is not sent', async () => {
  const r = rig();
  const p = r.phone('p1');
  r.state.patch('c1', {
    turn: 'running',
    queue: [{ id: 'q1', text: 'next', attachments: ['/secret/file'], opts: { model: 'x' } }],
    approvals: [{ id: 'a1', method: 'item/commandExecution/requestApproval', params: { command: 'ls', secret: 'tool args' } }],
  });
  const snap = ok(await p.ask('chat.follow', { chatId: 'c1', items: 10 }));
  assert.equal(snap.chatId, 'c1');
  assert.equal(snap.rev, r.state.get('c1').rev);
  assert.equal(snap.session.turn, 'running');
  assert.deepEqual(snap.session.queue, [{ id: 'q1', text: 'next', mine: true, attached: 1 }]);
  assert.equal(snap.session.approvals, undefined, 'approvals travel as cards');
  assert.deepEqual(snap.session.cards, [
    { id: 'a1', title: 'Run this command?', detail: 'ls', choices: snap.session.cards[0].choices, rev: snap.rev, where: 'phone' },
  ]);
  assert.equal(JSON.stringify(snap).includes('tool args'), false);
  assert.equal(JSON.stringify(snap).includes('/secret/file'), false);
  assert.equal(snap.itemsShape, 'rows');
  assert.deepEqual(
    r.calls.find((c) => c[0] === 'items'),
    ['items', 'c1', 10],
  );
  // a patch reaches the follower, with the new rev
  r.state.patch('c1', { plan: true });
  await settle();
  const patch = p.events('session.patch').at(-1);
  assert.deepEqual([patch.chatId, patch.rev, patch.patch], ['c1', r.state.get('c1').rev, { plan: true }]);
  // another phone that does not follow hears nothing; a patch on another chat neither
  assert.equal(r.phone('p2').events().length, 0);
  r.state.patch('c2', { plan: true });
  await settle();
  assert.equal(p.events('session.patch').length, 1);
  // a change of cards carries the cards, each with the rev it was raised at
  r.cards.c1 = [{ id: 'a2', title: 'Edit?', detail: null, choices: [], version: 'v2' }];
  r.state.patch('c1', { approvals: [{ id: 'a2', method: 'x', params: {} }] });
  await settle();
  const cards = p.events('cards.changed').at(-1);
  assert.deepEqual(cards.cards, [{ id: 'a2', title: 'Edit?', detail: null, choices: [], where: 'phone', rev: cards.rev }]);
  assert.equal(p.events('session.patch').at(-1).patch.approvals, undefined);
  // unfollow stops them; a gap is answered by following again, which sends a fresh snapshot
  assert.deepEqual(ok(await p.ask('chat.unfollow', { chatId: 'c1' })), { unfollowed: true });
  r.state.patch('c1', { plan: false });
  await settle();
  assert.equal(p.events('session.patch').length, 2);
  const again = ok(await p.ask('chat.follow', { chatId: 'c1' }));
  assert.equal(again.rev, r.state.get('c1').rev);
});

test('chat.follow refuses a chat that is gone, and a failed snapshot leaves nothing followed', async () => {
  const r = rig();
  const p = r.phone('p1');
  const gone = await p.ask('chat.follow', { chatId: 'nowhere' });
  fail(gone, 'gone', new RegExp(CHAT_GONE_TEXT.slice(0, 10)));
  const broken = rig({ ops: { cardsOf: async () => Promise.reject(new Error('cards down')) } });
  fail(await broken.phone('p1').ask('chat.follow', { chatId: 'c1' }), 'failed', /cards down/);
  assert.equal(broken.service.followers('c1').length, 0);
  // an op that throws the panel's chat-gone text is a gone reply
  const read = rig({ ops: { read: async () => Promise.reject(new Error(CHAT_GONE_TEXT)) } });
  fail(await read.phone('p1').ask('chat.read', { chatId: 'c1' }), 'gone');
});

test('translated items reach the phones that follow the chat, in order, with the rev', async () => {
  const r = rig();
  const p = r.phone('p1');
  ok(await p.ask('chat.follow', { chatId: 'c1' }));
  r.service.onFeedEvent({ ev: 'items.append', chatId: 'c1', items: [{ id: 'i1' }] } as any);
  r.service.onFeedEvent({ ev: 'items.replace', chatId: 'c1', items: [{ id: 'i1', done: true }] } as any);
  r.service.onFeedEvent({ ev: 'items.append', chatId: 'c2', items: [{ id: 'other' }] } as any);
  await settle();
  const items = p.events().filter((e) => e.ev.startsWith('items.'));
  assert.deepEqual(
    items.map((e) => [e.ev, e.chatId, e.items[0].id]),
    [
      ['items.append', 'c1', 'i1'],
      ['items.replace', 'c1', 'i1'],
    ],
  );
  assert.equal(items[0].rev, r.state.get('c1').rev);
  // an event that cannot be delivered does not stop the next
  const send = r.link.mac.send;
  r.link.mac.send = async () => {
    throw new Error('offline');
  };
  r.service.onFeedEvent({ ev: 'items.append', chatId: 'c1', items: [{ id: 'i2' }] } as any);
  await settle();
  r.link.mac.send = send;
  r.service.onFeedEvent({ ev: 'items.append', chatId: 'c1', items: [{ id: 'i3' }] } as any);
  await settle();
  assert.equal(p.events('items.append').at(-1).items[0].id, 'i3');
});

test('a phone’s tab is dropped, and a pair that leaves takes its follows and card revs with it', async () => {
  const r = rig();
  const p = r.phone('p1');
  ok(await p.ask('chat.send', { chatId: 'c1', text: 'hi', tab: { url: 'https://a.example/' } }));
  assert.equal(r.calls.find((c) => c[0] === 'send')![1].text, 'hi');
  assert.equal('tab' in r.calls.find((c) => c[0] === 'send')![1], false);
  ok(await p.ask('chat.read', { chatId: 'c1' }, undefined));
  r.state.patch('c1', { approvals: [{ id: 'a1', method: 'x', params: {} }] });
  ok(await p.ask('chat.follow', { chatId: 'c1' }));
  assert.notEqual(r.service.ledger.revOf('c1', 'v1'), undefined);
  r.link.removePair('p1');
  assert.equal(r.service.ledger.revOf('c1', 'v1'), undefined);
  // the panel keeps its tab line
  await r.service.call(PANEL, 'chat.send', { chatId: 'c1', text: 'hi', tab: { url: 'https://a.example/' } });
  assert.match(r.calls.filter((c) => c[0] === 'send').at(-1)![1].text, /Chrome tab: https:\/\/a.example/);
});

test('the panel starts a chat with a permission uncapped, and its sends map is the service’s', async () => {
  const r = rig({ policy: { permissionCeiling: () => 'read-only' } });
  assert.deepEqual(await r.service.call(PANEL, 'chat.start', { harness: 'codex', text: 'go', permission: 'full-access' }), {
    chatId: 'new-chat',
  });
  assert.equal(r.calls.filter((c) => c[0] === 'start').at(-1)![1].permission, 'full-access');
  const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
  const panel = new ChromePanel({});
  assert.equal(panel.sends, panel.service.sends);
  assert.equal(panel.sendOwners, panel.service.sendOwners);
});

test('a phone’s start permission is capped at auto-review when the Mac names no ceiling', async () => {
  const r = rig();
  const p = r.phone('p1');
  assert.deepEqual(ok(await p.ask('chat.start', { harness: 'codex', text: 'go', permission: 'default' })), { chatId: 'new-chat' });
  fail(await p.ask('chat.start', { harness: 'codex', text: 'go', permission: 'full-access' }), 'forbidden');
});

test('the speech lease is the panel’s: it begins and ends through the operations, a phone is refused, and operations without begin ask for an update', async () => {
  const speech: any[] = [];
  const r = rig({
    ops: {
      dictation: {
        engine: async () => 'local',
        transcribe: async () => ({ text: 'hi' }),
        begin: async (...args: any[]) => (speech.push(['begin', ...args]), { engine: 'local', capture: 'held' }),
        end: async (...args: any[]) => void speech.push(['end', ...args]),
      },
    },
  });
  assert.deepEqual(await r.service.call(PANEL, 'dictation.begin', { capture: true, clientId: 'client', generation: 1, chatId: 'c1' }), {
    engine: 'local',
    capture: 'held',
  });
  assert.deepEqual(await r.service.call(PANEL, 'dictation.end', { capture: 'held', clientId: 'client', generation: 1 }), {
    released: true,
  });
  assert.deepEqual(speech, [
    ['begin', 'client', { chatId: 'c1' }, 1],
    ['end', 'held', 'client', 1],
  ]);
  const p = r.phone('p1');
  fail(await p.ask('dictation.begin', { capture: true, chatId: 'c1' }), 'forbidden');
  fail(await p.ask('dictation.end', { capture: 'held' }), 'forbidden');
  assert.ok(
    !ok(await p.ask('machine.hello')).capabilities.methods.some((m: string) => m.startsWith('dictation.b') || m === 'dictation.end'),
  );
  const bare = rig();
  await assert.rejects(bare.service.call(PANEL, 'dictation.begin', { capture: true, chatId: 'c1' }), /Update the MoPilot extension/);
  assert.deepEqual(await bare.service.call(PANEL, 'dictation.end', {}), { released: true });
});
