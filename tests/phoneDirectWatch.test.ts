// A screen that shows a Host's cards keeps them current while it is open (mobile/src/remote/useDirect.ts `useDirectWatch`): the watch starts with the screen, asks for the shortest read the screen wants, and ends with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot } from './support/phone/component-kit';

const hookPath = '../mobile/src/remote/useDirect';
const { useDirectWatch, WATCH_MS } = await import(hookPath);

function mount(runtime: any, ms?: number) {
  function Probe() {
    useDirectWatch(runtime, ms);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  return { show: () => act(async () => root.render(createElement(Probe))), hide: () => act(async () => root.unmount()) };
}

test('the cards are read every second while the screen is open, and no more once it is gone', async () => {
  const log: string[] = [];
  const runtime = { direct: { phones: { watch: (ms: number) => (log.push(`watch ${ms}`), () => void log.push('stop')) } } };
  const screen = mount(runtime);
  await screen.show();
  assert.deepEqual(log, [`watch ${WATCH_MS}`]);
  assert.equal(WATCH_MS, 1000);
  await screen.hide();
  assert.deepEqual(log, [`watch ${WATCH_MS}`, 'stop']);
});

test("a screen may ask for a slower read, and a runtime without the phone's own paths watches nothing", async () => {
  const log: string[] = [];
  const runtime = { direct: { phones: { watch: (ms: number) => (log.push(`watch ${ms}`), () => undefined) } } };
  const slow = mount(runtime, 4000);
  await slow.show();
  assert.deepEqual(log, ['watch 4000']);
  await slow.hide();
  await mount(undefined).show();
  await mount({ direct: null }).show();
  assert.deepEqual(log, ['watch 4000']);
});
