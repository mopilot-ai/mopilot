// One status, however it is asked (host/src/cli.mjs serve, host/src/server.mjs): the line `status` the CLI and the app's heartbeat use and the protocol's `host.status` answer the same capabilities, so a Host that can run a browser says so to the app that decides which tools a chat gets (package 2.6).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';
// @ts-ignore: plain ESM without declarations
import { helloParams } from '../shared/host/schema.mjs';
// @ts-ignore: plain ESM without declarations
import { callHost, startServer } from '../host/src/server.mjs';
import { line } from './support/host-line.ts';
import { waitFor } from './support/waitFor.ts';
import { keySafe } from './support/hostKeySafe.ts';

const { loadIdentity, pairWith } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-status-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;

/** Runs `serve` in-process with `env` and asks it for its status both ways, then stops it; the Local Network check is a stand-in, so no test knocks on a real router. */
async function statuses(env: NodeJS.ProcessEnv, localNetwork = async (): Promise<'denied'> => 'denied') {
  const dir = path.join(base, `s${n++}`);
  const signals = new EventEmitter() as unknown as NodeJS.Process;
  const printed: string[] = [];
  const done = main(['serve', '--data-dir', dir], {
    env,
    signals,
    out: (l: string) => printed.push(l),
    err: () => {},
    localNetwork,
  });
  const paths = createPaths({ dataDir: dir, env: {} });
  await waitFor(() => printed.some((l) => l.startsWith('Pairing code: ')), 'the pairing code to print');
  const conn = line(paths.socketPath);
  try {
    await pairWith(
      conn.request,
      loadIdentity(path.join(base, `app${n}.json`), keySafe),
      printed.find((l) => l.startsWith('Pairing code: '))?.slice(14),
    );
    const legacy = (await conn.call('status', {})).result;
    await conn.call('host.hello', helloParams());
    const wire = (await conn.call('host.status', {})).result;
    return { legacy, wire };
  } finally {
    conn.close();
    signals.emit('SIGTERM');
    await done;
  }
}

test('I: a Host that can run a browser says so in the line status too, which is the one the app’s heartbeat reads', async () => {
  const chrome = process.execPath;
  const { legacy, wire } = await statuses({ MOPILOT_HOST_CHROME: chrome });
  assert.equal(wire.capabilities.iab, true);
  assert.deepEqual(legacy.capabilities, wire.capabilities);
  // the Host's reach into the local network rides the same status (host/src/localNetwork.mjs)
  assert.equal(legacy.localNetwork, 'denied');
  assert.equal(wire.localNetwork, 'denied');
  // a Host with no phone linked says so, so a card it cannot push is not a silent one (#4721)
  assert.deepEqual(legacy.push, { phones: 0, skipped: 0, lastSkippedAt: null });
  assert.deepEqual(wire.push, legacy.push);
});

test('I: a Host with no browser and no way to get one says so both ways', async () => {
  const { legacy, wire } = await statuses({ MOPILOT_HOST_CHROME: path.join(base, 'no-such-chrome'), MOPILOT_HOST_BROWSER_DOWNLOAD: '0' });
  assert.equal(wire.capabilities.iab, false);
  assert.deepEqual(legacy.capabilities, wire.capabilities);
});

test('I: a Host that can fetch its own headless shell counts as able to run a browser, both ways', async () => {
  const { legacy, wire } = await statuses({ MOPILOT_HOST_CHROME: path.join(base, 'no-such-chrome') });
  // platformKey is known on the platforms the Host runs on
  assert.equal(wire.capabilities.iab, true);
  assert.deepEqual(legacy.capabilities, wire.capabilities);
});

test('a server with no protocol (the line protocol alone) answers a plain status of its own, with the harnesses it was given', async () => {
  const paths = createPaths({ dataDir: path.join(base, `s${n++}`), env: {} });
  const server = await startServer({ paths, harnesses: async () => [{ id: 'fake', detected: true, signedIn: false }], updateKey: true });
  try {
    const status = ((await callHost(paths.socketPath, 'status')) as any).result;
    assert.equal(status.running, true);
    assert.deepEqual(status.harnesses, [{ id: 'fake', detected: true, signedIn: false }]);
    assert.equal(status.capabilities.iab, false, 'a server with no browser service cannot run a browser');
    assert.equal(status.localNetwork, 'unknown', 'nor say anything of the local network');
  } finally {
    await server.close();
  }
});
