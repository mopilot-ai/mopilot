// Phone push core: payload parsing, fixed titles, chat handles, sealed titles, Android data messages, channels and title-key storage.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { chatRef as macChatRef } from '../shared/remote/ref.mjs';
import { toBase64 } from '../shared/remote/envelope.mjs';
import { TITLES } from '../relay/src/notifier.mjs';
import { isPushKind, isUrgent, PUSH_TITLES } from '../mobile/src/push/kinds';
import { parsePushPayload } from '../mobile/src/push/payload';
import { chatRef } from '../mobile/src/push/chatRef';
import { openSealedTitle, titleAad } from '../mobile/src/push/sealedTitle';
import { buildNotification, withdrawn } from '../mobile/src/push/dataMessage';
import { CHANNELS, channelFor, channelIdsExcept, channelSpecs } from '../mobile/src/push/channels';
import { DEFAULT_PREFS, audible, inQuietHours, isClock, parsePrefs } from '../mobile/src/push/prefs';
import { CATEGORY_SPECS, MAX_REPLY, categoryId, replyDraft } from '../mobile/src/push/actions';
import { createTitleKeys } from '../mobile/src/push/titleKeys';

const require = createRequire(import.meta.url);
const prefs = async () => DEFAULT_PREFS;
const prim = require('../electron/platform/sodiumPrimitives.cjs').createSodiumPrimitives();
const open = (key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad: Uint8Array) => prim.aeadOpen(key, nonce, box, aad);
const key = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 255);
function seal(k: Uint8Array, ref: string, text: string, nonceSeed = 1) {
  const nonce = Uint8Array.from({ length: 24 }, (_, i) => (i + nonceSeed) & 255);
  const box = prim.aeadSeal(k, nonce, new TextEncoder().encode(text), titleAad(ref));
  return toBase64(Uint8Array.from([...nonce, ...box]));
}

test('the phone titles equal the relay titles and only the two needs-you kinds are urgent', () => {
  assert.deepEqual({ ...PUSH_TITLES }, { ...TITLES });
  assert.equal(isPushKind('done'), true);
  assert.equal(isPushKind('toString'), false);
  assert.equal(isPushKind(7), false);
  assert.deepEqual((Object.keys(PUSH_TITLES) as Array<keyof typeof PUSH_TITLES>).filter(isUrgent), ['needsYou', 'momoNeedsYou']);
});

test('push data parses to a typed payload and every malformed shape is dropped', () => {
  assert.equal(parsePushPayload(null), null);
  assert.equal(parsePushPayload('x'), null);
  assert.equal(parsePushPayload({ kind: 'nope', ref: 'r' }), null);
  assert.equal(parsePushPayload({ kind: 'done', ref: '' }), null);
  assert.equal(parsePushPayload({ kind: 'done', ref: 'r'.repeat(129) }), null);
  assert.deepEqual(parsePushPayload({ kind: 'done', ref: 'abc' }), {
    kind: 'done',
    ref: 'abc',
    count: 1,
    sealedTitle: undefined,
  });
  const full = parsePushPayload({ kind: 'needsYou', ref: 'abc', count: '2', st: 'AAAA' });
  assert.deepEqual(full, { kind: 'needsYou', ref: 'abc', count: 2, sealedTitle: 'AAAA' });
  assert.equal(parsePushPayload({ kind: 'done', ref: 'a', count: 1000 })?.count, 1);
  assert.equal(parsePushPayload({ kind: 'done', ref: 'a', st: 'x'.repeat(2049) })?.sealedTitle, undefined);
});

test('the phone recomputes exactly the handle the Mac sends', () => {
  for (const [pair, chat] of [
    ['p_pair00001', 'chat-1'],
    ['p_other0002', 'ünï/chat 2'],
    ['p', ''],
  ]) {
    assert.equal(chatRef(pair, chat), macChatRef(pair, chat));
  }
  assert.equal(chatRef('a', 'b').length, 22);
});

