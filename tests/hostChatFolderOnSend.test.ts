// The Host checks a chat's folder on `chat.send` (host/src/chatEffects.mjs), before anything is taken and before the agent starts: a folder that is gone is refused with the sentence a chat on this Mac gets, a folder that comes back makes the same message go, and any other fault of the path keeps the Host's own words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';

const quiet = { report: () => undefined };
const key = (n: number) => `key-${String(n).padStart(8, '0')}`;

function setup(t: { after: (fn: () => void) => void }, o: { withCheck?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-folder-send-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const sends: any[] = [];
  const runtime: any = { host, send: async (p: any) => (sends.push(p), { turnId: `t${sends.length}` }), prepare: async () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const hostFs = createHostFs({ roots: [dir] });
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    status: () => ({ running: true }),
    ...(o.withCheck === false ? {} : { existingFolder: (folder: string) => hostFs.existingDirectory(folder) }),
  });
  const conn = protocol.connection(() => undefined);
  const ready = conn.call('host.hello', helloParams());
  const send = async (params: object, n = 1) => (
    await ready, conn.call('chat.send', { chatId: 'claude:c1', epoch: 1, key: key(n), text: 'go', ...params })
  );
  return { dir, sends, send };
}

test('a folder that is there lets the message go, with the folder; a message that names none is not checked', async (t) => {
  const w = setup(t);
  const folder = fs.mkdtempSync(path.join(w.dir, 'proj-'));
  await w.send({ cwd: folder }, 1);
  await w.send({}, 2);
  assert.deepEqual(
    w.sends.map((s) => s.cwd),
    [folder, undefined],
  );
});

test('a folder that is gone is refused before the agent starts, in the words a chat on this Mac gets; the folder coming back lets the same message go once', async (t) => {
  const w = setup(t);
  const folder = path.join(w.dir, 'gone-proj');
  const error: any = await w.send({ cwd: folder }, 3).catch((e) => e);
  assert.equal(error.code, 'directory_missing');
  assert.equal(
    error.message,
    `This chat's folder no longer exists on this host: ${JSON.stringify(folder)}. Restore the folder, or continue in a new chat.`,
  );
  assert.deepEqual(w.sends, [], 'nothing reached the agent');
  // the cause is gone: the same key is run again (it was refused before anything was done), not answered with the refusal again
  fs.mkdirSync(folder);
  await w.send({ cwd: folder }, 3);
  assert.equal(w.sends.length, 1);
});

test('any other fault of the path keeps the Host’s own words: a path that is not absolute, a file', async (t) => {
  const w = setup(t);
  const file = path.join(w.dir, 'a-file');
  fs.writeFileSync(file, '');
  const relative: any = await w.send({ cwd: 'proj' }, 4).catch((e) => e);
  assert.deepEqual([relative.code, relative.message], ['invalid_path', 'Pick a folder by its full path.']);
  const notAFolder: any = await w.send({ cwd: file }, 5).catch((e) => e);
  assert.deepEqual([notAFolder.code, notAFolder.message], ['not_a_directory', 'That is not a folder.']);
  assert.deepEqual(w.sends, []);
});

test('a Host built with no folder check (an older wiring) sends as it did', async (t) => {
  const w = setup(t, { withCheck: false });
  await w.send({ cwd: path.join(w.dir, 'never-made') }, 6);
  assert.equal(w.sends.length, 1);
});
