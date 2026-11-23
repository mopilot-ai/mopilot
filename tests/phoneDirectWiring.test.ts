// The Mac side of direct access as main wires it (electron/app/ipc/host.cjs, hostPhone.cjs): the courier reaches the phone facade,
// and the owner's switch (host:phoneDirectList / host:phoneDirectSet) offers, lists and takes access away, behind the flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const flags = require('../electron/platform/flags.cjs');

function wire(on: boolean, chat = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-wire-'));
  flags.initFlags({
    file: path.join(dir, 'flags.json'),
    url: 'http://127.0.0.1:9/api/flags',
    channel: () => 'stable',
    version: '0.0.0',
    fetch: async () => {
      throw new Error('offline');
    },
    override: { 'host.phoneDirect': on, 'host.phoneChat': chat },
  });
  const handlers = new Map<string, any>();
  const live: any = { chromePanel: { service: { onMachinesChanged: () => void changed++ } } };
  let changed = 0;
  let machinesOpts: any;
  const forgot: string[] = [];
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      app: { getPath: () => dir },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll() {},
      live,
    },
    {
      create: (o: any) => (
        (machinesOpts = o),
        {
          list: () => ({ machines: [], resolved: true }),
          row: () => undefined,
          pairedFor: async () => ({ call: async (m: string) => (forgot.push(m), {}), close() {} }),
          onRowChange: () => () => undefined,
        }
      ),
      createFolders: () => ({}),
      allowed: () => true,
    },
  );
  return { live, handlers, dir, changed: () => changed, forgot, machinesOpts: () => machinesOpts };
}

test('the switch offers a phone, lists it and takes it away; the phone facade carries the courier', async () => {
  const w = wire(true);
  assert.deepEqual(await w.handlers.get('host:phoneDirectSet')!({}, 'ssh:box', 'pair1', true), { value: undefined });
  assert.equal(w.changed(), 1, 'phones hear the machine list again');
  assert.deepEqual(await w.handlers.get('host:phoneDirectList')!({}, 'ssh:box'), {
    value: [{ pairId: 'pair1', fingerprint: null, state: 'offered' }],
  });
  await w.handlers.get('host:phoneDirectSet')!({}, 'ssh:box', 'pair1', false);
  assert.deepEqual(await w.handlers.get('host:phoneDirectList')!({}, 'ssh:box'), { value: [] });
  assert.equal(w.changed(), 2);
});

test('the courier on the phone facade reaches the machine through a paired connection', async () => {
  const w = wire(true);
  await assert.rejects(w.live.hostPhone.phoneDirect.enroll('ssh:box', 'pair1', {}, 'box'), (e: any) => e.code === 'update_host');
  assert.deepEqual(w.forgot, ['host.hello']);
});

test('the phone facade tells a phone it may follow a machine’s chat itself only with the gate and host.phoneChat on', () => {
  assert.equal(wire(true, true).live.hostPhone.phoneChat.enabled(), true);
  assert.equal(wire(true, false).live.hostPhone.phoneChat.enabled(), false, 'the flag is off');
});

test('with the flag off the switch refuses', async () => {
  const w = wire(false);
  const answer = await w.handlers.get('host:phoneDirectSet')!({}, 'ssh:box', 'pair1', true);
  assert.equal(answer.error?.code ?? answer.code, 'not_allowed');
});

test('pairedFor: a paired connection to a listed machine for one exchange, refused for a stranger or a closed gate', async (t) => {
  const { createMachines } = require('../electron/host/machines.cjs');
  const { createRegistry } = require('../electron/host/registry.cjs');
  const { useFakeClock } = require('./support/ports/clock.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-for-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  useFakeClock(t, 1_000_000);
  let open = true;
  let closed = 0;
  const call = async () => ({});
  const registry = createRegistry({ file: path.join(dir, 'host-registry.json'), status: call });
  const m = createMachines({
    dir,
    root: dir,
    allowed: () => open,
    watch: () => undefined,
    call,
    onChange: () => undefined,
    onStep: () => undefined,
    installer: { install: async () => ({ ok: true }) },
    registry,
    session: async (record: any) => ({ call: async (method: string) => `${record.id}:${method}`, close: () => void closed++ }),
  });
  t.after(() => m.dispose());
  registry.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/s' });
  const s = await m.pairedFor('h1');
  assert.equal(await s.call('host.hello'), 'h1:host.hello');
  s.close();
  assert.equal(closed, 1);
  assert.throws(
    () => m.pairedFor('nope'),
    (e: any) => e.code === 'unknown_machine',
  );
  open = false;
  assert.throws(
    () => m.pairedFor('h1'),
    (e: any) => e.code === 'not_allowed',
  );
});