test('a sealed title opens under any stored key and every failure returns null', () => {
  const [k1, k2] = [key(1), key(2)];
  const sealed = seal(k2, 'ref1', 'Fix the login bug');
  assert.equal(openSealedTitle({ sealed, ref: 'ref1', keys: [k1, k2], open }), 'Fix the login bug');
  // wrong ref (replayed blob), wrong key, no keys, short key
  assert.equal(openSealedTitle({ sealed, ref: 'ref2', keys: [k1, k2], open }), null);
  assert.equal(openSealedTitle({ sealed, ref: 'ref1', keys: [k1], open }), null);
  assert.equal(openSealedTitle({ sealed, ref: 'ref1', keys: [], open }), null);
  assert.equal(openSealedTitle({ sealed, ref: 'ref1', keys: [new Uint8Array(5), k2], open }), 'Fix the login bug');
  // not base64, too short
  assert.equal(openSealedTitle({ sealed: '***', ref: 'ref1', keys: [k2], open }), null);
  assert.equal(openSealedTitle({ sealed: toBase64(new Uint8Array(10)), ref: 'ref1', keys: [k2], open }), null);
  // a primitive that throws is skipped, an oversized or blank or control-only title is refused
  assert.equal(
    openSealedTitle({
      sealed,
      ref: 'ref1',
      keys: [k2],
      open: () => {
        throw new Error('boom');
      },
    }),
    null,
  );
  assert.equal(openSealedTitle({ sealed: seal(k2, 'r', 'x'.repeat(201)), ref: 'r', keys: [k2], open }), null);
  assert.equal(openSealedTitle({ sealed: seal(k2, 'r', ' \u0007 '), ref: 'r', keys: [k2], open }), null);
  assert.equal(openSealedTitle({ sealed: seal(k2, 'r', 'a\nb\u0000c'), ref: 'r', keys: [k2], open }), 'a b c');
  // invalid UTF-8 inside a valid box
  const bad = prim.aeadSeal(k2, new Uint8Array(24), Uint8Array.of(0xff, 0xfe), titleAad('r'));
  assert.equal(openSealedTitle({ sealed: toBase64(Uint8Array.from([...new Uint8Array(24), ...bad])), ref: 'r', keys: [k2], open }), null);
});

test('the relay forwards the sealed title as unpadded base64url, which opens like the padded form', () => {
  const k = key(5);
  // choose a title whose blob needs padding and contains both - and _ after conversion
  for (const text of ['a', 'ab', 'abc', '??>>~~', 'Fix the login bug']) {
    const std = seal(k, 'r', text);
    const url = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(openSealedTitle({ sealed: url, ref: 'r', keys: [k], open }), text);
    assert.equal(openSealedTitle({ sealed: std, ref: 'r', keys: [k], open }), text);
  }
});

