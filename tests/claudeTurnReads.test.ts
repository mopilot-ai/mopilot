// How main's readers take a Claude chat's turns from a read in the core (electron/harness/claude/turnReads.cjs): what a read that
// has left is worth, that a read nobody keeps always goes, and what a thread without the core says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTranscripts } = require('../electron/harness/claude/transcripts.cjs');
const { createTranscriptReader, createReadCache } = require('../electron/platform/claudeTranscriptRead.cjs');
const { createTurnsWorker } = require('../electron/platform/claudeTurnsWorker.cjs');
const { resourcesFrom } = require('../electron/platform/claudeTurnsWorkerMain.cjs');
const { openHistory, releaseHistory } = require('../electron/platform/claudeHistory.cjs');
const { core } = require('../electron/platform/core.cjs');

const SID = '00000000-0000-4000-8000-000000000001';
const messages = [
  { type: 'user', uuid: 'p1', timestamp: '2026-01-01T00:00:00Z', message: { content: 'one' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { id: 'm1', content: [{ type: 'text', text: 'ok' }] } },
];
const state: any = { sdk: async () => ({ getSessionMessages: async () => messages }), resumeAt: new Map() };
const read = () => openHistory(messages, 'chat', '/w', { key: SID });
/** Whether the core still holds read `id`: a release says so, and lets it go. */
const held = (id: number) => String(core().dispatchSync('translate.claudeRelease', Buffer.from(String(id)))) === 'true';
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a kept read that left the cache meanwhile is read again outside it, and one that keeps failing says the chat could not be read', async () => {
  const asks: any[] = [];
  const flighty = {
    read: async (req: any) => {
      asks.push(req);
      return asks.length === 1 ? { read: 987654321, kept: true } : { read: await read(), kept: false };
    },
  };
  const page = await createTranscripts(state, flighty).turns(SID, { chatId: 'chat' });
  assert.deepEqual(page.ids, ['h-p1']);
  assert.deepEqual(
    asks.map((req) => req.uncached),
    [undefined, true],
  );
  let asked = 0;
  const gone = { read: async () => (asked++, { read: 987654321, kept: true }) };
  await assert.rejects(
    createTranscripts(state, gone).turns(SID, {}),
    (e: any) => e.message === 'This Claude Code chat could not be read' && /no Claude history/.test(e.cause.message),
  );
  assert.equal(asked, 3);
});

test('a kept read is not handed back after it failed: the read again does not ask the cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-kept-'));
  const file = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(file, '{}\n');
  const reader = createTranscriptReader({ noteIgnored: () => {} });
  const cache = createReadCache();
  const sdk = { getSessionMessages: async () => messages };
  const req = { sessionId: SID, file, chatId: 'chat', cwd: '' };
  const kept = await reader.readTurnPage({ sdk, cache }, req);
  assert.equal(kept.kept, true);
  assert.deepEqual(await reader.readTurnPage({ sdk, cache }, req), kept);
  const own = await reader.readTurnPage({ sdk, cache }, { ...req, uncached: true });
  assert.equal(own.kept, false);
  assert.notEqual(own.read, kept.read);
  assert.equal(cache.size, 1);
  releaseHistory(own.read);
  assert.deepEqual(await reader.readTurnPage({ sdk, cache }, req), kept, 'and it pushes out nothing');
  releaseHistory(kept.read);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every turn is read outside the cache: a window reading the chat meanwhile cannot take a walk from under it', async () => {
  const asks: any[] = [];
  const worker = { read: async (req: any) => (asks.push(req), { read: await read(), kept: false }) };
  await createTranscripts(state, worker).allTurns(SID, { chatId: SID });
  assert.equal(asks[0].uncached, true);
});

test('a read nobody keeps that the worker took with it is read again', async () => {
  const dead = await read();
  releaseHistory(dead);
  const fresh = await read();
  const asks = [dead, fresh];
  const worker = { read: async () => ({ read: asks.shift(), kept: false }) };
  assert.deepEqual((await createTranscripts(state, worker).turns(SID, {})).ids, ['h-p1']);
  await settled();
  assert.equal(held(fresh), false);
});

