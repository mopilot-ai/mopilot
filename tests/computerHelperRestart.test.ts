// electron/capabilities/computer.cjs: the helper client survives a helper that exits or crashes. Every
// request (re)launches it first (single-flight), a read-only request that loses the helper mid-call is
// sent once more to the relaunched one, an input request is never replayed and says the helper restarted,
// and cleanup requests don't launch a helper for nothing. Runs over a scripted unix-socket helper whose
// connections can be dropped, standing in for the helper process exiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scriptedHelper } from './helpers/scriptedHelper.ts';

const require = createRequire(import.meta.url);
const { ComputerHelper, READ_ONLY, NO_LAUNCH } = require('../electron/capabilities/computer.cjs');
const { withFloor } = require('../electron/capabilities/computerContract.cjs');
const { helperError } = require('../electron/capabilities/tools/computer.cjs');

const exited = (h: any) => new Promise<void>((r) => h.once('exit', r));

test('a helper that exited is relaunched by the next call, for every call path', async () => {
  const fake = await scriptedHelper(() => ({ result: { apps: [] } }));
  const helper = new ComputerHelper({ connectTo: fake.socket });
  try {
    await helper.start();
    assert.equal(helper.running, true);
    const gone = exited(helper);
    fake.kill();
    await gone;
    assert.equal(helper.running, false);
    // no explicit start(): the request itself brings the helper back
    assert.deepEqual(await helper.call('apps.list'), { apps: [] });
    assert.equal(helper.running, true);
    assert.equal(fake.connections(), 2);
    assert.deepEqual(
      fake.log.map((l) => `${l.conn}:${l.method}`),
      ['1:hello', '2:hello', '2:apps.list'],
    );
    // a never-started helper launches on its first request too (wrappers go through call)
    const fresh = new ComputerHelper({ connectTo: fake.socket });
    assert.equal((await fresh.listApps()).apps.length, 0);
    fresh.stop();
  } finally {
    helper.stop();
    await fake.close();
    fake.cleanup();
  }
});

test('concurrent calls share one launch (single-flight), also while hello is still on its way', async () => {
  const fake = await scriptedHelper((method) => ({ result: { method } }));
  const helper = new ComputerHelper({ connectTo: fake.socket });
  try {
    const out = await Promise.all([
      helper.call('apps.list'),
      helper.call('input.cursor'),
      helper.start(),
      helper.call('displays.list'),
      helper.start(),
    ]);
    assert.deepEqual(
      out.map((o: any) => o?.method ?? 'hello'),
      ['apps.list', 'input.cursor', 'hello', 'displays.list', 'hello'],
    );
    assert.equal(fake.connections(), 1);
    assert.equal(fake.log.filter((l) => l.method === 'hello').length, 1);
    // hello is the first request on the connection: nothing went out before the helper said hello back
    assert.equal(fake.log[0].method, 'hello');
    // after an exit, a burst of calls relaunches once
    const gone = exited(helper);
    fake.kill();
    await gone;
    await Promise.all([helper.call('apps.list'), helper.call('apps.list'), helper.call('screenshot')]);
    assert.equal(fake.connections(), 2);
    assert.equal(fake.log.filter((l) => l.method === 'hello').length, 2);
  } finally {
    helper.stop();
    await fake.close();
    fake.cleanup();
  }
});

test('an input call the helper dies during is not replayed: helper_restarted, and the helper is back', async () => {
  const fake = await scriptedHelper((method) => (method === 'input.click' ? { drop: true } : { result: { ok: true } }));
  const helper = new ComputerHelper({ connectTo: fake.socket });
  try {
    await helper.start();
    await assert.rejects(helper.click(10, 20), (e: any) => {
      assert.equal(e.reason, 'helper_restarted');
      assert.match(e.message, /stopped while running input\.click and was restarted/);
      assert.match(e.message, /may or may not have happened/);
      assert.match(e.message, /take a fresh screenshot/);
      return true;
    });
    // sent once only, and the relaunched helper already answers
    assert.equal(fake.log.filter((l) => l.method === 'input.click').length, 1);
    assert.equal(helper.running, true);
    assert.equal(fake.connections(), 2);
    // the tools show it as "state changed: look again"
    const t = helperError(Object.assign(new Error('x restarted'), { reason: 'helper_restarted' }));
    assert.equal(t.code, 'changed');
    assert.equal(t.message, 'x restarted');
  } finally {
    helper.stop();
    await fake.close();
    fake.cleanup();
  }
});

