// Add by command joined to the machines list (electron/host/machineBoot.cjs) and the Host's `enroll` command (host/src/cli.mjs): Allow
// lists the machine at once as `relay:<id>`, pairs with it once its service is up (trying again meanwhile) and replaces the credential
// that travelled in the script; an app without a relay says so; the CLI takes its input on standard input only and never repeats it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { main } from '../host/src/cli.mjs';
import { EnrollError } from '../host/src/relayEnroll.mjs';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createMachineBoot } = require('../electron/host/machineBoot.cjs');
const { generateKeyPairSync } = require('node:crypto');

const updateKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

test('Allow lists the machine at once, pairs once its service is up, then replaces the credential from the script', async () => {
  const rows: any[] = [];
  const calls: string[] = [];
  let pairTries = 0;
  const enrolled: any[] = [];
  const relay: any = {
    lane: {},
    url: () => 'wss://r/v1/ws',
    adopt: () => undefined,
    enroll: async (address: string, call: any, wanted: () => boolean) => {
      await call('host.relayEnroll', {});
      enrolled.push([address, wanted()]);
    },
  };
  let made: any = null;
  const boot: any = {
    view: { state: 'asking' },
    start: async () => boot.view,
    allow: () => ({
      destination: 'relay:h_1',
      name: 'far-box',
      socketPath: '/h/host.sock',
      hostKey: 'k',
      pairingCode: 'ABCD-EFGH-JKMN',
      hostId: 'h_1',
    }),
    deny: () => (boot.denied = true),
    dispose: () => (boot.disposed = true),
  };
  const m = createMachineBoot({
    relay,
    registry: { add: (r: any) => rows.push(r), list: () => rows },
    bundle: () => ({ file: '/x', sha256: '0', version: '1' }),
    updateKey: () => updateKey,
    pair: async (id: string, code: string) => {
      calls.push(`pair ${id} ${code}`);
      if (++pairTries < 3) throw new Error('not up yet');
    },
    openPaired: async () => ({ call: async (method: string) => (calls.push(method), null), close: () => calls.push('close') }),
    sleep: async () => undefined,
    makeBoot: (o: any) => ((made = o), boot),
  });
  assert.deepEqual(m.view(), { state: 'idle', command: '', expiresAt: 0, machine: null, error: '' });
  await m.start();
  assert.match(made.updateKeyPem(), /BEGIN PUBLIC KEY/);
  assert.equal(made.url(), 'wss://r/v1/ws');
  assert.equal(m.view().state, 'asking');
  assert.deepEqual(m.allow(), { id: 'relay:h_1' });
  assert.deepEqual(rows, [{ id: 'relay:h_1', name: 'far-box', address: 'relay:h_1', socketPath: '/h/host.sock' }]);
  await waitFor(() => enrolled.length, 'relay enrollment');
  assert.equal(pairTries, 3, 'paired once its service answered');
  assert.deepEqual(calls.slice(-3), ['host.hello', 'host.relayEnroll', 'close']);
  assert.deepEqual(enrolled, [['relay:h_1', true]]);
  m.deny();
  m.dispose();
  assert.equal(boot.denied, true);
  assert.equal(boot.disposed, true);
});

test('a machine that never comes up stays listed and is given up after the join window; one removed meanwhile is left alone', async (t) => {
  const { useFakeClock } = await import('./support/ports/clock.ts');
  const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');
  const clock: any = useFakeClock(t, 0);
  const rows: any[] = [];
  const boot: any = {
    view: {},
    start: async () => ({}),
    allow: () => ({ destination: 'relay:h_2', name: '', socketPath: '', hostKey: '', pairingCode: 'c', hostId: 'h_2' }),
    dispose: () => undefined,
  };
  let tries = 0;
  clearIgnored();
  const failing = createMachineBoot({
    relay: { lane: {}, url: () => 'u', adopt: () => undefined, enroll: async () => assert.fail('never enrolled') } as any,
    registry: { add: (r: any) => rows.push(r), list: () => rows },
    bundle: () => ({ file: '/x', sha256: '0', version: '1' }),
    updateKey: () => updateKey,
    pair: async () => {
      tries++;
      throw new Error('never up');
    },
    openPaired: async () => assert.fail('never opened'),
    sleep: async (ms: number) => clock.advance(ms),
    makeBoot: () => boot,
  });
  failing.allow();
  assert.equal(rows.length, 1, 'listed at once');
  await waitFor(() => recentIgnored().length, 'an ignored-error record');
  assert.match(String(recentIgnored().at(-1)?.message), /never up/);
  assert.equal(tries, 41, 'tried every 3 s for two minutes');
  // paired, but removed before the credential was replaced: nothing more is done
  const gone: any[] = [];
  const removed = createMachineBoot({
    relay: { lane: {}, url: () => 'u', adopt: () => undefined, enroll: async () => assert.fail('never enrolled') } as any,
    registry: { add: (r: any) => gone.push(r), list: () => [] },
    bundle: () => ({ file: '/x', sha256: '0', version: '1' }),
    updateKey: () => updateKey,
    pair: async () => undefined,
    openPaired: async () => assert.fail('never opened'),
    makeBoot: () => boot,
  });
  removed.allow();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
});

