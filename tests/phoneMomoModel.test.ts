// MoMo's phone model: the momo.* result checks, the sealed memory copy and the card reconciliation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCache } from './support/phone/momo-kit';
// the phone sources load by variable path so the node typecheck does not pull the phone's React types in
const contractPath = '../mobile/src/momo/contract';
const cachePath = '../mobile/src/momo/cache';
const needsPath = '../mobile/src/momo/needs';
const { changedTopic, momoAllowed, momoBrainSet, parseBrain, parseDocs, parseFacts, parseRoutines } = await import(contractPath);
const { createMomoCache } = await import(cachePath);
const { cardKey, emptyNeeds, reconcileNeeds } = await import(needsPath);

test('only an explicit momo capability opens the tab', () => {
  assert.equal(momoAllowed({ capabilities: { momo: true } }), true);
  for (const hello of [
    null,
    undefined,
    'x',
    {},
    { capabilities: {} },
    { capabilities: { momo: 'yes' } },
    { capabilities: { momo: false } },
    { features: { momo: true } },
  ])
    assert.equal(momoAllowed(hello), false);
});

test('phones may change the brain only when MoMo is allowed and the Mac says so', () => {
  assert.equal(momoBrainSet({ capabilities: { momo: true, momoBrainSet: true } }), true);
  for (const hello of [
    null,
    {},
    { capabilities: { momo: true } },
    { capabilities: { momo: true, momoBrainSet: 'yes' } },
    { capabilities: { momo: false, momoBrainSet: true } },
  ])
    assert.equal(momoBrainSet(hello), false);
});

test('the brain chip names the model the user chose, or nothing', () => {
  assert.deepEqual(parseBrain({ brain: { harness: 'claude', model: 'm-1', modelLabel: 'Model One' } }), { label: 'Model One' });
  assert.deepEqual(parseBrain({ brain: { harness: 'claude', model: 'm-1', modelLabel: null } }), { label: 'm-1' });
  // the effort MoMo runs its model at shows when there is one; none (the model's default) or a bad value shows none
  assert.deepEqual(parseBrain({ brain: { harness: 'claude', model: 'm-1', modelLabel: 'M', effort: 'high' } }), {
    label: 'M',
    effort: 'high',
  });
  assert.deepEqual(parseBrain({ brain: { harness: 'claude', model: 'm-1', modelLabel: 'M', effort: null } }), { label: 'M' });
  assert.deepEqual(parseBrain({ brain: { harness: 'claude', model: 'm-1', modelLabel: 'M', effort: 3 } }), { label: 'M' });
  assert.deepEqual(parseBrain({ brain: { harness: 'claude', model: 'm-1', modelLabel: 'M', effort: '' } }), { label: 'M' });
  assert.equal(parseBrain({ brain: { harness: 'acp:x', model: null, modelLabel: '' } }), null);
  assert.equal(parseBrain({ brain: null }), null);
  assert.equal(parseBrain({}), null);
  assert.throws(() => parseBrain('x'), /Could not read the brain/);
  assert.throws(() => parseBrain({ brain: 3 }), /Could not read the brain/);
});

test('facts, documents and routines are checked before they reach a screen', () => {
  assert.deepEqual(
    parseFacts({
      now: 100,
      facts: [
        { id: '1', text: 't', expiresAt: 50 },
        { id: '2', text: 'u', expiresAt: 500 },
        { id: '3', text: 'v' },
      ],
    }),
    [
      { id: '1', text: 't', expired: true },
      { id: '2', text: 'u', expired: false },
      { id: '3', text: 'v', expired: false },
    ],
  );
  assert.equal(parseFacts({ facts: [{ id: '1', text: 't', expiresAt: 1 }] })[0].expired, true);
  assert.throws(() => parseFacts({ facts: [{ id: 1, text: 't' }] }), /Could not read memory/);
  assert.throws(() => parseFacts({}), /Could not read memory/);
  assert.deepEqual(parseDocs({ aboutYou: 'a', persona: 'p', unreadable: ['persona', 4] }), {
    aboutYou: 'a',
    persona: 'p',
    unreadable: ['persona'],
  });
  assert.deepEqual(parseDocs({ aboutYou: 'a', persona: 'p' }).unreadable, []);
  assert.throws(() => parseDocs({ aboutYou: 'a' }), /Could not read memory/);
  assert.deepEqual(
    parseRoutines({
      proposals: [
        { id: 'p', name: 'N', prompt: 'P', schedule: 'S', rev: 2, sources: 'Calendar' },
        { id: 'q', name: 'N', prompt: 'P', schedule: 'S', rev: 0 },
      ],
      routines: [
        { id: 'r', name: 'R', schedule: 'daily', paused: true },
        { id: 's', name: 'R', schedule: 'daily' },
      ],
    }),
    {
      proposals: [
        { id: 'p', name: 'N', prompt: 'P', schedule: 'S', sources: 'Calendar', rev: 2 },
        { id: 'q', name: 'N', prompt: 'P', schedule: 'S', sources: '', rev: 0 },
      ],
      routines: [
        { id: 'r', name: 'R', schedule: 'daily', paused: true },
        { id: 's', name: 'R', schedule: 'daily', paused: false },
      ],
    },
  );
  assert.throws(() => parseRoutines({ proposals: [{ id: 'p' }], routines: [] }), /Could not read routines/);
  assert.throws(() => parseRoutines({ proposals: [], routines: [{ id: 1 }] }), /Could not read routines/);
});

