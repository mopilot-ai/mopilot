// routing:* (electron/app/ipc/routing.cjs): the catalog with which providers have a key, configs listed, saved and removed, a key set, cleared and asked about; a key never comes back in any reply, refusals come back as values, and every change, here or by Host key lending, tells the windows (and a routed key change re-sends the Host's machines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/routing.cjs');
const { register: registerHost } = require('../electron/app/ipc/host.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const KEY = 'sk-or-dummy-0000-test-key-wxyz';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (v: string) => Buffer.from([...v].reverse().join('')),
  decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
};

function world(t: any, o: { broadcastAll?: (...a: unknown[]) => void } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>();
  const sent: unknown[][] = [];
  const replies: unknown[] = [];
  const deps = { app: { getPath: () => dir }, broadcastAll: o.broadcastAll ?? ((...a: unknown[]) => void sent.push(a)) };
  register({ handle: (c: string, fn: any) => handlers.set(c, fn) }, deps, { safeStorage });
  const call = async (c: string, ...a: unknown[]) => {
    const r = await handlers.get(c)({}, ...a);
    replies.push(r);
    return r;
  };
  return { dir, handlers, sent, replies, call, deps };
}

test('the catalog says which providers have a key; a key is set, asked about, cleared, and never comes back', async (t) => {
  const w = world(t);
  const providers = async () => (await w.call('routing:providers')).value;
  const first = await providers();
  assert.equal(first.keys, 'ok');
  assert.deepEqual(
    first.providers.map((p: any) => [p.id, p.hasKey]),
    [
      ['openai', false],
      ['anthropic', false],
      ['gemini', false],
      ['openrouter', false],
      ['deepseek', false],
      ['custom', null],
    ],
  );
  assert.equal(first.providers[0].baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(await w.call('routing:setKey', 'openrouter', KEY), { value: '…wxyz' });
  assert.deepEqual(await w.call('routing:hasKey', 'openrouter'), { value: true });
  assert.equal((await providers()).providers.find((p: any) => p.id === 'openrouter').hasKey, true);
  // a server the user names keeps its key for its own URL
  assert.deepEqual(await w.call('routing:setKey', 'custom', 'token-abc1', 'http://localhost:8000/v1'), { value: '…abc1' });
  assert.deepEqual(await w.call('routing:hasKey', 'custom', 'http://localhost:8000'), { value: true });
  assert.deepEqual(await w.call('routing:hasKey', 'custom', 'http://localhost:11434'), { value: false });
  assert.deepEqual(await w.call('routing:clearKey', 'custom', 'http://localhost:8000/v1'), { value: true });
  assert.deepEqual(await w.call('routing:clearKey', 'openrouter'), { value: true });
  assert.deepEqual(await w.call('routing:clearKey', 'openrouter'), { value: false });
  assert.deepEqual(
    w.sent,
    [['routing:changed'], ['routing:changed'], ['routing:changed'], ['routing:changed']],
    'one per change, none for a clear that found none',
  );
  // refusals are values with their code, and never repeat the key
  assert.deepEqual(await w.call('routing:setKey', 'openrouter', 'nope'), {
    error: { message: 'That is not an API key.', code: 'invalid' },
  });
  assert.deepEqual(await w.call('routing:setKey', 'custom', KEY), {
    error: { message: 'Choose a provider, and enter its URL for your own server.', code: 'invalid' },
  });
  assert.equal((await w.call('routing:hasKey', 'mistral')).error.code, 'invalid');
  assert.doesNotMatch(JSON.stringify(w.replies), /sk-or-dummy|token-abc1/, 'no reply carries a key');
  assert.doesNotMatch(fs.readFileSync(path.join(w.dir, 'host-api-keys.json'), 'utf8'), /sk-or-dummy|token-abc1/);
  assert.equal(w.sent.length, 4);
});

test('configs are listed, saved and removed over IPC; a refusal is a value; each change tells every window', async (t) => {
  const w = world(t);
  assert.deepEqual(await w.call('routing:configs'), { value: { configs: [], invalid: 0, state: 'ok' } });
  const saved = (await w.call('routing:saveConfig', { name: 'Cheap', provider: 'deepseek', model: 'deepseek-chat' })).value;
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual((await w.call('routing:configs')).value.configs, [saved]);
  assert.deepEqual(await w.call('routing:saveConfig', { name: 'x', provider: 'mistral', model: 'm' }), {
    error: { message: 'Choose a provider.', code: 'invalid' },
  });
  assert.deepEqual(await w.call('routing:removeConfig', saved.id), { value: true });
  assert.deepEqual(await w.call('routing:removeConfig', saved.id), { value: false });
  assert.deepEqual(w.sent, [['routing:changed'], ['routing:changed']]);
  // an unreadable file is reported, and a change refused, as values
  fs.writeFileSync(path.join(w.dir, 'llm-configs.json'), '{not json');
  assert.equal((await w.call('routing:configs')).value.state, 'unreadable');
  assert.equal((await w.call('routing:saveConfig', { name: 'x', provider: 'deepseek', model: 'm' })).error.code, 'unreadable');
  fs.writeFileSync(path.join(w.dir, 'host-api-keys.json'), '{not json');
  assert.equal((await w.call('routing:providers')).value.keys, 'unreadable');
});

test('a fault that is not a refusal is recorded and answered; a window that can’t be told does not fail the change', async (t) => {
  const w = world(t, {
    broadcastAll: () => {
      throw new Error('window gone');
    },
  });
  assert.deepEqual(await w.call('routing:setKey', 'openrouter', KEY), { value: '…wxyz' }, 'kept, though no window heard');
  assert.ok(recentIgnored().some((e: any) => /tell the windows/.test(e.context)));
  // a fault of main's own (here userData can't be found) is no refusal of the stores: recorded, and answered with its message
  const blocked = world(t);
  blocked.deps.app.getPath = () => {
    throw new Error('no userData');
  };
  assert.deepEqual(await blocked.call('routing:saveConfig', { name: 'x', provider: 'deepseek', model: 'm' }), {
    error: { message: 'no userData' },
  });
  assert.ok(recentIgnored().some((e: any) => e.context === 'run routing:saveConfig'));
  const odd = world(t);
  odd.deps.app.getPath = () => {
    throw 'not an Error';
  };
  assert.deepEqual(await odd.call('routing:configs'), { error: { message: 'Something went wrong.' } });
});

test('without a safeStorage given, the store is still made (Electron’s is the default): a Mac with no key file has no keys', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>();
  register({ handle: (c: string, fn: any) => handlers.set(c, fn) }, { app: { getPath: () => dir }, broadcastAll: () => undefined });
  assert.deepEqual(await handlers.get('routing:hasKey')({}, 'openai'), { value: false });
});