test('without a relay there is no command; with one, allow lists and joins the machine', async () => {
  const none = createMachineBoot({
    relay: null,
    registry: { add: () => undefined, list: () => [] },
    bundle: () => ({ file: '/x', sha256: '0', version: '1' }),
    updateKey: () => updateKey,
    pair: async () => undefined,
    openPaired: async () => ({ call: async () => null, close: () => undefined }),
  });
  assert.throws(
    () => none.start(),
    (e: any) => e.code === 'no_relay',
  );
  assert.equal(none.deny(), undefined);
  none.dispose();
});

test('the CLI: enroll reads its input on standard input, says it joined, and refuses bad input without repeating it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-enroll-'));
  const lines: string[] = [];
  const io = (input: string | null, joinRelay: any) => ({
    out: (l: string) => lines.push(`out ${l}`),
    err: (l: string) => lines.push(`err ${l}`),
    env: { MOPILOT_HOST_DATA: dir, HOME: dir },
    stdin: input === null ? null : (Readable.from([Buffer.from(input)]) as any),
    joinRelay,
  });
  const good = JSON.stringify({
    relayUrl: 'wss://relay.example/v1/ws',
    hostId: 'h_host0000000000001',
    secret: 'S'.repeat(43),
    pairId: 'p_hostpair01',
    code: 'C'.repeat(22),
  });
  let given: any = null;
  assert.equal(await main(['enroll', '--data-dir', dir], io(good, async (o: any) => ((given = o), { hostId: o.input.hostId })) as any), 0);
  assert.equal(given.input.code, 'C'.repeat(22));
  assert.equal(lines.at(-1), 'out This machine joined MoPilot.');
  assert.equal(await main(['enroll', '--data-dir', dir], io('junk', async () => null) as any), 1);
  assert.equal(lines.at(-1), 'err MoPilot: Run the whole command MoPilot showed.');
  assert.equal(await main(['enroll', '--data-dir', dir], io(null, async () => null) as any), 1);
  assert.equal(
    await main(
      ['enroll', '--data-dir', dir],
      io(good, async () => Promise.reject(new EnrollError('denied', 'MoPilot did not allow this machine.'))) as any,
    ),
    1,
  );
  assert.equal(lines.at(-1), 'err MoPilot: MoPilot did not allow this machine.');
  assert.equal(
    await main(['enroll', '--data-dir', dir], io(good, async () => Promise.reject(new Error(`boom ${'S'.repeat(43)}`))) as any),
    1,
  );
  assert.equal(lines.at(-1), 'err MoPilot: This machine could not join MoPilot.');
  assert.ok(
    lines.every((l) => !l.includes('C'.repeat(22)) && !l.includes('S'.repeat(43))),
    'neither the code nor the credential is printed',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the defaults: no view listener, and a real wait between tries', async (t) => {
  const { useFakeClock } = await import('./support/ports/clock.ts');
  const clock: any = useFakeClock(t, 0);
  const rows: any[] = [];
  let made: any = null;
  let tries = 0;
  const boot: any = {
    view: {},
    start: async () => ({}),
    allow: () => ({ destination: 'relay:h_3', name: 'n', socketPath: '', hostKey: '', pairingCode: 'c', hostId: 'h_3' }),
    dispose: () => undefined,
  };
  const m = createMachineBoot({
    relay: { lane: {}, url: () => 'u', adopt: () => undefined, enroll: async () => undefined } as any,
    registry: { add: (r: any) => rows.push(r), list: () => rows },
    bundle: () => ({ file: '/x', sha256: '0', version: '1' }),
    updateKey: () => updateKey,
    pair: async () => {
      if (++tries === 1) throw new Error('not yet');
    },
    openPaired: async () => ({ call: async () => null, close: () => undefined }),
    makeBoot: (o: any) => ((made = o), boot),
  });
  await m.start();
  made.onChange({ state: 'waiting' });
  m.allow();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  clock.advance(3000);
  await waitFor(() => !(tries < 2), 'a second pairing try');
  assert.equal(tries, 2, 'tried again after the wait');
});
