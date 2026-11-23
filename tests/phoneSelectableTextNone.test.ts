// A build without the native text view: it is none, the flag stays off even when asked for, and a reply is drawn as before.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, createElement, createRoot } from './support/phone/component-kit';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
mock.module(require.resolve('expo'), {
  namedExports: {
    requireNativeView: () => {
      throw new Error('no such view');
    },
  },
});
const nativePath = '../mobile/src/platform/selectableTextNative';
const viewPath = '../mobile/src/platform/selectableText';
const flagPath = '../mobile/src/platform/inPlaceSelection';
const markdownPath = '../mobile/src/components/Markdown';
const runPath = '../mobile/src/components/SelectableRun';
await import(nativePath);
const { nativeSelectableText } = await import(viewPath);
const { setInPlaceSelection, inPlaceSelection } = await import(flagPath);
const { Markdown } = await import(markdownPath);
const { SelectableRun } = await import(runPath);

test('without the native view there is none, the flag stays off, and a reply is drawn by React Native', async () => {
  assert.equal(nativeSelectableText(), null);
  setInPlaceSelection(true);
  assert.equal(inPlaceSelection(), false);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(Markdown, { text: 'Plain **words**.', inPlace: { copyMessage: () => undefined, selectText: () => undefined } }),
    ),
  );
  assert.ok(host.textContent!.includes('Plain'));
  await act(async () => root.render(createElement(SelectableRun, { blocks: [], copyMessage: () => undefined, fallback: null })));
  assert.equal(host.textContent, '');
  await act(async () => root.unmount());
  host.remove();
  setInPlaceSelection(false);
});
