// The Android local notification carries MoMo's opt-in body (A6, mobile/src/platform/notifications.ts showLocal): the opened routine name is the notification's body, and none is the empty body, as before.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import '../tests/support/phone/register.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const scheduled: any[] = [];
mock.module(require.resolve('expo-notifications'), {
  namedExports: {
    AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2 },
    AndroidNotificationVisibility: { PUBLIC: 1, PRIVATE: 0, SECRET: -1 },
    scheduleNotificationAsync: async (r: any) => void scheduled.push(r),
  },
});
mock.module(require.resolve('expo-task-manager'), { namedExports: { defineTask: () => undefined } });
mock.module(require.resolve('expo-secure-store'), { namedExports: {} });

// a variable specifier keeps React Native's global typings out of the repository-wide typecheck
const notificationsPath = '../mobile/src/platform/notifications.ts';
const { showLocal } = await import(notificationsPath);

test('a local notification shows the opened body, and the empty body when there is none', async () => {
  await showLocal({
    id: 'momoNeedsYou:r2',
    title: 'MoMo needs you',
    body: 'Morning brief',
    channelId: 'needs-you',
    data: { kind: 'momoNeedsYou', ref: 'r2' },
  });
  await showLocal({ id: 'done:r1', title: 'A chat finished', channelId: 'done', data: { kind: 'done', ref: 'r1' } });
  assert.deepEqual(
    scheduled.map((s) => [s.identifier, s.content.title, s.content.body]),
    [
      ['momoNeedsYou:r2', 'MoMo needs you', 'Morning brief'],
      ['done:r1', 'A chat finished', ''],
    ],
  );
  assert.deepEqual(scheduled[0].trigger, { channelId: 'needs-you' });
});
