// Corrupt ItemsLog records stay out of history; fixture teardown drains queued writes before removing their directory.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptFixture } from './support/transcript-fixture.ts';

const require = createRequire(import.meta.url);
const { ItemsLog } = require('../electron/platform/itemsLog.cjs');

function fixture(t: TestContext) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'items-corruption-'));
  const owner = transcriptFixture(d);
  const log = owner.own(new ItemsLog(path.join(d, 'items')));
  t.after(() => owner.cleanup());
  return { d, log, stopWith: owner.stopWith };
}

test("ItemsLog: torn lines are skipped and counted once per read, without the chat's text", async (t) => {
  const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
  const { d, log } = fixture(t);
  clearIgnored();
  assert.deepEqual(await log.readAsync('none'), []);
  assert.deepEqual(recentIgnored(), [], 'no transcript yet is not a failure');
  log.append('c1', { text: 'first' });
  fs.appendFileSync(path.join(d, 'items', 'c1.items.jsonl'), '{"text": "private wor\n');
  log.append('c1', { text: 'second' });
  assert.deepEqual(await log.readAsync('c1'), [{ text: 'first' }, { text: 'second' }]);
  fs.appendFileSync(path.join(d, 'items', 'c1.items.jsonl'), 'garbage\n');
  await log.readAsync('c1');
  assert.deepEqual(
    recentIgnored().map((e: any) => e.message),
    ['1 unreadable line skipped', '2 unreadable lines skipped'],
  );
  assert.ok(!JSON.stringify(recentIgnored()).includes('private'));
  // a transcript that exists but can't be read is recorded, and reads as no items
  clearIgnored();
  fs.mkdirSync(path.join(d, 'items', 'c2.items.jsonl'));
  assert.deepEqual(await log.readAsync('c2'), []);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ["read a chat's transcript"],
  );
});

test('ItemsLog skips non-object JSON without breaking ACP history consumers', async (t) => {
  const { log, stopWith } = fixture(t);
  const id = 'acp:fake:1';
  const session = { t: 'session', sessionId: 'native', cwd: '/repo', at: 42 };
  const user = { t: 'user', user: { content: [{ type: 'text', text: 'hello' }] } };
  log.append(id, session);
  const nonRecords = ['null', '[]', '1', 'true', '"text"'];
  fs.appendFileSync(log.file(id), nonRecords.join('\n') + '\n');
  log.append(id, user);
  fs.appendFileSync(log.file(id), 'null\n');
  const { AcpHost } = require('../electron/harness/acp.cjs');
  const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
  clearIgnored();
  const host = new AcpHost({ items: log, quirks: () => null, resolveBin: () => null });
  stopWith(() => host.closeAll());
  assert.deepEqual(await host.lastSession(id), session);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.message),
    ['6 unreadable lines skipped'],
  );
  assert.deepEqual(await log.readAsync(id), [session, user]);
  assert.deepEqual(await host.history(id), [session, user]);
  assert.deepEqual(
    (await host.list()).map((r: any) => [r.id, r.cwd, r.preview]),
    [[id, '/repo', 'hello']],
  );
  assert.deepEqual(
    (await host.search('hello')).map((r: any) => r.id),
    [id],
  );
});
