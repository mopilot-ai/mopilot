// Preview restoration coalesces work, respects current owners and preserves retryable launch evidence.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { savedPreview, url } from './support/dev-preview/restart.ts';
import { deferred, tick } from './support/async-scenarios.ts';

test('equivalent restored tabs share one spawn and keep their own routes; other chats and external sites start nothing', async (t) => {
  const h = await savedPreview(t);
  const gate = deferred<boolean>();
  let probes = 0;
  const p = h.create({ probe: async () => (++probes === 1 ? gate.promise : true) });
  const a = p.prepare('chat', `${url}one?a=1`);
  const b = p.prepare('chat', `${url}two#demo`);
  assert.equal(p.prepare('other', url), null);
  assert.equal(p.prepare('chat', 'https://example.test'), null);
  assert.equal(p.prepare('chat', 'not a url'), null);
  await tick();
  assert.equal(probes, 1);
  gate.resolve(false);
  assert.deepEqual(await Promise.all([a, b]), [`${url}one?a=1`, `${url}two#demo`]);
  assert.equal(h.spawned.length, 2);
  assert.equal(await p.prepare('chat', url), url, 'a running preview is reused');
  assert.equal(h.spawned.length, 2);
  assert.equal(fs.statSync(h.stateFile).mode & 0o777, 0o600);
});

test('a port already served by the user is reused without adopting its process', async (t) => {
  const h = await savedPreview(t);
  const p = h.create();
  assert.equal(await p.prepare('chat', url), url);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(p.list('chat'), []);
});

test('owner changes during the port probe refuse a spawn; returning to the owner permits retry', async (t) => {
  const h = await savedPreview(t);
  const gate = deferred<boolean>();
  let allowed = true;
  const p = h.create({ canRestore: async () => allowed, probe: async () => gate.promise });
  const pending = p.prepare('chat', url);
  await tick();
  allowed = false;
  gate.resolve(false);
  await assert.rejects(pending, /can no longer restart/);
  assert.equal(h.spawned.length, 1);
  allowed = true;
  p.probe = async () => true;
  assert.equal(await p.prepare('chat', url), url);
});

for (const retirement of ['archive', 'quit'] as const) {
  test(`${retirement} while restoration reads its owner starts no retired process`, async (t) => {
    const h = await savedPreview(t);
    const gate = deferred<boolean>();
    const p = h.create({ canRestore: async () => gate.promise });
    const pending = p.prepare('chat', url);
    if (retirement === 'archive') p.stopChat('chat');
    else p.stopAll({ preserveSaved: true });
    gate.resolve(true);
    await assert.rejects(pending, /can no longer restart/);
    assert.equal(h.spawned.length, 1);
    if (retirement === 'archive') assert.equal(p.prepare('chat', url), null);
    else await assert.rejects(p.prepare('chat', url), /can no longer restart/);
  });
}

test('a stopped replacement cannot publish ready; the saved command is forgotten', async (t) => {
  const h = await savedPreview(t);
  const waiting = deferred<string>();
  const p = h.create({ probe: async () => false });
  p.waitReady = async () => waiting.promise;
  const pending = p.prepare('chat', url);
  await tick();
  const server = p.list('chat')[0];
  p.stop('chat', server.id);
  waiting.resolve('ready');
  await assert.rejects(pending, /can no longer restart/);
  assert.equal(p.prepare('chat', url), null);
});

for (const outcome of ['timeout', 'exited']) {
  test(`a ${outcome} ends restoration visibly and retains the recipe for retry`, async (t) => {
    const h = await savedPreview(t);
    const p = h.create({ probe: async () => false });
    p.waitReady = async () => outcome;
    await assert.rejects(p.prepare('chat', url), /could not restart/);
    assert.equal(p.saved.records.size, 1);
    p.waitReady = async () => 'ready';
    const server = p.list('chat')[0];
    server.url = url;
    assert.equal(await p.prepare('chat', url), url);
  });
}

test('transport and spawn errors release coalescing so the next attempt can recover', async (t) => {
  const h = await savedPreview(t);
  const p = h.create({
    probe: async () => {
      throw new Error('transport');
    },
  });
  await assert.rejects(p.prepare('chat', url), /transport/);
  p.probe = async () => false;
  const spawn = p.spawnFn;
  p.spawnFn = () => {
    throw new Error('executable missing');
  };
  await assert.rejects(p.prepare('chat', url), /executable missing/);
  p.spawnFn = spawn;
  p.probe = async () => true;
  assert.equal(await p.prepare('chat', url), url);
});

