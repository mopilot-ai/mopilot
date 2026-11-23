// The MCP proxy's generations (electron/momo/mcp/proxy.cjs, #2999 C0), each race in both orders where it has two: a removal or a restart while a server starts, while its tools are listed, while a call waits for the card or for the server; MoMo turned off or the tool turned off while the card waits; a list-changed notice from a client already stopped; Reset ending every client; sync starting allowed servers and a failure staying on the row; tools offered once main's registry is attached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mcpWorld, fakeServer, tick, READ } from './support/momoMcpWorld.ts';

const require = createRequire(import.meta.url);
const code = (c: string) => (e: any) => e.code === c;
const listTool = { name: 'notes_list', description: 'List.', inputSchema: READ, annotations: { readOnlyHint: true } };
const deferred = () => {
  let resolve: (v?: any) => void = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

test('race: removed, or allowed again, while the server starts: the old start is stale and its client closed', async () => {
  const w = mcpWorld({ servers: { notes: fakeServer([listTool]) } });
  w.attach();
  const gate = deferred();
  w.s.gate = gate.promise;
  const first = w.proxy.allow('claude:notes');
  const firstDone = assert.rejects(first, code('stale'));
  await tick();
  assert.equal((await w.proxy.list())[0].status, 'starting');
  await w.proxy.remove('claude:notes');
  gate.resolve();
  await firstDone;
  await settle();
  assert.equal(w.s.closed, 1);
  assert.equal(w.allowlist.get('claude:notes'), null, 'a stale start allows nothing');
  assert.equal(w.tools.size, 0);
  // the other order: a second Allow while the first starts replaces it
  const gate2 = deferred();
  w.s.gate = gate2.promise;
  const a = w.proxy.allow('claude:notes');
  const aDone = assert.rejects(a, code('stale'));
  await tick();
  const b = w.proxy.allow('claude:notes');
  gate2.resolve();
  await aDone;
  await b;
  assert.deepEqual([...w.tools.keys()], ['momo_mcp_notes_a20275_notes_list']);
});

test('race: removed while the tools are listed; a list-changed notice of a stopped client changes nothing', async () => {
  const srv = fakeServer([listTool]);
  const w = mcpWorld({ servers: { notes: srv } });
  w.attach();
  // the listing waits; a removal comes first
  const listed = deferred();
  const make = srv.make;
  srv.make = () => {
    const server = make();
    const handlers = (server as any)._requestHandlers;
    const list = handlers.get('tools/list');
    handlers.set('tools/list', async (...a: any[]) => (await listed.promise, list(...a)));
    return server;
  };
  const p = w.proxy.allow('claude:notes');
  const done = assert.rejects(p, code('stale'));
  await settle();
  await w.proxy.remove('claude:notes');
  listed.resolve();
  await done;
  srv.make = make;
  // allowed and running, then removed: the old client's notice is dropped
  await w.proxy.allow('claude:notes');
  const old = srv.server;
  await w.proxy.remove('claude:notes');
  await old.sendToolListChanged().catch(() => {});
  await settle();
  assert.equal(w.tools.size, 0);
});

test('race: removed while a call waits for the card or for the server, in either order', async () => {
  const card = deferred();
  let gated = true;
  const srv = fakeServer([listTool]);
  const w = mcpWorld({ servers: { notes: srv }, decide: async () => (gated ? (await card.promise, { allow: true }) : { allow: true }) });
  w.attach();
  await w.proxy.allow('claude:notes');
  const t = w.tools.get('momo_mcp_notes_a20275_notes_list');
  const p = t.handler({}, { chatId: 'mc' });
  const pDone = assert.rejects(p, code('stale'));
  await tick();
  await w.proxy.remove('claude:notes');
  card.resolve();
  await pDone;
  assert.equal(srv.calls.length, 0, 'nothing reached the server');
  // the server answers after the removal: audited done (it ran), the answer dropped
  gated = false;
  await w.proxy.allow('claude:notes');
  const answer = deferred();
  srv.answer = async () => (await answer.promise, { content: [{ type: 'text', text: 'late' }] });
  const t2 = w.tools.get('momo_mcp_notes_a20275_notes_list');
  const q = t2.handler({}, { chatId: 'mc' });
  const qDone = assert.rejects(q, (e: any) => e.code === 'stale' || e.code === 'failed');
  await settle();
  w.proxy.reset();
  answer.resolve();
  await qDone;
});

test('race: MoMo turned off, or the tool turned off, while the card waits: refused and audited', async () => {
  let card = deferred();
  const w = mcpWorld({ servers: { notes: fakeServer([listTool]) }, decide: async () => (await card.promise, { allow: true }) });
  w.attach();
  await w.proxy.allow('claude:notes');
  const t = w.tools.get('momo_mcp_notes_a20275_notes_list');
  const p = t.handler({}, { chatId: 'mc' });
  await tick();
  w.s.allowed = false;
  card.resolve();
  await assert.rejects(p, code('refused'));
  assert.equal(w.audits.at(-1).decision, 'MoMo is off');
  w.s.allowed = true;
  card = deferred();
  const q = t.handler({}, { chatId: 'mc' });
  await tick();
  await w.proxy.setTool('claude:notes', (await w.proxy.list())[0].tools[0].key, false);
  card.resolve();
  await assert.rejects(q, code('refused'));
  assert.equal(w.audits.at(-1).decision, 'turned off');
});

test('sync starts allowed servers once main attaches; a failed start shows on the row and Retry starts it', async () => {
  const w = mcpWorld({ servers: { notes: fakeServer([listTool]), other: fakeServer([listTool]) } });
  await w.proxy.allow('claude:notes');
  assert.equal(w.tools.size, 0, 'nothing offered before the registry is attached');
  w.attach();
  assert.deepEqual([...w.tools.keys()], ['momo_mcp_notes_a20275_notes_list']);
  // a new proxy over the same allowlist (MoMo started again): sync starts what is allowed
  w.proxy.reset();
  assert.equal(w.tools.size, 0);
  await w.proxy.sync();
  assert.deepEqual([...w.tools.keys()], ['momo_mcp_notes_a20275_notes_list']);
  await w.proxy.sync();
  assert.equal(w.s.connects, 2, 'a running server is not started twice');
  // a server that can't start: the row says why, sync keeps going
  w.proxy.reset();
  w.s.connectError = Object.assign(new Error('spawn fake ENOENT, token=SECRET'), { code: 'ENOENT' });
  await w.proxy.sync();
  const row = (await w.proxy.list())[0];
  // never the server's own words: only the kind of failure
  assert.deepEqual([row.allowed, row.status, row.error], [true, 'failed', "it didn't start (ENOENT)"]);
  w.s.connectError = 'a string';
  await assert.rejects(w.proxy.allow('claude:notes'), (e: any) => e.code === 'failed' && /notes didn't start/.test(e.message));
  assert.equal((await w.proxy.list())[0].error, "it didn't start (error)");
  // sync tries a failed server again
  w.s.connectError = null;
  await w.proxy.sync();
  assert.equal((await w.proxy.list())[0].status, 'ready');
  w.proxy.reset();
  w.s.connectError = null;
  await w.proxy.allow('claude:notes');
  assert.equal((await w.proxy.list())[0].status, 'ready');
  // everything removed: the file stays, nothing is started, the catalog isn't read
  w.proxy.reset();
  await w.proxy.remove('claude:notes');
  const reads = w.s.catalogReads;
  await w.proxy.sync();
  assert.equal(w.s.catalogReads, reads);
  // the allowlist can't be read (no OS key): noted, never thrown
  w.allowlist.list = () => {
    throw new Error('no key');
  };
  await w.proxy.sync();
});

test('race, both orders with the connection still up: a listing or an answer that arrives after a removal is dropped; an old notice too', async () => {
  const srv = fakeServer([listTool]);
  const w = mcpWorld({ servers: { notes: srv } });
  w.attach();
  w.s.lazyClose = true;
  // the listing answers after the removal: stale, nothing offered
  const listed = deferred();
  const make = srv.make;
  srv.make = () => {
    const server = make();
    const handlers = (server as any)._requestHandlers;
    const list = handlers.get('tools/list');
    handlers.set('tools/list', async (...a: any[]) => (await listed.promise, list(...a)));
    return server;
  };
  const p = w.proxy.allow('claude:notes');
  const done = assert.rejects(p, code('stale'));
  await settle();
  await w.proxy.remove('claude:notes');
  listed.resolve();
  await done;
  assert.equal(w.tools.size, 0);
  srv.make = make;
  // a notice of that stopped client: dropped
  await w.s.handlers[0]();
  await settle();
  assert.equal(w.tools.size, 0);
  // the server answers a call after Reset: audited done (it ran), the answer dropped as stale
  await w.proxy.allow('claude:notes');
  const answer = deferred();
  srv.answer = async () => (await answer.promise, { content: [{ type: 'text', text: 'late' }] });
  // no arguments at all: called with {}
  const q = w.tools.get('momo_mcp_notes_a20275_notes_list').handler(undefined, { chatId: 'mc' });
  const qDone = assert.rejects(q, code('stale'));
  await settle();
  w.proxy.reset();
  answer.resolve();
  await qDone;
  assert.deepEqual([w.audits.at(-1).result, w.audits.at(-1).args], ['done', {}]);
  assert.deepEqual(srv.calls.at(-1), { name: 'notes_list', arguments: {} });
});

test('a server still running after its allowance went: listed with every tool off', async () => {
  const w = mcpWorld({ servers: { notes: fakeServer([listTool]) } });
  w.attach();
  await w.proxy.allow('claude:notes');
  await w.allowlist.remove('claude:notes');
  const row = (await w.proxy.list())[0];
  assert.deepEqual([row.allowed, row.status, row.tools[0].on, row.tools[0].isNew], [false, 'ready', false, false]);
});

test('a client that connected but could not list is closed, not left running; MoMo not allowed starts nothing', async () => {
  const srv = fakeServer([listTool]);
  const w = mcpWorld({ servers: { notes: srv } });
  w.attach();
  const make = srv.make;
  srv.make = () => {
    const server = make();
    (server as any)._requestHandlers.set('tools/list', async () => {
      throw new Error('boom SECRET');
    });
    return server;
  };
  await assert.rejects(w.proxy.allow('claude:notes'), code('failed'));
  assert.equal(w.s.closed, 1);
  assert.equal((await w.proxy.list())[0].error?.includes('SECRET'), false);
  srv.make = make;
  // MoMo not allowed: sync starts nothing
  await w.allowlist.allow('claude:notes', []);
  w.s.allowed = false;
  const before = w.s.connects;
  await w.proxy.sync();
  assert.equal(w.s.connects, before);
});

test('race: removed while the allowance is saved: stale, nothing offered; a handler run after its server stopped is stale', async () => {
  const w = mcpWorld({ servers: { notes: fakeServer([listTool]) } });
  w.attach();
  const allow = w.allowlist.allow.bind(w.allowlist);
  let removing: Promise<void> | null = null;
  w.allowlist.allow = async (k: string, t: any) => {
    removing = w.proxy.remove(k);
    return allow(k, t);
  };
  await assert.rejects(w.proxy.allow('claude:notes'), code('stale'));
  await removing;
  assert.equal(w.tools.size, 0);
  w.allowlist.allow = allow;
  await w.proxy.allow('claude:notes');
  const handler = w.tools.get('momo_mcp_notes_a20275_notes_list').handler;
  w.proxy.reset();
  await assert.rejects(handler({}, { chatId: 'mc' }), code('stale'));
});

test('race: the claim changes while the card waits: a read that no longer says so is refused; listings out of order keep the newest', async () => {
  const card = deferred();
  const srv = fakeServer([listTool]);
  let gated = true;
  const w = mcpWorld({ servers: { notes: srv }, decide: async () => (gated ? (await card.promise, { allow: true }) : { allow: true }) });
  w.attach();
  await w.proxy.allow('claude:notes');
  const p = w.call('momo_mcp_notes_a20275_notes_list');
  await tick();
  srv.tools = [{ ...listTool, annotations: {} }];
  srv.changed();
  await settle();
  card.resolve();
  await assert.rejects(p, code('refused'));
  // off now (its claim changed): the tool went, and a call in hand is turned off
  assert.equal(w.audits.at(-1).decision, 'turned off');
  // the user turns it on again: it asks as a change, and if it says read-only again while asked, it still ran as asked
  gated = false;
  const key = (await w.proxy.list())[0].tools[0].key;
  await w.proxy.setTool('claude:notes', key, true);
  await w.call('momo_mcp_notes_a20275_notes_list');
  assert.equal(w.decisions.at(-1).kind, 'change');
  // a read whose claim goes away while the card waits (the user's choice keeps it on): refused as changed
  srv.tools = [listTool];
  srv.changed();
  await settle();
  gated = true;
  const card2 = deferred();
  const w2card = card2;
  const w2 = mcpWorld({ servers: { notes: srv }, decide: async () => (await w2card.promise, { allow: true }) });
  w2.attach();
  await w2.proxy.allow('claude:notes');
  await w2.proxy.setTool('claude:notes', key, true);
  const q = w2.call('momo_mcp_notes_a20275_notes_list');
  await tick();
  srv.tools = [{ ...listTool, annotations: {} }];
  srv.changed();
  await settle();
  card2.resolve();
  await assert.rejects(q, code('refused'));
  assert.equal(w2.audits.at(-1).decision, 'changed while asked');
  // two listings at once, the older answering last: the newer one stands
  const slow = deferred();
  const make = srv.make;
  let n = 0;
  srv.make = () => {
    const server = make();
    const h = (server as any)._requestHandlers;
    const list = h.get('tools/list');
    h.set('tools/list', async (...a: any[]) =>
      ++n === 2 ? (await slow.promise, { tools: [listTool, { name: 'old', inputSchema: READ }] }) : list(...a),
    );
    return server;
  };
  const w3 = mcpWorld({ servers: { notes: srv } });
  w3.attach();
  srv.tools = [listTool];
  await w3.proxy.allow('claude:notes');
  srv.changed();
  await settle();
  srv.tools = [listTool, { name: 'newest', inputSchema: READ }];
  srv.changed();
  await settle();
  slow.resolve();
  await settle();
  assert.deepEqual(
    (await w3.proxy.list())[0].tools.map((t: any) => t.name),
    ['notes_list', 'newest'],
  );
  srv.make = make;
});

test("allow again: a choice survives unless the tool's claim differs from the last baseline", async () => {
  const srv = fakeServer([listTool, { name: 'notes_add', inputSchema: READ }]);
  const w = mcpWorld({ servers: { notes: srv } });
  w.attach();
  await w.proxy.allow('claude:notes');
  const [l, a] = (await w.proxy.list())[0].tools;
  await w.proxy.setTool('claude:notes', a.key, true);
  await w.proxy.setTool('claude:notes', l.key, false);
  srv.tools = [listTool, { name: 'notes_add', inputSchema: READ, annotations: { readOnlyHint: true } }];
  srv.changed();
  await settle();
  await w.proxy.allow('claude:notes');
  assert.deepEqual(w.allowlist.get('claude:notes').choices, { [l.key]: false });
});

test("race: the tool disappears from the server's list while the card waits: turned off, refused", async () => {
  const card = deferred();
  const srv = fakeServer([listTool]);
  const w = mcpWorld({ servers: { notes: srv }, decide: async () => (await card.promise, { allow: true }) });
  w.attach();
  await w.proxy.allow('claude:notes');
  const p = w.call('momo_mcp_notes_a20275_notes_list');
  await tick();
  srv.tools = [];
  srv.changed();
  await settle();
  card.resolve();
  await assert.rejects(p, code('refused'));
  assert.equal(w.audits.at(-1).decision, 'turned off');
});

test('race: a list_changed during the first listing whose own listing fails leaves the first answer: ready, not starting', async () => {
  const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const srv = fakeServer([{ name: 'notes_list', description: 'List.', inputSchema: READ, annotations: { readOnlyHint: true } }]);
  let n = 0;
  const make = srv.make;
  srv.make = () => {
    const server = make();
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (++n > 1) throw new Error('busy');
      await server.sendToolListChanged();
      await new Promise((r) => setTimeout(r, 30));
      return { tools: srv.tools };
    });
    return server;
  };
  const w = mcpWorld({ servers: { notes: srv } });
  w.attach();
  await w.proxy.allow('claude:notes');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(n, 2);
  const [row] = await w.proxy.list();
  assert.equal(row.status, 'ready');
});
