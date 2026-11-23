// Authenticated phone input correlation is stable across native replay, but never authorizes bytes or accepts a caller-forged id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { messageIdentity } from '../shared/remote/messageIdentity.mjs';
import { parseParams } from '../shared/remote/schema.mjs';
const require = createRequire(import.meta.url);
const { ownedMessageParams } = require('../electron/remote/messageIdentity.cjs');
const { typed } = require('../electron/app/chromePanelInput.cjs');
const { clientIdOf, carryInputGuard } = require('../electron/session/contract/inputGuard.cjs');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const id = (pair = 'pair', chat = 'chat', send = 'send-identity') => messageIdentity(hash, pair, 'chat.send', chat, send);

test('native identity is deterministic, UUID-compatible and scoped to exact pair, operation, chat and send', () => {
  assert.equal(id(), id());
  assert.match(id(), /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const variants = [
    id(),
    id('another'),
    id('pair', 'another'),
    id('pair', 'chat', 'another'),
    messageIdentity(hash, 'pair', 'chat.start', null, 'send'),
  ];
  assert.equal(new Set(variants).size, variants.length);
  assert.equal(messageIdentity(hash, 'pair', 'chat.start', 'ignored', 'send'), variants[4]);
});

test('schema discards a forged native id; main derives the same id only for an authenticated phone idempotency key', () => {
  const parsed: any = parseParams('chat.send', {
    chatId: 'chat',
    text: '',
    attachments: ['0123456789abcdef'],
    sendId: 'send-identity',
    nativeMessageId: 'forged',
  });
  assert.equal(parsed.nativeMessageId, undefined);
  const owned = ownedMessageParams({ kind: 'phone', pairId: 'pair' }, 'chat.send', parsed);
  assert.equal(owned.nativeMessageId, id());
  assert.equal(ownedMessageParams({ kind: 'panel' }, 'chat.send', parsed), parsed);
  assert.equal(ownedMessageParams({ kind: 'phone', pairId: 'pair' }, 'chat.send', { text: 'legacy' }).nativeMessageId, undefined);
  assert.equal(
    ownedMessageParams({ kind: 'phone', pairId: 'pair' }, 'chat.start', { startId: 'send' }).nativeMessageId,
    messageIdentity(hash, 'pair', 'chat.start', null, 'send'),
  );
});

test('typed panel delivery preserves the trusted identity through an internal queue copy, without accepting ordinary id fields', () => {
  const input = typed(
    { text: '', attachments: ['image'], nativeMessageId: id() },
    { take: (ids: string[]) => ids.map(() => ({ kind: 'image', path: '/private/image' })) },
    [],
    [],
  );
  assert.equal(input.id, id());
  assert.equal(clientIdOf(input), id());
  assert.equal(clientIdOf(carryInputGuard(input, { ...input })), id());
  const ordinary = typed({ text: 'legacy', attachments: [] }, { take: () => [] }, [], []);
  assert.notEqual(clientIdOf({ ...ordinary, id: id() }), id());
});

test('capability observation rejects stale owner replies and downgrades visibly instead of inventing image confirmation', async () => {
  const { createMessageIdentity } = await import('../mobile/src/remote/messageIdentity');
  let pair = 'a';
  let generation = 0;
  const identities = createMessageIdentity(hash, () => pair);
  assert.equal(identities.id('chat.send', 'chat', 'send-identity'), undefined);
  let resolve!: (value: unknown) => void;
  const old = new Promise((done) => {
    resolve = done;
  });
  identities.observe('a', old, () => generation === 0 && pair === 'a');
  generation++;
  pair = 'b';
  resolve({ capabilities: { messageIdentity: 1 } });
  await old;
  assert.equal(identities.supports('a'), false);
  identities.observe('b', Promise.resolve({ capabilities: { messageIdentity: 1 } }), () => true);
  await Promise.resolve();
  assert.equal(identities.id('chat.send', 'chat', 'send-identity'), id('b'));
  identities.observe('b', Promise.reject(new Error('offline')), () => true);
  await Promise.resolve();
  assert.equal(identities.supports(), true, 'temporary disconnection retains negotiated offline identity');
  identities.observe('b', Promise.resolve({ capabilities: { messageIdentity: 2 } }), () => true);
  await Promise.resolve();
  assert.equal(identities.supports(), false, 'unknown versions cannot silently confirm image sends');
  for (const malformed of [null, false, { capabilities: 'invalid' }, { capabilities: null }]) {
    identities.observe('b', Promise.resolve(malformed), () => true);
    await Promise.resolve();
    assert.equal(identities.supports(), false);
  }
  pair = '';
  assert.equal(identities.supports(), false);
  assert.equal(identities.id('chat.start', null, 'start'), undefined);
});
