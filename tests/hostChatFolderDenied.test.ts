// A chat's folder is never one of the Host's own (host/src/chatEffects.mjs, methods/commands.mjs, R2b of #5576): refused at `chat.start` before the chat keeps it, again at every `chat.send` (the one it kept included, looked at afresh), and for `host.commands`.
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
const CHAT = '019e0000-0000-7000-8000-000000000003';

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-folder-denied-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data');
  const work = path.join(dir, 'work');
  fs.mkdirSync(data);
  fs.mkdirSync(work);
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const sends: any[] = [];
  const prepared: any[] = [];
  const asked: any[] = [];
  /** the chats' own records of their folder: the first one a chat is given, as the runtime keeps it */
  const records = new Map<string, string>();
  const runtime: any = {
    host,
    send: async (p: any) => {
      sends.push(p);
      if (typeof p.cwd === 'string' && !records.has(p.key)) records.set(p.key, p.cwd);
      return { turnId: `t${sends.length}` };
    },
    prepare: async (p: any) => void prepared.push(p),
    folderOf: async (id: string) => records.get(id) ?? null,
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const hostFs = createHostFs({ roots: [dir], denied: [data] });
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    hostFs,
    status: () => ({ running: true }),
    existingFolder: (folder: string) => hostFs.existingDirectory(folder),
    commands: async (p: any) => (asked.push(p), { listed: true, commands: [] }),
  });
  const conn = protocol.connection(() => undefined);
  const ready = conn.call('host.hello', helloParams());
  const call = async (method: string, params: object) => (await ready, conn.call(method, params));
  return { dir, data, work, sends, prepared, asked, call, records };
}

const start = (cwd: string, n: number) => ({ chatId: CHAT, epoch: 1, harness: 'codex', text: 'go', cwd, key: key(n) });

test("a chat is not started in the Host's own folder, by name, link or a name that is not there; nothing is prepared or kept", async (t) => {
  const w = setup(t);
  fs.symlinkSync(w.data, path.join(w.work, 'link'));
  for (const [n, cwd] of [w.data, path.join(w.work, 'link'), path.join(w.data, 'nothing')].entries()) {
    await assert.rejects(w.call('chat.start', start(cwd, n + 1)), { code: 'outside_roots' }, cwd);
  }
  assert.deepEqual(w.prepared, [], 'the chat kept no folder');
  assert.deepEqual(w.sends, []);
  await w.call('chat.start', start(w.work, 9));
  assert.equal(w.prepared.length, 1);
  assert.equal((w.sends[0] as any).cwd, w.work);
});

test("the folder a message runs in is asked of the chat's own record every time: a folder that became a link into the Host's own is refused, for any number of chats", async (t) => {
  const w = setup(t);
  const proj = path.join(w.work, 'proj');
  fs.mkdirSync(proj);
  await w.call('chat.send', { chatId: 'claude:c1', epoch: 1, key: key(1), text: 'a', cwd: proj });
  for (let i = 0; i < 2100; i++) await w.call('chat.send', { chatId: `claude:b${i}`, epoch: 1, key: key(i + 10), text: 'x', cwd: w.work });
  fs.rmSync(proj, { recursive: true });
  fs.symlinkSync(w.data, proj);
  await assert.rejects(w.call('chat.send', { chatId: 'claude:c1', epoch: 1, key: key(5000), text: 'again' }), { code: 'outside_roots' });
  const before = w.sends.length;
  assert.equal(before, 2101, 'nothing reached the agent after the swap');
  // another chat, in a folder that is fine, is not held by this one
  await w.call('chat.send', { chatId: 'claude:c2', epoch: 1, key: key(5001), text: 'ok', cwd: w.work });
  assert.equal(w.sends.length, before + 1);
});

test("a side chat runs in its parent's folder: that folder is looked at as the chat's own is, and a chat the runtime has no record of is not held", async () => {
  const { chatFoldersOf } = await import('../host/src/chatFolders.mjs');
  const runtime = { folderOf: async (id: string) => ({ parent: '/p', own: '/o' })[id as 'parent' | 'own'] ?? null };
  assert.deepEqual(await chatFoldersOf(runtime, { chatId: 'own', sideChat: { sourceId: 'parent' } }), ['/o', '/p']);
  assert.deepEqual(await chatFoldersOf(runtime, { chatId: 'side', sideChat: { sourceId: 'parent' } }), ['/p']);
  assert.deepEqual(await chatFoldersOf(runtime, { chatId: 'side', cwd: '/named', sideChat: { sourceId: 'parent' } }), ['/named', '/p']);
  assert.deepEqual(await chatFoldersOf(runtime, { chatId: 'new' }), []);
  assert.deepEqual(
    await chatFoldersOf({}, { chatId: 'x', sideChat: { sourceId: 'y' } }),
    [],
    'a runtime that keeps no folders has none to look at',
  );
});

test("host.commands lists for a folder the Host shares and never one of its own; a folder that is not there lists the agent's own", async (t) => {
  const w = setup(t);
  await w.call('host.commands', { harness: 'claude', cwd: w.work });
  await assert.rejects(w.call('host.commands', { harness: 'claude', cwd: w.data }), { code: 'outside_roots' });
  await assert.rejects(w.call('host.commands', { harness: 'claude', cwd: path.join(w.data, 'nothing') }), { code: 'outside_roots' });
  await w.call('host.commands', { harness: 'claude', cwd: path.join(w.work, 'not-made') });
  await w.call('host.commands', { harness: 'codex' });
  assert.deepEqual(w.asked, [{ harness: 'claude', cwd: w.work }, { harness: 'claude' }, { harness: 'codex' }]);
});