test('an Android data message always yields a notification: sealed title when it opens, fixed title otherwise', async () => {
  const k = key(3);
  const keys = async () => [k];
  const base = { kind: 'needsYou', ref: 'r1' };
  assert.equal(await buildNotification({ kind: 'bogus' }, { keys, open, prefs }), null);
  const fixed = await buildNotification(base, { keys, open, prefs });
  assert.deepEqual(fixed, {
    id: 'needsYou:r1',
    title: PUSH_TITLES.needsYou,
    channelId: CHANNELS.needsYou.id,
    data: { kind: 'needsYou', ref: 'r1' },
  });
  const titlesOn = async () => ({ ...DEFAULT_PREFS, titles: true });
  const sealed = await buildNotification({ ...base, st: seal(k, 'r1', 'Deploy review') }, { keys, open, prefs: titlesOn });
  assert.equal(sealed?.title, 'Deploy review');
  // titles are this phone's choice: with the switch off (the default) a sealed title that would open is not shown
  const off = await buildNotification({ ...base, st: seal(k, 'r1', 'Deploy review') }, { keys, open, prefs });
  assert.equal(off?.title, PUSH_TITLES.needsYou);
  // merged chats keep the relay's "(n)" title even when a sealed one is present
  const merged = await buildNotification({ ...base, count: 2, st: seal(k, 'r1', 'Deploy review') }, { keys, open, prefs });
  assert.equal(merged?.title, 'A chat needs you (2)');
  // text the sender put in `title` is never shown: whoever sends the push could phish on the lock screen
  const spoofed = await buildNotification(
    { ...base, title: 'MoPilot: your session expired. Sign in at evil.example' },
    { keys, open, prefs },
  );
  assert.equal(spoofed?.title, PUSH_TITLES.needsYou);
  const spoofedMerged = await buildNotification({ ...base, count: 3, title: 'Wire money' }, { keys, open, prefs });
  assert.equal(spoofedMerged?.title, `${PUSH_TITLES.needsYou} (3)`);
  // a key store that fails, or a blob that does not open, falls back
  const broken = await buildNotification(
    { ...base, st: seal(k, 'r1', 'x') },
    {
      keys: async () => {
        throw new Error('keychain');
      },
      open,
      prefs,
    },
  );
  assert.equal(broken?.title, PUSH_TITLES.needsYou);
  const forged = await buildNotification({ kind: 'done', ref: 'r1', st: seal(key(9), 'r1', 'x') }, { keys, open, prefs });
  assert.equal(forged?.title, PUSH_TITLES.done);
  assert.equal(forged?.channelId, CHANNELS.done.id);
});

test('channels: needs-you interrupts, everything else is quiet', () => {
  assert.equal(CHANNELS.needsYou.importance, 'high');
  assert.equal(channelFor('momoNeedsYou').id, 'needs-you');
  assert.equal(channelFor('machineOffline').id, 'done');
});

test('title keys are stored under one service, listed through an index, serialized and pruned', async () => {
  const items = new Map<string, string>();
  const seen: object[] = [];
  const secrets = {
    get: async (k: string, o: object) => (seen.push(o), items.get(k) ?? null),
    set: async (k: string, v: string, o: object) => (seen.push(o), void items.set(k, v)),
    remove: async (k: string) => void items.delete(k),
  };
  const options = { keychainService: 'mopilot-push' };
  const keys = createTitleKeys({ secrets, options });
  await Promise.all([keys.save('p_a', key(1)), keys.save('p_b', key(2)), keys.save('p_a', key(1))]);
  assert.deepEqual(JSON.parse(items.get('title-key-index')!), ['p_a', 'p_b']);
  assert.ok(seen.every((o) => o === options));
  assert.deepEqual(await keys.all(), [key(1), key(2)]);
  items.set('title-key.p_b', 'not-hex');
  assert.deepEqual(await keys.all(), [key(1)]);
  await keys.remove('p_a');
  assert.deepEqual(JSON.parse(items.get('title-key-index')!), ['p_b']);
  await keys.save('p_c', key(3));
  await keys.prune(['p_c']);
  assert.deepEqual(JSON.parse(items.get('title-key-index')!), ['p_c']);
  assert.equal(items.has('title-key.p_b'), false);
  // a corrupt or wrong-shaped index reads as empty; an unreadable item is skipped
  items.set('title-key-index', '{oops');
  assert.deepEqual(await keys.all(), []);
  items.set('title-key-index', '{"a":1}');
  assert.deepEqual(await keys.all(), []);
  items.set('title-key-index', JSON.stringify(['p_c', 7]));
  const flaky = createTitleKeys({
    secrets: {
      ...secrets,
      get: async (k) => {
        if (k === 'title-key.p_c') throw new Error('locked');
        return items.get(k) ?? null;
      },
    },
    options,
  });
  assert.deepEqual(await flaky.all(), []);
  // a failed write does not wedge the queue
  const failing = createTitleKeys({
    secrets: {
      ...secrets,
      set: async () => {
        throw new Error('full');
      },
    },
    options,
  });
  await assert.rejects(failing.save('p_x', key(4)), /full/);
  await assert.rejects(failing.save('p_y', key(5)), /full/);
});