for (const corrupt of [null, [], { version: 9, servers: [] }, { version: 1, servers: [null] }, '{truncated']) {
  test(`unreadable saved launch data is preserved and never executed: ${JSON.stringify(corrupt)}`, async (t) => {
    const h = await savedPreview(t);
    const raw = typeof corrupt === 'string' ? corrupt : JSON.stringify(corrupt);
    fs.writeFileSync(h.stateFile, raw);
    const p = h.create();
    assert.equal(p.prepare('chat', url), null);
    assert.equal(h.spawned.length, 1);
    assert.equal(fs.readFileSync(`${h.stateFile}.unreadable`, 'utf8'), raw);
    assert.throws(() => p.saved.remember(h.s), /could not be read/);
    assert.equal(fs.readFileSync(h.stateFile, 'utf8'), raw);
    // The fixture's older in-memory registry is retired; it must not overwrite this deliberately corrupt case at cleanup.
    h.first.saved.records.clear();
  });
}

test('a failed recipe removal preserves the running process and authoritative saved launch', async (t) => {
  const h = await savedPreview(t);
  const p = h.create({ probe: async () => false });
  p.waitReady = async () => 'ready';
  await p.prepare('chat', url);
  const server = p.list('chat')[0];
  const raw = fs.readFileSync(h.stateFile, 'utf8');
  const rename = mock.method(fs, 'renameSync', () => {
    throw new Error('disk unavailable');
  });
  try {
    assert.throws(() => p.stop('chat', server.id), /disk unavailable/);
    assert.equal(server.live, true);
    assert.equal(p.saved.records.size, 1);
    assert.equal(fs.readFileSync(h.stateFile, 'utf8'), raw);
  } finally {
    rename.mock.restore();
  }
  p.stop('chat', server.id);
  assert.equal(p.prepare('chat', url), null);
});

test('a ready server whose launch save failed reports the persistence limitation and can save on retry', async (t) => {
  const h = await savedPreview(t);
  const p = h.create();
  const rename = mock.method(fs, 'renameSync', () => {
    throw new Error('disk unavailable');
  });
  let server: any;
  try {
    server = p.start('another-chat', h.s.launch);
    assert.equal(await p.waitReady(server), 'ready');
    assert.match(server.restoreError, /could not be saved/);
    assert.equal(p.saved.records.size, 1);
  } finally {
    rename.mock.restore();
  }
  p.saved.remember(server);
  assert.equal(p.saved.records.size, 2);
});

test('attaching to an external server records no launch recipe', async (t) => {
  const h = await savedPreview(t);
  const p = h.create();
  const attached = p.attach('another-chat', url);
  assert.equal(await p.waitReady(attached), 'ready');
  assert.equal(p.saved.records.size, 1);
  assert.equal(p.prepare('another-chat', url), null);
});

test('older saved origins and routes with double slashes stay on the owned preview after a port change', async (t) => {
  const h = await savedPreview(t);
  const changed = { ...h.s, url: 'http://127.0.0.1:4318/' };
  h.first.saved.remember(changed);
  const p = h.create();
  assert.equal(await p.prepare('chat', `${url}/example.test/route?q=one#two`), 'http://127.0.0.1:4318//example.test/route?q=one#two');
});

