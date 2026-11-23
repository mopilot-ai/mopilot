// "Your Chrome" edge cases: the MCP framing of one Playwright instance, the per-chat channel's
// failure paths, the proxied tools' odd results, and the browser channel switch with its schema cache.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { tornWrites } from './support/torn-write.ts';
import { extensionWire } from './support/extension-wire.ts';

const require = createRequire(import.meta.url);
const { ChromeChannel, PlaywrightInstance, chromeTools, spawnSpec, pageUrl } = require('../electron/capabilities/browser/extension.cjs');
const { BrowserControl, schemaCache } = require('../electron/capabilities/browser/control.cjs');
const { JsonReader } = require('../electron/transport/jsonReader.cjs');

const tick = () => new Promise((r) => setTimeout(r, 5));

test('spawnSpec on Windows passes the folders Playwright needs, matched case-insensitively', () => {
  const env = { Path: 'p', SYSTEMROOT: 'C:\\Windows', LocalAppData: 'C:\\L', TEMP: '', USERNAME: 'me' };
  const s = spawnSpec({ outputDir: '/o', env, platform: 'win32' });
  assert.deepEqual(s.options.env, { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\L' });
  assert.equal(spawnSpec({ outputDir: '/o', env, platform: 'linux' }).options.env.SystemRoot, undefined);
});

test('pageUrl: no content, empty entries and text without a URL', () => {
  assert.equal(pageUrl(undefined), null);
  assert.equal(pageUrl([null, { type: 'text' }, { type: 'text', text: 'Page URL: https://x.test/' }]), 'https://x.test/');
});

/** A child whose messages the test sends itself. */
function rawChild() {
  const child: any = new EventEmitter();
  child.sent = [];
  child.postMessage = (m: any) => child.sent.push(m);
  child.kill = () => child.emit('exit', null);
  const fork = () => child;
  const out = extensionWire(child);
  const lastId = () => JSON.parse(child.sent.filter((m: any) => m.type === 'in').at(-1).data).id;
  return { child, fork, out, lastId };
}

async function started(callMs?: number) {
  const r = rawChild();
  const inst = new PlaywrightInstance({ fork: r.fork, spec: spawnSpec({ outputDir: '/o', env: {} }), clientName: 'c', callMs });
  const s = inst.start();
  r.out(`${JSON.stringify({ jsonrpc: '2.0', id: r.lastId(), result: {} })}\n`);
  await s;
  return { ...r, inst };
}

test('PlaywrightInstance retires a child with out-of-order utility output and rejects its pending request', async () => {
  const { child, inst } = await started();
  const rejected = assert.rejects(inst.request('pending', {}), /Your Chrome stopped/);
  child.emit('message', { type: 'output', seq: 99, data: Buffer.from('{"result":{}}\n') });
  await rejected;
  assert.equal(inst.exited, true);
  child.emit('message', { type: 'output', seq: 2, data: Buffer.from('{"result":{}}\n') });
});

test('PlaywrightInstance frames the CLI output in the core: a split character, and no acknowledgement while the reader is full', async () => {
  const child: any = new EventEmitter();
  child.sent = [];
  child.postMessage = (m: any) => child.sent.push(m);
  child.kill = () => child.emit('exit', null);
  const inst = new PlaywrightInstance({ fork: () => child, spec: spawnSpec({ outputDir: '/o', env: {} }), clientName: 'c' });
  const s = inst.start();
  const id = JSON.parse(child.sent.find((m: any) => m.type === 'in').data).id;
  const reply = Buffer.from(`${JSON.stringify({ id, result: { text: '中😀' } })}\n`);
  const split = reply.indexOf(Buffer.from('中')) + 1;
  child.emit('message', { type: 'output', seq: 1, data: reply.subarray(0, split) });
  child.emit('message', { type: 'output', seq: 2, data: new Uint8Array(reply.subarray(split)) });
  await s;
  assert.deepEqual(
    child.sent.filter((m: any) => m.type === 'out-ack').map((m: any) => m.seq),
    [1, 2],
  );
  // a reader past its high mark pauses its stream: the CLI's next write is held back until it resumes
  const p = inst.request('big', {});
  inst.reader!.o.stream.pause();
  child.emit('message', { type: 'output', seq: 3, data: Buffer.from(`${JSON.stringify({ id: id + 1, result: 'big' })}\n`) });
  assert.equal(child.sent.filter((m: any) => m.type === 'out-ack').length, 2, 'held while the reader is full');
  assert.deepEqual(await p, 'big');
  inst.reader!.o.stream.resume();
  assert.deepEqual(child.sent.at(-1), { type: 'out-ack', seq: 3 });
  inst.reader!.o.stream.resume();
  assert.equal(child.sent.filter((m: any) => m.type === 'out-ack').length, 3, 'nothing to acknowledge twice');
  // a chunk that is not bytes is nobody's
  child.emit('message', { type: 'output', seq: 4, data: 'text' });
  // what was held when the CLI went is not acknowledged after, and output past the end goes nowhere
  inst.reader!.o.stream.pause();
  child.emit('message', { type: 'output', seq: 4, data: Buffer.from('{}\n') });
  child.emit('exit', 0);
  inst.reader!.o.stream.resume();
  child.emit('message', { type: 'output', seq: 5, data: Buffer.from('{}\n') });
  assert.equal(child.sent.filter((m: any) => m.type === 'out-ack').length, 3);
  assert.equal(inst.reader!.closed, true);
});

test('PlaywrightInstance answers what the CLI said before it exited, then fails what is still waiting', async () => {
  const { child, inst, lastId } = await started();
  const answered = inst.request('tools/call', {});
  const answeredId = lastId();
  const unanswered = inst.request('tools/list', {});
  // a reply behind enough output that it is still queued when the exit comes
  const noise = `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'x'.repeat(200) } })}\n`.repeat(
    20_000,
  );
  child.emit('message', { type: 'output', seq: 2, data: Buffer.from(`${noise}${JSON.stringify({ id: answeredId, result: 'answer' })}\n`) });
  const exited = new Promise((resolve) => inst.once('exit', resolve));
  child.emit('exit', 0);
  assert.equal(await answered, 'answer');
  await assert.rejects(unanswered, /Your Chrome stopped/);
  assert.equal(await exited, 0);
});

test('PlaywrightInstance ends a CLI whose output cannot be framed', async () => {
  const { child, inst } = await started();
  let killed = 0;
  child.kill = () => killed++;
  const failing = mock.method(JsonReader.prototype, 'frame', () => {
    throw new Error('the core could not frame it');
  });
  try {
    child.emit('message', { type: 'output', seq: 2, data: Buffer.from('{}\n') });
  } finally {
    failing.mock.restore();
  }
  assert.equal(killed, 1);
  assert.equal(inst.reader!.closed, true);
});

test("PlaywrightInstance drains the child's stderr and stdout, which a Windows host can't take over, so a stray write never fills it", async () => {
  const r = rawChild();
  r.child.stderr = new EventEmitter();
  // a pipe nobody reads holds only its high-water mark: a CLI writing past it would block
  r.child.stdout = new PassThrough({ highWaterMark: 16 });
  const inst = new PlaywrightInstance({ fork: r.fork, spec: spawnSpec({ outputDir: '/o', env: {} }), clientName: 'c' });
  const s = inst.start();
  assert.equal(r.child.stderr.listenerCount('data'), 1);
  r.child.stderr.emit('data', Buffer.from('DevTools listening\n'));
  assert.equal(r.child.stdout.readableFlowing, true);
  r.child.stdout.write('a stray CLI log line on the real stdout\n'.repeat(1000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.child.stdout.writableLength + r.child.stdout.readableLength, 0, 'what the CLI wrote is read and dropped');
  r.out(`${JSON.stringify({ jsonrpc: '2.0', id: r.lastId(), result: {} })}\n`);
  await s;
  inst.stop();
});

test('PlaywrightInstance: ignores foreign messages, blank and broken lines, notifications and unknown ids', async () => {
  const { child, out, lastId, inst } = await started();
  const p = inst.request('x', {});
  const id = lastId();
  child.emit('message', null);
  child.emit('message', { type: 'other', data: 'x\n' });
  child.emit('message', { type: 'out', data: 5 });
  out('\n  \nnot json\nnull\n[]\n1\ntrue\n"text"\n');
  out(`${JSON.stringify({ method: 'notify', id })}\n${JSON.stringify({ id: 999, result: 1 })}\n${JSON.stringify({ result: 2 })}\n`);
  // a reply split over two messages
  const line = JSON.stringify({ id, result: { done: true } });
  out(line.slice(0, 5));
  out(`${line.slice(5)}\n`);
  assert.deepEqual(await p, { done: true });
});

test('PlaywrightInstance: an error without a message, a call past its time, a call after exit', async () => {
  const { out, lastId, inst, child } = await started(10);
  const p = inst.request('x', {});
  out(`${JSON.stringify({ id: lastId(), error: {} })}\n`);
  await assert.rejects(p, /Playwright MCP error/);
  await assert.rejects(inst.request('slow', {}), /didn't answer slow in time/);
  assert.equal(inst.pending.size, 0);
  child.emit('exit', 1);
  await assert.rejects(inst.request('y', {}), /Your Chrome stopped/);
  inst.stop(); // already gone: nothing to ask
});

test('PlaywrightInstance: tools/list and tools/call with empty results; a page URL is remembered', async () => {
  const { out, lastId, inst, child } = await started();
  const l = inst.listTools();
  out(`${JSON.stringify({ id: lastId(), result: null })}\n`);
  assert.deepEqual(await l, []);
  const l2 = inst.listTools();
  out(`${JSON.stringify({ id: lastId(), result: {} })}\n`);
  assert.deepEqual(await l2, []);
  const c = inst.call('browser_tabs');
  assert.deepEqual(JSON.parse(child.sent.at(-1).data).params, { name: 'browser_tabs', arguments: {} });
  out(`${JSON.stringify({ id: lastId(), result: null })}\n`);
  assert.deepEqual(await c, {});
  assert.equal(inst.url, null);
  const c2 = inst.call('browser_snapshot', {});
  out(`${JSON.stringify({ id: lastId(), result: { content: [{ type: 'text', text: 'Page URL: https://a.test/' }] } })}\n`);
  await c2;
  assert.equal(inst.url, 'https://a.test/');
});

test('PlaywrightInstance.stop: a CLI that does not exit when asked is killed; one that exits is not', async () => {
  const r = rawChild();
  let kills = 0;
  r.child.kill = () => kills++;
  const inst = new PlaywrightInstance({ fork: r.fork, spec: spawnSpec({ outputDir: '/o', env: {} }), clientName: 'c', stopMs: 1 });
  const s = inst.start();
  r.out(`${JSON.stringify({ id: r.lastId(), result: {} })}\n`);
  await s;
  inst.stop();
  assert.deepEqual(r.child.sent.at(-1), { type: 'stop' });
  await tick();
  assert.equal(kills, 1);
  const q = await started();
  q.child.kill = () => assert.fail('already gone');
  q.inst.stopMs = 1;
  q.inst.stop();
  q.child.emit('exit', 0);
  await tick();
});

test('PlaywrightInstance.stop: a child that cannot be messaged any more is still stopped', async () => {
  const { inst, child } = await started();
  child.postMessage = () => {
    throw new Error('channel closed');
  };
  assert.doesNotThrow(() => inst.stop());
  new PlaywrightInstance({ fork: () => null, spec: {}, clientName: 'c' }).stop(); // never started
});

/** A fork whose instances answer like @playwright/mcp; tools/call through `onCall`. */
function fakeFork(onCall: (name: string) => any, failCall = false) {
  const children: any[] = [];
  const fork = () => {
    const child: any = new EventEmitter();
    let output: (text: string) => unknown;
    const reply = (msg: any) => setImmediate(() => output(JSON.stringify(msg) + '\n'));
    child.postMessage = (m: any) => {
      if (m.type === 'stop') return setImmediate(() => child.emit('exit', 0));
      if (m.type !== 'in') return;
      const msg = JSON.parse(m.data);
      if (msg.method === 'initialize') reply({ id: msg.id, result: {} });
      else if (msg.method === 'tools/call')
        reply(failCall ? { id: msg.id, error: { message: 'relay down' } } : { id: msg.id, result: onCall(msg.params.name) });
    };
    output = extensionWire(child);
    child.kill = () => child.emit('exit', null);
    children.push(child);
    return child;
  };
  return { fork, children };
}

test('ChromeChannel.test: content-less answers, failing calls, and the extension version check', async () => {
  const spec = () => spawnSpec({ outputDir: '/o', env: {} });
  const bare = new ChromeChannel({ fork: fakeFork(() => ({ isError: true })).fork, spec });
  assert.deepEqual(await bare.test(), { ok: false, message: '' });
  const textless = new ChromeChannel({ fork: fakeFork(() => ({ isError: true, content: [{ type: 'image' }] })).fork, spec });
  assert.deepEqual(await textless.test(), { ok: false, message: '' });
  const down = new ChromeChannel({ fork: fakeFork(() => null, true).fork, spec });
  assert.deepEqual(await down.test(), { ok: false, message: 'relay down' });
  const throwing = new ChromeChannel({
    fork: () => {
      throw 'no utility process';
    },
    spec,
  });
  assert.deepEqual(await throwing.test(), { ok: false, message: 'no utility process' });

  const ok = () => fakeFork(() => ({ content: [] })).fork;
  const older = new ChromeChannel({ fork: ok(), spec, extensionVersion: () => '0.0.1', pinnedExtension: '0.0.83' });
  const r = await older.test();
  assert.equal(r.ok, true);
  assert.match(r.message, /^Connected to Chrome\. The Playwright Extension is version 0\.0\.1/);
  assert.equal(r.extension.status, 'older');
  const unknown = new ChromeChannel({
    fork: ok(),
    spec,
    extensionVersion: () => {
      throw new Error('no profile');
    },
    pinnedExtension: '0.0.83',
  });
  const u = await unknown.test();
  assert.equal(u.message, 'Connected to Chrome.');
  assert.equal(u.extension.status, 'unknown');
  const failed = new ChromeChannel({
    fork: fakeFork(() => null, true).fork,
    spec,
    extensionVersion: () => '0.0.1',
    pinnedExtension: '0.0.83',
  });
  assert.equal((await failed.test()).message, 'relay down');
  await tick();
});

test('ChromeChannel: stopping a chat without an instance does nothing; the default client name', async () => {
  const { fork, children } = fakeFork(() => ({}));
  const ch = new ChromeChannel({ fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }) });
  ch.stop('nobody');
  assert.equal(ch.has('c'), false);
  await ch.instance('c');
  assert.equal(ch.has('c'), true);
  assert.equal(ch.chats.size, 1);
  assert.equal(children.length, 1);
  ch.stop('c');
  await tick();
  assert.equal(ch.chats.size, 0);
});

/* -- the proxied tools ------------------------------------------------ */
function proxied(result: any, opts: any = {}) {
  const calls: any[] = [];
  const inst = {
    url: opts.url ?? 'https://a.test/',
    call: async (name: string, args: any) => {
      calls.push([name, args]);
      if (name === 'browser_navigate' && args?.url === 'about:blank') {
        if (opts.blankFails) throw new Error('tab closed');
        return {};
      }
      return result;
    },
  };
  const grants = {
    require: async (url: string) => {
      if (opts.deny && url.includes(opts.deny)) throw Object.assign(new Error('denied'), { code: 'denied' });
    },
  };
  const schemas = [
    { name: 'browser_snapshot' },
    { name: 'browser_click', description: 'Click', inputSchema: { type: 'object', properties: {} } },
    { name: 'browser_evaluate' },
  ];
  const defs = chromeTools({
    channel: { instance: async () => inst },
    grants,
    schemas,
    ...(opts.enabled ? { enabled: opts.enabled } : {}),
  });
  return { defs, calls, by: Object.fromEntries(defs.map((d: any) => [d.name, d])) };
}

test('chromeTools: tools without a schema or description get defaults; Playwright-only tools are left out', () => {
  const { defs, by } = proxied({});
  assert.deepEqual(
    defs.map((d: any) => d.name),
    ['sage_browser_snapshot', 'sage_browser_click'],
  );
  assert.deepEqual(by.sage_browser_snapshot.schema, { type: 'object', properties: {} });
  assert.equal(by.sage_browser_snapshot.description, "(Runs in the user's own Chrome, in a tab group for this chat.)");
  assert.equal(by.sage_browser_click.policy, 'act');
});

test('chromeTools: switched off refuses; an error without text is a Playwright error; no content is empty', async () => {
  const ctx = { chatId: 'c', segmentId: 's' };
  await assert.rejects(proxied({}, { enabled: () => false }).by.sage_browser_snapshot.handler({}, ctx), (e: any) => e.code === 'disabled');
  await assert.rejects(proxied({ isError: true }).by.sage_browser_snapshot.handler(undefined, ctx), /Playwright MCP error/);
  assert.deepEqual(await proxied({}).by.sage_browser_snapshot.handler({}, ctx), { content: [] });
  // a write on a new tab needs no site permission (the write first re-reads the page)
  const newTab = { content: [{ type: 'text', text: 'Page URL: chrome://newtab/' }] };
  assert.deepEqual(await proxied(newTab, { url: 'chrome://newtab/', deny: 'newtab' }).by.sage_browser_click.handler({}, ctx), newTab);
});

test('chromeTools: a page that landed on a refused site is left for a blank one', async () => {
  const ctx = { chatId: 'c', segmentId: 's' };
  const { by, calls } = proxied({ content: [{ type: 'text', text: 'Page URL: https://bad.test/' }] }, { deny: 'bad.test' });
  await assert.rejects(by.sage_browser_snapshot.handler({}, ctx), /denied/);
  assert.deepEqual(calls.at(-1), ['browser_navigate', { url: 'about:blank' }]);
  // leaving the page can fail too: the caller still gets the permission error
  const closed = proxied({ content: [{ type: 'text', text: 'Page URL: https://bad.test/' }] }, { deny: 'bad.test', blankFails: true });
  await assert.rejects(closed.by.sage_browser_snapshot.handler({}, ctx), /denied/);
  assert.deepEqual(closed.calls.at(-1), ['browser_navigate', { url: 'about:blank' }]);
});

/* -- channel switch and schema cache ---------------------------------- */
test('schemaCache: missing, junk and listed files; a failing write is swallowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-schemas-'));
  const file = path.join(dir, 'v', 'tools.json');
  const c = schemaCache(file);
  assert.equal(c.read(), null);
  c.write([{ name: 'browser_snapshot' }]);
  assert.deepEqual(c.read(), [{ name: 'browser_snapshot' }]);
  fs.writeFileSync(file, '{"not":"a list"}');
  assert.equal(c.read(), null);
  const blocked = path.join(dir, 'blocker');
  fs.writeFileSync(blocked, '');
  assert.doesNotThrow(() => schemaCache(path.join(blocked, 'x', 'tools.json')).write([]));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('schemaCache: a write cut off halfway keeps the cached list, and leaves no temporary file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-schemas-'));
  const file = path.join(dir, 'tools.json');
  const c = schemaCache(file);
  c.write([{ name: 'browser_snapshot' }]);
  const restore = tornWrites(dir);
  try {
    c.write([{ name: 'browser_snapshot' }, { name: 'browser_click' }]);
  } finally {
    restore();
  }
  assert.deepEqual(c.read(), [{ name: 'browser_snapshot' }]);
  assert.deepEqual(fs.readdirSync(dir), ['tools.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

function control(o: any = {}) {
  const registered = new Set<string>();
  const registry = { register: (t: any) => (registered.add(t.name), () => registered.delete(t.name)) };
  let stops = 0;
  const switches: Record<string, boolean> = { 'shared.browser.extension': true, 'shared.browser.panelCdp': true, ...o.switches };
  const chrome = {
    tools: o.tools ?? (async () => [{ name: 'browser_snapshot' }]),
    stopAll: () => stops++,
    instance: async () => ({ url: 'about:blank', call: async () => ({}) }),
  };
  const panel = { url: async () => 'about:blank', screenshot: async () => 'png' };
  const grants = { require: async () => {} };
  const bc = new BrowserControl({
    registry,
    grants,
    chromeGrants: grants,
    panel,
    chrome,
    isEnabled: (k: string) => switches[k],
    cache: o.cache,
  });
  return { bc, registered, switches, stops: () => stops };
}

test('BrowserControl: an unknown channel is the built-in browser; its tools follow the switch', async () => {
  const { bc, registered, switches } = control();
  assert.equal(await bc.configure('firefox'), 'builtin');
  assert.ok(registered.has('sage_browser_screenshot'));
  switches['shared.browser.panelCdp'] = false;
  assert.equal(await bc.configure('builtin'), null);
  assert.equal(registered.size, 0);
});

test('BrowserControl: Your Chrome tools check their switch at call time', async () => {
  let defs: any[] = [];
  const registry = { register: (t: any) => (defs.push(t), () => (defs = defs.filter((d) => d !== t))) };
  const switches: Record<string, boolean> = { 'shared.browser.extension': true, 'shared.browser.panelCdp': true };
  const chrome = {
    tools: async () => [{ name: 'browser_snapshot' }],
    stopAll() {},
    instance: async () => ({ url: null, call: async () => ({ content: [] }) }),
  };
  const wc = { getURL: () => 'about:blank', isDestroyed: () => false };
  const panel = { url: async () => 'about:blank', tab: async () => ({ backend: wc }), screenshot: async () => 'png' };
  const bc = new BrowserControl({
    registry,
    grants: { require: async () => {} },
    chromeGrants: { require: async () => {} },
    panel,
    chrome,
    isEnabled: (k: string) => switches[k],
  });
  assert.equal(await bc.configure('chrome'), 'chrome');
  const ctx = { chatId: 'c', segmentId: 's' };
  const snapshot = () => defs.find((d) => d.name === 'sage_browser_snapshot');
  assert.deepEqual(await snapshot().handler({}, ctx), { content: [] });
  switches['shared.browser.extension'] = false;
  await assert.rejects(snapshot().handler({}, ctx), (e: any) => e.code === 'disabled');
  // the built-in browser's tools read their own switch too
  assert.equal(await bc.configure('builtin'), 'builtin');
  const shot = defs.find((d) => d.name === 'sage_browser_screenshot');
  assert.equal(await shot.handler({}, ctx), 'png');
  switches['shared.browser.panelCdp'] = false;
  await assert.rejects(shot.handler({}, ctx), (e: any) => e.code === 'disabled');
});

test('BrowserControl: a newer configure wins while the tool list loads; an empty cache is refilled', async () => {
  let release: (v: any) => void = () => {};
  const writes: any[] = [];
  const cache = { read: () => [], write: (l: any) => writes.push(l) };
  const { bc, registered } = control({ cache, tools: () => new Promise((r) => (release = r)) });
  const first = bc.configure('chrome');
  const second = await bc.configure('builtin');
  release([{ name: 'browser_snapshot' }]);
  assert.equal(await first, 'builtin');
  assert.equal(second, 'builtin');
  assert.ok(registered.has('sage_browser_screenshot'));
  assert.equal(bc.active, 'builtin');
  // the list that loaded is still cached for next time
  assert.deepEqual(writes, [[{ name: 'browser_snapshot' }]]);
  // nothing listed: nothing cached, no tools
  const empty = control({ cache, tools: async () => [] });
  assert.equal(await empty.bc.configure('chrome'), null);
  assert.equal(writes.length, 1);
  // a cached list is used without asking Chrome
  const cached = control({
    cache: { read: () => [{ name: 'browser_tabs' }], write: () => assert.fail('no write') },
    tools: async () => assert.fail('no list'),
  });
  assert.equal(await cached.bc.configure('chrome'), 'chrome');
  assert.ok(cached.registered.has('sage_browser_tabs'));
  // without a cache the list comes from Chrome each time
  const nocache = control();
  assert.equal(await nocache.bc.configure('chrome'), 'chrome');
});