test('prefs read tolerantly: bad stores fall back field by field to the defaults', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('{oops'), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('[]'), DEFAULT_PREFS);
  const mixed = parsePrefs(JSON.stringify({ enabled: false, sound: 'yes', quiet: { on: true, from: '25:00', to: '06:30' } }));
  assert.deepEqual(mixed, { ...DEFAULT_PREFS, enabled: false, quiet: { on: true, from: '22:00', to: '06:30' } });
  assert.deepEqual(parsePrefs(JSON.stringify({ quiet: 5 })), DEFAULT_PREFS);
  assert.equal(DEFAULT_PREFS.liveActivity, false, 'Live Activity starts off');
  assert.equal(DEFAULT_PREFS.titles, false, 'chat titles on the lock screen start off');
  assert.equal(DEFAULT_PREFS.skipOpenChat, true, 'the chat that is open is not announced again');
  assert.deepEqual(parsePrefs(JSON.stringify({ liveActivity: 'on', titles: 1, skipOpenChat: null })), DEFAULT_PREFS);
  const full = {
    enabled: false,
    sound: false,
    lockScreen: 'hide',
    quiet: { on: true, from: '21:15', to: '05:45' },
    liveActivity: true,
    titles: true,
    skipOpenChat: false,
  };
  assert.deepEqual(parsePrefs(JSON.stringify(full)), full);
  assert.equal(isClock('09:05'), true);
  assert.equal(isClock('9:05'), false);
  assert.equal(isClock('24:00'), false);
  assert.equal(isClock(905), false);
});

test('the quiet window crosses midnight, ignores an empty window and silences only what the app can', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 28, h, m);
  const quiet = (from: string, to: string, on = true) => ({ ...DEFAULT_PREFS, quiet: { on, from, to } });
  const night = quiet('22:00', '07:00');
  assert.deepEqual(
    [at(21, 59), at(22), at(3), at(6, 59), at(7)].map((d) => inQuietHours(night, d)),
    [false, true, true, true, false],
  );
  const day = quiet('09:00', '17:00');
  assert.deepEqual(
    [at(8, 59), at(9), at(16, 59), at(17)].map((d) => inQuietHours(day, d)),
    [false, true, true, false],
  );
  assert.equal(inQuietHours(quiet('08:00', '08:00'), at(8)), false);
  assert.equal(inQuietHours(quiet('22:00', '07:00', false), at(23)), false);
  assert.equal(audible(night, at(12)), true);
  assert.equal(audible(night, at(23)), false);
  assert.equal(audible({ ...night, sound: false }, at(12)), false);
});

test('notifications off shows nothing; sound off or quiet hours pick the silent channel; loud otherwise', async () => {
  const keys = async () => [];
  const data = { kind: 'needsYou', ref: 'r1' };
  const noon = () => new Date(2026, 9, 28, 12);
  const night = () => new Date(2026, 9, 28, 23);
  const quiet = { ...DEFAULT_PREFS, quiet: { on: true, from: '22:00', to: '07:00' } };
  assert.equal(await buildNotification(data, { keys, open, prefs: async () => ({ ...DEFAULT_PREFS, enabled: false }) }), null);
  assert.equal((await buildNotification(data, { keys, open, prefs: async () => quiet, now: noon }))?.channelId, 'needs-you');
  assert.equal((await buildNotification(data, { keys, open, prefs: async () => quiet, now: night }))?.channelId, 'needs-you-silent');
  assert.equal(
    (await buildNotification(data, { keys, open, prefs: async () => ({ ...DEFAULT_PREFS, sound: false }) }))?.channelId,
    'needs-you-silent',
  );
  assert.equal(
    (await buildNotification({ kind: 'done', ref: 'r' }, { keys, open, prefs: async () => ({ ...DEFAULT_PREFS, sound: false }) }))
      ?.channelId,
    'done-silent',
  );
  assert.equal(channelFor('done').id, 'done');
});

