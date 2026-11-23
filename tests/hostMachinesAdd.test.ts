// Adding a machine end to end in main's service (electron/host/machines.cjs): the default installer uploads the tarball built from the app's files over a fake channel, the machine is recorded with its socket, and it pairs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');

const ready = {
  harnesses: [{ id: 'claude', detected: true, signedIn: true }],
  capabilities: { iab: false, cu: false, bu: false, shell: true },
};
const dirOf = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test("the default installer uploads the tarball built from the app's files, records the machine with its socket, and pairs it (the whole add, end to end over a fake channel)", async (t) => {
  installFakeClock(t, 1_000_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put('host/package.json', JSON.stringify({ version: '0.0.9' }));
  put('host/bin/mopilot-host.mjs', 'export {};');
  put('build/vendor/host-core/linux-x64-gnu/mopilot_core.node', 'an addon');
  const dir = dirOf(t);
  const sent: Buffer[] = [];
  const status = { running: true, socketPath: '/home/u/host.sock', harnesses: ready.harnesses, capabilities: ready.capabilities };
  const channel = async (_d: string, command: string, input?: Buffer) => {
    let stdout = '';
    if (command === 'uname -sm') stdout = 'Linux x86_64';
    else if (command.includes('process.report')) stdout = 'linux-x64-gnu';
    else if (command.includes('echo have')) stdout = 'have';
    else if (command.includes('cat >')) input && sent.push(input);
    else if (command.includes('sha256sum')) stdout = (await import('node:crypto')).createHash('sha256').update(sent[0]).digest('hex');
    else if (command.includes('tar -xzf')) stdout = 'made=yes prev=';
    else if (command.includes(' status') && !command.includes('test -f')) stdout = JSON.stringify(status);
    else if (command.includes(' pair')) stdout = 'Pairing code: ABCD-EFGH-JKMN';
    return { code: 0, stdout, stderr: '' };
  };
  const calls: string[] = [];
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    root,
    channel,
    allowed: () => true,
    watch: () => undefined,
    call: async (_r: any, method: string) => {
      calls.push(method);
      if (method === 'host.challenge') return { nonce: 'n', hostId: 'abababababababababababababababab' };
      return method === 'status' ? ready : { fingerprint: 'f' };
    },
  });
  t.after(() => m.dispose());
  const out = await m.add('me@box');
  assert.deepEqual([out.ok, out.paired, out.error], [true, true, '']);
  assert.equal(sent.length, 1, 'the tarball went up once');
  assert.deepEqual(
    fs
      .readdirSync(path.join(dir, 'host-bundle', 'linux-x64-gnu'))
      .sort()
      .map((f) => f.replace(/-[0-9a-f]{12}/, '-SHA')),
    ['host-0.0.9-SHA.tgz', 'manifest.json'],
  );
  // the record carries the socket the Host reported: without it the heartbeat could never ask the machine
  assert.equal(fs.readFileSync(path.join(dir, 'host-registry.json'), 'utf8').includes('"socketPath": "/home/u/host.sock"'), true);
  // a second add reuses the build
  await m.add('me@box');
  assert.equal(fs.readdirSync(path.join(dir, 'host-bundle', 'linux-x64-gnu')).length, 2);
});
