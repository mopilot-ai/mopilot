// The first press after a scroll (#5369): a run that is native when the list scrolls and comes to rest is still the same native view afterwards, ready, and nothing re-mounts it for the press.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, createElement, createRoot } from './support/phone/component-kit';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const g = globalThis as any;
function FakeNative(props: any) {
  (g.__nativeRuns ??= []).push(props);
  return createElement('div', { 'data-native-run': props.runs.map((r: any) => r.t).join('') });
}
// the paths are variables so the node type check does not follow them into the phone's sources
const nativePath = '../mobile/src/platform/selectableTextNative';
const flagPath = '../mobile/src/platform/inPlaceSelection';
const bubblePath = '../mobile/src/components/MessageBubble';
const gatePath = '../mobile/src/presentation/nativeGate';
mock.module(require.resolve('expo'), { namedExports: { requireNativeView: () => FakeNative } });
await import(nativePath);
const { setInPlaceSelection } = await import(flagPath);
const { MessageBubble } = await import(bubblePath);
const { nativeGate, OPEN_SETTLE, SCROLL_IDLE } = await import(gatePath);

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
  nativeGate.configure(false);
  mock.timers.reset();
  setInPlaceSelection(false);
});
const quiet = async (ms: number) => act(async () => mock.timers.tick(ms));
const last = () => (g.__nativeRuns as any[]).at(-1);

test('scroll, rest, press: the native run is the same view, shown, and a press on it asks for nothing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  setInPlaceSelection(true);
  g.__nativeRuns = [];
  nativeGate.configure(true);
  nativeGate.open();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(MessageBubble, { role: 'assistant', text: 'Hello world' })));
  const wrapper: any = [...host.querySelectorAll('div')].find((d: any) => d.__touchStartCapture && d.__onLayout);
  await act(async () => wrapper.__onLayout({ nativeEvent: { layout: { height: 100 } } }));
  await quiet(OPEN_SETTLE);
  await act(async () => last().onContentSize({ nativeEvent: { height: 100 } }));
  assert.equal(host.querySelectorAll('[data-native-run]').length, 1, 'native and shown');
  const view = host.querySelector('[data-native-run]');
  const renders = g.__nativeRuns.length;
  // a slow 20 pt drag: scroll reports for a while, then the list is still
  for (let i = 0; i < 6; i++) {
    await act(async () => nativeGate.activity());
    await quiet(100);
  }
  await quiet(SCROLL_IDLE);
  assert.equal(host.querySelector('[data-native-run]'), view, 'the same native element after the scroll');
  assert.equal(g.__nativeRuns.length, renders, 'the scroll and its rest did not re-render the run');
  // the press
  await act(async () => wrapper.__touchStartCapture?.());
  assert.equal(host.querySelector('[data-native-run]'), view);
  assert.equal(g.__nativeRuns.length, renders, 'the press did not re-render it either');
});
