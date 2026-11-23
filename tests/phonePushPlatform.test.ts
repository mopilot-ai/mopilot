// Expo notification, task-manager and keychain adapters for phone push, with the native modules replaced by recorders.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import '../tests/support/phone/register.ts';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const g = globalThis as any;
const rec: any = {
  categories: [],
  deleted: [],
  channels: [],
  scheduled: [],
  tasks: {},
  registered: [],
  handler: null,
  responseListeners: [],
  tokenListeners: [],
  secure: new Map(),
};
let permissions: any = { granted: false, canAskAgain: true };
let requestResult: any = { granted: true };
let lastResponse: any = null;
let tokenResult: any = { data: 'device-token' };
mock.module(require.resolve('expo-notifications'), {
  namedExports: {
    AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2 },
    AndroidNotificationVisibility: { PUBLIC: 1, PRIVATE: 0, SECRET: -1 },
    deleteNotificationChannelAsync: async (id: string) => {
      rec.deleted.push(id);
      if (rec.failDelete) throw new Error('no such channel');
    },
    getPermissionsAsync: async () => permissions,
    requestPermissionsAsync: async (o: any) => ((rec.requestOptions = o), requestResult),
    getDevicePushTokenAsync: async () => {
      if (tokenResult instanceof Error) throw tokenResult;
      return tokenResult;
    },
    addPushTokenListener: (l: any) => (rec.tokenListeners.push(l), { remove: () => rec.tokenListeners.pop() }),
    setNotificationChannelAsync: async (id: string, c: any) => {
      if (rec.failChannels) throw new Error('channel setup failed');
      rec.channels.push([id, c]);
    },
    setNotificationHandler: (h: any) => void (rec.handler = h),
    addNotificationResponseReceivedListener: (l: any) => (rec.responseListeners.push(l), { remove: () => rec.responseListeners.pop() }),
    getLastNotificationResponseAsync: async () => {
      if (lastResponse instanceof Error) throw lastResponse;
      return lastResponse;
    },
    scheduleNotificationAsync: async (r: any) => {
      if (rec.failSchedule) throw new Error('not allowed');
      rec.scheduled.push(r);
    },
    setNotificationCategoryAsync: async (id: string, actions: any[]) => void rec.categories.push([id, actions]),
    registerTaskAsync: async (name: string) => void rec.registered.push(name),
  },
});
mock.module(require.resolve('expo-task-manager'), { namedExports: { defineTask: (name: string, fn: any) => void (rec.tasks[name] = fn) } });
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 5,
    getItemAsync: async (k: string) => {
      checkSecureKey(k);
      if (rec.failPrefsRead && k === 'push-prefs') throw new Error('keystore locked');
      return rec.secure.get(k) ?? null;
    },
    setItemAsync: async (k: string, v: string) => (checkSecureKey(k), checkSecureValue(v), void rec.secure.set(k, v)),
    deleteItemAsync: async (k: string) => (checkSecureKey(k), void rec.secure.delete(k)),
  },
});
let expoExtra: any = { push: { keychainAccessGroup: 'TEAM.ai.mopilot.phone.shared' } };
mock.module(require.resolve('expo-constants'), {
  defaultExport: {
    get expoConfig() {
      return { extra: expoExtra };
    },
  },
});
const aead = { opened: [] as any[] };
let titleKeyHex = '';
mock.module('../mobile/src/platform/crypto.ts', {
  namedExports: { phonePrimitives: () => ({ aeadOpen: (...a: any[]) => (aead.opened.push(a), new TextEncoder().encode('Sealed chat')) }) },
});
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });

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

