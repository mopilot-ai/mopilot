// The chat veil (host/src/chatVeil.mjs, host/src/momoChats.mjs rules): chats a feature keeps apart (MoMo's) are asked for and told of only to callers that may see them. A caller that may not gets what a chat the Host never heard of gives, and no result, event, push or audit line names one; a registry that cannot be read serves no chat request at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createChatVeil } from '../host/src/chatVeil.mjs';
// @ts-ignore
import { createMomoHidden, MOMO_AUDIT_ID } from '../host/src/momoWiring.mjs';
// @ts-ignore
import { createAudit } from '../host/src/audit.mjs';
// @ts-ignore
import { helloParams, PARSERS } from '../shared/host/schema.mjs';

import { MOMO, scratch, world } from './support/host/momoVeilKit.ts';

test('unit: a hidden chat is a fresh one to a caller that may not see it, results and events lose what names it, and a caller that may see it is held to the rules', async () => {
  const hiddenIds = new Set(['claude:h1']);
  const decoys: [string, boolean][] = [];
  let seeing = false;
  const calls: any[] = [];
  const closed: number[] = [];
  const rules = {
    any: () => hiddenIds.size > 0,
    state: (id: string) => (hiddenIds.has(id) ? 'hidden' : 'open'),
    seen: () => seeing,
    guard: (method: string, p: any) => {
      if (method === 'chat.remove') throw new Error('fixed');
      return { ...p, guarded: true };
    },
    forged: (id: string) => id.startsWith('claude:forged'),
    isDecoy: (id: string) => decoys.some(([d, on]) => d === id && on),
    invalid: () => new Error('invalid id'),
    decoy: (id: string, on: boolean) => void decoys.push([id, on]),
  };
  let n = 0;
  const veil = createChatVeil(rules, { newId: () => `fresh-${++n}` });
  const sent: any[] = [];
  const principal = { id: 'p' };
  const { emit, wrap } = veil((m: object) => void sent.push(m), { principal: () => principal });
  const conn = wrap({
    close: () => void closed.push(1),
    call: async (method: string, raw: any) => {
      calls.push([method, raw]);
      if (method === 'host.pending')
        return {
          cards: [
            { chatId: 'claude:h1', requestId: 'r1' },
            { chatId: 'claude:o1', requestId: 'r2' },
          ],
          attention: [{ chatId: 'claude:h1', kind: 'approval' }],
          byChat: { 'claude:h1': 1, 'claude:o1': 2 },
          lines: [{ chat: 'claude:h1' }, { chat: 'claude:o1' }],
        };
      return { echoed: raw?.chatId, list: [raw?.chatId] };
    },
  });
  // before the hello nothing is changed: the Host answers a request without one as it always does
  assert.deepEqual(await conn.call('chat.send', { chatId: 'claude:h1' }), { echoed: 'claude:h1', list: ['claude:h1'] });
  assert.deepEqual(calls.at(-1), ['chat.send', { chatId: 'claude:h1' }]);
  await conn.call('host.hello', { moved: [{ chatId: 'claude:h1' }, { chatId: 'claude:o1' }, null] });
  assert.deepEqual(calls.at(-1)[1].moved, [{ chatId: 'claude:o1' }, null], 'a hidden chat is not moved away');
  await conn.call('host.hello', {});
  // another caller: the request runs on a fresh chat of the same shape, and the reply speaks of the id it asked about
  const first = await conn.call('chat.send', { chatId: 'claude:h1', text: 'x' });
  assert.equal(calls.at(-1)[1].chatId, 'claude:fresh-1');
  assert.deepEqual(first, { echoed: 'claude:h1', list: ['claude:h1'] });
  await conn.call('chat.stop', { chatId: 'claude:h1' });
  assert.equal(calls.at(-1)[1].chatId, 'claude:fresh-1', 'the same fresh chat each time');
  await conn.call('chat.stop', { chatId: 'claude:o1' });
  assert.equal(calls.at(-1)[1].chatId, 'claude:o1', 'an ordinary chat is not touched');
  await conn.call('host.pending', {});
  assert.deepEqual(await conn.call('host.pending', {}), {
    cards: [{ chatId: 'claude:o1', requestId: 'r2' }],
    attention: [],
    byChat: { 'claude:o1': 2 },
    lines: [{ chat: 'claude:o1' }],
  });
  // a result that names no chat is as it was
  assert.deepEqual(await conn.call('host.status', {}), { echoed: undefined, list: [undefined] });
  // events: one that names a hidden chat is not sent, the fresh chat's are told under the asked-for id
  emit({ chatId: 'claude:h1', frame: 1 });
  emit({ chatId: 'claude:o1', frame: 2 });
  emit({ chatId: 'claude:fresh-1', frame: 3, note: 'claude:fresh-1' });
  emit({ nothing: true });
  assert.deepEqual(sent, [{ chatId: 'claude:o1', frame: 2 }, { chatId: 'claude:h1', frame: 3, note: 'claude:h1' }, { nothing: true }]);
  // a caller that may see it is held to the rules, per message: what it hears stops with its grant
  seeing = true;
  await conn.call('chat.send', { chatId: 'claude:h1', text: 'y' });
  assert.deepEqual(calls.at(-1)[1], { chatId: 'claude:h1', text: 'y', guarded: true });
  assert.equal(((await conn.call('host.pending', {})) as any).cards.length, 2, 'it sees its own');
  emit({ chatId: 'claude:h1', frame: 4 });
  assert.equal(sent.at(-1)!.frame, 4);
  seeing = false;
  emit({ chatId: 'claude:h1', frame: 5 });
  assert.equal(sent.at(-1)!.frame, 4, 'its grant ended: nothing more is heard');
  // a result that holds nothing hidden is the very value the Host made, however deep it is: nothing is copied
  const history = {
    items: [
      { chatId: 'claude:o1', text: 'a' },
      { text: 'b', nested: { rows: [1, 2, 3] } },
    ],
  };
  const plain = createChatVeil(rules)(() => undefined, { principal: () => principal }).wrap({
    close: () => undefined,
    call: async (_method: string, _raw: unknown) => history,
  });
  await plain.call('host.hello', {});
  assert.equal(await plain.call('chat.history', {}), history);
  // an event names a chat in what it carries as well as at its top: each place is looked at
  seeing = false;
  const before = sent.length;
  for (const m of [
    { event: 'frame', frame: { chatId: 'claude:h1' } },
    { event: 'browser', payload: { chatId: 'claude:h1' } },
    { event: 'tool', card: { chatId: 'claude:h1' } },
    { event: 'x', what: { chatId: 'claude:h1' } },
    { kind: 'y', event: { chatId: 'claude:h1' } },
  ])
    emit(m);
  assert.equal(sent.length, before, 'none of them reached a caller that may not see the chat');
  emit({ event: 'frame', frame: { chatId: 'claude:o1' } });
  assert.equal(sent.length, before + 1);
  // and with nothing hidden the veil costs nothing: results are not even walked
  hiddenIds.clear();
  seeing = false;
  const results = { cards: [{ chatId: 'claude:h1' }] };
  const { wrap: wrapAgain } = createChatVeil(rules)(() => undefined, { principal: () => principal });
  const untouched = wrapAgain({ close: () => undefined, call: async (_method: string, _raw: unknown) => results });
  await untouched.call('host.hello', {});
  assert.equal(await untouched.call('host.pending', {}), results);
});

