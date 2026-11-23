// The gateway's connections (electron/gateway/upstream.cjs, service.cjs, #2999 C2) over in-process MCP servers: a managed server starts, lists its tools and lists them again on list_changed; a stop (remove, a new credential, a restart) moves its generation on, so an older start or listing never publishes (A1–A4) and a later start still works (A5); a vault that can't be opened is `locked`, never "needs credentials" (W3); a server whose sign-in has no credential is `needs_credentials`; a server that fails says only its failure's kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gatewayWorld, fakeServer, tick, READ, stdio, http } from './support/gatewayWorld.ts';

const require = createRequire(import.meta.url);
const { Upstreams, StaleError, failureOf, lockedText } = require('../electron/gateway/upstream.cjs');
const { SealedUnavailableError } = require('../electron/gateway/sealedFile.cjs');

const list = { name: 'list', description: 'List.', inputSchema: READ, annotations: { readOnlyHint: true } };
const add = { name: 'add', description: 'Add.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
const settled = async () => {
  for (let i = 0; i < 20; i++) await tick();
};
const status = (w: any, key: string) => w.gateway.view().servers.find((s: any) => s.key === key);

test('a managed server starts, lists its tools, and lists them again on list_changed', async () => {
  const srv = fakeServer([list]);
  const w = gatewayWorld({ servers: { notes: srv } });
  assert.deepEqual(w.gateway.view(), { state: 'ok', servers: [] });
  const { key } = await w.gateway.add(stdio('notes'));
  await settled();
  const row = status(w, key);
  assert.equal(row.status, 'ready');
  assert.deepEqual(
    row.tools.map((t: any) => t.name),
    ['list'],
  );
  assert.equal(w.s.connects[0].clientName, 'mopilot-gateway');
  assert.deepEqual(w.s.connects[0].auth, { headers: {}, url: null });
  srv.tools = [list, add];
  srv.changed();
  await settled();
  assert.deepEqual(
    status(w, key).tools.map((t: any) => t.name),
    ['add', 'list'],
  );
  // what Settings is told never carries a credential: only whether one is saved
  assert.equal(row.credential, 'none');
  assert.equal(row.target, 'notes');
});

test('sync starts every managed server not running, tries a failed one again, and starts none while the list is locked', async () => {
  const srv = fakeServer([list]);
  const w = gatewayWorld({ servers: { a: srv } });
  await w.gateway.sync();
  assert.equal(w.s.connects.length, 0);
  w.s.connectError = Object.assign(new Error('the server said: secret stuff'), { code: 'ECONNREFUSED' });
  const { key } = await w.gateway.add(stdio('a'));
  await settled();
  assert.equal(status(w, key).status, 'failed');
  // never the server's own words
  assert.equal(status(w, key).error, "it didn't start (ECONNREFUSED)");
  w.s.connectError = null;
  await w.gateway.sync();
  assert.equal(status(w, key).status, 'ready');
  const before = w.s.connects.length;
  await w.gateway.sync();
  assert.equal(w.s.connects.length, before, 'a ready server is not started again');
  w.safe.available = false;
  await w.gateway.sync();
  assert.deepEqual(w.gateway.view(), {
    state: 'locked',
    reason: 'The gateway can’t open its saved servers and credentials right now (the system keychain is unavailable)',
    servers: [],
  });
});

test('W3: a server whose vault is locked is `locked`, not "needs credentials"; one with no credential needs connecting', async () => {
  const w = gatewayWorld({ servers: { 'https://h.example/mcp': fakeServer([list]) } });
  const { key } = await w.gateway.add(http('h', 'https://h.example/mcp', 'bearer'));
  await settled();
  assert.equal(status(w, key).status, 'needs_credentials');
  assert.equal(status(w, key).error, 'It needs to be connected first');
  assert.equal(w.s.connects.length, 0, 'nothing is sent without its credential');
  await w.gateway.connect(key, { type: 'bearer', token: 'tok-1' });
  assert.equal(status(w, key).status, 'ready');
  assert.equal(status(w, key).credential, 'saved');
  assert.deepEqual(w.s.connects.at(-1).auth, { headers: { Authorization: 'Bearer tok-1' }, url: null });
  // the vault alone locked (its file sealed with another key): the server says locked, its row says so too
  const up = new Upstreams({
    servers: w.gateway.servers,
    credentials: {
      get: () => {
        throw new SealedUnavailableError('other_key');
      },
    },
    connect: async () => assert.fail('no connect while locked'),
  });
  const r = await up.start(w.gateway.servers.get(key));
  assert.equal(r.status, 'locked');
  assert.match(r.error, /encrypted with another key/);
  // anything else that can't read it is locked too, never "no credential"
  const other = new Upstreams({
    servers: w.gateway.servers,
    credentials: {
      get: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    },
  });
  assert.equal((await other.start(w.gateway.servers.get(key))).status, 'locked');
  assert.equal(lockedText(new Error('x')), 'The gateway’s saved data can’t be read');
  // a code that names something on every object is no locked state
  assert.equal(lockedText(Object.assign(new Error('x'), { code: 'constructor' })), 'The gateway’s saved data can’t be read');
  assert.equal(lockedText(null), 'The gateway’s saved data can’t be read');
  const kinds = w.gateway.credentials.kinds;
  w.gateway.credentials.kinds = () => {
    throw new SealedUnavailableError();
  };
  assert.equal(status(w, key).credential, 'locked');
  w.gateway.credentials.kinds = kinds;
});

test('connect refuses a server that is not managed, takes no saved credential, or a credential of another kind', async () => {
  const w = gatewayWorld();
  await assert.rejects(w.gateway.connect('["http","x"]', { type: 'bearer', token: 't' }), /not managed/);
  const none = await w.gateway.add(http('n', 'https://n.example/', 'none'));
  await assert.rejects(w.gateway.connect(none.key, { type: 'bearer', token: 't' }), /doesn’t take a saved credential/);
  const o = await w.gateway.add(http('o', 'https://o.example/', 'oauth'));
  await assert.rejects(w.gateway.connect(o.key, { type: 'bearer', token: 't' }), /doesn’t take a saved credential/);
  const b = await w.gateway.add(http('b', 'https://b.example/', 'basic'));
  await assert.rejects(w.gateway.connect(b.key, { type: 'bearer', token: 't' }), /another kind/);
  await settled();
});

test('A3: a removal while the server starts drops that start: its client closes and no tools publish', async () => {
  const w = gatewayWorld({ servers: { a: fakeServer([list]) } });
  let open!: () => void;
  w.s.gate = new Promise<void>((r) => (open = r));
  const { key } = await w.gateway.add(stdio('a'));
  await tick();
  assert.equal(status(w, key).status, 'starting');
  await w.gateway.remove(key);
  open();
  await settled();
  assert.deepEqual(w.gateway.view().servers, []);
  assert.equal(w.gateway.upstreams.get(key), null);
  assert.equal(w.s.closed, 1, 'the late client is closed');
  assert.deepEqual(w.names(), []);
});

test('A1/A2: two starts at once: the older one settles after the newer and changes nothing (success or failure)', async () => {
  for (const older of ['ok', 'fails']) {
    const w = gatewayWorld({ servers: { a: fakeServer([list]) } });
    const server = await w.gateway.servers.add(stdio('a'));
    let open!: () => void;
    w.s.gate = new Promise<void>((r) => (open = r));
    const first = w.gateway.upstreams.start(server);
    await tick();
    w.s.gate = null;
    const second = await w.gateway.upstreams.start(server);
    assert.equal(second.status, 'ready');
    if (older === 'fails') w.s.connectError = new Error('late failure');
    open();
    await assert.rejects(first, StaleError);
    assert.equal(w.gateway.upstreams.get(server.key), second, older);
    assert.equal(second.status, 'ready', older);
    assert.equal(second.error, null, older);
  }
});

test('A4: a listing that settles after a newer listing, or after a stop, is dropped; a notice of a stopped client lists nothing', async () => {
  const srv = fakeServer([list]);
  const w = gatewayWorld({ servers: { a: srv } });
  const server = await w.gateway.servers.add(stdio('a'));
  const r = await w.gateway.upstreams.start(server);
  // hold the first re-listing, let a second one finish first
  const client = r.client;
  const real = client.listTools.bind(client);
  let release!: () => void;
  const held = new Promise<void>((x) => (release = x));
  let n = 0;
  client.listTools = async () => {
    const mine = ++n;
    const out = await real();
    if (mine === 1) {
      await held;
      return { tools: [] };
    }
    return out;
  };
  srv.tools = [list, add];
  srv.changed();
  await settled();
  srv.changed();
  await settled();
  assert.deepEqual(
    r.tools.map((t: any) => t.name),
    ['add', 'list'],
  );
  release();
  await settled();
  assert.deepEqual(
    r.tools.map((t: any) => t.name),
    ['add', 'list'],
    'the older listing does not overwrite the newer',
  );
  // a stop while a listing is out: it never publishes
  let late!: () => void;
  const lateHeld = new Promise<void>((x) => (late = x));
  client.listTools = async () => (await lateHeld, { tools: [] });
  srv.changed();
  await settled();
  w.gateway.upstreams.stop(server.key);
  late();
  await settled();
  assert.deepEqual(
    r.tools.map((t: any) => t.name),
    ['add', 'list'],
  );
  assert.equal(w.gateway.upstreams.get(server.key), null);
});

test('A5: after a removal and a failure, adding the server again and connecting it works', async () => {
  const w = gatewayWorld({ servers: { 'https://h.example/mcp': fakeServer([add]) } });
  const { key } = await w.gateway.add(http('h', 'https://h.example/mcp', 'urlParam'));
  await w.gateway.connect(key, { type: 'urlParam', param: 'key', value: 'v1' });
  assert.equal(w.s.connects.at(-1).auth.url, 'https://h.example/mcp?key=v1');
  await w.gateway.remove(key);
  assert.equal(w.gateway.credentials.get(key), null, 'its credential goes with it');
  w.s.connectError = new Error('down');
  const again = await w.gateway.add(http('h', 'https://h.example/mcp', 'urlParam'));
  assert.equal(again.key, key, 'the same server keeps its key');
  await settled();
  assert.equal(status(w, key).status, 'needs_credentials');
  await w.gateway.connect(key, { type: 'urlParam', param: 'key', value: 'v2' });
  assert.equal(status(w, key).status, 'failed');
  w.s.connectError = null;
  await w.gateway.restart(key);
  assert.equal(status(w, key).status, 'ready');
  // disconnect forgets the credential: the server needs connecting again
  await w.gateway.disconnect(key);
  assert.equal(status(w, key).status, 'needs_credentials');
  assert.equal(status(w, key).credential, 'none');
  // restarting a server that is no longer managed only stops it
  await w.gateway.remove(key);
  await w.gateway.restart(key);
  assert.equal(w.gateway.upstreams.get(key), null);
});

test('A1: two connects at once end on the last one saved, whichever start settles first', async () => {
  const w = gatewayWorld({ servers: { 'https://h.example/mcp': fakeServer([add]) } });
  const { key } = await w.gateway.add(http('h', 'https://h.example/mcp', 'bearer'));
  await settled();
  await Promise.all([w.gateway.connect(key, { type: 'bearer', token: 'one' }), w.gateway.connect(key, { type: 'bearer', token: 'two' })]);
  await settled();
  assert.equal(w.gateway.credentials.get(key).token, 'two');
  assert.equal(status(w, key).status, 'ready');
  const live = w.gateway.upstreams.get(key);
  const used = w.s.connects.filter((c: any) => c.auth.headers.Authorization).at(-1);
  assert.equal(used.auth.headers.Authorization, 'Bearer two');
  assert.equal(live.epoch, w.gateway.upstreams.epoch(key));
});

test('a call under an older generation, or one whose answer comes after a stop, is stale; stopAll ends every client', async () => {
  const srv = fakeServer([add]);
  const w = gatewayWorld({ servers: { a: srv, b: fakeServer([list]) } });
  const server = await w.gateway.servers.add(stdio('a'));
  await w.gateway.servers.add(stdio('b'));
  const r = await w.gateway.upstreams.start(server);
  await assert.rejects(w.gateway.upstreams.call(server.key, r.epoch + 1, 'add', {}, { timeout: 1000, maxTotalTimeout: 1000 }), StaleError);
  let answer!: () => void;
  srv.answer = () => new Promise((res) => (answer = () => res({ content: [{ type: 'text', text: 'late' }] })));
  w.s.lazyClose = true;
  const p = w.gateway.upstreams.call(server.key, r.epoch, 'add', {}, { timeout: 1000, maxTotalTimeout: 1000 });
  await settled();
  w.gateway.upstreams.stop(server.key);
  answer();
  await assert.rejects(p, StaleError);
  await w.gateway.sync();
  assert.equal(w.gateway.upstreams.running.size, 2);
  w.gateway.close();
  assert.equal(w.gateway.upstreams.running.size, 0);
  assert.equal(failureOf({ name: 'TypeError' }), "it didn't start (TypeError)");
  assert.equal(failureOf(null), "it didn't start (error)");
});

test('B5: a server whose connection drops fails with its tools gone, and the sync at the next app start starts it again', async () => {
  const srv = fakeServer([list]);
  const w = gatewayWorld({ servers: { a: srv } });
  const { key } = await w.gateway.add(stdio('a'));
  await settled();
  assert.equal(w.names().length, 1);
  // the server side goes away
  await srv.server.close();
  await settled();
  assert.equal(status(w, key).status, 'failed');
  assert.equal(status(w, key).error, 'it stopped');
  assert.deepEqual(w.names(), []);
  await w.gateway.sync();
  assert.equal(status(w, key).status, 'ready');
  assert.equal(w.names().length, 1);
  // a drop of a client already replaced changes nothing
  const old = w.gateway.upstreams.get(key);
  await w.gateway.restart(key);
  old.client?.onclose?.();
  assert.equal(status(w, key).status, 'ready');
});

test('a server that connects but cannot list fails and its client closes; a re-listing failure or a notice after a stop is only noted', async () => {
  const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');
  const srv = fakeServer([list]);
  const w = gatewayWorld({ servers: { a: srv } });
  const server = await w.gateway.servers.add(stdio('a'));
  const realMake = srv.make;
  srv.make = () => {
    const made = realMake();
    made.setRequestHandler(require('@modelcontextprotocol/sdk/types.js').ListToolsRequestSchema, async () => {
      if (srv.failList) throw new Error('the server said: secret');
      return { tools: srv.tools };
    });
    return made;
  };
  srv.failList = true;
  const r = await w.gateway.upstreams.start(server);
  assert.equal(r.status, 'failed');
  assert.equal(r.client, null);
  assert.equal(w.s.closed, 1, 'the connected client is closed');
  srv.failList = false;
  const ok = await w.gateway.upstreams.start(server);
  assert.equal(ok.status, 'ready');
  clearIgnored();
  srv.failList = true;
  srv.changed();
  await settled();
  assert.equal(ok.status, 'ready', 'a failed re-listing keeps the last good tools');
  assert.ok(recentIgnored().some((e: any) => /tools again/.test(e.context) && !/secret/.test(e.message)));
  // a notice that comes after its client was stopped lists nothing and notes nothing
  const handler = w.s.handlers.at(-1);
  w.gateway.upstreams.stop(server.key);
  clearIgnored();
  handler();
  await settled();
  assert.deepEqual(recentIgnored(), []);
});

test('a sync whose start a removal overtakes ends quietly; a server saved but not started shows off', async () => {
  const w = gatewayWorld({ servers: { a: fakeServer([list]) } });
  const server = await w.gateway.servers.add(stdio('a'));
  assert.equal(status(w, server.key).status, 'off');
  assert.equal(status(w, server.key).error, null);
  assert.deepEqual(status(w, server.key).tools, []);
  let open!: () => void;
  w.s.gate = new Promise<void>((r) => (open = r));
  const syncing = w.gateway.sync();
  await tick();
  await w.gateway.remove(server.key);
  open();
  await syncing;
  assert.equal(w.gateway.upstreams.get(server.key), null);
});

/** A server whose listings and calls the test scripts by hand (the SDK's own Server). */
function scriptedServer(o: { list: (n: number, server: any) => Promise<any[]>; call?: (req: any, extra: any) => Promise<any> }) {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const s: any = { listings: 0 };
  s.make = () => {
    const server = new Server({ name: 'scripted', version: '1' }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await o.list(++s.listings, server) }));
    server.setRequestHandler(CallToolRequestSchema, async (req: any, extra: any) => (o.call ? o.call(req, extra) : { content: [] }));
    return server;
  };
  return s;
}