test('permission maps the OS answer: granted, askable and blocked', async () => {
  permissions = { granted: true };
  assert.equal(await notifications.permissionPort.status(), 'granted');
  permissions = { granted: false, canAskAgain: true };
  assert.equal(await notifications.permissionPort.status(), 'undetermined');
  permissions = { granted: false, canAskAgain: false };
  assert.equal(await notifications.permissionPort.status(), 'denied');
  assert.equal(await notifications.permissionPort.request(), 'granted');
  assert.deepEqual(rec.requestOptions, { ios: { allowAlert: true, allowSound: true, allowBadge: false } });
  requestResult = { granted: false };
  assert.equal(await notifications.permissionPort.request(), 'denied');
});

test('the token source names the platform, reads the device token and follows rotations', async () => {
  g.__phonePlatform = 'ios';
  assert.equal(notifications.tokenSource.platform, 'apns');
  g.__phonePlatform = 'android';
  assert.equal(notifications.tokenSource.platform, 'fcm');
  assert.equal(await notifications.tokenSource.get(), 'device-token');
  tokenResult = { data: '' };
  assert.equal(await notifications.tokenSource.get(), null);
  tokenResult = { data: { not: 'a string' } };
  assert.equal(await notifications.tokenSource.get(), null);
  assert.equal(notifications.tokenSource.failure, null, 'an empty token is not a failure');
  tokenResult = new Error('no google services');
  assert.equal(await notifications.tokenSource.get(), null);
  assert.equal(notifications.tokenSource.failure, null, 'a transient or unknown error is not "this build has no push"');
  tokenResult = new Error('no valid “aps-environment” entitlement string found for application');
  assert.equal(await notifications.tokenSource.get(), null);
  assert.match(notifications.tokenSource.failure!, /aps-environment/, 'a build without the entitlement says so');
  for (const message of [
    'Cannot find native module ExpoPushTokenManager',
    'Google Play services are not available',
    'Push is not linked',
  ]) {
    tokenResult = new Error(message);
    await notifications.tokenSource.get();
    assert.equal(notifications.tokenSource.failure, message, message);
  }
  tokenResult = { data: 'device-token' };
  assert.equal(await notifications.tokenSource.get(), 'device-token');
  assert.equal(notifications.tokenSource.failure, null, 'a token read clears it');
  tokenResult = {
    get data(): string {
      throw 'plain failure';
    },
  };
  assert.equal(await notifications.tokenSource.get(), null);
  assert.equal(notifications.tokenSource.failure, null, 'a failure that is not an Error and names nothing permanent is not one');
  tokenResult = {
    get data(): string {
      throw 'native module is missing';
    },
  };
  await notifications.tokenSource.get();
  assert.equal(notifications.tokenSource.failure, 'native module is missing', 'a failure that is not an Error is read as text');
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void warnings.push(m);
  g.__DEV__ = true;
  tokenResult = new Error('no aps-environment');
  await notifications.tokenSource.get();
  g.__DEV__ = false;
  await notifications.tokenSource.get();
  delete g.__DEV__;
  console.warn = warn;
  assert.deepEqual(warnings, ['[push] no device token: no aps-environment'], 'only a development build says why');
  tokenResult = new Error('no google services');
  const heard: unknown[] = [];
  const off = notifications.tokenSource.onRefresh((t) => heard.push(t));
  for (const event of [{ data: 'tokA' }, { data: '' }, { data: 7 }]) rec.tokenListeners[0](event);
  assert.deepEqual(heard, ['tokA', null, null], 'the announced token is passed on, and a missing one is null');
  off();
  assert.equal(rec.tokenListeners.length, 0);
});

test('channels exist only on Android and map importance', async () => {
  g.__phonePlatform = 'ios';
  await notifications.setupChannels();
  assert.deepEqual(rec.channels, []);
  g.__phonePlatform = 'android';
  await notifications.setupChannels();
  assert.deepEqual(
    rec.channels.map(([id, c]: any) => [id, c.importance, c.sound, c.lockscreenVisibility]),
    [
      ['system', 3, undefined, undefined],
      ['needs-you', 4, undefined, 1],
      ['needs-you-silent', 3, null, 1],
      ['done', 3, undefined, 1],
      ['done-silent', 2, null, 1],
    ],
  );
});