test('the lock-screen choice picks its own channel variants and ignores unknown stored values', async () => {
  assert.deepEqual(
    channelSpecs('private').map((c) => c.id),
    ['needs-you-private', 'needs-you-silent-private', 'done-private', 'done-silent-private'],
  );
  assert.deepEqual(
    channelSpecs('hide').map((c) => c.name),
    ['Needs you (hidden)', 'Needs you (silent) (hidden)', 'Finished (hidden)', 'Finished (silent) (hidden)'],
  );
  assert.equal(channelFor('needsYou', true, 'hide').id, 'needs-you-hide');
  assert.equal(channelFor('done', false, 'private').id, 'done-silent-private');
  assert.equal(channelIdsExcept('show').length, 8);
  assert.ok(!channelIdsExcept('private').includes('needs-you-private'));
  assert.equal(parsePrefs(JSON.stringify({ lockScreen: 'nope' })).lockScreen, 'show');
  const note = await buildNotification(
    { kind: 'needsYou', ref: 'r' },
    { keys: async () => [], open, prefs: async () => ({ ...DEFAULT_PREFS, lockScreen: 'private' }) },
  );
  assert.equal(note?.channelId, 'needs-you-private');
});

test('iOS actions: categories name the relay category ids, and only a typed Reply becomes a bounded draft', () => {
  assert.deepEqual(
    CATEGORY_SPECS.map((c) => c.id),
    ['mopilot.needsYou', 'mopilot.momoNeedsYou', 'mopilot.done'],
  );
  assert.equal(categoryId('done'), 'mopilot.done');
  assert.deepEqual(
    CATEGORY_SPECS.map((c) => c.actions.map((a) => a.identifier).join()),
    ['open,allow,deny,reply', 'open,reply', 'open,reply'],
  );
  assert.equal(CATEGORY_SPECS[2].actions[0].buttonTitle, 'Open');
  assert.equal(CATEGORY_SPECS[0].actions[3].textInput?.submitButtonTitle, 'Open chat');
  assert.equal(replyDraft('reply', '  looks good  '), 'looks good');
  assert.equal(replyDraft('reply', 'x'.repeat(MAX_REPLY + 50))?.length, MAX_REPLY);
  assert.equal(replyDraft('reply', '   '), null);
  assert.equal(replyDraft('reply', 5), null);
  const emoji = '\u{1F600}';
  const cut = replyDraft('reply', 'a'.repeat(MAX_REPLY - 1) + emoji) as string;
  assert.equal(cut, 'a'.repeat(MAX_REPLY - 1), 'half of a surrogate pair is not kept');
  assert.equal(replyDraft('open', 'hello'), null);
  assert.equal(replyDraft('expo.modules.notifications.actions.DEFAULT', 'hello'), null);
});

test('a clearing is its own quiet kind: parsed, never drawn by the Android handler, and it names the notification it withdraws', async () => {
  const keys = async () => [key(3)];
  assert.equal(isPushKind('cleared'), true);
  assert.equal(isUrgent('cleared'), false);
  assert.equal(parsePushPayload({ kind: 'cleared', ref: 'r1' })?.kind, 'cleared');
  // never a notification of its own, even with notifications on and a sealed blob attached
  assert.equal(await buildNotification({ kind: 'cleared', ref: 'r1', st: 'AAAA' }, { keys, open, prefs }), null);
  assert.deepEqual(withdrawn({ kind: 'cleared', ref: 'r1' })?.ids, ['needsYou:r1']);
  assert.equal(withdrawn({ kind: 'needsYou', ref: 'r1' }), null);
  assert.equal(withdrawn({ kind: 'cleared' }), null, 'no chat handle, nothing to withdraw');
  assert.equal(withdrawn('junk'), null);
  // what it withdraws is the id a needs-you notification is drawn under
  assert.equal(
    (await buildNotification({ kind: 'needsYou', ref: 'r1' }, { keys, open, prefs }))?.id,
    withdrawn({ kind: 'cleared', ref: 'r1' })!.ids[0],
  );
});