test('a card of a MoMo chat is in host.pending and the push only for a caller that may see it; a grant that ends ends what the connection hears', async (t) => {
  const w = await world(t);
  const granted = await w.connect({ fingerprint: 'f', kind: 'desktop' });
  assert.deepEqual((await granted.conn.call('host.momoStatus', {})).chats, { registry: 'ok' });
  const stranger = await w.connect(null);
  const other = `claude:${crypto.randomUUID()}`;
  await granted.conn.call('chat.subscribe', { chatId: w.M, epoch: 0 });
  w.card(w.M);
  w.card(other, 'r9');
  const pendingIds = async (c: any) => {
    const p = await c.conn.call('host.pending', {});
    return [p.cards.map((x: any) => x.chatId).sort(), p.attention.map((x: any) => x.chatId).sort()];
  };
  assert.deepEqual(await pendingIds(granted), [[other, w.M].sort(), [other, w.M].sort()]);
  assert.deepEqual(await pendingIds(stranger), [[other], [other]]);
  assert.doesNotMatch(JSON.stringify(stranger.out), new RegExp(w.M), 'nothing the stranger was told names the MoMo chat');
  assert.deepEqual(
    w.told.map((m) => m.chatId),
    [other],
    'no push for a MoMo chat',
  );
  const heard = granted.out.length;
  assert.ok(
    granted.out.some((m) => m.chatId === w.M),
    'the granted client hears its chat',
  );
  // the grant ends: the subscription it opened tells it nothing more
  await w.home.grant({ account: 'a1', features: [] }).catch(() => undefined);
  w.card(w.M, 'r2');
  assert.equal(granted.out.filter((m) => m.chatId === w.M).length, granted.out.slice(0, heard).filter((m) => m.chatId === w.M).length);
  assert.deepEqual(await pendingIds(granted), [[other], [other]]);
});

