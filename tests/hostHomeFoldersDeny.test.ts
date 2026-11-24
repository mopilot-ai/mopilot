// The home link's own files sit in the Host's config folder, which the Host's folder deny list closes to every request (host/src/hostFs.mjs `hostFolders`): a remote kind cannot read the marker key or the lease floor through the Host's files, while a MoMo task's folder beside the data folder stays a place a chat may run in. The gate reads its own files with fs directly (host/src/homeGate.mjs, homeGateParts.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostFs, hostFolders } from '../host/src/hostFs.mjs';
// @ts-ignore
import { createHostFiles } from '../host/src/hostFiles.mjs';
// @ts-ignore
import { createHomeGate } from '../host/src/homeGate.mjs';
import { tmpDir } from './support/hostClientsWorld.ts';

process.env.MOPILOT_MOMO_HOST_LINK = '1';

test('the marker key and the lease floor are closed to a Host file request, the task folders are not, and the gate still reads and writes its own files', async (t) => {
  const home = fs.realpathSync(tmpDir(t));
  const dataDir = path.join(home, 'Library', 'Application Support', 'mopilot-host');
  const configDir = path.join(home, '.config', 'mopilot-host');
  const work = `${dataDir}-momo-tasks`;
  const socketPath = path.join(dataDir, 'host.sock');
  const hostFs = createHostFs({ roots: [home], home, denied: hostFolders({ dataDir, configDir, socketPath }, home) });
  const files = createHostFiles({ hostFs });
  const gate = createHomeGate({
    configDir,
    workDir: work,
    knows: () => true,
    known: () => false,
    stop: async () => undefined,
    report: () => undefined,
    now: () => 5,
    cap: 1000,
    enabled: () => true,
    active: () => false,
    modeOf: () => undefined,
    settleMs: 0,
  });
  const chatId = 'claude:99999999-9999-4999-8999-999999999999';
  const home1 = { fingerprint: 'a'.repeat(64), name: 'MoMo', kind: 'home' };
  const params = await gate.admit(home1, 'chat.start', {
    chatId,
    epoch: 1,
    key: 'key-00000001',
    text: 't',
    harness: 'claude',
    permission: 'default',
    home: { homeId: 'home-a', leaseEpoch: 2 },
  });
  await gate.successor('b'.repeat(64), undefined);
  // the gate's own files exist, written by the gate itself
  for (const f of ['home-link.json', 'home-floor.json', 'home-marker.key']) assert.ok(fs.existsSync(path.join(configDir, f)), f);
  const refused = { code: 'outside_roots' };
  for (const f of ['home-link.json', 'home-floor.json', 'home-marker.key'])
    await assert.rejects(files.read({ path: path.join(configDir, f) }), refused, f);
  await assert.rejects(hostFs.existingDirectory(configDir), refused);
  // the folder a task runs in is beside the data folder, not inside it: a chat may run there
  assert.equal(await hostFs.existingDirectory(params.cwd), fs.realpathSync(params.cwd));
});
