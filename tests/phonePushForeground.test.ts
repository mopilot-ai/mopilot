// The foreground notification policy and the appearance store on the phone: which push is drawn while the app is open, the test notification, and the saved colour scheme.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import './support/phone/register.ts';
import { chatRef } from '../mobile/src/push/chatRef.ts';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const g = globalThis as any;
const rec: any = {
  scheduled: [],
  handler: null,
  responseListeners: [],
  secure: new Map(),
  failSchedule: false,
  presented: [],
  dismissed: [],
  order: [],
  readDelay: 0,
};
let permissions: any = { granted: true };
mock.module(require.resolve('expo-notifications'), {
  namedExports: {
    AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2 },
    AndroidNotificationVisibility: { PUBLIC: 1, PRIVATE: 0, SECRET: -1 },
    deleteNotificationChannelAsync: async () => {},
    getPermissionsAsync: async () => permissions,
    getDevicePushTokenAsync: async () => ({ data: 'tok' }),
    addPushTokenListener: () => ({ remove: () => {} }),
    setNotificationChannelAsync: async () => {},
    setNotificationHandler: (h: any) => void (rec.handler = h),
    addNotificationResponseReceivedListener: (l: any) => (rec.responseListeners.push(l), { remove: () => rec.responseListeners.pop() }),
    getLastNotificationResponseAsync: async () => null,
    scheduleNotificationAsync: async (r: any) => {
      if (rec.failSchedule) throw new Error('not allowed');
      rec.order.push('show');
      rec.scheduled.push(r);
    },
    setNotificationCategoryAsync: async () => {},
    registerTaskAsync: async () => {},
    getPresentedNotificationsAsync: async () => rec.presented,
    dismissNotificationAsync: async (id: string) => {
      if (rec.failDismiss) throw new Error('gone already');
      rec.order.push('dismiss');
      rec.dismissed.push(id);
    },
  },
});
mock.module(require.resolve('expo-task-manager'), { namedExports: { defineTask: () => {} } });
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 5,
    getItemAsync: async (k: string) => {
      checkSecureKey(k);
      if (rec.readDelay) await new Promise((r) => setTimeout(r, rec.readDelay));
      return rec.secure.get(k) ?? null;
    },
    setItemAsync: async (k: string, v: string) => (checkSecureKey(k), checkSecureValue(v), void rec.secure.set(k, v)),
    deleteItemAsync: async (k: string) => (checkSecureKey(k), void rec.secure.delete(k)),
  },
});
mock.module(require.resolve('expo-constants'), { defaultExport: { expoConfig: { extra: {} } } });
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({ aeadOpen: () => null }) } });
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });

const momoCopy = { used: true, rows: new Map<string, any>(), marks: 0 };
const copyApi = {
  newest: async (user: string) => (momoCopy.rows.has(user) ? { status: 'ok', stamp: momoCopy.rows.get(user) } : { status: 'none' }),
  keepStamp: async (user: string, stamp: any) => void momoCopy.rows.set(user, stamp),
};
mock.module('../mobile/src/platform/momoHomeStore.ts', {
  namedExports: {
    openMomoHomeCache: async () => copyApi,
    momoHomeWasUsed: async () => momoCopy.used,
    markMomoHomeUsed: async () => void momoCopy.marks++,
  },
});
// a stamp is sealed here as "<home>:<epoch>" for the ref it names
mock.module('../mobile/src/platform/pushStampContext.ts', {
  namedExports: {
    momoStampContext: async () => ({
      user: 'u',
      open: (sealed: string, ref: string) => {
        const [homeId, epoch, forRef] = sealed.split(':');
        return forRef === ref && Number(epoch) > 0 ? { homeId, leaseEpoch: Number(epoch) } : null;
      },
    }),
  },
});
// variable specifiers keep React Native's global typings out of the repository-wide typecheck
const notificationsPath = '../mobile/src/platform/notifications.ts';
const productionPath = '../mobile/src/push/production.ts';
const notifications = await import(notificationsPath);
const production = await import(productionPath);
let noteCount = 0;
const note = (extra: any = {}) => ({
  date: 1000 + ++noteCount,
  request: { identifier: `n${noteCount}`, content: { data: { kind: 'done', ref: 'r1', ...extra } } },
});