test('B5: a call that keeps reporting progress runs past the idle limit (a progress token is sent), up to its total limit', async () => {
  let token: unknown;
  const srv = scriptedServer({
    list: async () => [{ name: 'slow', description: 'Slow.', inputSchema: READ }],
    call: async (req, extra) => {
      token = req.params._meta?.progressToken;
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 60));
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: 6 } });
      }
      return { content: [{ type: 'text', text: 'done' }] };
    },
  });
  const w = gatewayWorld({ servers: { slow: srv } });
  const { key } = await w.gateway.add(stdio('slow'));
  await settled();
  const r = w.gateway.upstreams.get(key);
  const out = await w.gateway.upstreams.call(key, r.epoch, 'slow', {}, { timeout: 150, maxTotalTimeout: 5000 });
  assert.notEqual(token, undefined);
  assert.equal(out.content[0].text, 'done');
  // a total limit still ends it
  await assert.rejects(
    w.gateway.upstreams.call(key, r.epoch, 'slow', {}, { timeout: 150, maxTotalTimeout: 200 }),
    (e: any) => e.code === -32001,
  );
});

test('A2: a list_changed during the first listing whose own listing fails leaves the first answer in place: ready, not starting', async () => {
  const srv = scriptedServer({
    list: async (n, server) => {
      if (n > 1) throw new Error('busy');
      await server.sendToolListChanged();
      await new Promise((r) => setTimeout(r, 30));
      return [{ name: 'a', description: 'A.', inputSchema: READ }];
    },
  });
  const w = gatewayWorld({ servers: { flaky: srv } });
  const { key } = await w.gateway.add(stdio('flaky'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(srv.listings, 2);
  assert.equal(status(w, key).status, 'ready');
  assert.deepEqual(w.names().length, 1);
});

test('W1/A1: a connect that arrives while a removal runs never leaves a credential behind; restarting an unmanaged key keeps no state', async () => {
  const w = gatewayWorld({ servers: { 'https://h.example/mcp': fakeServer([list]) } });
  const { key } = await w.gateway.add(http('h', 'https://h.example/mcp', 'bearer'));
  await settled();
  const removing = w.gateway.remove(key);
  const connecting = w.gateway.connect(key, { type: 'bearer', token: 'SECRET-TOKEN' });
  await removing;
  await assert.rejects(connecting, /not managed/);
  assert.equal(w.gateway.servers.get(key), null);
  assert.equal(w.gateway.credentials.get(key), null);
  await w.gateway.add(http('h', 'https://h.example/mcp', 'bearer'));
  await settled();
  assert.equal(status(w, key).credential, 'none');
  assert.equal(status(w, key).status, 'needs_credentials');
  // the other order: connect first, then remove: both done, nothing left
  await Promise.all([w.gateway.connect(key, { type: 'bearer', token: 't' }), w.gateway.remove(key)]);
  assert.equal(w.gateway.credentials.get(key), null);
  // keys a window names that were never managed leave nothing behind
  for (let i = 0; i < 5; i++) await w.gateway.restart(`["http","https://nope-${i}.example/"]`);
  assert.equal(w.gateway.upstreams.epochs.size, 1);
  assert.equal(w.gateway.turns.size, 0);
});

test('an add whose start can’t read the store (the keychain went away meanwhile) still resolves, and the failure is noted', async () => {
  const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');
  const w = gatewayWorld({ servers: { a: fakeServer([list]) } });
  const get = w.gateway.servers.get.bind(w.gateway.servers);
  w.gateway.servers.get = () => {
    throw new SealedUnavailableError();
  };
  clearIgnored();
  const server = await w.gateway.add(stdio('a'));
  await settled();
  assert.equal(server.name, 'a');
  assert.ok(recentIgnored().some((e: any) => /start the gateway server a/.test(e.context)));
  w.gateway.servers.get = get;
});
