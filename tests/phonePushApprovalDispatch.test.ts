// Allow, Deny and Answer taps go to the approval handler (P5), never to the tap listener, with the native modules replaced by recorders.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import '../tests/support/phone/register.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const rec: any = { responseListeners: [], categories: [] };
mock.module(require.resolve('expo-notifications'), {
  namedExports: {
    addNotificationResponseReceivedListener: (l: any) => (rec.responseListeners.push(l), { remove: () => rec.responseListeners.pop() }),
    getLastNotificationResponseAsync: async () => null,
    setNotificationCategoryAsync: async (id: string, actions: any[]) => void rec.categories.push([id, actions]),
    AndroidImportance: {},
    AndroidNotificationVisibility: {},
  },
});
mock.module(require.resolve('expo-task-manager'), { namedExports: { defineTask: () => undefined } });
mock.module(require.resolve('expo-secure-store'), { namedExports: {} });
mock.module(require.resolve('expo-constants'), { defaultExport: {} });
const notificationsPath = '../mobile/src/platform/notifications.ts';
const notifications = await import(notificationsPath);
let noteCount = 0;
const note = (extra: any = {}) => ({
  date: 1000 + ++noteCount,
  request: { identifier: `n${noteCount}`, content: { data: { kind: 'done', ref: 'r1', ...extra } } },
});

test('Allow, Deny and Answer go to the approval handler and never to the tap listener', async () => {
  const taps: any[] = [];
  const acts: any[] = [];
  notifications.setApprovalHandler((p: any, action: string, id: string) => acts.push([p.kind, action, id]));
  const off = notifications.onTap((p) => taps.push(p.kind));
  await new Promise((r) => setImmediate(r));
  taps.length = 0;
  const n = note({ kind: 'needsYou', ref: 'r-act' });
  for (const a of ['allow', 'deny', 'answer']) rec.responseListeners[0]({ notification: n, actionIdentifier: `${a}` });
  assert.deepEqual(taps, []);
  assert.deepEqual(
    acts.map((a) => a[1]),
    ['allow', 'deny', 'answer'],
  );
  // with no handler set an action does nothing at all
  notifications.setApprovalHandler(null);
  rec.responseListeners[0]({ notification: note({ kind: 'needsYou', ref: 'r-none' }), actionIdentifier: 'deny' });
  assert.deepEqual(taps, []);
  off();
});

test('Allow runs in the background after device authentication; Deny runs in the background without it', async () => {
  (globalThis as any).__phonePlatform = 'ios';
  await notifications.setupCategories();
  const [, allow, deny] = rec.categories[0][1];
  assert.deepEqual([allow.buttonTitle, allow.options], ['Allow', { opensAppToForeground: false, isAuthenticationRequired: true }]);
  assert.deepEqual([deny.buttonTitle, deny.options], ['Deny', { opensAppToForeground: false, isAuthenticationRequired: false }]);
  (globalThis as any).__phonePlatform = undefined;
});