test('a read nobody keeps goes when its page is cut, and when cutting it fails', async () => {
  const id = await read();
  const once = { read: async () => ({ read: id, kept: false }) };
  await createTranscripts(state, once).turns(SID, {});
  await settled();
  assert.equal(held(id), false);
  const failing = { read: async () => ({ read: 987654321, kept: false }) };
  await assert.rejects(createTranscripts(state, failing).turns(SID, {}), /could not be read/);
});

test('a read that a moved cutoff made stale goes too', async () => {
  const ids: number[] = [];
  const moving: any = { sdk: state.sdk, resumeAt: new Map() };
  let moves = 1;
  const worker = {
    read: async () => {
      const id = await read();
      ids.push(id);
      if (moves-- > 0) moving.resumeAt.set(`claude:${SID}`, 'a1');
      return { read: id, kept: false };
    },
  };
  await createTranscripts(moving, worker).turns(SID, {});
  await settled();
  assert.equal(ids.length, 2);
  assert.equal(held(ids[0]), false);
});

test("every turn, for main's own readers, and the window's page with what it takes from the app", async () => {
  const t = createTranscripts(state, null);
  assert.deepEqual(
    (await t.allTurns(SID, { open: true })).map((turn: any) => turn.id),
    ['h-p1'],
  );
  assert.deepEqual(
    (await t.allTurns(SID)).map((turn: any) => turn.id),
    ['h-p1'],
  );
  const pages = { liveTurn: () => null, diffs: (key: string, ids: string[]) => ({ [ids[0]]: key }) };
  assert.deepEqual((await t.windowPage(SID, { limit: 1 }, pages)).diffs, { 'h-p1': `claude:${SID}` });
  assert.deepEqual((await t.windowPage(SID, {})).diffs, {});
});

test('a thread that could not load the core says so, and its asker reads in main', async () => {
  const reader = createTranscriptReader({ noteIgnored: () => {}, threadCore: () => null });
  const sdk = { getSessionMessages: async () => messages };
  await assert.rejects(
    reader.readTurnPage({ sdk }, { sessionId: SID, file: null, chatId: 'chat', cwd: '' }),
    (e: any) => e.code === 'CORE_UNAVAILABLE',
  );
  const w: any = new EventEmitter();
  w.unref = () => {};
  let ended = 0;
  w.terminate = () => ended++;
  w.postMessage = () => {};
  const client = createTurnsWorker({ makeWorker: () => w });
  const asked = client.read({});
  w.emit('message', { id: 1, ok: false, error: new Error('no core'), code: 'CORE_UNAVAILABLE' });
  await assert.rejects(asked, (e: any) => e.workerDown === true);
  // what the SDK failed on says nothing of the core
  const failed = client.read({});
  w.emit('message', { id: 2, ok: false, error: new Error('bad session') });
  await assert.rejects(failed, /bad session/);
  // two of those and it goes, so that no read is parsed twice, and what it held is read in main
  const again = client.read({});
  const held = client.read({});
  w.emit('message', { id: 3, ok: false, error: new Error('no core'), code: 'CORE_UNAVAILABLE' });
  await assert.rejects(again, (e: any) => e.workerDown === true);
  await assert.rejects(held, (e: any) => e.workerDown === true && /has no core/.test(e.message));
  assert.equal(ended, 1);
  await assert.rejects(client.read({}), /not available/);
  client.close();
});

test("a worker finds the addon where main's process says, which its own may not know", () => {
  const worker: any = {};
  resourcesFrom({ resourcesPath: '/app/Resources' }, worker);
  assert.equal(worker.resourcesPath, '/app/Resources');
  resourcesFrom({ resourcesPath: '/elsewhere' }, worker);
  assert.equal(worker.resourcesPath, '/app/Resources', 'its own stands');
  const none: any = {};
  resourcesFrom(null, none);
  resourcesFrom({}, none);
  assert.deepEqual(none, {});
});