test('momo.changed names a topic or is ignored', () => {
  const ev = (e: any) => changedTopic({ id: '1', t: 0, kind: 'event', ...e });
  assert.equal(ev({ ev: 'momo.changed', area: 'memory' }), 'memory');
  assert.equal(ev({ ev: 'momo.changed', area: 'routines' }), 'routines');
  assert.equal(ev({ ev: 'momo.changed', area: 'brain' }), 'brain');
  assert.equal(ev({ ev: 'momo.changed', area: 'x' }), null);
  assert.equal(ev({ ev: 'momo.changed' }), null);
  assert.equal(ev({ ev: 'items.append' }), null);
});

test('the memory copy is sealed, bound to its account and computer, and cleared on demand', async () => {
  const cache = fakeCache();
  assert.equal(await cache.load('a'), null);
  const copy = { facts: [{ id: '1', text: 'secret dentist appointment' }], docs: null };
  await cache.save('a', copy);
  assert.doesNotMatch(cache.raw()!, /dentist/);
  assert.deepEqual(await cache.load('a'), copy);
  assert.equal(await cache.load('b'), null);
  await cache.clear();
  assert.equal(await cache.load('a'), null);
});

test('an unreadable or malformed copy reads as none', async () => {
  const sealed = fakeCache();
  await sealed.save('a', { facts: [], docs: null });
  const good = sealed.raw()!;
  const make = (raw: string, open: () => Uint8Array | null) =>
    createMomoCache({
      store: { read: async () => raw, write: async () => {}, clear: async () => {} },
      crypto: { key: async () => new Uint8Array(32), randomBytes: () => new Uint8Array(24), seal: () => new Uint8Array(), open },
    });
  const text = (value: string) => () => new TextEncoder().encode(value);
  assert.equal(await make('not json', () => null).load('a'), null);
  assert.equal(await make(good, () => null).load('a'), null);
  assert.equal(await make(good, text('{"x":1}')).load('a'), null);
  assert.deepEqual(await make(JSON.stringify({ nonce: '', box: '' }), text('{"facts":[]}')).load('a'), { facts: [] });
});

test('cards that vanish unanswered here were answered on the Mac', () => {
  const a = { id: 'a', rev: 1, title: 'A' };
  const b = { id: 2, rev: 1, title: 'B' };
  assert.equal(cardKey(b), '2');
  let state = reconcileNeeds(emptyNeeds, [a, b], new Set());
  assert.deepEqual(state.answeredOnMac, []);
  state = reconcileNeeds(state, [b], new Set());
  assert.deepEqual(state.answeredOnMac, [a]);
  // answered here: not claimed to be answered elsewhere
  state = reconcileNeeds(state, [], new Set(['2']));
  assert.deepEqual(state.answeredOnMac, [a]);
  // the same card coming back clears its note
  state = reconcileNeeds(state, [a], new Set());
  assert.deepEqual(state.answeredOnMac, []);
  // only the latest few are kept
  let many = reconcileNeeds(
    emptyNeeds,
    Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, rev: 1, title: 't' })),
    new Set(),
  );
  many = reconcileNeeds(many, [], new Set());
  assert.equal(many.answeredOnMac.length, 5);
});
