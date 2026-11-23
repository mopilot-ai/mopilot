// The wire for a continue (shared/host/schema.mjs chat.prepareContinue, chat.commitContinue, chat.release): what each request must carry, B1-B3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../shared/host/schema.mjs');

const key = 'req-0000001';
const prepare = { chatId: 'claude:abc', epoch: 4, key, harness: 'acp:gemini', cwd: '/w', handoff: 'history' };
const commit = { chatId: 'claude:abc', expectedEpoch: 3, targetHostId: 'host-b', preparedId: 'prepared-0001' };
const release = { chatId: 'claude:abc', epoch: 4, preparedId: 'prepared-0001' };
const invalid = (m: string, p: unknown) =>
  assert.throws(
    () => S.parseParams(m, p),
    (e: any) => e instanceof S.SchemaError && e.code === 'invalid',
  );

test('a valid prepare, commit and release parse to exactly their fields; extra fields are dropped (B3)', () => {
  assert.deepEqual(S.parseParams('chat.prepareContinue', { ...prepare, extra: 1 }), prepare);
  assert.deepEqual(S.parseParams('chat.commitContinue', { ...commit, key, epoch: 9, extra: 1 }), commit);
  assert.deepEqual(S.parseParams('chat.release', { ...release, key, extra: 1 }), release);
});

test('B1: every required field is refused when absent, field by field', () => {
  for (const [m, valid] of [
    ['chat.prepareContinue', prepare],
    ['chat.commitContinue', commit],
    ['chat.release', release],
  ] as const)
    for (const field of Object.keys(valid)) {
      const { [field]: _drop, ...rest } = valid as Record<string, unknown>;
      invalid(m, rest);
    }
});

test('B2: wrong types and ranges never become a continue', () => {
  for (const handoff of ['', '   ', 5, null, 'x'.repeat(4 * 1024 * 1024 + 1)]) invalid('chat.prepareContinue', { ...prepare, handoff });
  for (const harness of ['gemini', 5, '']) invalid('chat.prepareContinue', { ...prepare, harness });
  for (const cwd of ['', 'a\0b', 5]) invalid('chat.prepareContinue', { ...prepare, cwd });
  for (const expectedEpoch of ['3', -1, 1.5, null]) invalid('chat.commitContinue', { ...commit, expectedEpoch });
  // the ids the registry gives machines (`ssh:` and the destination) are hosts to continue on
  for (const targetHostId of ['ssh:me@box', 'ssh:me@box.example.com:2222', 'ssh:me@[::1]'])
    assert.equal(S.parseParams('chat.commitContinue', { ...commit, targetHostId }).targetHostId, targetHostId);
  for (const targetHostId of ['', 5, 'a b', 'x'.repeat(129), 'a|b', 'a/b', 'a;b'])
    invalid('chat.commitContinue', { ...commit, targetHostId });
  for (const preparedId of ['', 'short', 5, 'has space 12345', 'x'.repeat(129)]) {
    invalid('chat.commitContinue', { ...commit, preparedId });
    invalid('chat.release', { ...release, preparedId });
  }
  invalid('chat.release', { ...release, epoch: -1 });
});

test('a continue needs the epoch and dedupe features on both ends', () => {
  for (const m of ['chat.prepareContinue', 'chat.commitContinue', 'chat.release']) {
    assert.throws(() => S.requireFeatures(m, { features: ['dedupe'] }), /lacks epoch/);
    assert.throws(() => S.requireFeatures(m, { features: ['epoch'] }), /lacks dedupe/);
    S.requireFeatures(m, { features: ['epoch', 'dedupe'] });
  }
});
