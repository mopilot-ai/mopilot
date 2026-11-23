// Host phone admission contracts under changing ownership and precise/legacy transcript identities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';
const require = createRequire(import.meta.url);
const { createSendChecks } = require('../electron/host/remoteSendChecks.cjs');
const { createStartPairs } = require('../electron/host/turnStartPairs.cjs');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('ownership changing during folder validation discards the old verdict and checks the current cwd', async () => {
  let owner = { hostId: 'old', epoch: 1, folder: '/old' };
  const old = deferred();
  const entered = deferred();
  const asked: string[] = [];
  const checks = createSendChecks({
    ownerOf: () => owner,
    checkFolder: async (host: string, folder: string) => {
      asked.push(`${host}:${folder}`);
      if (host === 'old') {
        entered.resolve();
        await old.promise;
      }
    },
  });
  const pending = checks.validate({ chatId: 'chat', key: 'input', options: { requiresFolderCheck: true } });
  await entered.promise;
  owner = { hostId: 'new', epoch: 2, folder: '/new' };
  old.resolve();
  await pending;
  assert.deepEqual(asked, ['old:/old', 'new:/new']);
});

test('sent input lookup prefers an exact key and falls back only for a legacy turn id', async (t) => {
  const w = world(t);
  w.remote('c1');
  await w.service.send('c1', msg('first', UUID(1)));
  await w.service.send('c1', msg('second', UUID(2)));
  assert.equal(w.service.sent.take('c1', UUID(2)), 'second');
  assert.equal(w.service.sent.take('c1', 'native-old-host'), 'first');
  assert.equal(w.service.sent.take('no-chat', UUID(2)), undefined);
  w.service.sent.seen('no-chat', 'second', UUID(2));
  assert.deepEqual(
    w.queues.get('c1')!.map((q) => q.id),
    [UUID(1), UUID(2)],
  );
});

test('bare autonomous turns have no sent fallback, while a keyed turn retains its message key', () => {
  const standalone = createStartPairs();
  standalone.take(null, { kind: 'turnStart', turnId: 'autonomous' });
  assert.deepEqual(standalone.take(null, { kind: 'update', turnId: 'autonomous' })[0].user.content, []);
  const keys: unknown[] = [];
  const pairs = createStartPairs({ unasked: (key: string) => (keys.push(key), 'sent') });
  pairs.take(null, { kind: 'turnStart', turnId: 'keyed', messageKey: UUID(3) });
  const result = pairs.take(null, { kind: 'update', turnId: 'keyed' });
  assert.deepEqual(keys, [UUID(3)]);
  assert.equal(result[0].user.messageKey, UUID(3));
  assert.equal(result[0].user.content[0].text, 'sent');
  const explicit = { kind: 'turnStart', turnId: 'native', user: { clientId: UUID(4), content: [{ type: 'text', text: 'host input' }] } };
  assert.deepEqual(pairs.take(null, explicit), [explicit]);
  assert.deepEqual(keys, [UUID(3)], 'a Host-provided user never consumes a different queued fallback');
});