test('in the foreground a policy decides which push is drawn; the test notification is always drawn and never wakes or routes', async () => {
  const seen: any[] = [];
  notifications.quietForeground(
    (p) => seen.push(p),
    (p) => p.ref !== 'open',
  );
  const shown = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false };
  assert.deepEqual(await rec.handler.handleNotification(note({ ref: 'other' })), shown);
  assert.equal((await rec.handler.handleNotification(note({ ref: 'open' }))).shouldShowBanner, false, 'the open chat is not announced');
  assert.equal(seen.length, 2, 'both still wake the drain');
  const test = await rec.handler.handleNotification(note({ ref: 'test', test: true }));
  assert.deepEqual(test, shown);
  assert.equal(seen.length, 2, 'a test notification wakes nothing');
  assert.equal((await rec.handler.handleNotification({ request: { content: { data: { junk: true } } } })).shouldShowBanner, false);
  // a notification that is not ours is not drawn, whatever the policy says
  notifications.quietForeground(
    () => {},
    () => true,
  );
  assert.equal((await rec.handler.handleNotification({ request: { content: { data: null } } })).shouldShowBanner, false);
  const taps: any[] = [];
  const off = notifications.onTap((p) => taps.push(p.ref));
  rec.responseListeners.at(-1)({ notification: note({ ref: 'test', test: true }) });
  rec.responseListeners.at(-1)({ notification: note({ ref: 'real' }) });
  assert.deepEqual(taps, ['real'], 'tapping the test notification opens nothing');
  off();
});