test('one key store: a key set for a routed chat re-sends the Host’s machines, and one set for a Host tells the routing windows', async (t) => {
  const w = world(t);
  let machinesFail = false;
  const hostHandlers = new Map<string, any>();
  registerHost(
    { handle: (c: string, fn: any) => hostHandlers.set(c, fn) },
    { app: { getPath: () => w.dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: w.deps.broadcastAll },
    {
      create: () => ({
        list: () => {
          if (machinesFail) throw new Error('machines unavailable');
          return { machines: ['m'], resolved: true };
        },
      }),
      createFolders: () => ({}),
      allowed: () => true,
      safeStorage,
    },
  );
  const host = (c: string, ...a: unknown[]) => hostHandlers.get(c)({}, ...a);
  assert.deepEqual(await host('host:apiKeys'), { value: {} });
  await w.call('routing:providers');
  assert.deepEqual(await w.call('routing:setKey', 'anthropic', 'sk-ant-dummy-0000-test-key-abcd'), { value: '…abcd' });
  assert.deepEqual(await host('host:apiKeys'), { value: { anthropic: '…abcd' } }, 'entered once, lent to a Host');
  assert.deepEqual(
    w.sent.find((m) => m[0] === 'host:machines'),
    ['host:machines', { machines: ['m'], resolved: true }],
  );
  assert.deepEqual(w.sent.map((m) => m[0]).sort(), ['host:machines', 'routing:changed']);
  w.sent.length = 0;
  // a key only routed chats take, or only a Host takes, tells only its own page
  await w.call('routing:setKey', 'openrouter', 'sk-or-dummy-0000-test-key-wxyz');
  await host('host:setApiKey', 'xai', 'xai-dummy-0000-test-key-ijkl');
  assert.deepEqual(
    w.sent.map((m) => m[0]),
    ['routing:changed', 'host:machines'],
  );
  w.sent.length = 0;
  assert.deepEqual(await host('host:removeApiKey', 'anthropic'), { value: true });
  assert.deepEqual(await w.call('routing:hasKey', 'anthropic'), { value: false });
  assert.deepEqual(w.sent.map((m) => m[0]).sort(), ['host:machines', 'routing:changed']);
  // the machines can't be listed: the routed key is still kept, and the fault recorded
  machinesFail = true;
  assert.deepEqual(await w.call('routing:setKey', 'openai', 'sk-proj-dummy-0000-test-key-efgh'), { value: '…efgh' });
  assert.ok(recentIgnored().some((e: any) => e.context === 'send the machines again after a key changed'));
});

test('the model router starts over the same stores, Claude Code is given its base and token, and it stops when the app quits', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-ipc-router-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>();
  const quit: (() => void)[] = [];
  let routing: any = null;
  const deps = {
    app: { getPath: () => dir, on: (event: string, fn: () => void) => void (event === 'will-quit' && quit.push(fn)) },
    broadcastAll: () => {},
    claude: { setRouting: (r: any) => void (routing = r) },
  };
  const { router } = register({ handle: (c: string, fn: any) => handlers.set(c, fn) }, deps, { safeStorage });
  const call = async (c: string, ...a: unknown[]) => (await handlers.get(c)({}, ...a)).value;
  await router.start();
  const saved = await call('routing:saveConfig', { name: 'Work', provider: 'openrouter', model: 'openai/gpt-x' });
  assert.equal(routing.configOf(saved.id).name, 'Work', "the router's configs are the windows'");
  assert.equal(routing.configOf('gone'), null);
  assert.match(routing.baseFor(saved.id), new RegExp(`^http://127\\.0\\.0\\.1:\\d+/[0-9a-f]{36}/c/${saved.id}$`));
  assert.equal(routing.token, router.token);
  let heard = 0;
  routing.onChange(() => heard++);
  await call('routing:removeConfig', saved.id);
  assert.equal(heard, 1, 'a config change reaches Claude Code (its idle CLIs restart)');
  quit.forEach((f) => f());
  assert.equal(routing.baseFor(saved.id), null, 'stopped');
  // a process without Claude Code's routed mode starts no router
  const bare = register({ handle: () => {} }, { app: { getPath: () => dir }, broadcastAll: () => {} }, { safeStorage });
  assert.equal(bare.router.baseFor('x'), null);
});

test('the router reads the windows’ configs and keys: a request reaches the provider with the key set here', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-ipc-req-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let seen: any = null;
  const provider = http.createServer((req, res) => {
    seen = req.headers;
    req.resume();
    req.on('end', () => res.end('{"type":"message"}'));
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', () => r()));
  t.after(() => provider.close());
  const handlers = new Map<string, any>();
  const { router } = register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => dir }, broadcastAll: () => {} },
    { safeStorage, router: { bases: { anthropic: `http://127.0.0.1:${(provider.address() as any).port}` } } },
  );
  const call = async (c: string, ...a: unknown[]) => (await handlers.get(c)({}, ...a)).value;
  await router.start();
  t.after(() => router.stop());
  const saved = await call('routing:saveConfig', { name: 'Own', provider: 'anthropic', model: 'claude-own' });
  await call('routing:setKey', 'anthropic', 'sk-ant-dummy-0000-test-key-abcd');
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      `${router.baseFor(saved.id)}/v1/messages`,
      { method: 'POST', headers: { authorization: `Bearer ${router.token}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ messages: [] }));
  });
  assert.equal(status, 200);
  assert.equal(seen['x-api-key'], 'sk-ant-dummy-0000-test-key-abcd');
});