test('a lock-screen choice creates its own channels and removes the other choices', async () => {
  g.__phonePlatform = 'android';
  rec.channels.length = 0;
  rec.deleted.length = 0;
  rec.failDelete = true;
  await notifications.setupChannels('hide');
  rec.failDelete = false;
  assert.deepEqual(
    rec.channels.filter(([id]: any) => id !== 'system').map(([id, c]: any) => [id, c.lockscreenVisibility]),
    [
      ['needs-you-hide', -1],
      ['needs-you-silent-hide', -1],
      ['done-hide', -1],
      ['done-silent-hide', -1],
    ],
  );
  assert.equal(rec.deleted.length, 8);
  assert.ok(rec.deleted.includes('needs-you') && rec.deleted.includes('done-private'));
  rec.channels.length = 0;
  await notifications.setupChannels('private');
  assert.equal(rec.channels[1][1].lockscreenVisibility, 0);
  rec.channels.length = 0;
  await notifications.setupChannels();
  assert.equal(rec.channels[1][0], 'needs-you');
  rec.channels.length = 0;
  rec.deleted.length = 0;
  await notifications.setupChannels('hide', false);
  assert.deepEqual(rec.deleted, [], 'without pruning nothing is removed');
  assert.ok(!rec.deleted.includes('system') && !rec.deleted.includes('done'), 'the manifest channel is never removed');
});

test('iOS registers the Review/Open and Reply categories, every action opens the app and a reply needs the device unlocked', async () => {
  g.__phonePlatform = 'android';
  await notifications.setupCategories();
  assert.deepEqual(rec.categories, []);
  g.__phonePlatform = 'ios';
  await notifications.setupCategories();
  assert.deepEqual(
    rec.categories.map(([id]: any) => id),
    ['mopilot.needsYou', 'mopilot.momoNeedsYou', 'mopilot.done'],
  );
  const [open, , , reply] = rec.categories[0][1];
  assert.deepEqual(open, {
    identifier: 'open',
    buttonTitle: 'Review',
    options: { opensAppToForeground: true, isAuthenticationRequired: false },
  });
  assert.equal(reply.textInput.placeholder, 'Message');
  assert.deepEqual(reply.options, { opensAppToForeground: true, isAuthenticationRequired: true });
  g.__phonePlatform = undefined;
});

test('in the foreground a push only wakes the app and shows nothing', async () => {
  const seen: any[] = [];
  notifications.quietForeground((p) => seen.push(p));
  const behaviour = await rec.handler.handleNotification(note());
  assert.deepEqual(behaviour, { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });
  assert.equal(seen[0].ref, 'r1');
  await rec.handler.handleNotification({ request: { content: { data: { junk: true } } } });
  assert.equal(seen.length, 1);
});

test('taps arrive live and from the launching notification; bad data and a failing launch read are ignored', async () => {
  const seen: any[] = [];
  lastResponse = { notification: note({ kind: 'needsYou' }) };
  const replies: Array<string | undefined> = [];
  const off = notifications.onTap((p, reply) => (seen.push(p.kind), replies.push(reply)));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['needsYou']);
  rec.responseListeners[0]({ notification: note({ kind: 'done' }) });
  rec.responseListeners[0]({ notification: { request: { identifier: 'junk', content: { data: {} } } } });
  rec.responseListeners[0]({ notification: note({ kind: 'needsYou' }), actionIdentifier: 'reply', userText: ' ok ' });
  assert.equal(replies.at(-1), 'ok');
  rec.responseListeners[0]({ notification: note({ kind: 'done' }), actionIdentifier: 'open', userText: 'ignored' });
  assert.equal(replies.at(-1), undefined);
  replies.length = 0;
  assert.deepEqual(seen, ['needsYou', 'done', 'needsYou', 'done']);
  off();
  lastResponse = new Error('x');
  notifications.onTap(() => seen.push('never'))();
  await new Promise((r) => setImmediate(r));
  lastResponse = null;
  notifications.onTap(() => seen.push('never'))();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 4);
});