test('a clearing is never drawn in the foreground and takes that chat’s delivered "needs you" away, and no other notification', async () => {
  const { handleDataMessage } = production;
  notifications.quietForeground(
    () => {},
    () => true,
  );
  rec.presented = [
    { request: { identifier: 'waiting-r1', content: { data: { kind: 'needsYou', ref: 'r1' } } } },
    { request: { identifier: 'waiting-r2', content: { data: { kind: 'needsYou', ref: 'r2' } } } },
    { request: { identifier: 'finished-r1', content: { data: { kind: 'done', ref: 'r1' } } } },
    { request: { identifier: 'junk', content: { data: { junk: true } } } },
    // an iOS push carries its keys in the trigger's payload, with no content data
    { request: { identifier: 'ios-r1', content: { data: null }, trigger: { type: 'push', payload: { kind: 'needsYou', ref: 'r1' } } } },
  ];
  rec.dismissed.length = 0;
  const res = await rec.handler.handleNotification(note({ kind: 'cleared', ref: 'r1' }));
  assert.equal(res.shouldShowBanner, false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(rec.dismissed, ['waiting-r1', 'ios-r1']);
  // a system that refuses the removal does not break the handler
  rec.failDismiss = true;
  assert.equal((await rec.handler.handleNotification(note({ kind: 'cleared', ref: 'r1' }))).shouldShowBanner, false);
  await new Promise((r) => setImmediate(r));
  // Android: the data message removes the id the notification was drawn under and draws nothing, whether or not it can be removed
  rec.failDismiss = false;
  rec.dismissed.length = 0;
  rec.scheduled.length = 0;
  await handleDataMessage({ kind: 'cleared', ref: 'r1' });
  assert.deepEqual(rec.dismissed, ['needsYou:r1']);
  assert.equal(rec.scheduled.length, 0);
  rec.failDismiss = true;
  await handleDataMessage({ kind: 'cleared', ref: 'r1' });
  rec.failDismiss = false;
  rec.presented = [];
});

test('Android data messages are handled in the order they arrive: a clearing never overtakes the needs-you it follows, and one that fails does not stop the next', async () => {
  const { handleDataMessage } = production;
  g.__phonePlatform = 'android';
  rec.secure.delete('push-prefs');
  rec.order.length = 0;
  rec.dismissed.length = 0;
  rec.scheduled.length = 0;
  rec.readDelay = 25; // the needs-you is slow (its prefs read), the clearing would otherwise be quick
  await Promise.all([handleDataMessage({ kind: 'needsYou', ref: 'r9' }), handleDataMessage({ kind: 'cleared', ref: 'r9' })]);
  rec.readDelay = 0;
  assert.deepEqual(rec.order, ['show', 'dismiss']);
  assert.deepEqual(rec.dismissed, ['needsYou:r9']);
  // a message that throws (the system refuses to draw it) rejects its own promise only
  rec.failSchedule = true;
  const failing = handleDataMessage({ kind: 'needsYou', ref: 'r8' });
  const next = handleDataMessage({ kind: 'cleared', ref: 'r8' });
  await assert.rejects(failing);
  await next;
  rec.failSchedule = false;
  assert.deepEqual(rec.dismissed, ['needsYou:r9', 'needsYou:r8']);
  g.__phonePlatform = undefined;
});

test('production: the foreground policy follows the open chat, and the test button hands the system a fixed-title notification', async () => {
  g.__phonePlatform = 'ios';
  const runtime: any = {
    snapshot: () => ({ user: { id: 'u' }, pairs: [{ pairId: 'p_a' }], phase: 'online', selectedPair: 'p_a' }),
    subscribe: () => () => {},
    onEvent: () => () => {},
    connect: async () => {},
    pushRegister: async () => {},
    pushUnregister: async () => {},
  };
  permissions = { granted: true };
  rec.secure.delete('push-prefs');
  const push = production.createProductionPush(runtime);
  await push.start();
  push.setOpenChat('p_a', 'c1');
  const open = chatRef('p_a', 'c1');
  assert.equal((await rec.handler.handleNotification(note({ kind: 'needsYou', ref: open }))).shouldShowBanner, false);
  assert.equal((await rec.handler.handleNotification(note({ kind: 'needsYou', ref: 'elsewhere' }))).shouldShowBanner, true);
  await push.setPrefs({ skipOpenChat: false });
  assert.equal((await rec.handler.handleNotification(note({ kind: 'needsYou', ref: open }))).shouldShowBanner, true);
  // with the app running, a clearing data message withdraws and wakes the same drain
  rec.dismissed.length = 0;
  await production.handleDataMessage({ kind: 'cleared', ref: 'elsewhere' });
  assert.deepEqual(rec.dismissed, ['needsYou:elsewhere']);
  rec.scheduled.length = 0;
  assert.equal(await push.sendTest(), true);
  assert.deepEqual(rec.scheduled[0].content, {
    title: 'A chat needs you',
    body: '',
    data: { kind: 'needsYou', ref: 'test', test: true },
  });
  assert.equal(rec.scheduled[0].identifier, 'test');
  // with the real policy a clearing is no more drawn than with a permissive one
  assert.equal((await rec.handler.handleNotification(note({ kind: 'cleared', ref: 'elsewhere' }))).shouldShowBanner, false);
  rec.failSchedule = true;
  assert.equal(await push.sendTest(), false, 'a refusal of the system is reported, not thrown');
  rec.failSchedule = false;
  push.stop();
  g.__phonePlatform = undefined;
});

test('appearance: the saved choice is read from the keychain and handed to the system, with auto meaning follow the phone', async () => {
  const appearancePath = '../mobile/src/platform/appearance.ts';
  const { createProductionAppearance } = await import(appearancePath);
  rec.secure.set('appearance', 'dark');
  const control = createProductionAppearance();
  assert.equal(await control.read(), 'dark');
  assert.equal(g.__phoneScheme, 'dark');
  await control.set('system');
  assert.equal(rec.secure.get('appearance'), 'system');
  assert.equal(g.__phoneScheme, 'auto');
  await control.set('light');
  assert.equal(g.__phoneScheme, 'light');
});

test('haptic feedback: the saved choice is kept in the keychain as on or off', async () => {
  const hapticsPath = '../mobile/src/platform/haptics.ts';
  const { createProductionHaptics } = await import(hapticsPath);
  rec.secure.set('haptics', 'off');
  const control = createProductionHaptics();
  assert.equal(await control.read(), false);
  await control.set(true);
  assert.equal(rec.secure.get('haptics'), 'on');
});

test('production: a MoMo push from an old home is neither drawn in the foreground nor on Android; a newer one is', async () => {
  g.__phonePlatform = 'ios';
  const runtime: any = {
    snapshot: () => ({ user: { id: 'u' }, pairs: [{ pairId: 'p_a' }], phase: 'online', selectedPair: 'p_a' }),
    subscribe: () => () => {},
    onEvent: () => () => {},
    connect: async () => {},
    pushRegister: async () => {},
    pushUnregister: async () => {},
  };
  permissions = { granted: true };
  rec.secure.delete('push-prefs');
  const push = production.createProductionPush(runtime);
  await push.start();
  momoCopy.rows.set('u', { homeId: 'mini', leaseEpoch: 5 });
  momoCopy.rows.set('u|push', { homeId: 'mini', leaseEpoch: 5 });
  const stamped = (leaseEpoch: number) => note({ kind: 'momoNeedsYou', ref: 'm1', ss: `studio:${leaseEpoch}:m1` });
  assert.equal((await rec.handler.handleNotification(stamped(1))).shouldShowBanner, false, 'an old home’s push is not drawn');
  assert.equal((await rec.handler.handleNotification(stamped(6))).shouldShowBanner, true, 'a newer one is');
  g.__phonePlatform = 'android';
  rec.scheduled.length = 0;
  await production.handleDataMessage({ kind: 'momoNeedsYou', ref: 'm1', ss: 'studio:1:m1' });
  assert.equal(rec.scheduled.length, 0, 'a data message of an old home draws nothing');
  await production.handleDataMessage({ kind: 'momoNeedsYou', ref: 'm1', ss: 'studio:7:m1' });
  assert.equal(rec.scheduled.length, 1);
  rec.scheduled.length = 0;
  await production.handleDataMessage({ kind: 'momoNeedsYou', ref: 'm1' });
  assert.equal(rec.scheduled.length, 0, 'once stamped pushes were seen, one with no stamp draws nothing');
  assert.ok(momoCopy.marks >= 1);
  g.__phonePlatform = undefined;
});
