// The foreground adapter tells how long the app was away: from the first moment it left the front until it was active again.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const lifecycleModulePath = '../mobile/src/platform/lifecycle.ts';
let appState: ((state: string) => void) | null = null;
const AppStateMock = {
  currentState: 'background',
  addEventListener: (_event: string, fn: any) => {
    appState = fn;
    return { remove() {} };
  },
};
mock.module(require.resolve('react-native'), {
  namedExports: {
    AppState: AppStateMock,
  },
});
const { isActive, onForeground } = await import(lifecycleModulePath);

test('the listener is told how long the app was away, counted from the first time it left the front', () => {
  let clock = 1_000;
  const now = mock.method(Date, 'now', () => clock);
  const away: number[] = [];
  const off = onForeground((ms: number) => away.push(ms));
  appState!('inactive');
  clock += 400;
  appState!('background'); // inactive then background is one absence, from the first
  clock += 59_600;
  appState!('active');
  assert.deepEqual(away, [60_000]);
  // a plain pull of the control centre is short, and the next absence counts from its own start
  clock += 5_000;
  appState!('inactive');
  clock += 300;
  appState!('active');
  assert.deepEqual(away, [60_000, 300]);
  // active again with no absence in between says nothing was missed
  appState!('active');
  assert.deepEqual(away, [60_000, 300, 0]);
  off();
  now.mock.restore();
});

test('the app is in front only while its state is active', () => {
  assert.equal(isActive(), false);
  AppStateMock.currentState = 'active';
  assert.equal(isActive(), true);
});