test('an input call whose helper could not come back says so', async () => {
  const fake = await scriptedHelper(() => ({ drop: true }));
  const helper = new ComputerHelper({ connectTo: fake.socket, connectTimeoutMs: 30 });
  try {
    await helper.start();
    const closing = fake.close();
    await assert.rejects(
      helper.call('app.click', {}),
      (e: any) => e.reason === 'helper_restarted' && /could not be restarted yet/.test(e.message),
    );
    await closing;
    // the next call reports the failed launch as unavailable
    await assert.rejects(
      helper.call('apps.list'),
      (e: any) => e.reason === 'helper_unavailable' && /could not be started: computer-use helper did not start/.test(e.message),
    );
    assert.equal(helperError(Object.assign(new Error('nope'), { reason: 'helper_unavailable' })).code, 'unavailable');
  } finally {
    helper.stop();
    fake.cleanup();
  }
});

test('a read-only call retries once on the relaunched helper; a second exit gives up', async () => {
  // the first screenshot loses the helper, the second one answers
  const fake = await scriptedHelper((method, _p, n) =>
    method === 'app.screenshot' && n === 1 ? { drop: true } : method === 'app.windows' ? { drop: true } : { result: { method, n } },
  );
  const helper = new ComputerHelper({ connectTo: fake.socket });
  try {
    assert.deepEqual(await helper.call('app.screenshot', { pid: 1 }), { method: 'app.screenshot', n: 2 });
    assert.deepEqual(
      fake.log.filter((l) => l.method === 'app.screenshot').map((l) => l.conn),
      [1, 2],
    );
    // app.windows loses the helper every time: one retry, then a clear error
    await assert.rejects(
      helper.call('app.windows', { pid: 1 }),
      (e: any) => e.reason === 'helper_unavailable' && /exited twice while running app\.windows/.test(e.message),
    );
    assert.equal(fake.log.filter((l) => l.method === 'app.windows').length, 2);
  } finally {
    helper.stop();
    await fake.close();
    fake.cleanup();
  }
});

test('readOnly: true makes any request retryable (a menu listing); false keeps a read-only one from replaying', async () => {
  const fake = await scriptedHelper((method, _p, n) => (n === 1 ? { drop: true } : { result: { method } }));
  const helper = new ComputerHelper({ connectTo: fake.socket });
  try {
    assert.deepEqual(await helper.call('app.menu', { list: ['File'] }, { readOnly: true }), { method: 'app.menu' });
    await assert.rejects(helper.call('apps.list', {}, { readOnly: false }), (e: any) => e.reason === 'helper_restarted');
    // the classification the tools rely on
    for (const m of [
      'screenshot',
      'app.screenshot',
      'app.windows',
      'app.zoom',
      'app.menuRefresh',
      'permissions.status',
      'ax.snapshot',
      'target.info',
    ])
      assert.ok(READ_ONLY.has(m), m);
    for (const m of [
      'input.click',
      'input.type',
      'input.key',
      'input.drag',
      'input.scroll',
      'app.click',
      'app.press',
      'app.setText',
      'app.key',
      'app.drag',
      'app.scroll',
      'app.menu',
      'apps.open',
      'text.insert',
      'input.paste',
    ])
      assert.equal(READ_ONLY.has(m), false, m);
  } finally {
    helper.stop();
    await fake.close();
    fake.cleanup();
  }
});

test('cleanup requests never launch a helper; stop() fails what is still waiting', async () => {
  const fake = await scriptedHelper((method) => (method === 'input.type' ? { hold: true } : { result: { ok: true } }));
  const helper = new ComputerHelper({ connectTo: fake.socket });
  try {
    for (const m of NO_LAUNCH)
      await assert.rejects(
        helper.call(m),
        (e: any) => e.reason === 'helper_not_running' && e.message === 'computer-use helper is not running',
      );
    await assert.rejects(helper.releaseControl(), (e: any) => e.reason === 'helper_not_running');
    assert.equal(fake.connections(), 0);
    assert.equal(helperError(Object.assign(new Error('x'), { reason: 'helper_not_running' })).code, 'unavailable');
    // a running helper takes them
    await helper.start();
    assert.deepEqual(await helper.releaseControl(), { ok: true });
    // stop() while a request waits: it fails at once instead of at its timeout
    const typing = helper.type('hello');
    await new Promise((r) => setTimeout(r, 20));
    helper.stop();
    await assert.rejects(typing, (e: any) => e.reason === 'helper_stopped');
    const t = helperError(Object.assign(new Error('x'), { reason: 'helper_stopped' }));
    assert.equal(t.code, 'unavailable');
    assert.match(t.message, /relaunches it on the next call: take a fresh screenshot/);
  } finally {
    helper.stop();
    await fake.close();
    fake.cleanup();
  }
});