test('the Host’s audit record never carries a MoMo chat id', async (t) => {
  const dir = scratch(t);
  const hidden = createMomoHidden();
  hidden.bind((id: string) => id === 'claude:m1');
  const audit = createAudit({ dir: path.join(dir, 'audit') });
  audit.redactWith(hidden.redact);
  audit.note({ kind: 'approval.asked', chat: 'claude:m1', turn: 't1', what: { key: 'claude:m1', tool: 'execute' } });
  audit.note({ kind: 'approval.asked', chat: 'claude:o1', turn: 't2', what: { key: 'claude:o1' } });
  const { lines } = audit.read({ after: 0, limit: 10 });
  assert.deepEqual(
    lines.map((l: any) => [l.chat, l.what.key]),
    [
      [MOMO_AUDIT_ID, MOMO_AUDIT_ID],
      ['claude:o1', 'claude:o1'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(lines), /claude:m1/);
  // the default redaction changes nothing
  const plain = createAudit({ dir: path.join(dir, 'audit2') });
  plain.note({ kind: 'approval.asked', chat: 'claude:m1' });
  assert.equal(plain.read().lines[0].chat, 'claude:m1');
});

test('a MoMo chat id answers a caller that may not see it exactly as an unknown chat id does, method by method, and the hello comes first for both', async (t) => {
  const w = await world(t);
  const params = (chatId: string): Record<string, any> => ({
    'chat.subscribe': { chatId, epoch: 0 },
    'chat.history': { chatId, epoch: 0, generation: 'g', rev: 1, index: 0, offset: 0 },
    'chat.stop': { chatId, epoch: 0, key: 'key-00000001' },
    'chat.answer': { chatId, epoch: 0, key: 'key-00000002', requestId: 'r1', optionId: 'allow' },
    'chat.permit': { chatId, epoch: 0, key: 'key-00000003', value: 'auto' },
    'chat.login': { chatId, epoch: 0, key: 'key-00000004', login: 'work' },
    'chat.remove': { chatId, epoch: 0, key: 'key-00000005' },
    'chat.start': { chatId, epoch: 0, key: 'key-00000006', harness: 'claude', text: 'go', projectId: null },
    'chat.send': { chatId, epoch: 0, key: 'key-00000007', text: 'hi', cwd: '/tmp' },
  });
  const said = (p: Promise<unknown>) =>
    p.then(
      (r) => JSON.stringify(r),
      (e: any) => `${e.code}:${e.message}`,
    );
  const norm = (s: string, id: string) =>
    s
      .split(id)
      .join('<id>')
      .replace(/\bt\d+\b/g, 't<n>');
  for (const principal of [null, {}]) {
    // an id no chat has ever had, new for each caller
    const R = `claude:${crypto.randomUUID()}`;
    // an ungranted paired client is a stranger too
    if (principal) await w.home.grant({ account: 'a1', features: [] }).catch(() => undefined);
    const asksM = await w.connect(principal);
    const asksR = await w.connect(principal);
    for (const method of Object.keys(params(R)))
      assert.equal(
        norm(await said(asksM.conn.call(method, params(w.M)[method])), w.M),
        norm(await said(asksR.conn.call(method, params(R)[method])), R),
        `${method} for ${JSON.stringify(principal)}`,
      );
    // no hello yet: the same answer for both
    for (const id of [w.M, R]) {
      const fresh = w.protocol.connection(
        () => undefined,
        () => null,
        { principal: () => principal as any },
      );
      assert.equal(
        norm(await said(fresh.call('chat.send', params(id)['chat.send'])), id),
        norm(
          await said(
            w.protocol
              .connection(
                () => undefined,
                () => null,
                { principal: () => principal as any },
              )
              .call('chat.send', params(R)['chat.send']),
          ),
          R,
        ),
      );
    }
    await w.home.grant({ account: 'a1', features: MOMO });
  }
  // nothing of it reached MoMo's own chat: its turns are not the stranger's
  assert.ok(w.sends.every((s) => s.key !== w.M));
});

test('sweep: no method of the Host wire, asked with no chat or with a MoMo chat’s, and no event, says a MoMo chat’s id it was not given', async (t) => {
  const w = await world(t);
  const granted = await w.connect({ fingerprint: 'f', kind: 'desktop' });
  await granted.conn.call('chat.subscribe', { chatId: w.M, epoch: 0 });
  w.card(w.M);
  const asked = {
    chatId: w.M,
    key: 'key-00000001',
    epoch: 0,
    requestId: 'r1',
    optionId: 'allow',
    harness: 'claude',
    text: 'x',
    value: 'auto',
    login: 'work',
    projectId: null,
  };
  /** What a caller was told without having named the chat: any of it that holds the id is a leak. @type {string[]} */
  const unasked: string[] = [];
  const untyped: string[] = [];
  const told: string[] = [];
  for (const principal of [null, {}]) {
    if (principal) await w.home.grant({ account: 'a1', features: [] }).catch(() => undefined);
    const stranger = await w.connect(principal);
    const methods = [...new Set([...Object.keys(PARSERS), 'host.noSuchThing'])].filter((m) => m !== 'host.hello');
    assert.ok(methods.length > 40, 'the wire was enumerated');
    for (const method of methods) {
      for (const [params, named] of [
        [asked, true],
        [{}, false],
      ] as const) {
        let said: string;
        try {
          said = JSON.stringify(await stranger.conn.call(method, params));
        } catch (error: any) {
          said = `${error.code}:${error.message}`;
          // an error with no code is the Host failing, not answering
          if (typeof error.code !== 'string') untyped.push(`${method}: ${said}`);
        }
        // a list of chats holds the chat this connection made by asking about MoMo's id, under that id, as a Host that had the chat would: that is its own (tests/hostMomoChatList.test.ts holds what a list says to anyone else)
        if (!named && method !== 'host.chats') unasked.push(said);
      }
    }
    w.card(w.M, `r-${unasked.length}`);
    // a stranger that named the chat is told of the fresh one it got, under that id; none of what MoMo's chat really did reaches it
    for (const m of stranger.out) told.push(JSON.stringify(m));
    await w.home.grant({ account: 'a1', features: MOMO });
  }
  assert.deepEqual(untyped, [], 'every refusal is one the Host meant');
  assert.deepEqual(
    unasked.filter((o) => o.includes(w.M)),
    [],
  );
  assert.equal(w.told.filter((m) => m.chatId === w.M).length, 0);
});

test('the hidden-chat helper changes nothing until it is bound to MoMo’s chats', async () => {
  const hidden = createMomoHidden();
  assert.deepEqual(hidden.redact({ chat: 'claude:m' }), { chat: 'claude:m' });
  const told: any[] = [];
  hidden.notify((m: any) => told.push(m))({ chatId: 'claude:m' });
  assert.equal(told.length, 1);
  hidden.bind((id: string) => id === 'claude:m');
  hidden.notify((m: any) => told.push(m))({ chatId: 'claude:m' });
  // a MoMo chat's event goes only through MoMo's own push, when there is one
  const momoTold: any[] = [];
  hidden.notify(
    (m: any) => told.push(m),
    (m: any) => momoTold.push(m),
  )({ chatId: 'claude:m' });
  hidden.notify(
    (m: any) => told.push(m),
    (m: any) => momoTold.push(m),
  )({ chatId: 'claude:o' });
  assert.deepEqual(
    momoTold.map((m) => m.chatId),
    ['claude:m'],
  );
  // a decoy (an ordinary chat made for a caller that may not see MoMo's) is hidden and not MoMo's: its cards go nowhere
  const split = createMomoHidden();
  split.bind(
    (id: string) => id === 'claude:m' || id === 'claude:d',
    (id: string) => id === 'claude:m',
  );
  const plain: any[] = [];
  const asMomo: any[] = [];
  split.notify(
    (m: any) => plain.push(m),
    (m: any) => asMomo.push(m),
  )({ chatId: 'claude:d' });
  assert.deepEqual([plain, asMomo], [[], []]);
  told.length = 1;
  hidden.notify((m: any) => told.push(m))({ chatId: 'claude:o' });
  assert.deepEqual(
    told.map((m) => m.chatId),
    ['claude:m', 'claude:o'],
  );
  // the runtime the line protocol's send reaches: everything else of it is as it was, and a send naming no chat goes through
  const runtime = { send: async (p: any) => `sent ${p?.key}`, other: 5 };
  const guarded = hidden.guard(runtime);
  assert.equal(guarded.other, 5);
  assert.equal(await guarded.send({ key: 'claude:o' }), 'sent claude:o');
  assert.equal(await guarded.send(undefined), 'sent undefined');
  await assert.rejects(guarded.send({ key: 'claude:m' }), (e: any) => e.code === 'momo_chat_fixed');
});

test('two features that keep chats apart are refused when the folder loads, and a connection made with no identity still works', async (t) => {
  const { collectHandlers } = await import('../host/src/methodHandlers.mjs');
  const rules = {
    any: () => false,
    state: () => 'open',
    seen: () => true,
    guard: (_m: string, p: any) => p,
    unreadable: () => new Error('x'),
  };
  const files: Record<string, any> = { 'a.mjs': () => ({ chatRules: rules }), 'b.mjs': () => ({ chatRules: rules }) };
  assert.throws(
    () => collectHandlers(['a.mjs', 'b.mjs'], (n: string) => files[n], {}),
    /keeps chats apart, which another feature already does/,
  );
  const w = await world(t);
  // the identity of a connection is optional: an image request on one made without it is asked for its client and refused as any other
  const bare = w.protocol.connection(() => undefined);
  await bare.call('host.hello', helloParams());
  await assert.rejects(
    bare.call('chat.image', { chatId: `claude:${crypto.randomUUID()}`, epoch: 0, imageId: '0'.repeat(64), offset: 0 }),
    (e: any) => typeof e.code === 'string',
  );
});

test('a request a rule answers itself is answered and never reaches the runtime; a Host that stops being the home tells the clients that may see MoMo, and stops when they go', async () => {
  const { Answered } = await import('../host/src/chatVeil.mjs' as any);
  let seeing = true;
  let on: ((e: { running: boolean; state: string }) => void) | null = null;
  let stops = 0;
  const rules = {
    any: () => true,
    state: () => 'hidden' as const,
    seen: () => seeing,
    guard: (method: string, p: any) => (method === 'chat.send' && p.key === 'dup' ? new Answered({ duplicate: true }) : p),
    forged: () => false,
    isDecoy: () => false,
    invalid: () => new Error('invalid id'),
    decoy: () => undefined,
    watch: (fn: any) => ((on = fn), () => void stops++),
  };
  const sent: any[] = [];
  const reached: any[] = [];
  const { wrap } = createChatVeil(rules, { newId: () => 'x' })((m: object) => void sent.push(m), { principal: () => ({ id: 'p' }) });
  const conn = wrap({ close: () => undefined, call: async (m: string, p: any) => (reached.push([m, p]), { ok: true }) });
  await conn.call('host.hello', {});
  reached.length = 0;
  assert.deepEqual(await conn.call('chat.send', { chatId: 'claude:h1', key: 'dup' }), { duplicate: true });
  assert.deepEqual(reached, [], 'a duplicate never reaches the runtime');
  assert.deepEqual(await conn.call('chat.send', { chatId: 'claude:h1', key: 'new' }), { ok: true });
  // the home stops running here: a client that may see MoMo is told, one that may not is not
  on!({ running: false, state: 'moving' });
  assert.deepEqual(sent.at(-1), { event: 'momoHome', momoHome: false, state: 'moving' });
  seeing = false;
  const before = sent.length;
  on!({ running: true, state: 'running' });
  assert.equal(sent.length, before);
  conn.close();
  assert.equal(stops, 1, 'and the connection stops listening when it closes');
});

test('a send the ledger accepted that throws before the chat took it settles its turn as failed, for a caller that may see MoMo only', async () => {
  const failed: string[] = [];
  let seeing = true;
  const rules = {
    any: () => true,
    state: () => 'hidden' as const,
    seen: () => seeing,
    guard: (_m: string, p: any) => ({ ...p, cwd: '/w' }),
    forged: () => false,
    isDecoy: () => false,
    invalid: () => new Error('invalid id'),
    decoy: () => undefined,
    watch: () => () => undefined,
    sendFailed: (id: string) => void failed.push(id),
  };
  const { wrap } = createChatVeil(rules, { newId: () => 'x' })(() => undefined, { principal: () => ({ id: 'p' }) });
  const conn = wrap({
    close: () => undefined,
    call: async (m: string, _p?: unknown) => {
      if (m === 'chat.send') throw new Error('the harness would not take it');
      return {};
    },
  });
  await conn.call('host.hello', {});
  await assert.rejects(conn.call('chat.send', { chatId: 'claude:h1', key: 'key-00000001' }), /would not take it/);
  assert.deepEqual(failed, ['claude:h1']);
  seeing = false;
  await assert.rejects(conn.call('chat.send', { chatId: 'claude:h1', key: 'key-00000002' }), /would not take it/);
  assert.deepEqual(failed, ['claude:h1'], 'a caller that may not see it settles nothing');
});
