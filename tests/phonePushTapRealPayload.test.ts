// The app's notification-response path with the push body the relay really sends: a tap while the app runs (warm) and the tap that launched it (cold) reach the chat, even one beyond the loaded pages. The OS delivery of the push itself is not exercised.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import '../tests/support/phone/register.ts';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
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
mock.module('../mobile/src/platform/crypto.ts', {
  namedExports: { phonePrimitives: () => ({ aeadOpen: () => new TextEncoder().encode('Sealed chat') }) },
});
mock.module('../mobile/src/platform/lifecycle.ts', { namedExports: { onForeground: () => () => {} } });

// variable specifiers keep React Native's global typings out of the repository-wide typecheck
const notificationsPath = '../mobile/src/platform/notifications.ts';
const routePath = '../mobile/src/push/route.ts';
const refPath = '../mobile/src/push/chatRef.ts';
const notifications = await import(notificationsPath);
const { locateTarget } = await import(routePath);
const { chatRef } = await import(refPath);

/** What the relay sends the phone for "a chat needs you" (the dev host's `run push-payload` prints exactly this body), as iOS hands it to the app on a tap. */
const relayBody = (ref: string) => ({
  aps: { category: 'mopilot.needsYou', alert: { title: 'A chat needs you', body: '' }, sound: 'default', 'thread-id': ref },
  kind: 'needsYou',
  ref,
});
const tapped = (ref: string, id: string) => ({
  date: 9000,
  request: { identifier: id, content: { data: null }, trigger: { type: 'push', payload: relayBody(ref) } },
});

/** A Mac with 130 chats that answers the list in pages of 50, as the locator reads it. */
const locator = (pairs: string[]) => {
  const all = Array.from({ length: 130 }, (_, i) => `c${i}`);
  const pages: number[] = [];
  return {
    pages,
    locator: {
      pairs,
      current: () => true,
      async chatIds(_pairId: string, found: (ids: string[]) => boolean) {
        const read: string[] = [];
        for (let offset = 0; offset < all.length; offset += 50) {
          pages.push(offset);
          read.push(...all.slice(offset, offset + 50));
          if (found(read)) break;
        }
        return read;
      },
    },
  };
};

const settle = () => new Promise((r) => setImmediate(r));

for (const how of ['warm', 'cold'] as const) {
  test(`a tap on the relay's real "needs you" push for a chat beyond the loaded pages opens that chat (${how} start)`, async () => {
    const ref = chatRef('p_a', 'c120');
    const seen: any[] = [];
    lastResponse = how === 'cold' ? { notification: tapped(ref, `cold-${how}`) } : null;
    const off = notifications.onTap((payload: any) => seen.push(payload));
    await settle();
    if (how === 'warm') rec.responseListeners.at(-1)({ notification: tapped(ref, `warm-${how}`) });
    assert.equal(seen.length, 1, 'one tap');
    assert.deepEqual([seen[0].kind, seen[0].ref], ['needsYou', ref]);
    const rig = locator(['p_a']);
    assert.deepEqual(await locateTarget(seen[0], rig.locator), { pairId: 'p_a', chatId: 'c120' });
    assert.deepEqual(rig.pages, [0, 50, 100], 'the pages were read until the chat was found');
    off();
    lastResponse = null;
  });
}

test('a tap for a chat the Mac does not have opens nothing, and one for another paired computer finds its chat there', async () => {
  const gone = locator(['p_a']);
  assert.equal(await locateTarget({ kind: 'needsYou', ref: chatRef('p_a', 'nobody'), count: 1 }, gone.locator), null);
  const two = locator(['p_a', 'p_b']);
  assert.deepEqual(await locateTarget({ kind: 'needsYou', ref: chatRef('p_b', 'c7'), count: 1 }, two.locator), {
    pairId: 'p_b',
    chatId: 'c7',
  });
});