test('a helper whose hello fails is let go, and the next call launches it again', async () => {
  // the first hello is refused (a stale or foreign helper on the socket), the second one answers
  const fake = await scriptedHelper(
    () => ({ result: { ok: true } }),
    (n) => (n === 1 ? { error: { code: 1, message: 'bad token', data: { reason: 'unauthorized' } } } : { result: { pid: 2 } }),
  );
  const helper = new ComputerHelper({ connectTo: fake.socket });
  try {
    await assert.rejects(helper.start(), (e: any) => e.reason === 'unauthorized');
    assert.equal(helper.running, false);
    assert.deepEqual(await helper.call('apps.list'), { ok: true });
    assert.equal(fake.connections(), 2);
  } finally {
    helper.stop();
    await fake.close();
    fake.cleanup();
  }
});

test('the deny list survives a relaunch: kept while stopped, sent while running', async () => {
  const fake = await scriptedHelper(() => ({ result: { ok: true } }));
  const helper = new ComputerHelper({ connectTo: fake.socket, denyBundleIds: ['a.b'] });
  try {
    assert.equal(await helper.setDeny(['com.example.bank']), null);
    assert.deepEqual(helper.denyBundleIds, ['com.example.bank']);
    assert.equal(fake.connections(), 0);
    await helper.start();
    await helper.setDeny(['com.example.other']);
    assert.deepEqual(fake.log.at(-1), { method: 'deny.set', params: { bundleIds: withFloor(['com.example.other']) }, conn: 1 });
    assert.deepEqual(helper.denyBundleIds, ['com.example.other']);
  } finally {
    helper.stop();
    await fake.close();
    fake.cleanup();
  }
});

test('the launched helper (open -n -g through LaunchServices) is relaunched with a fresh token and the current deny list', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the launch path is macOS only');
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cuh-app-'));
  const launches: { config: any; fake: Awaited<ReturnType<typeof scriptedHelper>> }[] = [];
  // `open` stand-in: reads the launch config and starts a helper on its socket that checks the token
  const spawn = (cmd: string, args: string[]) => {
    assert.equal(cmd, '/usr/bin/open');
    const child: any = new EventEmitter();
    child.stderr = new EventEmitter();
    const config = JSON.parse(fs.readFileSync(args.at(-1)!, 'utf8'));
    scriptedHelper(
      () => ({ result: { ok: true } }),
      (_n, params) => (params.token === config.token ? { result: { pid: 3 } } : { error: { code: 1, message: 'bad token' } }),
      config.socket,
    ).then((fake) => {
      launches.push({ config, fake });
      child.emit('exit', 0);
    });
    return child;
  };
  const helper = new ComputerHelper({ appPath, spawn, denyBundleIds: ['a.b'] });
  try {
    assert.deepEqual(await helper.start(), { pid: 3 });
    const gone = exited(helper);
    launches[0].fake.kill();
    await gone;
    await helper.setDeny(['com.example.bank']);
    assert.deepEqual(await helper.call('apps.list'), { ok: true });
    assert.equal(launches.length, 2);
    assert.notEqual(launches[1].config.token, launches[0].config.token);
    assert.deepEqual(
      launches.map((l) => l.config.denyBundleIds),
      [withFloor(['a.b']), withFloor(['com.example.bank'])],
    );
  } finally {
    helper.stop();
    for (const l of launches) {
      await l.fake.close();
      l.fake.cleanup();
    }
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('a helper stopped between the launch check and the send: a read-only call goes to a relaunched one', async () => {
  const fake = await scriptedHelper(() => ({ result: { ok: true } }));
  const helper = new ComputerHelper({ connectTo: fake.socket });
  try {
    await helper.start();
    const p = helper.call('apps.list');
    helper.stop();
    assert.deepEqual(await p, { ok: true });
    assert.equal(fake.connections(), 2);
  } finally {
    helper.stop();
    await fake.close();
    fake.cleanup();
  }
});