test('saved records validate each persisted field before any command can be restored', async (t) => {
  const h = await savedPreview(t);
  const data = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'));
  const mutations = [
    (s: any) => (s.id = null),
    (s: any) => (s.chatId = []),
    (s: any) => (s.url = 'https://remote.test'),
    (s: any) => (s.origins = []),
    (s: any) => (s.origins = ['http://127.0.0.1:4317/path']),
    (s: any) => (s.launch = []),
    (s: any) => (s.launch.run = []),
    (s: any) => (s.launch.run = [7]),
    (s: any) => (s.launch.display = null),
    (s: any) => (s.launch.cwd = ''),
    (s: any) => (s.launch.cwd = 'relative'),
    (s: any) => (s.launch.project = false),
    (s: any) => (s.launch.port = 0),
    (s: any) => (s.launch.port = 65536),
    (s: any) => (s.launch.port = 1.5),
    (s: any) => (s.launch.url = 'file:///tmp/file'),
    (s: any) => (s.launch.name = false),
    (s: any) => (s.launch.verbatim = 'false'),
    (s: any) => (s.launch.env = []),
    (s: any) => (s.launch.env = { key: 7 }),
  ];
  for (const [n, mutate] of mutations.entries()) {
    const next = structuredClone(data);
    mutate(next.servers[0]);
    const file = `${h.stateFile}.${n}`;
    fs.writeFileSync(file, JSON.stringify(next));
    const p = h.create({ stateFile: file });
    assert.equal(p.prepare('chat', url), null);
    assert.ok(p.saved.error);
  }
  const valid = structuredClone(data);
  Object.assign(valid.servers[0].launch, { project: null, port: 4317, url: null, name: null, env: { EXAMPLE: 'value' } });
  fs.writeFileSync(`${h.stateFile}.valid`, JSON.stringify(valid));
  const accepted = h.create({ stateFile: `${h.stateFile}.valid` });
  assert.equal(await accepted.prepare('chat', url), url);
});

test('a nonlocal page served by a command saves no local restart recipe', async (t) => {
  const h = await savedPreview(t);
  const p = h.create();
  const s = p.start('remote-page', { ...h.s.launch, url: 'https://example.test' });
  assert.equal(await p.waitReady(s), 'ready');
  assert.equal(p.saved.records.size, 1);
});

test('preview_start reports a save failure and retries persistence when the running server is reused', async (t) => {
  const { createRequire } = await import('node:module');
  const { createPreviewTools } = createRequire(import.meta.url)('../electron/capabilities/browser/devPreview/tools.cjs');
  const h = await savedPreview(t);
  const p = h.create();
  const server = p.start('chat', h.s.launch);
  await p.waitReady(server);
  const tools = createPreviewTools({ previews: p, open: async () => ({ id: 'tab' }), projectOf: async () => h.cwd, anchor: () => 'full' });
  const start = tools.find((tool: any) => tool.name === 'browser_preview_start').handler;
  const args = { command: h.s.display, cwd: h.cwd, url };
  const ctx = { chatId: 'chat', segmentId: 'segment' };
  const rename = mock.method(fs, 'renameSync', () => {
    throw new Error('disk unavailable');
  });
  try {
    assert.match(await start(args, ctx), /could not be saved for an app restart/);
  } finally {
    rename.mock.restore();
  }
  assert.doesNotMatch(await start(args, ctx), /could not be saved/);
  assert.equal(server.restoreError, null);
});

test('an archive retires its process and in-memory launch even when durable removal fails', async (t) => {
  const h = await savedPreview(t);
  const p = h.create({ probe: async () => false });
  p.waitReady = async () => 'ready';
  await p.prepare('chat', url);
  const server = p.list('chat')[0];
  const rename = mock.method(fs, 'renameSync', () => {
    throw new Error('disk unavailable');
  });
  try {
    assert.doesNotThrow(() => p.stopChat('chat'));
    assert.equal(server.live, false);
    assert.equal(server.status, 'stopped');
    assert.equal(p.prepare('chat', url), null);
  } finally {
    rename.mock.restore();
  }
});

test('a natural process exit during a ready wait never reports a successful restore', async (t) => {
  const h = await savedPreview(t);
  const p = h.create({ probe: async () => false });
  p.waitReady = async (s: any) => {
    s.proc.emit('exit', 0);
    return 'ready';
  };
  await assert.rejects(p.prepare('chat', url), /could not restart/);
});

test('default HTTP and HTTPS ports and IPv6 loopback are restored with the correct probe target', async (t) => {
  const h = await savedPreview(t);
  for (const [address, port, host] of [
    ['http://localhost/', 80, 'localhost'],
    ['https://localhost/', 443, 'localhost'],
    ['https://[::1]/', 443, '::1'],
  ] as const) {
    h.first.saved.remember({ ...h.s, url: address, launch: { ...h.s.launch, url: address } });
    const probes: any[] = [];
    const p = h.create({
      probe: async (...args: any[]) => {
        probes.push(args);
        return true;
      },
    });
    assert.equal(await p.prepare('chat', address), address);
    assert.deepEqual(probes, [[port, host]]);
  }
});