test('one response reaches the listener once: a launch replay and a quick live repeat are dropped, a later tap is not', async () => {
  const taps: Array<string | undefined> = [];
  const replyNote = note({ kind: 'needsYou' });
  lastResponse = { notification: replyNote, actionIdentifier: 'reply', userText: 'once' };
  const first = notifications.onTap((_p, reply) => taps.push(reply));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(taps, ['once']);
  rec.responseListeners.at(-1)({ notification: replyNote, actionIdentifier: 'reply', userText: 'once' });
  assert.deepEqual(taps, ['once'], 'the live delivery of the same response is the same tap');
  first();
  // the effect restarts: the launch response is replayed and must not be delivered again
  const second = notifications.onTap((_p, reply) => taps.push(reply));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(taps, ['once']);
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  try {
    rec.responseListeners.at(-1)({ notification: replyNote, actionIdentifier: 'reply', userText: 'again' });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(taps, ['once', 'again'], 'the same notification tapped again later is a new tap');
  second();
  lastResponse = null;
  const many = notifications.onTap(() => {});
  for (let i = 0; i < 60; i++) rec.responseListeners.at(-1)({ notification: note(), actionIdentifier: 'open' });
  many();
});

test('a local notification replaces the previous one for the same chat and names its channel', async () => {
  await notifications.showLocal({ id: 'done:r1', title: 'A chat finished', channelId: 'done', data: { kind: 'done', ref: 'r1' } });
  assert.deepEqual(rec.scheduled[0], {
    identifier: 'done:r1',
    content: { title: 'A chat finished', body: '', data: { kind: 'done', ref: 'r1' } },
    trigger: { channelId: 'done' },
  });
});

test('task data accepts a string, an object, a data string and junk', () => {
  assert.deepEqual(notifications.taskData({ dataString: '{"kind":"done"}' }), { kind: 'done' });
  assert.deepEqual(notifications.taskData({ data: { kind: 'done' } }), { kind: 'done' });
  assert.deepEqual(notifications.taskData({ data: '{"a":1}' }), { a: 1 });
  assert.equal(notifications.taskData({ data: '{oops' }), null);
  assert.deepEqual(notifications.taskData({ kind: 'done' }), { kind: 'done' });
  assert.equal(notifications.taskData(null), null);
});

test('the Android data-message task is defined once and registered only on Android', async () => {
  const handled: unknown[] = [];
  notifications.defineDataMessageTask(async (d) => void handled.push(d));
  const task = rec.tasks[notifications.DATA_MESSAGE_TASK];
  await task({ data: { dataString: '{"kind":"done"}' }, error: null });
  await task({ data: {}, error: new Error('x') });
  assert.deepEqual(handled, [{ kind: 'done' }]);
  notifications.defineDataMessageTask(async () => {
    throw new Error('handler failed');
  });
  await rec.tasks[notifications.DATA_MESSAGE_TASK]({ data: {}, error: null });
  g.__phonePlatform = 'ios';
  await notifications.registerDataMessageTask();
  assert.deepEqual(rec.registered, []);
  g.__phonePlatform = 'android';
  await notifications.registerDataMessageTask();
  assert.deepEqual(rec.registered, [notifications.DATA_MESSAGE_TASK]);
});

test('the secret port forwards to SecureStore', async () => {
  await notifications.secretPort.set('k', 'v', {});
  assert.equal(await notifications.secretPort.get('k', {}), 'v');
  await notifications.secretPort.remove('k', {});
  assert.equal(await notifications.secretPort.get('k', {}), null);
});

test('production: a data message opens the sealed title with the stored key under the shared service and group', async () => {
  g.__phonePlatform = 'android';
  rec.scheduled.length = 0;
  titleKeyHex = '11'.repeat(32);
  rec.secure.set('title-key-index', JSON.stringify(['p_a']));
  rec.secure.set('title-key.p_a', titleKeyHex);
  rec.secure.set('push-prefs', JSON.stringify({ titles: true }));
  await production.handleDataMessage({ kind: 'needsYou', ref: 'r1', st: 'AAAA' });
  assert.equal(aead.opened.length, 0, 'a blob too short to hold a nonce and tag never reaches the cipher');
  const nonce = new Uint8Array(24 + 16 + 5).fill(1);
  const b64 = Buffer.from(nonce).toString('base64');
  await production.handleDataMessage({ kind: 'needsYou', ref: 'r1', st: b64 });
  assert.equal(rec.scheduled.at(-1).content.title, 'Sealed chat');
  assert.equal(rec.scheduled.at(-1).trigger.channelId, 'needs-you');
  assert.ok(
    rec.channels.some(([id]: any) => id === 'needs-you-silent'),
    'the channels exist before the notification is shown',
  );
  const created = rec.channels.length;
  rec.failChannels = true;
  await production.handleDataMessage({ kind: 'done', ref: 'r9' });
  rec.failChannels = false;
  assert.equal(rec.channels.length, created, 'a channel setup failure still shows the notification');
  assert.equal(rec.scheduled.at(-1).content.data.ref, 'r9');
  rec.scheduled.pop();
  await production.handleDataMessage({ junk: true });
  assert.equal(rec.scheduled.length, 2);
});

test('production: installing defines the task and registers it; the controller wires foreground pushes and taps', async () => {
  production.installDataMessageTask();
  await new Promise((r) => setImmediate(r));
  assert.ok(rec.tasks[notifications.DATA_MESSAGE_TASK]);
  assert.ok(rec.registered.includes(notifications.DATA_MESSAGE_TASK));
  const wakes: string[] = [];
  const runtime: any = {
    snapshot: () => ({ user: { id: 'u' }, pairs: [{ pairId: 'p_a' }], phase: 'offline', selectedPair: null }),
    subscribe: () => () => {},
    onEvent: () => () => {},
    connect: async (p: string) => void wakes.push(p),
    pushRegister: async (platform: string, token: string) => void wakes.push(`reg:${platform}:${token}`),
    pushUnregister: async () => void wakes.push('unreg'),
  };
  permissions = { granted: true };
  tokenResult = { data: 'tok-A' };
  const push = production.createProductionPush(runtime);
  await push.start();
  assert.ok(wakes.includes('reg:fcm:tok-A'));
  await rec.handler.handleNotification(note());
  await new Promise((r) => setImmediate(r));
  assert.ok(wakes.includes('p_a'));
  // a data message handled while the app's controller is alive in this process drains the mailbox as well
  wakes.length = 0;
  permissions = { granted: true };
  await production.handleDataMessage({ kind: 'done', ref: 'rw' });
  await new Promise((r) => setImmediate(r));
  assert.ok(wakes.includes('p_a'), 'the backgrounded process reconnects its computer');
  await push.signOut().catch(() => undefined);
  assert.ok(wakes.includes('unreg'));
  // the app hands sign-out the Live Activity's cleanup, which runs with the token removal
  const hooked = production.createProductionPush(runtime, { beforeSignOut: async () => void wakes.push('activity-forgotten') });
  await hooked.start();
  await hooked.signOut().catch(() => undefined);
  assert.ok(wakes.includes('activity-forgotten'));
  hooked.stop();
  push.stop();
  wakes.length = 0;
  await production.handleDataMessage({ kind: 'done', ref: 'rz' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(wakes, [], 'a stopped or never-started app has no runtime to drain with');
  await rec.handler.handleNotification(note());
  // without the shared group (no team id) and with a missing config the group is simply absent
  expoExtra = undefined;
  await production.handleDataMessage({ kind: 'done', ref: 'r2' });
  rec.secure.set('push-prompt-dismissed-at', String(Date.now()));
  permissions = { granted: false, canAskAgain: true };
  await push.start();
  assert.equal(push.ui().step, 'later');
  rec.secure.set('push-prompt-dismissed-at', 'not-a-number');
  await push.start();
  assert.equal(push.ui().step, 'explain');
  await push.accept();
  assert.equal(rec.secure.has('push-prompt-dismissed-at'), false, 'accepting forgets an earlier Not now');
  await push.setPrefs({ sound: false });
  assert.equal(JSON.parse(rec.secure.get('push-prefs')).sound, false, 'preferences persist in the keychain');
  await push.later();
  assert.equal(rec.secure.get('push-prompt-dismissed-at') !== undefined, true);
  push.stop();
});

test('channels follow the latest saved choice: quick changes converge, an unreadable store changes nothing, the headless task stays private', async () => {
  g.__phonePlatform = 'android';
  rec.channels.length = 0;
  rec.deleted.length = 0;
  rec.scheduled.length = 0;
  rec.secure.set('push-prefs', JSON.stringify({ lockScreen: 'private' }));
  const first = production.syncChannels();
  rec.secure.set('push-prefs', JSON.stringify({ lockScreen: 'hide' }));
  const second = production.syncChannels();
  await Promise.all([first, second]);
  const ids = rec.channels.map(([id]: any) => id).filter((id: string) => id !== 'system');
  assert.deepEqual(ids.slice(-4), ['needs-you-hide', 'needs-you-silent-hide', 'done-hide', 'done-silent-hide']);
  assert.ok(!rec.deleted.includes('system'));
  rec.channels.length = 0;
  rec.failPrefsRead = true;
  await production.syncChannels();
  assert.deepEqual(rec.channels, [], 'an unreadable store leaves the channels as they are');
  await production.handleDataMessage({ kind: 'needsYou', ref: 'rk' });
  assert.equal(rec.scheduled.at(-1).trigger.channelId, 'needs-you-private');
  assert.deepEqual(
    rec.deleted.filter((id: string) => id.endsWith('-hide')),
    [],
    'the private set is created without removing the saved choice',
  );
  rec.failPrefsRead = false;
});

// an iOS push: the custom keys the relay puts beside `aps` arrive in the trigger's payload, and `content.data` is null
const iosPush = (payload: any, extra: any = {}) => {
  noteCount += 1;
  return {
    date: 5000 + noteCount,
    request: {
      identifier: `ios${noteCount}`,
      content: { data: null, ...extra },
      trigger: { type: 'push', payload: { aps: { alert: {} }, ...payload } },
    },
  };
};

test('an iOS push is read from its trigger payload, in the foreground and when tapped, with its MoMo card', async () => {
  const seen: any[] = [];
  notifications.quietForeground((p) => seen.push(p));
  await rec.handler.handleNotification(iosPush({ kind: 'momoNeedsYou', ref: 'r9', card: 'c9' }));
  assert.deepEqual([seen[0].kind, seen[0].ref, seen[0].card], ['momoNeedsYou', 'r9', 'c9']);
  const taps: any[] = [];
  const off = notifications.onTap((p) => taps.push([p.kind, p.ref, p.card]));
  rec.responseListeners.at(-1)({ notification: iosPush({ kind: 'momoNeedsYou', ref: 'r9', card: 'c9' }) });
  rec.responseListeners.at(-1)({ notification: iosPush({ kind: 'needsYou', ref: 'r8' }) });
  // a push with neither data nor a push trigger carries nothing to open
  rec.responseListeners.at(-1)({
    notification: { request: { identifier: 'local', content: { data: null }, trigger: { type: 'timeInterval' } } },
  });
  assert.deepEqual(taps, [
    ['momoNeedsYou', 'r9', 'c9'],
    ['needsYou', 'r8', undefined],
  ]);
  off();
});
